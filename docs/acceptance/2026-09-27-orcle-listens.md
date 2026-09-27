# Orcle listens (plan 068) — acceptance record, 2026-09-27

Scope: plan `plans/068-orcle-listens.md`. Orcle hears the streamer for the
whole live stream without captions (one transcription engine, two intents),
and uses it for Clip that, a transcript-aware regular check (topic, promises,
recap, on-topic questions), "Say hi" and dead-air nudges, and a post-stream
pack that runs itself. This note records what the deterministic gates proved
on the finished desktop branch and what still needs the owner's real stream.
No transcripts, tokens or user data are recorded here.

## Host and build

| Item | Value |
| --- | --- |
| Desktop branch | `feat/orcle-listens` (S3–S9), rebased onto `origin/main` `278ff17b` (0.9.116) |
| Web branch | `feat/orcle-listens` in `videorcweb` (S1, S2); verified in its own worktree, not re-run here |
| Machine | Apple M4, macOS 26.5.1, Node 24.6.0 (arm64), rustc 1.98.0 |
| Backend | debug build for smokes; `cargo build --release -p videorc-backend` also green |
| Services | local fakes only: `scripts/lib/fake-caption-service.mjs`, `scripts/lib/fake-cohost-service.mjs`; no production bearer, provider credential or external network |

## Rebase check

Main's #464 reworked `recording.rs` after the plan was cut. Both plan 068
seams survived the rebase unchanged: the listen resume spawn next to the
session-audio sampler in `start_session_with_timeline`, and
`presented_chunk_count()` (not `chunks.len()`) deciding the captioned-copy
render in `monitor_session` and `finalize_recording_media`. The `recording`
test filter passes (below).

## Gates (2026-09-27, after the rebase)

| Gate | Result |
| --- | --- |
| `cargo fmt --check --all` | PASS |
| `cargo clippy -p videorc-backend -- -D warnings` | PASS |
| `cargo build --release -p videorc-backend` | PASS (release warnings are all pre-existing, none in plan 068 code) |
| `env -u VIDEORC_PREMIUM_FEATURES cargo test -p videorc-backend <filter>` | PASS for every filter: `captions` 89, `cohost` 87, `clip` 29, `ai::` 14, `publish_clips` 7, `protocol` 46, `remote_control` 5, `remote_lan` 20, `recording` 420 (+6 ignored), `storage` 105, `videorc_api` 18, `live_chat` 70, `comment_highlight` 15 |
| `pnpm typecheck` | PASS |
| `pnpm lint` (ESLint + em-dash gate) | PASS, 0 warnings |
| `pnpm format:check` | PASS |
| `pnpm --filter @videorc/desktop test` | PASS, 226 files, 2,293 passed, 1 skipped |
| `pnpm test:scripts` | PASS, 1,598 tests (includes the new fake-service purpose test) |
| `pnpm build` | PASS |
| `pnpm check:renderer-assets` | PASS: eager JS 1,994,684 raw / 384,988 gzip (ceilings 2,000,000 / 390,000); entry 733,637 raw / 146,330 gzip (ceilings 1,200,000 / 235,000). The S8 pack runner is a lazy module. Raw headroom is 5,316 bytes |
| `pnpm smoke:captions-contract` | PASS, now with the listen-only scenario (below) |
| `pnpm smoke:cohost-fake` | PASS: 9 ticks over 44 messages with the fake speaking v3; spotlight lane; Say hi greeted two first-timers on stream and one by voice 1,000 ms after the final |
| `pnpm smoke:remote-control` | PASS: discovery, allowlist and filter lock, micToggle and sceneApply round trips, debounce, `clipMark` relayed through the renderer and refused with "No active session.", regenerate cuts the client |
| `pnpm smoke:remote-lan` | PASS: router isolation, backend tokens refused, single-use pairing, signed intents, chat snapshot and allowlist, no renderer credential on remote sockets, per-device revoke |
| `pnpm smoke:captions-live` | PASS after a smoke fix (below): 3 chunk uploads, none for the muted window, +6 dB ratio 1.996, captions on the RTMP stream and in the captioned copy (burn path), SRT written |
| `pnpm smoke:record-latency:gate` | PASS in enforce mode, screen-only synthetic scene, 5 cycles at 1080p30: warm click→recording p95 104 ms, stop click→idle p95 100 ms, idle→MP4 p95 210 ms; 5 compositor arms in place, 0 restarts. No listen intent was wanted here, so this proves the new resume spawn on the start path is inert, not listen-on timing |

