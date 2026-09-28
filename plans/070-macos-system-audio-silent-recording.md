# Plan 070: macOS static-screen recording loses microphone and system audio

Status: investigated 2026-09-28; **IMPLEMENTED 2026-09-28** on
`fix/070-static-screen-audio` (slices 1-3 and the automated part of 4, see
[Implementation record](#implementation-record-2026-09-28)). Packaged-candidate
acceptance on the owner's Mac is still owed. Priority P0: a completed
recording can contain no audio despite both inputs delivering samples.

## Incident and evidence

Installed app: `/Applications/Videorc.app`, version **0.9.119**. Investigated
release source at `dbb11586` using the local `videorc-wt-rel0119` worktree;
its compositor, encoder bridge, and session-audio files have no diff against
that release commit. The user's current `videorc` checkout is older
(`15206746`) and must not be used as the implementation baseline.

Owner recording: session `3eeb5dad-00a4-4089-a7d8-846f0a3f20d3`, September 28,
**11:34 Madrid / 09:34 UTC**, screen-only, 1920×1080 at 30 fps, MacBook Pro
microphone and system audio. Local evidence, inspected read-only:

- `~/Library/Application Support/Videorc/logs/backend.log`, lines 8819–8873.
- `~/Library/Application Support/Videorc/videorc.sqlite3`, `sessions` and
  `health_events` rows for that session.
- `~/Movies/Videorc/Recordings/videorc-session-20260928-093438-3eeb5dad-00a4-4089-a7d8-846f0a3f20d3.mp4`.

The MP4 is 16.066 seconds, with H.264 video and 48 kHz stereo AAC audio.
Decoding the audio to f32 yielded **1,540,096 samples, every sample exactly
zero**. This is not a player, missing-track, or MP4-remux problem. Audio is
absent from the saved track and cannot be reconstructed from this file.

Relevant log sequence:

| UTC          | Evidence                                                                                 |
| ------------ | ---------------------------------------------------------------------------------------- |
| 09:34:38.725 | Warm microphone taken into recording; 1,325,568 frames already captured                  |
| 09:34:38.829 | Recording running, 412 ms startup                                                        |
| 09:34:39.005 | Native system-audio capture started successfully                                         |
| 09:34:39.034 | System audio joined the mix at sample 13,920                                             |
| 09:34:41.065 | System source lost: no buffer could be placed for 2 s                                    |
| 09:34:41.065 | System timeline: 0 captured, 97,920 dropped, **all ahead-of-cap**; max lateness 8,849 ms |
| 09:34:41.092 | System adapter closed: 97,920 captured, **0 dropped, 0 rejected buffers**                |
| 09:34:41.833 | Microphone reported stopped after 2.1 s                                                  |
| 09:34:54.975 | Microphone timeline: 0 captured, 99,328 dropped, **all ahead-of-cap**                    |

Saved screen diagnostics: 478 callbacks, 5 complete/published frames, 473 idle
statuses, no suspended or stopped statuses. Healthy static-screen callbacks
continued while the previous image was reused. The startup barrier accepted a
new compositor publication in 11 ms; this does not make its source timestamp new.

The same session later received `recording-quality-passed` despite the known
audio losses and completely silent artifact.

## Diagnosis and confidence

**High-confidence root cause: source-content time is incorrectly used as the
recording epoch.** The exact epoch value is not logged, so a full native
reproduction with epoch instrumentation remains the first implementation gate.
The production evidence and deterministic source-code replay agree:

1. `compositor.rs:7666`, `compositor_frame_content_captured_at`, retains the
   camera/screen source's `captured_at`. For an unchanged screen, that may be
   many seconds old. New composition ticks correctly retain that content age.
2. `encoder_bridge.rs:3998–4004` sets `video_epoch` to that source timestamp
   when feeding the first video frame. The file's video starts at output PTS
   zero now, but the audio bus is told that zero was seconds ago.
3. `session_audio.rs:1927`, `SourceClock::new`, maps current audio against
   this old epoch. `AudioTimeline::push` rejects samples more than its bounded
   headroom ahead of the output cursor. The bus starts at sample zero and is
   downstream-paced, so it cannot catch up with an approximately nine-second
   error before the source-loss timeout.
4. The microphone watchdog advances its liveness timestamp only after a
   successful timeline insertion (`ingest_pending`, around line 1821).
   Placement rejection therefore becomes the misleading claim that the mic
   stopped. System audio reports its placement failure more accurately.

An isolated temporary Rust harness copied the **actual** `AudioTimeline` and
`SourceClock` bodies from the release source. With fresh nonzero packets,
150 ms playout headroom, and an epoch 8.85 s old, both 480- and 960-frame
packet cases produced 0 captured / 100,800 ahead-cap drops / 93,600 generated
frames. Changing only the epoch to the start of the simulated session yielded
93,600 captured / 0 drops / 0 generated frames. Three consecutive runs matched.
The temporary harness was removed. This proves the mapping failure mechanism;
it is not a packaged-app end-to-end reproduction or a shipped fix.

Competing explanations:

- Permission/adapter failure: inconsistent with 97,920 native system samples,
  no rejected buffers, and all bus losses attributed to ahead-of-cap.
- System adapter clock conversion alone: does not explain the microphone's
  identical failure; both share the bad recording epoch.
- Ordinary startup/FIFO pressure: 111–128 ms stalls exist, but do not explain
  8,849 ms lateness and every sample being ahead-of-cap. Preserve pressure
  regression tests; do not try to solve this by enlarging buffers/timeouts.

The epoch assignment and compositor timestamp semantics predate system audio
(git blame reaches June/July). This incident exposes a shared recording bug;
the evidence does not establish that yesterday's adapter introduced it.

## Why existing verification missed it

`scripts/smoke-system-audio-app.mjs` uses a continuously updating synthetic
screen and disables native microphone capture. Its fresh content timestamps
avoid this failure. `docs/acceptance/2026-09-28-system-audio.md` documents that
coverage and leaves the packaged mixed microphone/system-audio owner checklist
unchecked. That document alone provides no packaged mixed-input acceptance.

`recording.rs:9871` passes FPS, audio-stream expectation, and pipeline freeze
evidence into `QualityExpectations`; it does not pass these audio-loss facts.
`repair.rs` checks audio-stream presence and one-sided channels, which cannot
establish that an all-silent track preserved the expected source audio.

## Ordered implementation slices

Work from current main in an isolated worktree, first checking whether newer
changes already address these call sites. Read its AGENTS.md. Preserve existing
user changes and production library/configuration. Do not ship as part of this
plan without a release request.

### 1. Reproduce through the real startup path

- Add a deterministic regression spanning compositor publication, first encoded
  frame epoch selection, and session audio. Reuse valid static screen pixels
  captured 9 seconds earlier while compositor ticks and both audio sources are
  current. Assert fresh nonzero audio reaches output from the beginning. Show
  the test failing on the release baseline before changing implementation.
- Cover source ages 0, 0.5, 2, 9, and 30 seconds; microphone-only, system-only,
  and mixed input; warmed preview and repeated Record/Stop cycles.
- Log one bounded startup record containing source-content age, compositor
  presentation time, chosen epoch age, first audio mapped position, and cursor.
  Keep source arrival, placement, and downstream-write evidence distinguishable.
- Reproduce in an isolated native app profile with a real unchanged display
  held for at least 10 seconds before Record, plus an external known tone.
  Control the app from another display or the remote surface so clicking does
  not refresh the captured screen and hide the bug. Use readiness/observed
  source-age evidence, not a fixed sleep alone.

Exit: native evidence confirms the old epoch and the regression fails for
ahead-of-cap rejection. If it does not, revisit the diagnosis before fixing.

### 2. Give recording its own presentation-time authority

- Preserve `captured_at` for source freshness/latency diagnostics. Introduce an
  explicit compositor presentation timestamp associated with the output tick
  and carry it alongside the immutable frame into `FedCompositorFrame`.
  Relevant files: `compositor.rs`, `frame_store.rs` or compositor metadata,
  and `encoder_bridge.rs`.
- Establish the shared recording epoch from the first session-eligible output
  frame's presentation time corresponding to encoded video PTS zero. Never
  derive it from the age of reused screen pixels or a pre-arm preview frame.
  Keep epoch selection one-shot and shared by audio and output legs.
- Preserve source-to-presentation timing information. Do not blindly replace
  all timestamps with `Instant::now()` at encoder submission: that can move
  A/V alignment by encoder delay. Verify moving-screen and camera sync as well
  as the static-screen case.
- Cover primary/auxiliary outputs and review raw-video/Windows epoch semantics
  explicitly; retain their existing startup guarantees. Test mapping/metadata
  preservation through every touched frame-copy/export path.
- Keep bounded timeline buffering, per-source sync offsets, and the cursor law
  intact. Do not jump the output cursor, fabricate fresh capture timestamps,
  or increase source-loss deadlines to conceal the offset.

Exit: slice 1 passes; held static content no longer creates audio pre-roll or
ahead-cap drops, and A/V measurements stay within existing gates.

### 3. Report the actual failure and preserve it in quality results

- Track producer arrival separately from successful timeline placement.
  EOF/callback stall, timestamp-placement failure, and transport failure must
  produce distinct reasons. A microphone that delivered samples must not be
  described as disconnected/stopped solely because the bus rejected them.
- Surface mic and system losses independently, including when both fail.
  Carry structured reasons through health events and the existing session
  runtime notice instead of losing the system error behind the microphone
  alert. Keep existing source-loss behavior for genuine disconnections.
- Pass confirmed audio-loss evidence into post-recording assessment and its
  persisted/resumable job state. A structurally valid file must not receive an
  unqualified quality pass over a confirmed lost-audio event.
- Do not reject legitimate silence just because samples are zero: system audio
  may be idle and inputs may be intentionally muted. Use source selection,
  control state, arrival/placement provenance, and known loss evidence.
- Regression: the incident-shaped assessment reports audio missing; muted and
  legitimately idle sources remain valid. No repair/interpolation can restore
  source audio that was never written.

### 4. Add end-to-end coverage and packaged acceptance

- Extend `smoke:system-audio` with real static-screen startup, warmed preview,
  and repeat starts. Keep the current tone, toggle, self-exclusion, privacy,
  and record-plus-local-stream cases.
- Analyze final MP4 and received stream artifacts for expected tone onset,
  continuity, amplitude, and A/V offset. Require zero unexpected ahead-cap
  losses and no false mic/system-source-loss events.
- Packaged app on this Mac: real built-in microphone plus external system tone,
  screen-only static display, then moving content; verify voice and tone
  separately in the artifact. Repeat with a camera layout. A dev synthetic
  pass is insufficient. Use controlled audio stimuli where automation is needed.
- Record text-only acceptance evidence. Keep user media, logs, tokens, and
  generated recordings out of the repository.

## Verification gates for implementation

Start with the new regression and affected `session_audio`, `encoder_bridge`,
`compositor`, `recording`, and `repair` tests, plus desktop runtime-notice tests.
Then run:

- `cargo test -p videorc-backend`, `cargo fmt --check --all`, and
  `cargo clippy -p videorc-backend -- -D warnings`.
- `pnpm test:scripts`, desktop tests, typecheck, lint, and format check for
  touched TS/protocol/UI paths.
- `pnpm smoke:system-audio` and final-artifact A/V analysis, including the
  existing `measure:av-sync --system-audio` route.
- `pnpm smoke:recording-studio`, `pnpm smoke:record-latency:gate`, and
  `pnpm smoke:recording-studio:devices` with required macOS grants.
- `pnpm probe:preview-lifecycle`; add placement/window probes only if those
  paths change. Run the recording matrix if encoding/fps/output handling changes.
- Windows compile/CI coverage for shared frame/epoch changes; apply AGENTS.md's
  Windows repeated-run requirements if Windows async/process tests are changed.

Do not mark fixed until the original static-screen native scenario passes on a
packaged candidate. Record any permission/device blocker explicitly. This task
produced investigation and a plan only; no application code, settings, library
records, or installed binaries were changed, and full implementation gates
were not run.

## Implementation record (2026-09-28)

Branch `fix/070-static-screen-audio`, from main `e62b47dd` (0.9.119 plus
release-workflow fixes; the compositor, encoder bridge and session-audio files
match the investigated release). Started by an earlier agent session and
finished here; no production library, settings or installed binaries changed.

### The epoch rule (slice 2)

- `CompositorFrameExportHandle` carries the compositor's presentation time for
  primary and auxiliary outputs. `captured_at` is unchanged, so freshness and
  latency diagnostics stay honest.
- `encoder_bridge::recording_epoch(content, presented, frame_interval)` sets
  audio sample zero once, from the first fed frame:
  - content no more than 100 ms old at presentation is live, and keeps its
    exact capture time. Calibrated camera and moving-screen A/V sync is
    unchanged; owner sessions show a 6-72 ms source-to-encode p95.
  - older content is held: an unchanged screen's pixels are still current, so
    the epoch is the capture time a change would have had, half a tick before
    presentation. Moving screens measure 0-16 ms at presentation.
- A Windows direct D3D11 frame has no compositor presentation; its feed time
  stands in. The raw-video prime and D3D11 Media Foundation epochs were already
  `Instant::now()` at first output, so they are unaffected.
- A first design bounded held content to a flat 100 ms. That left audio about
  80 ms behind the picture once a static-start recording began to move, so
  it was replaced.

### Honest loss reporting (slice 3)

- `SourceLossReason::{CaptureStopped, TimelineRejected}`. A microphone whose
  samples keep arriving but cannot be placed now reports
  `microphone-timeline-lost` ("kept delivering audio, but Videorc could not
  place it"), not "stopped". System audio keeps `system-audio-lost` but gets
  the same distinction in its message; EOF and platform failure outrank
  placement.
- Session health events for microphone or system-audio loss set
  `QualityExpectations::pipeline_reported_audio_loss`. Such a file gets
  `QualityIssue::AudioInputLost` (needs review, never transcode-repaired), and
  the flag persists in the resumable `repair_jobs` row. Muted or idle inputs
  produce no loss event and still pass.
- The session runtime notice keeps microphone and system losses together,
  including after a renderer reconnect. System-only loss keeps the existing
  no-toast policy while active.

### Evidence (slices 1 and 4)

- Deterministic regression
  `compositor::tests::static_screen_recording_epoch_keeps_current_audio`: real
  compositor publication, then the epoch, then the real timeline, clock and
  system slot, at source ages 0/0.5/2/9/30 s × mic/system/mixed × 128/480/512/960-frame
  packets × two takes. On the release rule it fails: at 0.5 s the first
  audible sample lands 0.50 s into the file, and at 2 s or more every sample
  is dropped ahead-of-cap. The test asserts that failure too.
- `smoke:system-audio --static-screen-id screen:screencapturekit:2
  --microphone`, dev app, real LG 4K display held static by a native fixture
  (content 10.0-10.2 s old at Record), MacBook Pro Microphone warm, three
  consecutive takes, all PASS:
  - first frame source age 10,225-10,522 ms and presentation age 17-21 ms;
  - epoch age 33-37 ms, with the first microphone sample mapped 26-36 ms in;
  - 0 ahead-of-cap drops, microphone ~569k frames captured, no source loss,
    no audio-loss health events;
  - the system tone lands at 3.27-6.30 s, 3.000 s long, at -12 dBFS.
- `--moving` variant (two takes, PASS): source age 25 ms and 9 ms, and the
  epoch equals the capture time. Live behaviour is unchanged.
- The native baseline (release rule) could not be reproduced on the owner's
  active machine: the display did not stay unchanged between the 10 s
  readiness check and Record. Across the fixed runs, the release rule would
  have used a 10.2-10.5 s-old epoch, which the regression shows loses
  everything.

### Gates

All run on the owner's Mac from this worktree, 2026-09-28, while the owner
was using the machine (Chrome audio over Bluetooth, active displays).

- Rust: `cargo test -p videorc-backend` 2675 passed, 0 failed;
  `cargo fmt --check --all`; `cargo clippy -p videorc-backend -- -D warnings`.
- TS: `pnpm test:scripts` 1669/1669; desktop unit tests 2358 passed
  (1 skipped); `pnpm typecheck`, `pnpm lint`, `pnpm format:check`.
- `smoke:recording-studio`, all stages. Every stage passed except two, both
  outside the changed paths:
  - `smoke:freeform-editor` failed twice at different points (landscape
    move 0, then portrait move 3) and passed on a third run. It drives
    trusted OS pointer input, which live mouse use disturbs.
  - The device run of `smoke:preview-interaction-stress:devices` first
    produced a 40.3 s file where 52 s was required. On retry the recording
    was full length (59.9 s, PASS), and a different contract (a layout
    button intent race) tripped. It is flaky under load and neither failure
    involves audio.
  Passed: `smoke:record-latency:gate`, `probe:preview-lifecycle`,
  `probe:preview-window`, `smoke:dev` all-layout artifacts,
  `smoke:screen-recording-real`, `smoke:live-layout-switch-recording` (+
  `:devices`), `smoke:recording-native-preview` (source-complete stress),
  captions, noise cleanup, app-quit finalization, preview surface/pump/
  click-focus/scene-commit, Notes invisibility, comments.
- `smoke:system-audio` (default synthetic cases): `on`, `toggle-off`,
  `toggle-on` and `off` passed. `self` and `stream` (and `on` in one run)
  failed only on extra 0.2-0.4 s regions near -30 dBFS at random times.
  Chrome was playing audio for the whole run, and the tones themselves were
  exact. They need a quiet re-run.
- Not run: `measure:av-sync --system-audio`. It flashes the main display in
  Chrome and measures clicks as system audio, which the owner's Chrome
  playback would contaminate. The live-content epoch is unchanged, so the
  calibrated constant needs no change. Also not run: the recording matrix
  (no encoding/fps change) and a Windows build (CI covers it).

### Still owed

- Packaged candidate on the owner's Mac: screen-only on a display left static
  for 10+ s, built-in mic plus a known system tone. Then repeat with moving
  content and with a camera layout. Confirm voice and tone by ear, and check
  that the Library shows no "needs review". The smoke supports this with
  `--app-executable` (Studio set up by hand).
- A quiet-machine re-run of `pnpm smoke:system-audio` and
  `measure:av-sync --system-audio`.
