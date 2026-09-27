//! macOS system audio capture through ScreenCaptureKit (plan 069).
//!
//! S0 (this file today) holds the pure helpers the spike proved, plus the
//! debug-only spike itself: an `#[ignore]`d test gated on
//! `VIDEORC_SYSTEM_AUDIO_SPIKE=1` that runs an audio-only SCStream and writes
//! a WAV plus a JSON measurement summary. S3 grows this module into the real
//! `ProducerSource::system` producer and promotes or deletes the spike.
//!
//! Evidence and numbers: `docs/acceptance/2026-09-27-system-audio-spike.md`.

use std::time::{Duration, Instant};

/// SCK is asked for 48 kHz stereo (`setSampleRate`, `setChannelCount`) and
/// delivered exactly that in S0; the bus consumes the same shape.
#[allow(dead_code)] // wired in S3
pub(crate) const SYSTEM_AUDIO_SAMPLE_RATE: u32 = 48_000;
#[allow(dead_code)] // wired in S3
pub(crate) const SYSTEM_AUDIO_CHANNELS: u16 = 2;

/// Bundle id of the packaged app (`apps/desktop/electron-builder.yml`
/// `appId`). Its helpers are `dev.theorcdev.videorc.helper[.GPU|.Plugin|
/// .Renderer]`.
#[allow(dead_code)] // wired in S3
pub(crate) const PACKAGED_VIDEORC_BUNDLE_ID: &str = "dev.theorcdev.videorc";
/// Bundle id of the unpackaged Electron used by `pnpm dev`. Its helpers are
/// all `com.github.Electron.helper`. Only exclude it when the backend's own
/// parent is that dev Electron, or an unrelated Electron dev app goes mute.
#[allow(dead_code)] // wired in S3
pub(crate) const DEV_ELECTRON_BUNDLE_ID: &str = "com.github.Electron";

// AudioStreamBasicDescription constants (CoreAudioBaseTypes.h). Kept local so
// the conversion helpers stay pure and testable without CoreAudio.
#[allow(dead_code)] // wired in S3
const AUDIO_FORMAT_LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
#[allow(dead_code)] // wired in S3
const AUDIO_FORMAT_FLAG_IS_FLOAT: u32 = 1 << 0;
#[allow(dead_code)] // wired in S3
const AUDIO_FORMAT_FLAG_IS_BIG_ENDIAN: u32 = 1 << 1;
#[allow(dead_code)] // wired in S3
const AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER: u32 = 1 << 2;
#[allow(dead_code)] // wired in S3
const AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED: u32 = 1 << 5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // wired in S3
pub(crate) enum PcmSampleKind {
    F32,
    I16,
    I32,
}

impl PcmSampleKind {
    #[allow(dead_code)] // wired in S3
    fn bytes(self) -> usize {
        match self {
            Self::F32 | Self::I32 => 4,
            Self::I16 => 2,
        }
    }
}

/// The PCM shape of one ScreenCaptureKit audio sample buffer, taken from its
/// `AudioStreamBasicDescription`.
#[derive(Debug, Clone, Copy, PartialEq)]
#[allow(dead_code)] // wired in S3
pub(crate) struct PcmLayout {
    pub(crate) sample_rate: f64,
    pub(crate) channels: u32,
    pub(crate) kind: PcmSampleKind,
    /// `kAudioFormatFlagIsNonInterleaved`: one AudioBuffer per channel.
    pub(crate) planar: bool,
}

/// Classifies an `AudioStreamBasicDescription`. S0 measured SCK delivering
/// `lpcm`, flags `0x29` (float | packed | non-interleaved), 32 bits, 2
/// channels, 48000 Hz; other linear PCM shapes are accepted defensively.
#[allow(dead_code)] // wired in S3
pub(crate) fn pcm_layout_from_stream_description(
    format_id: u32,
    format_flags: u32,
    bits_per_channel: u32,
    channels: u32,
    sample_rate: f64,
) -> Result<PcmLayout, String> {
    if format_id != AUDIO_FORMAT_LINEAR_PCM {
        return Err(format!(
            "system audio format {} is not linear PCM",
            four_char_code(format_id)
        ));
    }
    if format_flags & AUDIO_FORMAT_FLAG_IS_BIG_ENDIAN != 0 {
        return Err("system audio is big-endian PCM".to_string());
    }
    if channels == 0 {
        return Err("system audio reports zero channels".to_string());
    }
    if !(sample_rate.is_finite() && sample_rate > 0.0) {
        return Err(format!("system audio sample rate {sample_rate} is invalid"));
    }
    let is_float = format_flags & AUDIO_FORMAT_FLAG_IS_FLOAT != 0;
    let is_signed = format_flags & AUDIO_FORMAT_FLAG_IS_SIGNED_INTEGER != 0;
    let kind = match (is_float, is_signed, bits_per_channel) {
        (true, _, 32) => PcmSampleKind::F32,
        (false, true, 16) => PcmSampleKind::I16,
        (false, true, 32) => PcmSampleKind::I32,
        _ => {
            return Err(format!(
                "unsupported system audio PCM: flags {format_flags:#x}, {bits_per_channel} bits"
            ));
        }
    };
    Ok(PcmLayout {
        sample_rate,
        channels,
        kind,
        planar: format_flags & AUDIO_FORMAT_FLAG_IS_NON_INTERLEAVED != 0,
    })
}

/// Converts the AudioBuffers of one sample buffer (one per channel when
/// planar, one interleaved buffer otherwise) into interleaved stereo f32 at
/// the source rate. Mono is duplicated to both sides, channels past the
/// second are dropped. A rate other than 48 kHz is rejected: S0 never saw
/// one, so S3 resamples only if a real device ever proves it necessary.
#[allow(dead_code)] // wired in S3
pub(crate) fn interleaved_stereo_f32(
    layout: &PcmLayout,
    buffers: &[&[u8]],
) -> Result<Vec<f32>, String> {
    if (layout.sample_rate - f64::from(SYSTEM_AUDIO_SAMPLE_RATE)).abs() > 0.5 {
        return Err(format!(
            "system audio arrived at {} Hz, expected {SYSTEM_AUDIO_SAMPLE_RATE}",
            layout.sample_rate
        ));
    }
    let channels = layout.channels as usize;
    let sample_bytes = layout.kind.bytes();
    let (frames, sample_at): (usize, Box<dyn Fn(usize, usize) -> f32 + '_>) = if layout.planar {
        if buffers.len() < channels {
            return Err(format!(
                "planar system audio has {} buffers for {channels} channels",
                buffers.len()
            ));
        }
        let frames = buffers[..channels]
            .iter()
            .map(|buffer| buffer.len() / sample_bytes)
            .min()
            .unwrap_or(0);
        let kind = layout.kind;
        (
            frames,
            Box::new(move |frame, channel| {
                decode_sample(kind, &buffers[channel][frame * sample_bytes..])
            }),
        )
    } else {
        let Some(buffer) = buffers.first() else {
            return Err("interleaved system audio has no buffer".to_string());
        };
        let frame_bytes = sample_bytes * channels;
        let kind = layout.kind;
        (
            buffer.len() / frame_bytes,
            Box::new(move |frame, channel| {
                decode_sample(
                    kind,
                    &buffer[frame * frame_bytes + channel * sample_bytes..],
                )
            }),
        )
    };
    let right_channel = if channels >= 2 { 1 } else { 0 };
    let mut output = Vec::with_capacity(frames * 2);
    for frame in 0..frames {
        output.push(sample_at(frame, 0));
        output.push(sample_at(frame, right_channel));
    }
    Ok(output)
}

#[allow(dead_code)] // wired in S3
fn decode_sample(kind: PcmSampleKind, bytes: &[u8]) -> f32 {
    match kind {
        PcmSampleKind::F32 => f32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]),
        PcmSampleKind::I16 => f32::from(i16::from_ne_bytes([bytes[0], bytes[1]])) / 32_768.0,
        PcmSampleKind::I32 => {
            i32::from_ne_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) as f32 / 2_147_483_648.0
        }
    }
}