## What each slice proved

| Slice | Deterministic evidence | Still owed |
| --- | --- | --- |
| S1, S2 (web) | Listen allowance (`purpose`, `listen-quota-YYYY-MM`, kill switch), Kick in every tick version, tick v3 schemas and prompt: tests in the web repo's `feat/orcle-listens` branch | Web deploy before the desktop release |
| S3 transcription split | Rust: `intent_matrix_keeps_one_task_alive_while_either_intent_is_wanted`, `listen_only_task_presents_nothing_but_orcle_hears_every_final`, `chunk_purpose_follows_presentation`, `silence_gate_skips_only_chunks_with_no_window_above_minus_45_dbfs`, `silence_skip_keeps_the_timeline_exact`, `listen_block_ends_listening_only_and_never_a_presenting_caption_session`, `listen_start_never_blocks_capture_or_raises_a_caption_block`, `listen_only_recording_writes_the_srt_but_renders_no_cues`, `state_serialization_omits_listening_when_none_and_never_writes_null` (15 tests). Smoke: `smoke:captions-contract` listen-only scenario | Captions off + Orcle hears, on a real mic |
| S4 listening UI | 25 renderer tests: the Listening / Starting to listen / Not listening indicator, every blocked reason, the one-time card (Turn on, Not now, storage that throws), the settings switch and time left, the consent copy naming listening and what is kept | By-eye check of the card and indicator, dark and light |
| S5 tick v3 | Rust: `v3_request_carries_speech_and_the_response_feeds_topic_summary_and_on_topic`, `speech_alone_ticks_on_v3_after_200_chars_and_20_seconds_but_never_below_v3`, `promises_merge_like_questions_and_triggers_remind_once`, `recap_rides_five_minutes_and_a_draft_cuts_the_summary_at_a_word`, `promise_trigger_matrix_matches_the_contract`. Renderer: On topic badge and sort, Promises, recap card. Smoke: `smoke:cohost-fake` asserts the v3 shape | A promise with a viewers trigger, and a recap on "what did I miss", from real chat |
| S6 Say hi, dead air | Rust: the name matcher tables (camelCase, digits, short names, stop list, one edit from six characters), `voice_greets_recent_authors_named_after_they_chatted`, `the_echo_of_the_streamers_own_send_never_asks_to_say_hi`, `dead_air_nudge_fires_once_per_two_minutes_with_a_fresh_key`, `dead_air_matrix` (16 tests). Smoke: `smoke:cohost-fake` greets by voice | Greet a first-timer by name; leave dead air with a question open |
| S7 Clip that | Rust: `phrase_table`, `mark_time_is_the_first_word_of_the_phrase`, `a_phrase_split_across_finals_matches_once_at_the_first_word`, `repeats_within_ten_seconds_dedupe_against_voice_and_manual_marks`, `clip_marks_persist_per_session_in_file_time_order_and_follow_deletes`, `marks_come_first_and_overlapping_chat_spikes_are_dropped` (11 tests). Smoke: `smoke:remote-control` sends `clipMark` and gets the relayed refusal without a session. No LAN route and no `LAN_EVENTS` entry were added; the phone reaches `clipMark` only through the existing `remote.intent` allowlist, and its ack carries only ok or the refusal sentence | Say "clip that" while recording and find the mark first in Publish → Clips |
| S8 post-stream pack | Rust: the timed transcript builder (30 s blocks, hours from one hour, the 110k UTF-16 cap dropping whole blocks from the start), `a_partial_run_never_shares_a_request_id_with_the_full_run`. Renderer: `runPostStreamPackOnce` makes exactly one workflow call per session, never retries, honours the setting | Stop a recorded stream and see the pack toast, then open Publish |
| S9 fakes, smokes, docs | The fake caption service records `purpose` (`captions` default, `listen`, unknown refused with 400): node test in `fake-caption-service.test.mjs`. `smoke:captions-contract` listen-only scenario, below | — |

### The listen-only scenario (`smoke:captions-contract`)

Captions stay off. A fake chat session starts, `cohost.settings.set
{enabled, listen}`, then `cohost.start` with consent. With realtime
unavailable, 5 s of injected tone produce one chunk upload. The smoke proves:

