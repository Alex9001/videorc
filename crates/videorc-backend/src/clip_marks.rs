//! Clip that (plan 068 D6): a spoken "clip that" or a manual mark stamps a
//! recording-file time the streamer wants clipped.
//!
//! Detection is a pure phrase matcher over transcript finals and their word
//! segments. The previous final's last words are kept so a phrase split across
//! a chunk boundary ("clip" | "that") still matches. Marks persist in the
//! `clip_marks` table only when the active session records to a file; a
//! stream-only session keeps nothing and the event says so.
//!
//! The caption task calls [`note_transcript_final`], which locks, matches, and
//! returns; the recording lock and the database write happen on a spawned task.

use std::sync::{Arc, Mutex as StdMutex};

use anyhow::Result;
use chrono::Utc;

use crate::captions::CaptionSegment;
use crate::protocol::{ClipMark, ClipMarkSource, ClipMarkedEvent};
use crate::state::AppState;

/// English phrases that place a mark, as normalized words.
pub const CLIP_PHRASES: &[&[&str]] = &[
    &["clip", "that"],
    &["clip", "it"],
    &["clip", "this"],
    &["thats", "a", "clip"],
    &["make", "a", "clip"],
];

/// A voice match within this many seconds of the previous mark (voice or
/// manual) is the same moment said twice.
pub const CLIP_MARK_DEDUPE_SECONDS: f64 = 10.0;

/// The longest phrase has three words, so two carried words complete any
/// phrase that started in the previous final.
const TAIL_WORDS: usize = 2;

/// Carried words older than this are a different sentence; a tail from the
/// future belongs to a previous session whose file time restarted.
const TAIL_MAX_AGE_SECONDS: f64 = 6.0;

/// Why `clip.mark` produced no mark.
#[derive(Debug, thiserror::Error)]
pub enum ClipMarkError {
    #[error("No session is running, so there is nothing to mark.")]
    NoActiveSession,
    #[error("{0}")]
    Storage(#[from] anyhow::Error),
}

impl ClipMarkError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoActiveSession => "no-active-session",
            Self::Storage(_) => "clip-mark-failed",
        }
    }
}

/// One transcript word with its recording-file time.
#[derive(Debug, Clone, PartialEq)]
pub struct TimedWord {
    pub word: String,
    pub at_seconds: f64,
}

/// A phrase found in the transcript and the file time of its first word.
#[derive(Debug, Clone, PartialEq)]
pub struct PhraseMatch {
    /// The phrase as spoken, normalized ("clip that").
    pub phrase: String,
    pub at_seconds: f64,
}

/// Lowercase ASCII letters and digits only: "That's," → "thats", "Clip!" →
/// "clip". Whole words compare, so "eclipse", "clipboard" and "clipped"
/// never equal "clip".
pub fn normalize_word(raw: &str) -> Option<String> {
    let word: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect();
    (!word.is_empty()).then_some(word)
}

/// The final's words with file times: each word takes the start of the
/// segment it came from; without segments every word takes the final's
/// offset.
pub fn timed_words(text: &str, segments: &[CaptionSegment], offset_seconds: f64) -> Vec<TimedWord> {
    if segments.is_empty() {
        return text
            .split_whitespace()
            .filter_map(normalize_word)
            .map(|word| TimedWord {
                word,
                at_seconds: offset_seconds,
            })
            .collect();
    }
    segments
        .iter()
        .flat_map(|segment| {
            let at_seconds = offset_seconds + segment.start_second.max(0.0);
            segment
                .text
                .split_whitespace()
                .filter_map(normalize_word)
                .map(move |word| TimedWord { word, at_seconds })
        })
        .collect()
}

/// The earliest clip phrase in `tail ++ words` that ends inside `words`, so
/// a phrase already matched from the tail alone is never matched again.
pub fn find_clip_phrase(tail: &[TimedWord], words: &[TimedWord]) -> Option<PhraseMatch> {
    let all: Vec<&TimedWord> = tail.iter().chain(words.iter()).collect();
    for start in 0..all.len() {
        for phrase in CLIP_PHRASES {
            let end = start + phrase.len();
            if end > all.len() || end <= tail.len() {
                continue;
            }
            if phrase
                .iter()
                .zip(&all[start..end])
                .all(|(expected, word)| word.word == *expected)
            {
                return Some(PhraseMatch {
                    phrase: phrase.join(" "),
                    at_seconds: all[start].at_seconds,
                });
            }
        }
    }
    None
}

/// Matcher state across finals: the carried tail and the last mark for dedupe.
#[derive(Debug, Default)]
pub struct ClipMarkDetector {
    tail: Vec<TimedWord>,
    last_mark_at_seconds: Option<f64>,
}