#[allow(dead_code)] // wired in S3
fn four_char_code(code: u32) -> String {
    let bytes = code.to_be_bytes();
    if bytes.iter().all(|byte| byte.is_ascii_graphic()) {
        String::from_utf8_lossy(&bytes).into_owned()
    } else {
        format!("{code:#x}")
    }
}

/// `mach_timebase_info` ratio. Apple Silicon reports 125/3 (24 MHz ticks);
/// Intel reports 1/1.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // wired in S3
pub(crate) struct MachTimebase {
    pub(crate) numer: u32,
    pub(crate) denom: u32,
}

impl MachTimebase {
    #[allow(dead_code)] // wired in S3
    pub(crate) fn ticks_to_nanos(self, ticks: u64) -> u64 {
        if self.denom == 0 {
            return ticks;
        }
        let nanos = u128::from(ticks) * u128::from(self.numer) / u128::from(self.denom);
        u64::try_from(nanos).unwrap_or(u64::MAX)
    }
}

/// Host-clock nanoseconds for a CMSampleBuffer PTS. SCK stamps audio and
/// screen buffers on the CoreMedia host time clock (`CMClockGetHostTimeClock`),
/// whose seconds are `mach_absolute_time` converted through the timebase. S0
/// measured both audio and screen PTS at timescale 1_000_000_000.
/// Returns `None` for an invalid or non-positive time.
#[allow(dead_code)] // wired in S3
pub(crate) fn cm_time_to_host_nanos(value: i64, timescale: i32, valid: bool) -> Option<u64> {
    if !valid || timescale <= 0 || value < 0 {
        return None;
    }
    let nanos = i128::from(value) * 1_000_000_000 / i128::from(timescale);
    u64::try_from(nanos).ok()
}

/// One simultaneous reading of the host clock and `Instant`. On macOS
/// `Instant` is `CLOCK_UPTIME_RAW`, the same counter as `mach_absolute_time`,
/// so the offset between them is constant and one anchor per stream is
/// enough; the anchor only has to be read with a small bracket.
#[derive(Debug, Clone, Copy)]
#[allow(dead_code)] // wired in S3
pub(crate) struct HostClockAnchor {
    pub(crate) host_nanos: u64,
    pub(crate) instant: Instant,
}

impl HostClockAnchor {
    /// The `Instant` at which the host clock read `host_nanos`.
    #[allow(dead_code)] // wired in S3
    pub(crate) fn instant_for_host_nanos(&self, host_nanos: u64) -> Instant {
        if host_nanos >= self.host_nanos {
            self.instant + Duration::from_nanos(host_nanos - self.host_nanos)
        } else {
            let back = Duration::from_nanos(self.host_nanos - host_nanos);
            self.instant.checked_sub(back).unwrap_or(self.instant)
        }
    }

    /// `AudioFrame::captured_at` for a buffer: the bus treats `captured_at`
    /// as the END of the frame (`trim_audio_frame_before_epoch`), so this is
    /// PTS (first sample) plus the buffer duration.
    #[allow(dead_code)] // wired in S3
    pub(crate) fn buffer_end_instant(
        &self,
        pts_host_nanos: u64,
        frames: usize,
        sample_rate: u32,
    ) -> Instant {
        let duration_nanos = if sample_rate == 0 {
            0
        } else {
            (frames as u64).saturating_mul(1_000_000_000) / u64::from(sample_rate)
        };
        self.instant_for_host_nanos(pts_host_nanos.saturating_add(duration_nanos))
    }
}

#[cfg(target_os = "macos")]
mod host_clock {
    use super::{HostClockAnchor, MachTimebase};
    use std::time::{Duration, Instant};

    #[repr(C)]
    struct Timebase {
        numer: u32,
        denom: u32,
    }

    unsafe extern "C" {
        fn mach_timebase_info(info: *mut Timebase) -> i32;
        fn mach_absolute_time() -> u64;
    }

    #[allow(dead_code)] // wired in S3
    pub(crate) fn timebase() -> Option<MachTimebase> {
        let mut info = Timebase { numer: 0, denom: 0 };
        let status = unsafe { mach_timebase_info(&mut info) };
        (status == 0 && info.denom != 0).then_some(MachTimebase {
            numer: info.numer,
            denom: info.denom,
        })
    }

    #[allow(dead_code)] // wired in S3
    pub(crate) fn host_nanos_now(timebase: MachTimebase) -> u64 {
        timebase.ticks_to_nanos(unsafe { mach_absolute_time() })
    }

    /// Reads an anchor with the host read bracketed by two `Instant`s,
    /// retrying until the bracket is under 50 µs.
    #[allow(dead_code)] // wired in S3
    pub(crate) fn sample_anchor(timebase: MachTimebase) -> (HostClockAnchor, Duration) {
        let mut best: Option<(HostClockAnchor, Duration)> = None;
        for _ in 0..5 {
            let before = Instant::now();
            let host_nanos = host_nanos_now(timebase);
            let after = Instant::now();
            let bracket = after.duration_since(before);
            let anchor = HostClockAnchor {
                host_nanos,
                instant: before + bracket / 2,
            };
            if best.is_none_or(|(_, previous)| bracket < previous) {
                best = Some((anchor, bracket));
            }
            if bracket <= Duration::from_micros(50) {
                break;
            }
        }
        best.expect("at least one anchor sample")
    }
}

/// True when `bundle_id` is `prefix` or one of its dotted children:
/// `dev.theorcdev.videorc` matches itself and `dev.theorcdev.videorc.helper.GPU`
/// but not `dev.theorcdev.videorcweb`.
#[allow(dead_code)] // wired in S3
pub(crate) fn bundle_id_matches_prefix(bundle_id: &str, prefix: &str) -> bool {
    if prefix.is_empty() {
        return false;
    }
    bundle_id == prefix
        || bundle_id
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('.'))
}

/// Prefixes whose applications the system-audio filter must exclude: always
/// the packaged id, plus the bundle id of the app that launched the backend
/// (its Electron main process) when that is known and different. In `pnpm
/// dev` that is `com.github.Electron`.
#[allow(dead_code)] // wired in S3
pub(crate) fn videorc_exclusion_prefixes(host_app_bundle_id: Option<&str>) -> Vec<String> {
    let mut prefixes = vec![PACKAGED_VIDEORC_BUNDLE_ID.to_string()];
    if let Some(host) = host_app_bundle_id
        .map(str::trim)
        .filter(|id| !id.is_empty())
        && !prefixes
            .iter()
            .any(|prefix| bundle_id_matches_prefix(host, prefix))
    {
        prefixes.push(host.to_string());
    }
    prefixes
}