- every upload in the scenario says `purpose=listen`;
- the transcript record is kept (the record count grows), so a recording
  would still get its SRT;
- Orcle reports `listening: on` with the allowance the service returned;
- `captions.status.get` and the snapshot status stay `idle` with
  `desiredEnabled: false`, so the renderer's caption intent can never read
  the session as active;
- zero `captions.*` events (and zero caption health events) reach the
  socket, while the earlier caption scenarios on the same socket did emit
  them (the check is not vacuous);
- `cohost.stop` ends the listen-only task and removes the tap.

A "clip that" mark needs a recording to be saved, which this backend-only
smoke does not run; the `clip_marks` tests cover the matcher and storage.

### `smoke:captions-live` after the silence skip

The first run after the rebase timed out waiting for the muted window's
WAV. That is D4 working: a muted tap carries only silence, and silence is
never uploaded, so the smoke's old expectation (a silent WAV reaches the
service) could no longer hold. The smoke now waits two chunk windows after
the muted injection, requires the caption tap to have seen frames meanwhile,
and fails if any muted chunk was uploaded, a stronger privacy assertion
than before. The unmuted baseline and +6 dB windows still prove the same
task uploads speech. The run then passed end to end, including the
captioned-copy burn path that S3 gated behind presented records.

## Review fixes (2026-09-27)

The S10 review found one blocker and ten smaller issues. All are fixed on
this branch in `2cd65f78`, `44189299` and `f5abaf54`, each with a
regression test.

| # | Finding | Fix | Regression test |
| --- | --- | --- | --- |
| 1a | A listen-only task asked the caption-gated realtime token route, so a caption quota or the captions switch ended listening | A task that starts without presentation goes straight to the metered chunk path and stays there | `a_listen_only_task_never_tries_realtime` |
| 1b | With both intents on, a caption-scoped terminal failure ended the whole task | Scope by code and origin (`terminal_failure_scope`): the caption allowance, the captions switch (answered to a caption-metered request) and any realtime transport failure end captions only; the caption block is published as before, presentation turns off, and the chunk goes again as `purpose=listen`. Sign-in, Premium, the blocklist, server configuration and `ai-disabled` on a listen chunk end both | `terminal_failure_scope_table`, `caption_scoped_failures_never_stop_orcle_listening` |
| 2 | Session end aborted a listen-only task before the capture drain; a voice mark in the drain was lost | `session.stop` and the recording monitor only clear the listen intent (`ListenStop::DrainIfCapturing` / `DrainWithCapture`); `finish_captions_for_capture` drains the task. Explicit stops still abort. The caption task carries its capture (`MarkTarget`: session id, records to file) to every final | `a_capture_end_drains_the_listen_task_and_an_explicit_stop_aborts_it`, `a_capture_end_stop_lets_the_listen_task_drain_and_an_explicit_stop_aborts`, `session_stop_lets_orcles_listen_task_drain_with_the_capture`, `a_voice_mark_heard_during_the_capture_end_drain_lands_on_its_session`, `the_caption_task_carries_its_capture_to_every_final` |
| 3 | The pack ran for captions-only streams and defaulted on for everyone | The renderer records sessions whose Orcle listening reached `on`; the pack runs only for those. Without a choice in Publish the setting follows `listen`; an explicit choice wins | `post-stream-pack.test.ts`: `orcle-not-listening` skip, "follows Orcle listening by default", "runs only while Orcle listening is on", "never runs for a stream Orcle did not listen to" |
| 4 | Sign-out left Orcle "listening" and kept what it heard | Sign-out publishes `blocked (signed-out)` and purges the transcript window, recent speech, the Clip that tail, voice activity, the pending transcript, summary, topic, promises, recap and voice greetings; a tick in flight is dropped. A listen epoch fences late publishes. Sign-in resumes listening | `sign_out_purges_what_orcle_heard_and_blocks_listening`, `sign_in_resumes_listening_for_a_running_session`, `sign_out_and_stops_fence_late_listening_publishes`, `forgetting_voice_keeps_chat_and_manual_greetings` |
| 5 | The consent copy did not name the cloud step | Card, Settings, pane and popover: the microphone audio goes to Videorc's cloud speech-to-text to be turned into text; Videorc servers don't keep it; the transcript is saved with the recording on this computer | `cohost-view.test.ts`, `cohost-settings-section.test.ts`, `cohost-pane.test.ts` |
| 6 | "Say hi" greeted RustLover when a Rust streamer said "rust" | Longer names match only whole or as neighbouring words in order; a name that is an everyday word (a small list) needs a greeting within three words | `transcript_mentions_name_table` (RustLover/rust, Pizza/hey pizza, Python, TheLegend27), `name_forms_follow_the_short_name_and_stop_word_rules`, `common_name_words_are_sorted_lowercase_unique_and_never_stop_words` |
| 7 | A speech-only v3 tick to a rolled-back server fails `invalid-request` | No speech-only tick until one v3 tick succeeded this session | `speech_alone_waits_for_a_v3_answer_and_keeps_the_chat_mood` |
| 8 | Speech-only ticks clobbered the chat mood | Mood and mood scores stay when the tick sent no chat | same test |
| 9 | Rust capped by chars, the contract by UTF-16 units | Every emitted or echoed bounded text is cut by UTF-16 units on a char boundary (`truncate_utf16`); incoming v3 strings too | `every_bounded_text_counts_utf16_units_with_emoji_at_the_boundary`, `names_and_nudges_are_bounded_in_utf16_units` |
| 10 | A final could show after captions turned off | Presentation is read, and `captions.update` emitted, under the coordinator lock `captions.stop` flips it under (chunked and realtime) | `a_final_after_captions_turned_off_never_shows` |
| 11 | Quiet read as "starting" | A skipped silent chunk after real frames, or the first successful upload, makes the task ready (`on`, allowance unknown); the listen allowance refreshes from listen-metered answers at most every 30 s | `listen_readiness_reports_on_in_quiet_and_throttles_the_allowance`, `listen_joining_a_ready_task_is_on_at_once` |