impl ClipMarkDetector {
    /// One settled final. Returns a match that is not a repeat of the last
    /// mark; the tail always advances.
    pub fn note_final(
        &mut self,
        text: &str,
        segments: &[CaptionSegment],
        offset_seconds: f64,
    ) -> Option<PhraseMatch> {
        let words = timed_words(text, segments, offset_seconds);
        self.tail.retain(|word| {
            word.at_seconds <= offset_seconds + 0.001
                && offset_seconds - word.at_seconds <= TAIL_MAX_AGE_SECONDS
        });
        let found = find_clip_phrase(&self.tail, &words);
        let mut carried: Vec<TimedWord> = self.tail.drain(..).chain(words).collect();
        if carried.len() > TAIL_WORDS {
            carried.drain(..carried.len() - TAIL_WORDS);
        }
        self.tail = carried;
        found.filter(|found| self.accept_voice_mark(found.at_seconds))
    }

    /// Dedupe: a voice mark within [`CLIP_MARK_DEDUPE_SECONDS`] after the
    /// previous mark is dropped. An earlier time than the last mark means the
    /// file time restarted (a new session) and is accepted.
    fn accept_voice_mark(&mut self, at_seconds: f64) -> bool {
        if let Some(last) = self.last_mark_at_seconds
            && at_seconds >= last
            && at_seconds - last < CLIP_MARK_DEDUPE_SECONDS
        {
            return false;
        }
        self.last_mark_at_seconds = Some(at_seconds);
        true
    }

    /// A manual mark always lands; it only moves the dedupe window.
    pub fn note_manual_mark(&mut self, at_seconds: f64) {
        self.last_mark_at_seconds = Some(at_seconds);
    }
}

pub type ClipMarkDetectorSlot = Arc<StdMutex<ClipMarkDetector>>;

pub fn new_clip_mark_detector_slot() -> ClipMarkDetectorSlot {
    Arc::new(StdMutex::new(ClipMarkDetector::default()))
}

/// Caption-task hook for every transcript final (both intents, both
/// transports): match under the std lock and return. A hit is recorded on a
/// spawned task so the caller never waits on the recording lock.
pub(crate) fn note_transcript_final(
    state: &AppState,
    text: &str,
    segments: &[CaptionSegment],
    offset_seconds: f64,
) {
    let found = state
        .clip_marks
        .lock()
        .ok()
        .and_then(|mut detector| detector.note_final(text, segments, offset_seconds));
    let Some(found) = found else {
        return;
    };
    let Ok(handle) = tokio::runtime::Handle::try_current() else {
        tracing::warn!(
            "Heard '{}' at {:.1}s but no runtime is available to record the clip mark.",
            found.phrase,
            found.at_seconds
        );
        return;
    };
    let state = state.clone();
    handle.spawn(async move {
        match record_mark(
            &state,
            Some(found.at_seconds),
            ClipMarkSource::Voice,
            Some(found.phrase.clone()),
        )
        .await
        {
            Ok(event) if event.saved => {
                tracing::info!(
                    "Clip marked at {:.1}s: you said '{}'.",
                    event.at_seconds,
                    found.phrase
                );
            }
            Ok(event) => tracing::info!(
                "Heard '{}' at {:.1}s but the clip was not saved ({}).",
                found.phrase,
                event.at_seconds,
                event.reason.as_deref().unwrap_or("unknown")
            ),
            Err(error) => tracing::info!(
                "Heard '{}' at {:.1}s but no clip mark landed: {error}",
                found.phrase,
                found.at_seconds
            ),
        }
    });
}

/// `clip.mark`: a manual mark at the capture's current elapsed time.
pub async fn mark_manual(state: &AppState) -> Result<ClipMarkedEvent, ClipMarkError> {
    record_mark(state, None, ClipMarkSource::Manual, None).await
}

/// Store a mark for the active session and emit `clip.marked`. `at_seconds`
/// `None` stamps the capture's elapsed time now. Without a recording output
/// nothing is stored and the event says why.
async fn record_mark(
    state: &AppState,
    at_seconds: Option<f64>,
    source: ClipMarkSource,
    phrase: Option<String>,
) -> Result<ClipMarkedEvent, ClipMarkError> {
    let (session_id, at_seconds, records_to_file) = {
        let recording = state.recording.lock().await;
        let active = recording.as_ref().ok_or(ClipMarkError::NoActiveSession)?;
        (
            active.session_id.clone(),
            at_seconds.unwrap_or_else(|| active.capture_elapsed_seconds()),
            active.output_path.is_some(),
        )
    };
    let at_seconds = at_seconds.max(0.0);
    if source == ClipMarkSource::Manual
        && let Ok(mut detector) = state.clip_marks.lock()
    {
        detector.note_manual_mark(at_seconds);
    }
    let event = if records_to_file {
        state.database.insert_clip_mark(&ClipMark {
            id: uuid::Uuid::new_v4().to_string(),
            session_id: session_id.clone(),
            at_seconds,
            source,
            phrase,
            created_at: Utc::now().to_rfc3339(),
        })?;
        ClipMarkedEvent {
            session_id,
            at_seconds,
            source,
            saved: true,
            reason: None,
        }
    } else {
        ClipMarkedEvent {
            session_id,
            at_seconds,
            source,
            saved: false,
            reason: Some("recording-off".to_string()),
        }
    };
    state.emit_event("clip.marked", event.clone());
    Ok(event)
}