/// Indices of the running applications to pass to
/// `initWithDisplay:excludingApplications:exceptingWindows:`: every app whose
/// bundle id matches one of `prefixes`, or whose pid is in `pids` (the
/// Electron main pid, for hosts without a bundle id).
///
/// S0 proved app exclusion only silences audio the excluded app's OWN
/// process plays. Chromium's default out-of-process audio service (a
/// `.helper` utility process that SCK does not list) escapes it, so this
/// list is only sufficient while Electron runs with
/// `--disable-features=AudioServiceOutOfProcess` (renderer audio then plays
/// from the main process).
#[allow(dead_code)] // wired in S3
pub(crate) fn excluded_application_indices<'a>(
    applications: impl IntoIterator<Item = (&'a str, i32)>,
    prefixes: &[String],
    pids: &[i32],
) -> Vec<usize> {
    applications
        .into_iter()
        .enumerate()
        .filter(|(_, (bundle_id, pid))| {
            pids.contains(pid)
                || prefixes
                    .iter()
                    .any(|prefix| bundle_id_matches_prefix(bundle_id, prefix))
        })
        .map(|(index, _)| index)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f32_bytes(samples: &[f32]) -> Vec<u8> {
        samples.iter().flat_map(|s| s.to_ne_bytes()).collect()
    }

    #[test]
    fn system_audio_layout_accepts_the_shape_sck_delivered_in_s0() {
        // lpcm, flags 0x29 = float | packed | non-interleaved, 32 bits.
        let layout =
            pcm_layout_from_stream_description(u32::from_be_bytes(*b"lpcm"), 0x29, 32, 2, 48_000.0)
                .expect("SCK's float planar stereo is supported");
        assert_eq!(
            layout,
            PcmLayout {
                sample_rate: 48_000.0,
                channels: 2,
                kind: PcmSampleKind::F32,
                planar: true,
            }
        );
    }

    #[test]
    fn system_audio_layout_classifies_integer_and_rejects_others() {
        let lpcm = u32::from_be_bytes(*b"lpcm");
        let i16_layout = pcm_layout_from_stream_description(lpcm, 0x0c, 16, 2, 48_000.0)
            .expect("signed 16-bit interleaved");
        assert_eq!(i16_layout.kind, PcmSampleKind::I16);
        assert!(!i16_layout.planar);
        assert_eq!(
            pcm_layout_from_stream_description(lpcm, 0x0c, 32, 1, 48_000.0)
                .expect("signed 32-bit")
                .kind,
            PcmSampleKind::I32
        );
        assert!(
            pcm_layout_from_stream_description(u32::from_be_bytes(*b"aac "), 0, 0, 2, 48_000.0)
                .is_err()
        );
        assert!(pcm_layout_from_stream_description(lpcm, 0x0e, 16, 2, 48_000.0).is_err());
        assert!(pcm_layout_from_stream_description(lpcm, 0x08, 16, 2, 48_000.0).is_err());
        assert!(pcm_layout_from_stream_description(lpcm, 0x29, 32, 0, 48_000.0).is_err());
        assert!(pcm_layout_from_stream_description(lpcm, 0x29, 32, 2, 0.0).is_err());
    }

    #[test]
    fn system_audio_planar_float_interleaves_left_right() {
        let layout = PcmLayout {
            sample_rate: 48_000.0,
            channels: 2,
            kind: PcmSampleKind::F32,
            planar: true,
        };
        let left = f32_bytes(&[0.1, 0.2, 0.3]);
        let right = f32_bytes(&[-0.1, -0.2, -0.3]);
        let output = interleaved_stereo_f32(&layout, &[&left, &right]).expect("converts");
        assert_eq!(output, vec![0.1, -0.1, 0.2, -0.2, 0.3, -0.3]);
    }

    #[test]
    fn system_audio_mono_is_duplicated_and_extra_channels_dropped() {
        let mono = PcmLayout {
            sample_rate: 48_000.0,
            channels: 1,
            kind: PcmSampleKind::F32,
            planar: false,
        };
        let samples = f32_bytes(&[0.5, -0.25]);
        assert_eq!(
            interleaved_stereo_f32(&mono, &[&samples]).expect("mono"),
            vec![0.5, 0.5, -0.25, -0.25]
        );

        let quad = PcmLayout {
            sample_rate: 48_000.0,
            channels: 4,
            kind: PcmSampleKind::F32,
            planar: false,
        };
        let samples = f32_bytes(&[0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
        assert_eq!(
            interleaved_stereo_f32(&quad, &[&samples]).expect("quad"),
            vec![0.1, 0.2, 0.5, 0.6]
        );
    }

    #[test]
    fn system_audio_integer_samples_scale_to_unit_float() {
        let layout = PcmLayout {
            sample_rate: 48_000.0,
            channels: 2,
            kind: PcmSampleKind::I16,
            planar: false,
        };
        let bytes: Vec<u8> = [i16::MIN, i16::MAX, 0, 16_384]
            .iter()
            .flat_map(|s| s.to_ne_bytes())
            .collect();
        let output = interleaved_stereo_f32(&layout, &[&bytes]).expect("converts");
        assert_eq!(output[0], -1.0);
        assert!((output[1] - 1.0).abs() < 1.0e-4);
        assert_eq!(output[2], 0.0);
        assert_eq!(output[3], 0.5);
    }

    #[test]
    fn system_audio_rejects_other_rates_and_short_planar_lists() {
        let layout = PcmLayout {
            sample_rate: 44_100.0,
            channels: 2,
            kind: PcmSampleKind::F32,
            planar: true,
        };
        let left = f32_bytes(&[0.0]);
        assert!(interleaved_stereo_f32(&layout, &[&left, &left]).is_err());
        let layout = PcmLayout {
            sample_rate: 48_000.0,
            ..layout
        };
        assert!(interleaved_stereo_f32(&layout, &[&left]).is_err());
        assert!(interleaved_stereo_f32(&layout, &[]).is_err());
    }

    #[test]
    fn system_audio_host_time_conversions() {
        let apple_silicon = MachTimebase {
            numer: 125,
            denom: 3,
        };
        assert_eq!(apple_silicon.ticks_to_nanos(24_000_000), 1_000_000_000);
        assert_eq!(MachTimebase { numer: 1, denom: 1 }.ticks_to_nanos(42), 42);

        // S0 saw timescale 1e9 for audio and screen; other timescales convert too.
        assert_eq!(
            cm_time_to_host_nanos(48_000 * 3 + 24_000, 48_000, true),
            Some(3_500_000_000)
        );
        assert_eq!(
            cm_time_to_host_nanos(1_234_567_890, 1_000_000_000, true),
            Some(1_234_567_890)
        );
        assert_eq!(cm_time_to_host_nanos(10, 48_000, false), None);
        assert_eq!(cm_time_to_host_nanos(10, 0, true), None);
        assert_eq!(cm_time_to_host_nanos(-1, 48_000, true), None);
    }

    #[test]
    fn system_audio_anchor_maps_host_time_to_instant_both_directions() {
        let base = Instant::now() + Duration::from_secs(10);
        let anchor = HostClockAnchor {
            host_nanos: 5_000_000_000,
            instant: base,
        };
        assert_eq!(
            anchor.instant_for_host_nanos(5_250_000_000),
            base + Duration::from_millis(250)
        );
        assert_eq!(
            anchor.instant_for_host_nanos(4_900_000_000),
            base - Duration::from_millis(100)
        );
        // 480 frames at 48 kHz end 10 ms after the PTS of the first sample.
        assert_eq!(
            anchor.buffer_end_instant(5_000_000_000, 480, 48_000),
            base + Duration::from_millis(10)
        );
        assert_eq!(
            anchor.buffer_end_instant(5_000_000_000, 480, 0),
            base,
            "a zero rate never panics"
        );
    }

    #[test]
    fn system_audio_bundle_prefix_matches_only_dotted_children() {
        let prefix = PACKAGED_VIDEORC_BUNDLE_ID;
        assert!(bundle_id_matches_prefix("dev.theorcdev.videorc", prefix));
        assert!(bundle_id_matches_prefix(
            "dev.theorcdev.videorc.helper.Renderer",
            prefix
        ));
        assert!(!bundle_id_matches_prefix(
            "dev.theorcdev.videorcweb",
            prefix
        ));
        assert!(!bundle_id_matches_prefix("com.google.Chrome", prefix));
        assert!(!bundle_id_matches_prefix("anything", ""));
    }

    #[test]
    fn system_audio_exclusion_prefixes_add_the_dev_host_once() {
        assert_eq!(
            videorc_exclusion_prefixes(None),
            vec![PACKAGED_VIDEORC_BUNDLE_ID.to_string()]
        );
        assert_eq!(
            videorc_exclusion_prefixes(Some(DEV_ELECTRON_BUNDLE_ID)),
            vec![
                PACKAGED_VIDEORC_BUNDLE_ID.to_string(),
                DEV_ELECTRON_BUNDLE_ID.to_string()
            ]
        );
        assert_eq!(
            videorc_exclusion_prefixes(Some("dev.theorcdev.videorc")),
            vec![PACKAGED_VIDEORC_BUNDLE_ID.to_string()]
        );
        assert_eq!(
            videorc_exclusion_prefixes(Some("  ")),
            vec![PACKAGED_VIDEORC_BUNDLE_ID.to_string()]
        );
    }

    #[test]
    fn system_audio_exclusion_list_matches_the_s0_fixture() {
        // S0 saw SCShareableContent list only bundle MAIN processes (Chrome's
        // and Electron's `.helper` processes were absent). Helper ids stay in
        // the fixture so a macOS that does list them is still covered.
        let running = [
            ("com.apple.finder", 501),
            ("dev.theorcdev.videorc", 1000),
            ("dev.theorcdev.videorc.helper", 1001),
            ("dev.theorcdev.videorc.helper.Renderer", 1002),
            ("dev.theorcdev.videorc.helper.GPU", 1003),
            ("com.google.Chrome", 2000),
            ("com.google.Chrome.helper", 2001),
            ("com.github.Electron", 3000),
            ("com.github.Electron.helper", 3001),
            ("dev.theorcdev.videorcweb", 4000),
            ("", 5000),
        ];
        let packaged_only = videorc_exclusion_prefixes(None);
        assert_eq!(
            excluded_application_indices(running, &packaged_only, &[]),
            vec![1, 2, 3, 4]
        );
        let dev = videorc_exclusion_prefixes(Some(DEV_ELECTRON_BUNDLE_ID));
        assert_eq!(
            excluded_application_indices(running, &dev, &[5000]),
            vec![1, 2, 3, 4, 7, 8, 10]
        );
    }
}

/// The S0 spike: an audio-only SCStream that writes a WAV and a JSON summary.
///
/// Run: `VIDEORC_SYSTEM_AUDIO_SPIKE=1 cargo test -p videorc-backend
/// system_audio_spike -- --ignored --nocapture`. Knobs (all optional):
/// - `VIDEORC_SYSTEM_AUDIO_SPIKE_SECONDS` capture length (default 30)
/// - `VIDEORC_SYSTEM_AUDIO_SPIKE_DIR` output dir (default temp dir)
/// - `VIDEORC_SYSTEM_AUDIO_SPIKE_LABEL` output file stem (default `spike`)
/// - `VIDEORC_SYSTEM_AUDIO_SPIKE_EXCLUDE` comma-separated bundle-id prefixes
///   to exclude (default: packaged + dev Electron ids; `none` for no apps,
///   `all` for every listed application)
/// - `VIDEORC_SYSTEM_AUDIO_SPIKE_EXCLUDE_CURRENT_PROCESS=0` control run
/// - `VIDEORC_SYSTEM_AUDIO_SPIKE_SELF_TONE_AT=<s>` plays a 3 s 1 kHz tone
///   from inside the test process starting at `s` seconds
/// - `VIDEORC_SYSTEM_AUDIO_SPIKE_SCREEN=1` adds a SECOND SCStream with only a
///   Screen output (the product shape: separate streams) and pairs flash and
///   click onsets from the A/V sync stimulus to measure capture-level o_sys
#[cfg(all(test, target_os = "macos"))]
mod spike {
    use std::fs;
    use std::path::PathBuf;
    use std::ptr::{self, NonNull};
    use std::slice;
    use std::sync::{Arc, Mutex, mpsc};
    use std::thread;
    use std::time::{Duration, Instant};

    use block2::RcBlock;
    use dispatch2::DispatchQueue;
    use objc2::rc::{Retained, autoreleasepool};
    use objc2::runtime::ProtocolObject;
    use objc2::{AnyThread, DefinedClass, define_class, msg_send};
    use objc2_core_audio_types::{AudioBuffer, AudioBufferList};
    use objc2_core_foundation::CFRetained;
    use objc2_core_graphics::{CGMainDisplayID, CGPreflightScreenCaptureAccess};
    use objc2_core_media::{
        CMAudioFormatDescriptionGetStreamBasicDescription, CMBlockBuffer, CMSampleBuffer, CMTime,
        CMTimeFlags, kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
    };
    use objc2_core_video::{
        CVPixelBufferGetBaseAddress, CVPixelBufferGetBytesPerRow, CVPixelBufferGetHeight,
        CVPixelBufferGetWidth, CVPixelBufferLockBaseAddress, CVPixelBufferLockFlags,
        CVPixelBufferUnlockBaseAddress, kCVPixelFormatType_32BGRA,
    };
    use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
    use objc2_screen_capture_kit::{
        SCContentFilter, SCRunningApplication, SCShareableContent, SCStream, SCStreamConfiguration,
        SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
    };
    use serde_json::json;

    use super::host_clock;
    use super::*;

    unsafe extern "C-unwind" {
        // CoreMedia (already linked through objc2-core-media). Declared here
        // because the crate's `CMSync` feature is off; used only to cross-check
        // `cm_time_to_host_nanos` against Apple's own conversion.
        fn CMClockConvertHostTimeToSystemUnits(host_time: CMTime) -> u64;
    }

    #[derive(Default)]
    struct AudioBufferRecord {
        pts_nanos: u64,
        pts_value: i64,
        pts_timescale: i32,
        arrival_host_nanos: u64,
        pts_ticks_nanos: u64,
        frames: usize,
        peak: f32,
        first_sample_index: usize,
    }

    struct ScreenFrameRecord {
        pts_nanos: u64,
        arrival_host_nanos: u64,
        luma: f32,
    }

    #[derive(Default)]
    struct SpikeState {
        audio_buffers: Vec<AudioBufferRecord>,
        samples: Vec<f32>,
        format: Option<serde_json::Value>,
        format_errors: Vec<String>,
        screen_frames: Vec<ScreenFrameRecord>,
        unexpected_output_types: Vec<isize>,
        stop_errors: Vec<String>,
    }

    struct SpikeIvars {
        state: Arc<Mutex<SpikeState>>,
        timebase: MachTimebase,
    }

    define_class!(
        #[unsafe(super(NSObject))]
        #[thread_kind = AnyThread]
        #[name = "VideorcSystemAudioSpikeDelegate"]
        #[ivars = SpikeIvars]
        struct SpikeDelegate;

        unsafe impl NSObjectProtocol for SpikeDelegate {}

        #[allow(non_snake_case)]
        unsafe impl SCStreamOutput for SpikeDelegate {
            #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
            unsafe fn stream_didOutputSampleBuffer_ofType(
                &self,
                _stream: &SCStream,
                sample_buffer: &CMSampleBuffer,
                output_type: SCStreamOutputType,
            ) {
                let arrival = host_clock::host_nanos_now(self.ivars().timebase);
                let mut state = self
                    .ivars()
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                if output_type == SCStreamOutputType::Audio {
                    record_audio(sample_buffer, arrival, &mut state);
                } else if output_type == SCStreamOutputType::Screen {
                    record_screen(sample_buffer, arrival, &mut state);
                } else {
                    state.unexpected_output_types.push(output_type.0);
                }
            }
        }

        #[allow(non_snake_case)]
        unsafe impl SCStreamDelegate for SpikeDelegate {
            #[unsafe(method(stream:didStopWithError:))]
            unsafe fn stream_didStopWithError(&self, _stream: &SCStream, error: &NSError) {
                let mut state = self
                    .ivars()
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                state.stop_errors.push(format!(
                    "{} ({})",
                    error.localizedDescription(),
                    error.code()
                ));
            }
        }
    );

    impl SpikeDelegate {
        fn new(state: Arc<Mutex<SpikeState>>, timebase: MachTimebase) -> Retained<Self> {
            let delegate = Self::alloc().set_ivars(SpikeIvars { state, timebase });
            unsafe { msg_send![super(delegate), init] }
        }
    }

    fn cm_time_nanos(time: CMTime) -> Option<u64> {
        cm_time_to_host_nanos(
            time.value,
            time.timescale,
            time.flags.contains(CMTimeFlags::Valid),
        )
    }

    fn record_audio(sample_buffer: &CMSampleBuffer, arrival: u64, state: &mut SpikeState) {
        let pts = unsafe { sample_buffer.presentation_time_stamp() };
        let Some(pts_nanos) = cm_time_nanos(pts) else {
            state
                .format_errors
                .push("audio buffer without a valid PTS".into());
            return;
        };
        let pts_ticks_nanos = host_clock::timebase()
            .map(|tb| tb.ticks_to_nanos(unsafe { CMClockConvertHostTimeToSystemUnits(pts) }))
            .unwrap_or(0);
        let Some(description) = (unsafe { sample_buffer.format_description() }) else {
            state
                .format_errors
                .push("audio buffer without a format".into());
            return;
        };
        let asbd = unsafe { CMAudioFormatDescriptionGetStreamBasicDescription(&description) };
        let Some(asbd) = (unsafe { asbd.as_ref() }) else {
            state
                .format_errors
                .push("audio format without an ASBD".into());
            return;
        };
        let layout = match pcm_layout_from_stream_description(
            asbd.mFormatID,
            asbd.mFormatFlags,
            asbd.mBitsPerChannel,
            asbd.mChannelsPerFrame,
            asbd.mSampleRate,
        ) {
            Ok(layout) => layout,
            Err(error) => {
                state.format_errors.push(error);
                return;
            }
        };

        let mut size_needed = 0usize;
        let status = unsafe {
            sample_buffer.audio_buffer_list_with_retained_block_buffer(
                &mut size_needed,
                ptr::null_mut(),
                0,
                None,
                None,
                0,
                ptr::null_mut(),
            )
        };
        if status != 0 || size_needed == 0 {
            state
                .format_errors
                .push(format!("buffer list size query failed: {status}"));
            return;
        }
        // u64 backing keeps the AudioBufferList pointer-aligned.
        let mut storage = vec![0u64; size_needed.div_ceil(8)];
        let list = storage.as_mut_ptr().cast::<AudioBufferList>();
        let mut block: *mut CMBlockBuffer = ptr::null_mut();
        let status = unsafe {
            sample_buffer.audio_buffer_list_with_retained_block_buffer(
                ptr::null_mut(),
                list,
                size_needed,
                None,
                None,
                kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
                &mut block,
            )
        };
        // Owns the retained block buffer for the rest of this call.
        let _block = NonNull::new(block).map(|raw| unsafe { CFRetained::from_raw(raw) });
        if status != 0 {
            state
                .format_errors
                .push(format!("buffer list read failed: {status}"));
            return;
        }
        let buffer_count = unsafe { (*list).mNumberBuffers } as usize;
        let audio_buffers: &[AudioBuffer] = unsafe {
            slice::from_raw_parts(
                ptr::addr_of!((*list).mBuffers).cast::<AudioBuffer>(),
                buffer_count,
            )
        };
        let byte_slices: Vec<&[u8]> = audio_buffers
            .iter()
            .map(|buffer| {
                if buffer.mData.is_null() {
                    &[][..]
                } else {
                    unsafe {
                        slice::from_raw_parts(
                            buffer.mData.cast::<u8>(),
                            buffer.mDataByteSize as usize,
                        )
                    }
                }
            })
            .collect();

        if state.format.is_none() {
            state.format = Some(json!({
                "formatId": four_char_code(asbd.mFormatID),
                "formatFlags": format!("{:#x}", asbd.mFormatFlags),
                "sampleRate": asbd.mSampleRate,
                "channelsPerFrame": asbd.mChannelsPerFrame,
                "bitsPerChannel": asbd.mBitsPerChannel,
                "bytesPerFrame": asbd.mBytesPerFrame,
                "bytesPerPacket": asbd.mBytesPerPacket,
                "framesPerPacket": asbd.mFramesPerPacket,
                "audioBufferCount": buffer_count,
                "channelsPerAudioBuffer": audio_buffers.iter().map(|b| b.mNumberChannels).collect::<Vec<_>>(),
                "layout": format!("{layout:?}"),
                "numSamples": unsafe { sample_buffer.num_samples() },
                "ptsTimescale": pts.timescale,
            }));
        }

        match interleaved_stereo_f32(&layout, &byte_slices) {
            Ok(samples) => {
                let peak = samples.iter().fold(0.0f32, |peak, s| peak.max(s.abs()));
                let first_sample_index = state.samples.len() / 2;
                state.audio_buffers.push(AudioBufferRecord {
                    pts_nanos,
                    pts_value: pts.value,
                    pts_timescale: pts.timescale,
                    arrival_host_nanos: arrival,
                    pts_ticks_nanos,
                    frames: samples.len() / 2,
                    peak,
                    first_sample_index,
                });
                state.samples.extend_from_slice(&samples);
            }
            Err(error) => state.format_errors.push(error),
        }
    }

    fn record_screen(sample_buffer: &CMSampleBuffer, arrival: u64, state: &mut SpikeState) {
        let Some(pts_nanos) = cm_time_nanos(unsafe { sample_buffer.presentation_time_stamp() })
        else {
            return;
        };
        // Idle/blank frames carry no image buffer; only complete frames count.
        let Some(pixel_buffer) = (unsafe { sample_buffer.image_buffer() }) else {
            return;
        };
        let lock = unsafe {
            CVPixelBufferLockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly)
        };
        if lock != 0 {
            return;
        }
        let width = CVPixelBufferGetWidth(&pixel_buffer);
        let height = CVPixelBufferGetHeight(&pixel_buffer);
        let stride = CVPixelBufferGetBytesPerRow(&pixel_buffer);
        let base = CVPixelBufferGetBaseAddress(&pixel_buffer).cast::<u8>();
        let mut sum = 0.0f64;
        let mut count = 0usize;
        if !base.is_null() {
            let bytes = unsafe { slice::from_raw_parts(base, stride * height) };
            for y in (0..height).step_by(4) {
                for x in (0..width).step_by(4) {
                    let offset = y * stride + x * 4;
                    let (b, g, r) = (bytes[offset], bytes[offset + 1], bytes[offset + 2]);
                    sum += 0.0722 * f64::from(b) + 0.7152 * f64::from(g) + 0.2126 * f64::from(r);
                    count += 1;
                }
            }
        }
        unsafe {
            CVPixelBufferUnlockBaseAddress(&pixel_buffer, CVPixelBufferLockFlags::ReadOnly);
        }
        if count > 0 {
            state.screen_frames.push(ScreenFrameRecord {
                pts_nanos,
                arrival_host_nanos: arrival,
                luma: (sum / count as f64) as f32,
            });
        }
    }

    struct SendContent(Retained<SCShareableContent>);
    // SAFETY: the retained SCShareableContent is only moved from the
    // completion-handler thread to the waiting test thread, never shared.
    unsafe impl Send for SendContent {}

    fn shareable_content() -> Result<Retained<SCShareableContent>, String> {
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(
            move |content: *mut SCShareableContent, error: *mut NSError| {
                let result = if let Some(error) = unsafe { error.as_ref() } {
                    Err(format!(
                        "{} ({})",
                        error.localizedDescription(),
                        error.code()
                    ))
                } else {
                    unsafe { Retained::retain(content) }
                        .map(SendContent)
                        .ok_or_else(|| "no shareable content".to_string())
                };
                let _ = tx.send(result);
            },
        );
        // All apps, not only on-screen ones: background helpers must be
        // visible to the exclusion builder.
        unsafe {
            SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(
                false, false, &handler,
            );
        }
        rx.recv_timeout(Duration::from_secs(5))
            .map_err(|_| "shareable content timed out".to_string())?
            .map(|content| content.0)
    }

    fn start(stream: &SCStream) -> Result<Duration, String> {
        let (tx, rx) = mpsc::channel();
        let started = Instant::now();
        let handler = RcBlock::new(move |error: *mut NSError| {
            let result = match unsafe { error.as_ref() } {
                Some(error) => Err(format!(
                    "{} (domain {}, code {})",
                    error.localizedDescription(),
                    error.domain(),
                    error.code()
                )),
                None => Ok(()),
            };
            let _ = tx.send(result);
        });
        unsafe { stream.startCaptureWithCompletionHandler(Some(&handler)) };
        rx.recv_timeout(Duration::from_secs(10))
            .map_err(|_| "start timed out".to_string())??;
        Ok(started.elapsed())
    }

    fn stop(stream: &SCStream) {
        let (tx, rx) = mpsc::channel();
        let handler = RcBlock::new(move |_error: *mut NSError| {
            let _ = tx.send(());
        });
        unsafe { stream.stopCaptureWithCompletionHandler(Some(&handler)) };
        let _ = rx.recv_timeout(Duration::from_secs(3));
    }

    fn env_flag(name: &str) -> Option<String> {
        std::env::var(name).ok().filter(|value| !value.is_empty())
    }

    /// Plays a 1 kHz sine from THIS process through the default output, to
    /// prove `excludesCurrentProcessAudio`.
    fn play_self_tone(seconds: f64) -> coreaudio::audio_unit::AudioUnit {
        use coreaudio::audio_unit::render_callback::{self, data};
        use coreaudio::audio_unit::{AudioUnit, IOType};
        let mut unit = AudioUnit::new(IOType::DefaultOutput).expect("default output unit");
        let rate = unit
            .output_stream_format()
            .expect("output format")
            .sample_rate;
        let total = (seconds * rate) as u64;
        let mut index = 0u64;
        type Args = render_callback::Args<data::NonInterleaved<f32>>;
        unit.set_render_callback(move |args: Args| {
            let Args {
                num_frames,
                mut data,
                ..
            } = args;
            for frame in 0..num_frames {
                let value = if index < total {
                    (0.3 * (2.0 * std::f64::consts::PI * 1000.0 * index as f64 / rate).sin()) as f32
                } else {
                    0.0
                };
                index += 1;
                for channel in data.channels_mut() {
                    channel[frame] = value;
                }
            }
            Ok(())
        })
        .expect("render callback");
        unit.start().expect("start self tone");
        unit
    }

    fn write_wav_f32(path: &PathBuf, samples: &[f32], rate: u32, channels: u16) {
        let data_bytes = (samples.len() * 4) as u32;
        let mut out = Vec::with_capacity(44 + data_bytes as usize);
        out.extend_from_slice(b"RIFF");
        out.extend_from_slice(&(36 + data_bytes).to_le_bytes());
        out.extend_from_slice(b"WAVEfmt ");
        out.extend_from_slice(&16u32.to_le_bytes());
        out.extend_from_slice(&3u16.to_le_bytes()); // IEEE float
        out.extend_from_slice(&channels.to_le_bytes());
        out.extend_from_slice(&rate.to_le_bytes());
        out.extend_from_slice(&(rate * u32::from(channels) * 4).to_le_bytes());
        out.extend_from_slice(&(channels * 4).to_le_bytes());
        out.extend_from_slice(&32u16.to_le_bytes());
        out.extend_from_slice(b"data");
        out.extend_from_slice(&data_bytes.to_le_bytes());
        for sample in samples {
            out.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(path, out).expect("write wav");
    }

    /// Rising-edge onsets with a 500 ms refractory period.
    fn onsets(points: impl Iterator<Item = (f64, f32)>, threshold: f32) -> Vec<f64> {
        let mut found: Vec<f64> = Vec::new();
        let mut above = false;
        for (time, value) in points {
            let is_above = value >= threshold;
            if is_above && !above && found.last().is_none_or(|last| time - last > 0.5) {
                found.push(time);
            }
            above = is_above;
        }
        found
    }

    /// Pairs each audio onset with the nearest video onset within 300 ms and
    /// returns `audio - video` in milliseconds.
    fn paired_offsets_ms(audio: &[f64], video: &[f64]) -> Vec<f64> {
        audio
            .iter()
            .filter_map(|a| {
                video
                    .iter()
                    .map(|v| a - v)
                    .filter(|delta| delta.abs() <= 0.3)
                    .min_by(|x, y| x.abs().total_cmp(&y.abs()))
                    .map(|delta| delta * 1000.0)
            })
            .collect()
    }

    fn stats(values: &[f64]) -> serde_json::Value {
        if values.is_empty() {
            return json!({ "count": 0 });
        }
        let mut sorted = values.to_vec();
        sorted.sort_by(f64::total_cmp);
        let mean = sorted.iter().sum::<f64>() / sorted.len() as f64;
        json!({
            "count": sorted.len(),
            "medianMs": sorted[sorted.len() / 2],
            "meanMs": mean,
            "minMs": sorted[0],
            "maxMs": sorted[sorted.len() - 1],
        })
    }

    fn analyze_sync(state: &SpikeState, origin: u64) -> serde_json::Value {
        let rate = f64::from(SYSTEM_AUDIO_SAMPLE_RATE);
        let seconds = |nanos: u64| (nanos as f64 - origin as f64) / 1.0e9;
        let audio_points = |use_arrival: bool| {
            state.audio_buffers.iter().flat_map(move |buffer| {
                (0..buffer.frames).map(move |frame| {
                    let index = (buffer.first_sample_index + frame) * 2;
                    let value = state.samples[index]
                        .abs()
                        .max(state.samples[index + 1].abs());
                    let time = if use_arrival {
                        seconds(buffer.arrival_host_nanos) - (buffer.frames - frame) as f64 / rate
                    } else {
                        seconds(buffer.pts_nanos) + frame as f64 / rate
                    };
                    (time, value)
                })
            })
        };
        let (min_luma, max_luma) = state
            .screen_frames
            .iter()
            .fold((f32::MAX, f32::MIN), |(lo, hi), f| {
                (lo.min(f.luma), hi.max(f.luma))
            });
        let luma_threshold = (min_luma + max_luma) / 2.0;
        let video_pts = onsets(
            state
                .screen_frames
                .iter()
                .map(|f| (seconds(f.pts_nanos), f.luma)),
            luma_threshold,
        );
        let video_arrival = onsets(
            state
                .screen_frames
                .iter()
                .map(|f| (seconds(f.arrival_host_nanos), f.luma)),
            luma_threshold,
        );
        let audio_pts = onsets(audio_points(false), 0.05);
        let audio_arrival = onsets(audio_points(true), 0.05);
        let screen_latency: Vec<f64> = state
            .screen_frames
            .iter()
            .map(|f| (f.arrival_host_nanos as f64 - f.pts_nanos as f64) / 1.0e6)
            .collect();
        let audio_latency: Vec<f64> = state
            .audio_buffers
            .iter()
            .map(|b| {
                (b.arrival_host_nanos as f64
                    - (b.pts_nanos as f64 + b.frames as f64 / rate * 1.0e9))
                    / 1.0e6
            })
            .collect();
        let screen_intervals: Vec<f64> = state
            .screen_frames
            .windows(2)
            .map(|w| (w[1].pts_nanos as f64 - w[0].pts_nanos as f64) / 1.0e6)
            .collect();
        json!({
            "lumaRange": [min_luma, max_luma],
            "videoOnsetsPts": video_pts.len(),
            "audioOnsetsPts": audio_pts.len(),
            "audioMinusVideoPts": stats(&paired_offsets_ms(&audio_pts, &video_pts)),
            "audioMinusVideoArrival": stats(&paired_offsets_ms(&audio_arrival, &video_arrival)),
            "audioMinusVideoAudioPtsVideoArrival": stats(&paired_offsets_ms(&audio_pts, &video_arrival)),
            "screenArrivalMinusPts": stats(&screen_latency),
            "screenPtsIntervals": stats(&screen_intervals),
            "audioArrivalMinusBufferEnd": stats(&audio_latency),
            "audioMinusVideoPtsSeries": paired_offsets_ms(&audio_pts, &video_pts),
        })
    }

    #[test]
    #[ignore = "local macOS spike: needs Screen Recording, set VIDEORC_SYSTEM_AUDIO_SPIKE=1"]
    fn system_audio_spike_capture() {
        if env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE").as_deref() != Some("1") {
            eprintln!("VIDEORC_SYSTEM_AUDIO_SPIKE != 1; skipping the ScreenCaptureKit spike");
            return;
        }
        autoreleasepool(|_| run_spike());
    }

    fn run_spike() {
        let seconds: f64 = env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE_SECONDS")
            .and_then(|value| value.parse().ok())
            .unwrap_or(30.0);
        let dir = env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| std::env::temp_dir().join("videorc-system-audio-spike"));
        let label = env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE_LABEL").unwrap_or_else(|| "spike".into());
        let exclude_current_process =
            env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE_EXCLUDE_CURRENT_PROCESS").as_deref() != Some("0");
        let with_screen = env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE_SCREEN").as_deref() == Some("1");
        let self_tone_at: Option<f64> = env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE_SELF_TONE_AT")
            .and_then(|value| value.parse().ok());
        let exclude_all = env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE_EXCLUDE").as_deref() == Some("all");
        let prefixes: Vec<String> = match env_flag("VIDEORC_SYSTEM_AUDIO_SPIKE_EXCLUDE") {
            Some(value) if value == "none" || value == "all" => Vec::new(),
            Some(value) => value
                .split(',')
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty())
                .collect(),
            None => videorc_exclusion_prefixes(Some(DEV_ELECTRON_BUNDLE_ID)),
        };
        fs::create_dir_all(&dir).expect("create spike dir");

        let preflight = CGPreflightScreenCaptureAccess();
        eprintln!("CGPreflightScreenCaptureAccess = {preflight}");
        assert!(
            preflight,
            "Screen Recording is not granted to the host app of {:?}",
            std::env::current_exe()
        );
        let timebase = host_clock::timebase().expect("mach timebase");
        let (anchor_start, anchor_bracket) = host_clock::sample_anchor(timebase);

        let content = shareable_content().expect("shareable content");
        let main_display_id = CGMainDisplayID();
        let displays = unsafe { content.displays() };
        let display = (0..displays.count())
            .map(|i| displays.objectAtIndex(i))
            .find(|d| unsafe { d.displayID() } == main_display_id)
            .expect("main display in shareable content");
        let applications = unsafe { content.applications() };
        let apps: Vec<(String, i32, String)> = (0..applications.count())
            .map(|i| {
                let app = applications.objectAtIndex(i);
                unsafe {
                    (
                        app.bundleIdentifier().to_string(),
                        app.processID(),
                        app.applicationName().to_string(),
                    )
                }
            })
            .collect();
        let excluded_indices = if exclude_all {
            (0..apps.len()).collect()
        } else {
            excluded_application_indices(
                apps.iter().map(|(id, pid, _)| (id.as_str(), *pid)),
                &prefixes,
                &[],
            )
        };
        let excluded_apps: Vec<Retained<SCRunningApplication>> = excluded_indices
            .iter()
            .map(|&i| applications.objectAtIndex(i))
            .collect();
        let excluded_report: Vec<_> = excluded_indices
            .iter()
            .map(|&i| json!({ "bundleId": apps[i].0, "pid": apps[i].1, "name": apps[i].2 }))
            .collect();
        eprintln!(
            "{} running applications listed; excluding {:?}",
            apps.len(),
            excluded_report
        );

        let filter = unsafe {
            SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &display,
                &NSArray::from_retained_slice(&excluded_apps),
                &NSArray::<SCWindow>::new(),
            )
        };
        let config = unsafe { SCStreamConfiguration::new() };
        unsafe {
            config.setWidth(2);
            config.setHeight(2);
            config.setMinimumFrameInterval(CMTime::new(1, 1));
            config.setQueueDepth(3);
            config.setShowsCursor(false);
            config.setCapturesAudio(true);
            config.setExcludesCurrentProcessAudio(exclude_current_process);
            config.setSampleRate(48_000);
            config.setChannelCount(2);
        }
        let state = Arc::new(Mutex::new(SpikeState::default()));
        let delegate = SpikeDelegate::new(Arc::clone(&state), timebase);
        let stream = unsafe {
            SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                Some(ProtocolObject::from_ref(&*delegate)),
            )
        };
        let audio_queue = DispatchQueue::new("com.videorc.system-audio.spike", None);
        unsafe {
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    ProtocolObject::from_ref(&*delegate),
                    SCStreamOutputType::Audio,
                    Some(&audio_queue),
                )
                .expect("add audio output");
        }

        // Optional second stream: screen only, the product shape, to pair
        // stimulus flashes with clicks on the shared host clock.
        let screen_queue = DispatchQueue::new("com.videorc.system-audio.spike.screen", None);
        let screen_stream = with_screen.then(|| {
            let filter = unsafe {
                SCContentFilter::initWithDisplay_excludingWindows(
                    SCContentFilter::alloc(),
                    &display,
                    &NSArray::<SCWindow>::new(),
                )
            };
            let config = unsafe { SCStreamConfiguration::new() };
            unsafe {
                config.setWidth(320);
                config.setHeight(180);
                config.setPixelFormat(kCVPixelFormatType_32BGRA);
                config.setMinimumFrameInterval(CMTime::new(1, 60));
                config.setQueueDepth(6);
                config.setShowsCursor(false);
                config.setCapturesAudio(false);
            }
            let stream = unsafe {
                SCStream::initWithFilter_configuration_delegate(
                    SCStream::alloc(),
                    &filter,
                    &config,
                    Some(ProtocolObject::from_ref(&*delegate)),
                )
            };
            unsafe {
                stream
                    .addStreamOutput_type_sampleHandlerQueue_error(
                        ProtocolObject::from_ref(&*delegate),
                        SCStreamOutputType::Screen,
                        Some(&screen_queue),
                    )
                    .expect("add screen output");
            }
            (stream, filter, config)
        });

        let start_requested_host = host_clock::host_nanos_now(timebase);
        let start_result = start(&stream);
        eprintln!("audio-only stream start: {start_result:?}");
        let start_latency = start_result.expect("audio-only SCStream starts");
        if let Some((screen, _, _)) = &screen_stream {
            start(screen).expect("screen SCStream starts");
        }

        let started_at = Instant::now();
        let mut self_tone = None;
        let mut self_tone_started_host = None;
        while started_at.elapsed().as_secs_f64() < seconds {
            if let Some(at) = self_tone_at
                && self_tone.is_none()
                && started_at.elapsed().as_secs_f64() >= at
            {
                self_tone_started_host = Some(host_clock::host_nanos_now(timebase));
                self_tone = Some(play_self_tone(3.0));
            }
            thread::sleep(Duration::from_millis(20));
        }
        drop(self_tone);
        stop(&stream);
        if let Some((screen, _, _)) = &screen_stream {
            stop(screen);
        }
        let (anchor_end, _) = host_clock::sample_anchor(timebase);

        let state = state.lock().unwrap_or_else(|p| p.into_inner());
        let wav_path = dir.join(format!("{label}.wav"));
        write_wav_f32(&wav_path, &state.samples, SYSTEM_AUDIO_SAMPLE_RATE, 2);

        let origin = start_requested_host;
        let frames: Vec<usize> = state.audio_buffers.iter().map(|b| b.frames).collect();
        let mut frame_histogram = std::collections::BTreeMap::<usize, usize>::new();
        for f in &frames {
            *frame_histogram.entry(*f).or_default() += 1;
        }
        // Gaps between consecutive buffers on the PTS timeline (expected ==
        // the previous buffer's duration when delivery is continuous).
        let pts_gaps_ms: Vec<f64> = state
            .audio_buffers
            .windows(2)
            .map(|w| {
                (w[1].pts_nanos as f64
                    - w[0].pts_nanos as f64
                    - w[0].frames as f64 / 48_000.0 * 1.0e9)
                    / 1.0e6
            })
            .collect();
        let arrival_intervals_ms: Vec<f64> = state
            .audio_buffers
            .windows(2)
            .map(|w| (w[1].arrival_host_nanos as f64 - w[0].arrival_host_nanos as f64) / 1.0e6)
            .collect();
        let max_arrival_interval = arrival_intervals_ms.iter().cloned().fold(0.0, f64::max);
        let pts_vs_cm_conversion_ns = state
            .audio_buffers
            .iter()
            .map(|b| (b.pts_nanos as i128 - b.pts_ticks_nanos as i128).abs())
            .max()
            .unwrap_or(0);
        // Instant vs host drift over the run: both anchors should map the
        // same host time to the same Instant.
        let anchor_drift_ns = {
            let predicted = anchor_start.instant_for_host_nanos(anchor_end.host_nanos);
            if predicted >= anchor_end.instant {
                predicted.duration_since(anchor_end.instant).as_nanos() as i128
            } else {
                -(anchor_end.instant.duration_since(predicted).as_nanos() as i128)
            }
        };
        // Per-second peak envelope (dBFS) for the silence / tone questions.
        let per_second_peak_db: Vec<f64> = state
            .samples
            .chunks(48_000 * 2)
            .map(|chunk| {
                let peak = chunk.iter().fold(0.0f32, |p, s| p.max(s.abs()));
                if peak <= 0.0 {
                    -f64::INFINITY
                } else {
                    20.0 * f64::from(peak).log10()
                }
            })
            .map(|db| {
                if db.is_finite() {
                    (db * 10.0).round() / 10.0
                } else {
                    -999.0
                }
            })
            .collect();
        // If S3 places buffers by PTS, a bus that plays out `delay` behind the
        // wall clock has already rendered (as zeros) every frame older than
        // `arrival - delay`. Fraction of captured frames that would be late:
        let late_fraction_at = |delay_ms: f64| {
            let late: f64 = state
                .audio_buffers
                .iter()
                .map(|b| {
                    let late_ms =
                        (b.arrival_host_nanos as f64 - b.pts_nanos as f64) / 1.0e6 - delay_ms;
                    (late_ms * 48.0).clamp(0.0, b.frames as f64)
                })
                .sum();
            let total = (state.samples.len() / 2).max(1) as f64;
            (late / total * 10_000.0).round() / 10_000.0
        };
        // PTS advances by exact sample counts (S0: zero PTS gaps), so a drift
        // between the audio clock and the host clock shows up as a trend in
        // (arrival - PTS). Least-squares slope, in ppm.
        let latency_trend_ppm = {
            let points: Vec<(f64, f64)> = state
                .audio_buffers
                .iter()
                .map(|b| {
                    (
                        b.pts_nanos as f64 / 1.0e9,
                        (b.arrival_host_nanos as f64 - b.pts_nanos as f64) / 1.0e9,
                    )
                })
                .collect();
            let n = points.len() as f64;
            if n < 2.0 {
                None
            } else {
                let mx = points.iter().map(|p| p.0).sum::<f64>() / n;
                let my = points.iter().map(|p| p.1).sum::<f64>() / n;
                let sxx: f64 = points.iter().map(|p| (p.0 - mx).powi(2)).sum();
                let sxy: f64 = points.iter().map(|p| (p.0 - mx) * (p.1 - my)).sum();
                (sxx > 0.0).then(|| sxy / sxx * 1.0e6)
            }
        };
        let first = state.audio_buffers.first();
        let summary = json!({
            "label": label,
            "seconds": seconds,
            "wav": wav_path.display().to_string(),
            "preflight": preflight,
            "excludeCurrentProcessAudio": exclude_current_process,
            "excludedPrefixes": prefixes,
            "excludedApps": excluded_report,
            "runningApplicationCount": apps.len(),
            "runningApplications": apps.iter().map(|(id, pid, name)| json!([id, pid, name])).collect::<Vec<_>>(),
            "startCompletionMs": start_latency.as_secs_f64() * 1000.0,
            "firstBufferArrivalAfterStartRequestMs": first.map(|b| (b.arrival_host_nanos as f64 - origin as f64) / 1.0e6),
            "firstBufferPtsAfterStartRequestMs": first.map(|b| (b.pts_nanos as f64 - origin as f64) / 1.0e6),
            "firstPts": first.map(|b| json!({"value": b.pts_value, "timescale": b.pts_timescale})),
            "format": state.format,
            "formatErrors": state.format_errors.iter().take(10).collect::<Vec<_>>(),
            "formatErrorCount": state.format_errors.len(),
            "unexpectedOutputTypes": state.unexpected_output_types.len(),
            "stopErrors": state.stop_errors,
            "audioBufferCount": state.audio_buffers.len(),
            "digitallySilentBufferCount": state.audio_buffers.iter().filter(|b| b.peak == 0.0).count(),
            "buffersAboveMinus60Dbfs": state.audio_buffers.iter().filter(|b| b.peak > 0.001).count(),
            "framesPerBufferHistogram": frame_histogram,
            "capturedFrames": state.samples.len() / 2,
            "expectedFramesForWallTime": (seconds * 48_000.0) as u64,
            "ptsGapMs": stats(&pts_gaps_ms),
            "ptsGapsOver5ms": pts_gaps_ms.iter().filter(|g| g.abs() > 5.0).count(),
            "arrivalIntervalMs": stats(&arrival_intervals_ms),
            "maxArrivalIntervalMs": max_arrival_interval,
            "lateFractionIfPtsPlacedAtPlayoutDelayMs": {
                "50": late_fraction_at(50.0),
                "80": late_fraction_at(80.0),
                "100": late_fraction_at(100.0),
                "150": late_fraction_at(150.0),
            },
            "arrivalLatencyTrendPpm": latency_trend_ppm,
            "arrivalMinusBufferEndMs": stats(&state.audio_buffers.iter().map(|b| (b.arrival_host_nanos as f64 - (b.pts_nanos as f64 + b.frames as f64 / 48_000.0 * 1.0e9)) / 1.0e6).collect::<Vec<_>>()),
            "ptsVsCMClockConvertHostTimeToSystemUnitsMaxAbsNs": pts_vs_cm_conversion_ns,
            "timebase": [timebase.numer, timebase.denom],
            "anchorBracketNs": anchor_bracket.as_nanos() as u64,
            "anchorDriftOverRunNs": anchor_drift_ns,
            "selfToneStartedAfterStartRequestMs": self_tone_started_host.map(|h| (h as f64 - origin as f64) / 1.0e6),
            "perSecondPeakDbfs": per_second_peak_db,
            "screenFrames": state.screen_frames.len(),
            "sync": with_screen.then(|| analyze_sync(&state, origin)),
        });
        let csv_path = dir.join(format!("{label}-buffers.csv"));
        let mut csv = String::from("pts_host_ns,arrival_host_ns,frames,peak\n");
        for b in &state.audio_buffers {
            csv.push_str(&format!(
                "{},{},{},{}\n",
                b.pts_nanos, b.arrival_host_nanos, b.frames, b.peak
            ));
        }
        fs::write(&csv_path, csv).expect("write buffer csv");
        let json_path = dir.join(format!("{label}.json"));
        fs::write(
            &json_path,
            serde_json::to_string_pretty(&summary).expect("summary json"),
        )
        .expect("write summary");
        eprintln!("wrote {} and {}", wav_path.display(), json_path.display());
        drop(screen_stream);
    }
}