`smoke:captions-contract` now waits for the listen allowance, since
listening may read `on` before the first upload.

Gates after the fixes: `cargo fmt --check --all`, `cargo clippy -p
videorc-backend -- -D warnings`, `cargo build --release -p videorc-backend`
(no new warnings) all PASS. `env -u VIDEORC_PREMIUM_FEATURES cargo test -p
videorc-backend` filters: `captions` 98, `cohost` 95, `clip` 26,
`recording` 420 (+6 ignored), `ai::` 14, `protocol` 46, `live_chat` 71,
`account` 62, `videorc_api` 18, `storage` 103, all PASS. `pnpm typecheck`,
`pnpm lint`, `pnpm format:check` PASS; desktop tests 226 files, 2,296
passed, 1 skipped; `pnpm test:scripts` 1,598 PASS; `pnpm build` PASS;
renderer assets eager JS 1,995,044 raw / 385,079 gzip (entry 733,997 /
146,421), 4,956 bytes of raw headroom. Smokes: `smoke:captions-contract`
PASS (listen chunks=1), `smoke:cohost-fake` PASS (9 ticks over 44 messages;
spotlight, Say hi by voice 1,001 ms after the final), `smoke:captions-live`
PASS (SRT and captioned copy).

Not changed here: the web privacy page copy (D3) lives in the web repo.

## Owner acceptance stream (S10, owed)

One real stream on the packaged build, recorded, with the web branch
deployed first.

| Check | How | Expect |
| --- | --- | --- |
| Captions off, Orcle hears | Captions off, Orcle on with listening on; talk | Orcle header says Listening; "Talking about" follows what you say; no caption bar anywhere |
| Say "clip that" | Say it once, then again within 10 s | One toast "Clip marked at m:ss"; after stop, the mark is first in Publish → Clips as "You said 'clip that'" |
| Greet a first-timer by name | A new chatter says hi; say their name out loud | They leave the Say hi list without pressing Greeted |
| Dead air with a question open | Leave a question unanswered, stay silent (not muted) 20 s | One private nudge suggesting it; none again within 2 minutes; none while muted |
| Stop → pack toast | Stop the recorded stream with cloud AI consent on | "Your post-stream pack is ready" once; chapters carry real times |
| Promise with a viewers trigger | Say "at 10 viewers I'll show the setup" | A promise with a viewers hint; a private reminder once viewers reach it |
| Recap on "what did I miss" | A chatter asks what they missed | A recap card; Post to chat only fills the composer |