/// `clip.marks.list`: every mark of a session, earliest first.
pub fn list_marks(state: &AppState, session_id: &str) -> Result<Vec<ClipMark>> {
    state.database.list_clip_marks(session_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(word: &str, at_seconds: f64) -> TimedWord {
        TimedWord {
            word: word.to_string(),
            at_seconds,
        }
    }

    fn segment(text: &str, start_second: f64) -> CaptionSegment {
        CaptionSegment {
            text: text.to_string(),
            start_second,
            end_second: start_second + 0.5,
        }
    }

    #[test]
    fn words_normalize_case_and_punctuation() {
        assert_eq!(normalize_word("That's,"), Some("thats".to_string()));
        assert_eq!(normalize_word("CLIP!"), Some("clip".to_string()));
        assert_eq!(normalize_word("…"), None);
    }

    #[test]
    fn phrase_table() {
        let cases: &[(&str, Option<&str>)] = &[
            ("okay clip that", Some("clip that")),
            ("Clip it.", Some("clip it")),
            ("please clip this one", Some("clip this")),
            ("That's a clip!", Some("thats a clip")),
            ("thats a clip", Some("thats a clip")),
            ("we should make a clip of that", Some("make a clip")),
            ("look at the eclipse that was cool", None),
            ("copy it to the clipboard that helps", None),
            ("I clipped it yesterday", None),
            ("a clip of that", None),
            ("", None),
        ];
        for (text, expected) in cases {
            let found = find_clip_phrase(&[], &timed_words(text, &[], 100.0));
            assert_eq!(
                found.as_ref().map(|found| found.phrase.as_str()),
                *expected,
                "text: {text:?}"
            );
        }
    }

    #[test]
    fn mark_time_is_the_first_word_of_the_phrase() {
        let segments = [
            segment("okay so", 0.2),
            segment("clip", 1.4),
            segment("that", 1.9),
        ];
        let words = timed_words("okay so clip that", &segments, 120.0);
        let found = find_clip_phrase(&[], &words).expect("phrase");
        assert_eq!(found.at_seconds, 121.4);

        let without_segments = timed_words("okay so clip that", &[], 120.0);
        let found = find_clip_phrase(&[], &without_segments).expect("phrase");
        assert_eq!(found.at_seconds, 120.0);
    }

    #[test]
    fn a_phrase_split_across_finals_matches_once_at_the_first_word() {
        let mut detector = ClipMarkDetector::default();
        assert!(
            detector
                .note_final("and that was great, clip", &[segment("clip", 2.5)], 30.0)
                .is_none()
        );
        let found = detector
            .note_final("that for me", &[segment("that", 0.1)], 33.0)
            .expect("boundary match");
        assert_eq!(found.phrase, "clip that");
        assert_eq!(found.at_seconds, 32.5);
        // The tail alone never matches again on the next silent final.
        assert!(detector.note_final("okay", &[], 36.0).is_none());
    }

    #[test]
    fn a_stale_tail_does_not_complete_a_phrase() {
        let mut detector = ClipMarkDetector::default();
        assert!(detector.note_final("clip", &[], 30.0).is_none());
        // Ten seconds of other finals later, "that" is a new sentence.
        assert!(detector.note_final("that", &[], 40.0).is_none());
        // And a tail from a previous session (file time restarted) is dropped.
        let mut detector = ClipMarkDetector::default();
        assert!(detector.note_final("clip", &[], 3000.0).is_none());
        assert!(detector.note_final("that", &[], 1.0).is_none());
    }

    #[test]
    fn repeats_within_ten_seconds_dedupe_against_voice_and_manual_marks() {
        let mut detector = ClipMarkDetector::default();
        assert!(detector.note_final("clip that", &[], 100.0).is_some());
        assert!(detector.note_final("clip that", &[], 105.0).is_none());
        assert!(detector.note_final("clip that", &[], 110.0).is_some());
        detector.note_manual_mark(200.0);
        assert!(detector.note_final("clip it", &[], 209.0).is_none());
        assert!(detector.note_final("clip it", &[], 210.5).is_some());
        // A new session restarts file time: an earlier time is a new mark.
        assert!(detector.note_final("clip this", &[], 4.0).is_some());
    }

    #[test]
    fn tail_words_keep_their_times() {
        assert_eq!(
            find_clip_phrase(&[word("make", 9.0), word("a", 9.3)], &[word("clip", 12.0)]),
            Some(PhraseMatch {
                phrase: "make a clip".to_string(),
                at_seconds: 9.0
            })
        );
        // A phrase entirely inside the tail was already reported.
        assert!(
            find_clip_phrase(&[word("clip", 1.0), word("that", 1.5)], &[word("ok", 2.0)]).is_none()
        );
    }
}
