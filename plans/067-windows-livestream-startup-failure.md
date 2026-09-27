# Plan 067: Diagnose and fix the Windows 0.9.115 livestream startup failure

> Executor: read this entire plan and `AGENTS.md`. Implement in a dedicated
> worktree from current main, not the old checkout in which this plan was
> written. Preserve user changes. Follow the evidence checkpoints below;
> the exact cause of FFmpeg's stall is not established yet.

## Status

- Priority: P0. Effort: L overall; evidence and warning fixes M. Risk: HIGH
  for pipeline changes, MED for diagnostic ownership and toast lifecycle.
- Status: PARTIAL: remaining independent reproduction tooling is implemented on
  `fix/067-windows-incident-reproduction`, PR [#472](https://github.com/TheOrcDev/videorc/pull/472).
  Initial tooling checkpoint `446411a7`; final verification is tracked in the PR.
  Steps 1–2 merged in PR #464.
  Full incident closure still needs affected Windows hardware, which the user
  confirmed is currently unavailable. Mac timing variability is documented below.
- Planned: 2026-09-27, against cached main
  `b772cb59b2dc7c675ce7f34b3bd1f3356151d67e`.
- Local checkout: `15206746`, desktop 0.9.98, dated 2026-09-21. It is older
  than the report. Release-era comparison: `f0e57b32`, whose 0.9.115 release
  record includes Windows fix #457 (`e77bc623`). The bundle's app commit is
  null, so these are comparison revisions, not proven installed binary hashes.
- Depends on: landed Plan 065 A/B1/B2. This plan owns the follow-up incident;
  reuse its pending B0 probe work and B3/B4 where appropriate instead of
  launching competing implementations. Plans 039/040 retain broad Windows
  performance and architecture acceptance; this does not claim those complete.

Drift check:

```sh
git diff --stat b772cb59..HEAD -- crates/videorc-backend/src/recording.rs crates/videorc-backend/src/encoder_bridge.rs crates/videorc-backend/src/windows_media_foundation_encoder.rs apps/desktop/src/renderer/src/lib/studio-health.ts apps/desktop/src/renderer/src/lib/session-runtime-recovery.ts apps/desktop/src/renderer/src/hooks/use-studio.tsx
```

Compare changed symbols with the excerpts below before implementation.
The supplied local checkout is deliberately not the implementation baseline.

## What happened

Evidence remains outside the repository:

- `/Users/orcdev/Downloads/videorc-support-bundle-20260926-221332Z.json`
- `/Users/orcdev/Downloads/ffff.png`

Do not commit the bundle, screenshot, device identifiers, stream endpoints,
credentials, or generated recordings. The facts below are enough to create
small synthetic regression fixtures without private data.

The failed session in the first bundle, `b6dcec24-b9e6-44ca-bc31-6c757c9efef8`, was a packaged
Windows 0.9.115 **record+stream to YouTube and Twitch**, not just the YouTube
destination named by the legacy `streamPreset` summary.

| UTC, 2026-09-26 | Evidence |
| --- | --- |
| 22:12:14 | Start requested; two destinations configured. |
| 22:12:17 | Capture worker received no fresh microphone PCM within 2 s; selected microphone retained through DirectShow fallback. This does not prove the direct input subsequently delivered audio. |
| 22:12:25 | Intel Quick Sync MFT failed at `process-output`, `HRESULT=0x8000FFFF`; software OpenH264 selected. Combined reason also says system-memory input failed. |
| 22:12:26 | Compositor barrier passed: three fresh 1920×1080 frames after 280 ms. Shared recording/stream writer started. |
| 22:12:29 | 39 compositor ticks skipped before encode under output pressure. |
| 22:12:34.751 | `ffmpeg-output-startup-failed`: no positive output media progress within 8,000 ms of process spawn. |
| 22:12:35.199 | `recording-degraded`: 16 fps versus 30, incorrectly followed by “The stream continues”. This was 448 ms after the failure health event. |
| 22:12:35 | Empty MKV removed; session marked failed; recorded writer counts eventually returned to zero. |

No successful Running transition or usable recording is proven for this
attempt. `finalDiagnostics` is null. Its 17 session logs contain no retained
FFmpeg stderr tail. Global diagnostics at bundle export are an idle snapshot,
not a substitute for that missing session snapshot.

Earlier sessions did complete but used CPU composition and software OpenH264.
The five earlier same-day stream sessions have terminal render-rate snapshots
of about 9–24 fps against 30; those are snapshots, not whole-session averages.
Some earlier artifact analyses report freezes. This supports a recurring
performance problem, independently of the latest startup refusal.

The performance check failed both 1080p30 and 720p30, with `belowFloor=true`.
Its 720p “recommendation” is the last attempted floor, not a passing result.
The reported `deliveredFps` uses bridge input cadence, not final encoded frame
delivery (`performance_check.rs:526`); OpenH264 also logged skipped frames.
Do not claim the tiny reported encoder-speed values precisely measure this
PC's sustained capacity without examining FFmpeg progress timing.

## Findings and confidence

| Finding | Impact | Confidence | Effort / fix risk |
| --- | --- | --- | --- |
| Startup stderr and session diagnostics are discarded on failure | The immediate cause of a real failed broadcast is hidden | HIGH, code and bundle agree | M / MED |
| Configured streaming is mistaken for confirmed live output in a late warning | User sees “could not start” and “stream continues” together | HIGH, trace replay reproduced 3/3 | S–M / MED |
| Intel rejection still falls through to an overloaded CPU path | Poor quality and startup pressure on this machine | HIGH for fallback; exact timeout causality unproven | L / HIGH |
| Compact MF reason truncates the second topology failure | Cannot see the second stage/HRESULT despite Plan 065's intended diagnostic contract | HIGH, bundle ends with `system-memory input also failed: Me...` | S / LOW |

Ranked hypotheses for the eight-second stall, not conclusions:

1. Software/raw pipeline pressure: if it is causal, holding microphone and
   destination count fixed while reducing workload restores initial output.
2. DirectShow input startup: if causal, the same video/output topology works
   with a controlled audio source and stalls with that microphone path.
3. Output connection startup: if causal, local recording/local RTMP succeeds
   with identical inputs while a particular destination or two-target setup
   stalls. Test destinations separately before combined output.

The bundle cannot distinguish them. A passed compositor barrier rules out
“no initial compositor frames”; it does not prove sustained encode/output.
The 16 fps warning measures bridge input, not provider delivery. There is no
retained authentication/TLS/network error proving bad keys or bad internet.
`E_UNEXPECTED` means “Unexpected failure”, not a documented proof of an
unsupported resolution or bitrate: [Microsoft HRESULT reference](https://learn.microsoft.com/en-us/windows/win32/seccrypto/common-hresult-values).
The same hardware also failed 720p. Do not repeat the old bitrate-only fix or
promise that a driver update or lower resolution solves this report.

## Current code, verified at b772cb59 and release-era f0e57b32

1. `crates/videorc-backend/src/recording.rs:4374` starts the stderr relay.
   Windows/raw output waits synchronously at :4562. The failure branch
   :4578–4607 tears down and returns before the persistence consumer exists:

   ```rust
   uncommitted_capture_process
       .terminate_and_reap_before_fifo_writer_join()
       .await;
   let _ = finish_recording_encoder_bridge_teardown(&state, batch, teardown_origin).await;
   return Err(error);
   ```

   The stderr consumer is only started at :4933, and its bounded
   `FfmpegStderrTail` is persisted at :5125. Therefore queued startup messages
   never reach that consumer after rejection. The raw event channel is
   unbounded; any new diagnostic collector must itself be bounded.
2. `SessionStartRowGuard::drop` (:5213) calls `finish_session(..., None, None)`.
   The running monitor owns final diagnostics (:8213). Reuse
   `persist_terminal_session_or_recovery` (:7631) and existing finalization
   conventions instead of introducing a competing database writer.
3. `encoder_bridge.rs:7236` runs the degradation watch without proof of a
   committed running session. At :7260 it derives streaming from
   `diagnostics_context.stream_output.is_some()`. The helper at :1274 says
   “The stream continues” whenever that configuration flag is true.
4. Renderer `lib/studio-health.ts:77` maps every `recording-degraded` event to
   a 20-second warning. `lib/session-runtime-recovery.ts:280` shows it without
   lifecycle state. `hooks/use-studio.tsx:6014` checks session ID/epoch, but
   accepts the last session ID after termination; that does not prove it is live.
5. `windows_media_foundation_encoder.rs:3134` already tries Auto and
   SystemMemory topologies; :3190 walks the bitrate ladder. Do not duplicate
   #457's video-capable D3D11 device, multithread protection, or rejection cache.
   `probe_failure_without_encoder` (:3184) retains the long explanatory
   HRESULT parenthetical; `recording.rs:13016` later caps the whole string at
   480 bytes, truncating the second failure. Prefer structured compact fields.
6. `resolve_windows_recordable_video` (`recording.rs:13401`) deliberately
   returns `None` for streaming. Plan 065 B3 remains unimplemented. Stream
   profiles originate in provider-aware planning, so reducing only the local
   recording canvas is not a valid stream step-down implementation.

Conventions: use small pure policy helpers with Rust unit tests; retain owned
child cleanup and session-generation checks. Renderer uses existing keyed
Sonner toasts and `session-start-failure.ts` reconciliation. Follow
`.agents/skills/videorc-design/SKILL.md`; no new screen or restyling is needed.

## Scope and boundaries

Allowed for evidence and lifecycle fixes:

- `crates/videorc-backend/src/recording.rs`, `encoder_bridge.rs`,
  `windows_media_foundation_encoder.rs`, `windows_d3d11_encoder_contract.rs`.
- Existing diagnostic/support bundle types in `protocol.rs`, `diagnostics.rs`,
  `apps/desktop/src/shared/backend.ts` only if existing fields cannot express
  the new snapshot. Keep Rust/TS mirrors and redaction tests together.
- Renderer `lib/studio-health.ts`, `session-runtime-recovery.ts`,
  `session-start-failure.ts`, `hooks/use-studio.tsx`, and adjacent tests,
  especially `hooks/studio-provider.integration.test.ts`.
- `scripts/smoke-windows-stream-performance.mjs`,
  `scripts/lib/windows-stream-performance{,.test}.mjs`, support-bundle verifier
  and tests, and `package.json` for a maintained probe command if required.
- Plan 065's pending B0 probe module/script, this plan, and `plans/README.md`.

Conditional media-fix scope, only after the reproduction identifies the cause:
`capture_input.rs`, `audio_capture_adapter.rs`, `session_audio.rs`,
`performance_check.rs`, `streaming.rs`, provider output planning and their
existing protocol/renderer mirrors. Record the selected change and causal
evidence in this plan before implementation. Escalate anything broader.

Out of scope: shipping a release, changing credentials, provider OAuth,
replacing the encoder architecture, adding a new codec dependency, redesigning
preview, globally increasing the timeout, silently disabling the mic or a
destination, or marking Windows OBS parity complete.

Use a branch such as `fix/windows-startup-evidence`. Do not commit, push or
publish unless instructed. Keep the existing dirty plan index additions.

## Ordered implementation

### 1. Preserve evidence before changing media behavior

Give the uncommitted startup owner an immediately active diagnostic collector.
Capture a bounded sanitized tail, first fatal category, last media clock,
reached phases, effective encoder/topology, FIFO byte/frame progress and audio
readiness if observable. Record unknown values explicitly; process existence
is not PCM proof. Do not log full FFmpeg argv or destination secrets.

On rejection/cancellation: stop further active-session notices, reap the exact
child before joining blocked FIFO writers, boundedly drain diagnostic output,
then persist a snapshot belonging to this session before resources/reset erase
it. Preserve the first failure. Transfer collector ownership once on success;
do not create competing stderr readers or duplicate terminal database writes.
Retain only nonempty media as existing policy requires.

Compact each MF attempt to topology, stage, HRESULT, requested/effective
profile and encoder identity separately. The first and second stage/HRESULT
must survive the 480-byte human summary. General E_UNEXPECTED copy must not
assert a specific cause that has not been measured.

Add tests at the real startup ownership seam: warning + zero progress + stall;
fatal error; EOF; cancellation while bridge opens; success ownership transfer;
late output after a replacement session starts; database reload/export of
failed diagnostics; long multibyte MF identity; secret-bearing URL redaction.
Use explicit readiness channels, never fixed sleep or temporary-file handshakes.

Verify: `cargo test -p videorc-backend ffmpeg` and
`cargo test -p videorc-backend published` pass including new rejected-start
evidence cases. `pnpm test:scripts` passes bundle/redaction tests. On Windows,
run the affected new process filters 25 times as required by `AGENTS.md`.

### 2. Make runtime notices follow actual session state

Gate backend degradation notices on the matching committed active session;
stop publication when startup fails or teardown begins. Avoid taking a
recording mutex in a path whose owner awaits that diagnostics task: use a
session-scoped lifecycle signal or equivalent nonblocking authority.

Remove unconditional “stream continues” reassurance. Even a running aggregate
session does not prove every target is healthy. Use accurate recording-rate
copy unless target output health explicitly supports stronger wording.
Renderer must dismiss active degradation notices on terminal failure and
ignore late active-only notices for the last session. Keep historical events
in the session log. Preserve valid running-session warnings and existing
terminal recording-quality notifications.

Replay the supplied event ordering as a synthetic integration test: Starting,
startup failure, degradation at +448 ms, Idle, late diagnostics, Retry with a
new ID. Assert one persistent actionable failure, no live reassurance, no
stale degradation toast, and the new session's warnings work normally. Also
test degradation arriving just before failure and async module loading across
terminal state. Include the timeout detail in the safe start-failure message;
the screenshot currently exposes only its outer context.

Verify: `pnpm --filter @videorc/desktop exec vitest run src/renderer/src/lib/studio-health.test.ts src/renderer/src/lib/session-start-failure.test.ts src/renderer/src/hooks/studio-provider.integration.test.ts`
and `cargo test -p videorc-backend recording_degraded` pass; then
`pnpm typecheck`, `pnpm lint`, `pnpm format:check` pass.

### 3. Reproduce the media stall on Windows with the new evidence

Finish/reuse Plan 065 B0's bounded MF probe tool. Record app/backend/FFmpeg
identity, OS, adapter and driver identity and every attempted topology/profile.
Do not infer a specific GPU model from the generic Intel MFT name in this
bundle. Export all failure stages even if no configuration works.

Extend the maintained Windows stream smoke to cover the incident topology.
First use local RTMP receivers and test media, never the tester's secret keys.
Keep video source, fps, bitrate and preview state fixed while changing one
variable. Required comparisons:

- 1080p30 raw/OpenH264 local recording with controlled audio, then DirectShow.
- Same inputs: local recording, one local RTMP destination, two local RTMP
  destinations, and record plus two destinations.
- Repeat the failing combination at 720p30; do not count startup alone as a
  quality pass. Exercise a microphone worker that delivers PCM and an injected
  worker-open failure taking the direct fallback.
- Hardware probes at both resolutions using existing input and bitrate ladders.

Each report must contain start outcome, first PCM evidence or unknown, bridge
bytes/frames, FFmpeg tail/media clock, fallback reason, exit/cleanup result,
and final artifact analysis. Record sound and moving content; check real
encoded frame cadence, freezes and A/V sync, not bridge input fps or file size.
Use at least three repetitions per case and retain failures, not just successes.

Verify: `node --test scripts/lib/windows-stream-performance.test.mjs` passes
matrix-generation/report tests; `pnpm smoke:windows-stream-performance -- --list`
shows the incident cases after extension; execute the documented incident
selection on the affected Windows host. The runner must fail for missing
evidence or a startup timeout. Add the exact new selector command here when
implemented; do not pretend the existing one-target matrix covers this case.

### 4. Apply the fix selected by the reproduction

- If input readiness is causal, repair that acquisition/probing path and
  prove PCM reaches the real FFmpeg graph before claiming the mic is live.
- If MF compatibility is causal, make only the measured configuration change,
  use it identically in probe and session, and invalidate matching cached
  rejections. Validate sustained output, not just the first IDR.
- If software pressure is causal, finish Plan 065 B3/B4 through provider-aware
  output planning and actual software-output qualification. A 720p floor that
  failed is not a successful recommendation. Preserve the requested profile
  separately, expose the effective profile and failure, and do not silently
  alter per-target dimensions/fps. Shared and split roles must agree with the
  effective graph. Do not disable a destination to manufacture success.
- If a destination startup stall is causal, isolate/classify that output with
  a bounded connection policy while preserving other outputs according to
  existing product policy. Do not relax the positive-output proof globally.

Before code changes, write the minimal reproduction and expected before/after
result into this section. Add a failing regression at that exact seam, then
apply the fix. If the box cannot sustain any tested profile, return a truthful
unsupported/degraded result; do not report the incident fixed by hiding a toast.

Verify: rerun the failing case and neighboring matrix cases. Every claimed
supported case must produce analyzed video/audio and cleanly stop repeatedly.
Only after local evidence, perform a private/test broadcast to each provider
and combined with explicit operator-controlled destinations. Receiver/VOD
evidence is necessary for any claim that viewers receive it.

### 5. Complete acceptance and record limitations

Run `cargo fmt --check --all`, `cargo test -p videorc-backend`,
`cargo clippy -p videorc-backend -- -D warnings`, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm test:scripts`, desktop tests, and `pnpm build`.
Run `pnpm check:windows` on macOS for Windows compile coverage. In PowerShell 7
on Windows, run affected async/process filters at least 25 times and the full
Rust suite three times with bounded owned-child cleanup on failures.

Because the fix touches startup/encoding/audio, run `pnpm smoke:recording-studio`
and `pnpm smoke:record-latency`; add `pnpm smoke:recording-matrix` for profile,
fps or container changes. Run the applicable device gate and
`pnpm probe:preview-lifecycle` if preview lifecycle changes. Record unavailable
host/permission gates explicitly; cross compilation is not hardware evidence.
Run `pnpm smoke:local-gates:windows` on the candidate and retain its identity.
Follow existing acceptance rules; this plan authorizes neither release nor a
waiver of physical gates.

## Done criteria

- [x] Failed/cancelled startup persists a redacted bounded FFmpeg tail and
  session-owned diagnostics; reload/export tests prove it.
- [x] Both MF topology failure summaries retain stage/HRESULT under the cap.
- [x] Event-order regression suppresses post-failure active notices and keeps
  valid warnings for the new/running session.
- [ ] The precise Windows stall has a failing reproduction and a passing
  regression; hardware/configuration assumptions are recorded, not guessed.
- [ ] Original two-destination plus recording case passes analyzed A/V on
  affected hardware, or is explicitly recorded as still BLOCKED/unresolved.
- [ ] Applicable verification and Windows repeat gates pass. Missing physical
  evidence cannot be replaced with macOS tests or a fake receiver alone.
- [x] Only scoped files changed; plan index updated with actual status.

## STOP conditions and maintenance

Stop the dependent media-fix work if affected Windows hardware is unavailable,
the enhanced trace still cannot localize the stall, or a proposed change needs
new codec dependencies, licensing changes, or broad architecture work. Evidence
and notice fixes can be completed independently. Never weaken startup proof or
quality thresholds to make the matrix green. Recheck redaction and session
ownership when adding diagnostic fields or retry paths.

Not audited: general security/dependency posture, other platforms' media
pipelines, provider authentication, network reachability and the user's actual
saved/VOD media. No native Windows reproduction was run in this macOS session.

Investigation validation: bundle verifier passed; supplied degradation event
replayed through cached-main toast mapping 3/3 with the contradictory claim.
The local desktop test invocation ran the entire existing suite: 174 files,
1,742 tests passed, one skipped. That suite was the older local checkout and
does not validate the released Windows binary. No implementation smoke claimed.


## Follow-up: successful dual-destination attempt (2026-09-27)

Additional private evidence, not for commit:
`/Users/orcdev/Downloads/videorc-support-bundle-20260926-222840Z.json`.
Both bundles pass the maintained support-bundle verifier. The reporter clarified
that the second livestream went live on both YouTube and Twitch; Twitch used
OAuth. The first bundle was exported before that success. Do not characterize
this as a demonstrated Twitch OAuth failure or a success caused by removing a
destination.

The second bundle retains the original failure and adds:

| UTC session start | Mode | First confirmed FFmpeg output | Result |
| --- | --- | --- | --- |
| 22:12:14 | Record + YouTube + Twitch | No positive output before 8,000 ms deadline | Failed |
| 22:15:53 | Local recording only | 6,262 ms | Completed |
| 22:17:46 | Record + YouTube + Twitch | 6,352 ms | Completed, MP4 export recorded |

A new `Videorc backend ready` event at 22:17:20 precedes the successful
livestream, whose startup timeline says `cold=true`. Therefore this is not
controlled evidence that retry warmed the same backend. It includes an
intervening local recording and a backend restart. The successful livestream
used 1920x1080@30, microphone-worker timeout followed by DirectShow, rejected
Intel Media Foundation encoding, software OpenH264, and CPU composition.
Those fallbacks occurred in both outcomes; their presence alone does not
explain why one start failed. No OAuth rejection is recorded.

Successful output remains performance-constrained: final diagnostics report a
7.46 fps render-rate snapshot, 1,224 fresh and 1,496 repeated bridge frames,
and 5,922 ms maximum output-queue frame age. These are compositor/bridge
measurements, not a provider-received fps measurement or final-artifact A/V
analysis. The software/raw path's zero encoded-bridge frame counter does not
mean the FFmpeg recording contained zero frames.

The similar 6.26 s local-only and 6.35 s dual-stream first-output waits make
shared input/probing/encoding startup a priority for the controlled comparison.
They do not exclude an intermittent network stall on the failed attempt. The
successful stream had only 1.65 s headroom beneath the current output deadline;
do not claim extending that deadline fixes the root cause.

For step 3, add same-process retry versus backend restart as a controlled axis
while retaining the identical source/audio/destination graph. Instrument time
to input open, first audio sample, encoder initialization, each output open,
and first positive media clock. Compare the DirectShow fallback's input probing
with the owned video FIFO without changing all parameters at once. Current
code bounds MPEG-TS probing but leaves the raw-video/DirectShow path without
those explicit bounds; this is a lead for reproduction, not a proven cause or
permission to copy codec-specific flags blindly.

The failed attempt still has no stderr tail/final diagnostics. The immediate
stall cause remains unresolved without a reproducible Windows trace. Evidence
retention and terminal-state warning fixes remain independently established.
No product changes, Windows reproduction, release or fix verification are
claimed by this follow-up.


## Execution checkpoint

Implementation began 2026-09-27 in an isolated worktree from `b772cb59`.
The advisor/executor split preserves the original checkout. No release or
provider broadcast is authorized by this work.

Initial reproduction check: a real FFmpeg 8.1.1 process on macOS, paced raw
YUV420P video plus paced stereo PCM, x264/AAC to Matroska, produced first output
in 133/148 ms with default audio probing and 143/155 ms with explicitly bounded
audio probing. This does not reproduce the six-to-eight-second DirectShow
startup delay and does not justify changing capture flags. The input and
encoder differ from the affected Windows device; this is a limited negative
result, not Windows acceptance.

Windows availability audit: no configured SSH host, PowerShell or Parallels
command; installed VBoxManage path is a stale stub without VirtualBox.app;
repository self-hosted runner list is empty. Native Windows repeat gates and
Intel/DirectShow reproduction are currently unavailable. Independent portable
regression fixes and macOS gates proceed.


### Implemented scope and portable verification

Steps 1 and 2 have source changes in this worktree:

- A single early FFmpeg stderr reader retains a bounded, sanitized snapshot
  before startup awaits. Rejected/cancelled starts persist session diagnostics;
  successful starts transfer child/monitor ownership once. Cancellation before
  the monitor's first poll and a saturated relay retain evidence.
- Backend degradation notices require the matching active session. Renderer
  notices are dismissed at terminal state, and delayed callbacks cannot restore
  a warning for the failed session. Valid warnings on retry remain enabled.
- The start error exposes the timeout detail. Media Foundation summaries retain
  both attempt stages/HRESULTs and requested/effective profiles ahead of bounded
  driver names. E_UNEXPECTED no longer asserts a specific unproven cause.

No timeout, codec, bitrate, resolution, input probing or destination-selection
behavior was changed. Steps 3 and 4 remain open pending Windows reproduction.

Reviewer verification on 2026-09-27:

| Gate | Result |
| --- | --- |
| `pnpm test:scripts` | PASS: 1,595 tests, 267 suites. |
| `pnpm --filter @videorc/desktop exec vitest run --maxWorkers=2` | PASS: 223 files, 2,227 tests, 1 skipped. |
| StudioProvider integration file alone | PASS: all 108 tests. |
| `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | PASS. |
| `cargo fmt --check --all`, `git diff --check` | PASS at review checkpoint. |

The initial unrestricted desktop run, concurrent with cold native builds,
accumulated overlapping React act/timeouts and was interrupted. The changed
case plus its successor passed together, the entire provider file passed, and
then the complete suite passed with two workers. No test was disabled to get
that result. Native verification follows below.


### Native verification

- Final `cargo test -p videorc-backend`: PASS, 80 library + 2,461 backend
  + 1 integration tests; 10 ignored. The first run identified two outdated
  assertions for the changed copy/private retired-session history. Both were
  corrected without weakening replacement-session isolation, then the complete
  suite passed.
- Reviewer independently ran the final built test executable: `ffmpeg`
  69 passed/2 ignored; `published` 13 passed; `recording_degraded` 2 passed;
  MF compact failure regressions 2 passed; `retired_stderr_generation`
  3 passed. These cover cancellation, bounded evidence and replacement isolation.
- Final `cargo fmt --check --all`: PASS.
- `cargo clippy -p videorc-backend -- -D warnings`: PASS.
- `pnpm build`: PASS.

The final logging change also restores exactly one bounded, sanitized
`session-start-failed` reason after ownership transfers away from the row guard,
including the missing-audio-stdin rejection path. Explicit rejection and
cancellation preserve their reason; successful ownership transfer emits no
failure log. The complete final Rust suite passed again (same counts), and the
reviewer independently reran all 13 `published` regressions successfully.

Final clippy and Windows cross-compilation passed after this change. Native
Windows repetition and Intel hardware acceptance remain unavailable; a
cross-compile does not satisfy those gates. App smoke outcomes follow below.


### App smoke evidence and open timing failures

The maintained recording-studio sequence was resumed at failed prerequisites
instead of repeating already-passing steps. Prerequisite problems were local:
fixture FFmpeg needed x264 support; the addon builder expects its dylib under the
worktree target path; one launch began rebuilding after a final source edit and
exhausted its 90-second launch budget. The owned children were reaped. Final
source was explicitly prebuilt before the subsequent app checks.

Passed so far: FFmpeg live-audio controls, backend layout/scene/recording/audio
filters, CPU and Metal recording/stream scene-switch artifact analysis, freeform
editor (98 gestures plus recorded composition), live captions and noise cleanup,
all-layout recording artifacts, quit during blocked finalization, imported-image
screen switching/recording, normal-launch native first frame, layout/source
liveness, active-session layout switching artifacts, comment/caption stream
artifacts, detached Comments relay, backend scene commits, preview pump
diagnostics, and click/focus continuity.

The final binary's first five-cycle latency run produced valid analyzed
artifacts but FAILED its cold stop budget: click-to-idle 749 ms versus 300 ms.
The trace includes approximately 200 ms before the backend origin, 362 ms to
FFmpeg exit, and 422 ms backend stop total. The earlier checkpoint passed
(cold start 161 ms, warm-start p95 85 ms, warm-stop p95 103 ms). Do not attribute
the later miss to host load without evidence or erase it after a rerun.

Preview interaction stress also FAILED rapid-scenes timing: 491 ms presented
frame stall and 381 ms status sampling gap, both against 250 ms limits. Other
stress phases passed. The patch does not change preview operations before
recording, but causality has not been established by a controlled baseline
comparison. No timing threshold was changed. Remaining independent device and
lifecycle results, and the one planned isolated latency rerun, follow below.


### Final review checkpoint

Final-binary native tail passed: 100 detached-preview toggles, placement/docking,
surface reattachment, real ScreenCaptureKit recording with startup and final-file
analysis, and Notes invisibility in the recording artifact.

One isolated final latency rerun passed all five analyzed cycles with unchanged
budgets: cold start 193 ms, cold Stop 66 ms, warm-start p95 121 ms, warm-Stop p95
101 ms. Our compiles and other smokes were stopped. Shared host load remained
high, so this was not a controlled idle-host baseline. Keep the earlier 749 ms
cold Stop failure as observed variability; a passing rerun does not explain it.

All maintained recording-studio components have passing runs across the resumed
sequence, including the isolated final latency and preview-stress repeats. This
was not a single uninterrupted aggregate command: retain the prerequisite
failures and two initial timing misses above. Early successful app checks preceded
the last failure-log-only change; final unit suites, cross-compile, imported media,
native lifecycle/capture checks and isolated latency include that final change.

Review verdict: confirmed evidence/lifecycle fixes are implemented and reviewed;
full incident closure is BLOCKED by unavailable Windows reproduction/25-repeat
process filters/three full native suites. Timing variability remains documented;
no causal performance fix is claimed from the passing repeats. Do not claim the Intel rejection or original eight-second stall fixed.
No media-path parameters, timing thresholds or provider credentials were changed.
At the implementation handoff, the patch was uncommitted in
`/Users/orcdev/projects/videorc-wt-067`. The user subsequently authorized merging
the confirmed fixes. That merge does not close steps 3–4 or claim native Windows
acceptance. No release or broadcast is part of this incident task.


Final isolated preview interaction stress repeat: PASS, exit 0, report has no
failures. Rapid-scene stall was 24 ms; floating, resize and docked phases delivered
59.9, 59.8 and 59.6 fps respectively. Thresholds and source were unchanged.
Final latency also exited 0 after its harness timers drained. The temporary
`vendor/ffmpeg/current` symlink created for local smokes was removed; its original
FFmpeg target was untouched. Final Rust format and diff whitespace checks passed.


## Follow-on execution: remaining plan (2026-09-27)

The user explicitly requested execution of the entire remaining plan and a new
PR after steps 1–2 merged as PR #464 (`6ecca383`). Execute from `cfda7e6f`,
branch `fix/067-windows-incident-reproduction`, preserving the earlier fixes.
Drift review: subsequent changes add Orcle capture-listen resumption, caption
artifact accounting, and Linux-only VAAPI B-frame suppression in recording.rs.
Keep those changes. The Linux eight-second stall has a measured VAAPI-specific
fix; it is a lead, not proof of the Windows OpenH264/DirectShow incident cause.
PR #464's hosted Windows source gate and installer, Linux, Rust and JS gates
all passed. Its Windows workflow runs three full suites; the new startup
ownership filters were not included in its dedicated 25-repeat list.

Proceed with all independent remaining work: Plan 065 B0's bounded MF probe
and support-bundle inclusion, Plan 067's maintained incident matrix/reporting,
and hosted Windows verification. The hardware-dependent media fix must follow
a reproduced cause; unavailable affected hardware must not prevent building
these maintained reproduction tools. Request access or a tester-run report
while implementation continues.

Necessary supporting scope beyond the original allowlist: backend CLI entry
and a dedicated portable probe-contract module plus tests; support_bundle.rs;
a maintained MF probe wrapper/test; docs/windows-dev-loop.md; the existing
Windows source-gates workflow for probe execution and affected startup filters.
Use a bounded child-process attempt for driver probes that may hang, with
explicit readiness and owned cleanup. Do not alter shipping encoder choices
merely to expose diagnostic variants. Do not publish or broadcast to real
providers. Local RTMP endpoints must be runner-owned and verified loopback.

Keep existing protected performance scenarios and acceptance thresholds intact;
add a separate selectable incident matrix in the maintained runner. Cover
record-only, one and two local receivers, record plus two receivers; 1080p30
and 720p30; controlled audio and the real/injected worker-fallback path;
same-process retry and backend restart, at least three repetitions. Retain
failed-start evidence, exact candidate/driver/config identity, observable media
milestones, analyzed final artifacts, and explicit unknown/blocked evidence.
A probe completing without an encoder on hosted Windows is a successful
measurement, not a claim of hardware encoding support.

The existing STOP condition continues to govern dependent media-policy fixes.
If affected hardware remains unavailable, finish and open a reviewable PR for
all independently executable work, with unfinished acceptance explicit rather
than declaring the entire incident solved. This user request authorizes commits,
push and PR creation for this branch, not merge or release.


Follow-on scope clarification: `session_audio.rs` may add a diagnostic-only
worker-open failure hook, compiled only for Windows debug builds and requiring
both `VIDEORC_ENABLE_SMOKE_RPC=1` and a dedicated incident flag. It must enter the
existing fallback path, retain explicit injection evidence, and have gate tests.
Release builds ignore it. The runner must verify observed fallback and refuse to
claim coverage when the hook or real microphone is unavailable. This is
reproduction instrumentation, not a shipping media-policy change.

The user confirmed no Windows PC is currently available. Hosted Windows can
exercise the controlled-audio diagnostic cases and no-encoder probe behavior;
physical worker/DirectShow and affected Intel acceptance must remain BLOCKED.


### Follow-on review checkpoint before hosted execution

Implemented diagnostic commands (verification still in progress):

```powershell
pnpm smoke:windows-mf-probe -- --output "$env:TEMP/mf-probe-evidence"
pnpm smoke:windows-stream-performance -- --incident --list
pnpm smoke:windows-stream-performance -- --incident --audio controlled --output "$env:TEMP/incident-controlled-new"
```

The selectable incident matrix contains 48 cases / 144 attempts. The existing
protected matrix remains 19 scenarios / 55 measured runs. The new mode labels
its backend-only, synthetic-source evidence separately from installed-candidate
qualification. Physical worker/DirectShow cases require a real selected mic;
controlled tone is not a substitute for their acceptance.

Independent review checks so far: Node logic suite 1,603 passed; desktop unit
suite 2,296 passed / one skipped; TypeScript, lint, desktop build and both
modified Windows workflows' actionlint pass. The non-Windows incident invocation
exits 2 and persists BLOCKED with zero spawned groups. These are checkpoint
results, not the final native or hosted Windows result. Newly added runner
regressions will be rerun after the implementation freezes.

Review corrections include complete-line READY parsing, redacted launch errors,
immutable incident output directories, exact process ownership, independent
receiver cleanup, atomic partial MF reports, and bounded optional report loading.
No causal encoder/profile/timeout change has been justified or made.


### Reviewed implementation and acceptance record

PR #472 contains the B0 MF tool, incident matrix, debug-only fallback injection,
standalone Windows diagnostic backend artifact, and hosted control/repeat gates.
The independent implementation is complete. The affected-machine reproduction
and the dependent causal media fix remain BLOCKED because the user has no
Windows PC available. No profile/codec policy or startup timeout was changed.

Review follow-ups validate MF reports before atomic publication, normalize
unknown/short source revisions, list optional evidence in support export results,
keep optional adapter metadata failures nonfatal, and prevent natural microphone
fallback from being counted as worker success. A generated moving file with an
entirely silent audio track demonstrated a false pass in the shared analyzer's
lead/tail exclusion; incident-only audible-interior validation now rejects it.
Both receiver timings carry their actual observation origin. The 100 ms tail
bound and physical audible-input requirements are explicit. Independent hosted
incident runs continue after MF probe failure when their build prerequisites pass.

Before the final-head CI restart, local verification passed: 1,613 Node tests;
2,296 desktop tests (one skipped); native Rust 2,543 backend tests (10 ignored),
80 helper tests and one wire test; strict clippy; Windows cross-check; TypeScript;
lint; format; desktop build; actionlint and explicit new-file formatting. The
report/export follow-up receives another native check. Shadscan baseline/floor
was 37 and the initial pre-commit score was 37.

The recording-studio run passed scene-switch CPU/Metal recording+stream pixel
artifacts, pointer continuity (98 gestures), captions transport and live artifacts,
noise-cleanup final artifacts and all-layout recording. Its latency gate passed
five analyzed 1080p artifacts: cold start/stop 116/103 ms, warm start/stop p95
78/92 ms. The latency process exited naturally after its existing timer drained;
no app/backend leak or workaround occurred. Remaining native-smoke and hosted
Windows results are recorded in the PR's verification section and checks, which
are the live acceptance record for this implementation. This checkpoint is not
a claim that affected Intel/DirectShow or real provider acceptance has passed.

### Hosted-control diagnosis follow-up

The Windows source gates, installer, JS, Rust and Linux checks passed on
`16c1e6b0`; the incident artifact matrix remained red. Retained native PCM
artifacts showed load-sensitive silence and overlapping sample timestamps.
A deterministic regression identified cumulative clock drift in the debug
synthetic microphone: late wakes reset its deadline while sample timestamps
continued at the original rate. The fixture now preserves its sample schedule,
with bounded catch-up and explicit accounting for expired samples. This is a
fixture correction, not a change to physical microphone clock policy.

The matrix adds an independent, explicitly gated debug FFmpeg tone control,
bringing selectable coverage to 64 cases / 192 attempts. Hosted CI retains
both 48-attempt synthetic controls separately, including failures. Neither
control qualifies physical microphone or Intel Quick Sync behavior.

Review also found that FLV stream durations can be absent, leaving the previous
duration-based tail metric unknown. Incident validation now measures terminal
audio/video packet ends and fails closed when timing cannot be measured. The
100 ms bound remains unchanged. A real generated FLV regression covers both
aligned and excessive audio tails. Earlier receiver passes with unknown tails
are not acceptance evidence for that bound. Final results remain in PR #472.

### Clean preview rerun and remaining hosted failures

The user confirmed closing the test app during the earlier preview failures.
With its windows left open, all 100 lifecycle cycles passed, as did the remaining
studio components, including native reattachment and real ScreenCaptureKit
recording analysis. The corrected freeform smoke waits for native surface
readiness and sends valid CDP mouse-button state. Its latest full run passed all
98 gestures and recording composition, but failed the unchanged landscape
cadence bound: 36 ms versus 33 ms. The aggregate is not recorded as green.

The `c3f7f38c` hosted native PCM matrix completed all 48 starts and owned cleanups,
with 18 artifact passes and 30 failures. The clock correction reduced generated
silence in one representative 1080p attempt from about 10.4 seconds to about
1 ms. Remaining failures include measured silence, repeated frames and audio
tails; these are retained as failures. A representative 720p tail had all 378
supplied frames encoded, so encoder frame dropping alone does not explain it.

Review also corrected Windows sibling tool discovery: an explicitly selected
`ffmpeg.exe` now resolves its matching `ffprobe.exe`, and the incident runner
passes both exact tool paths to the backend. This repairs a proven discovery
defect; it does not establish that live RTMP tails are fixed.

A bounded standalone OpenH264 comparison now precedes backend compilation in
Windows CI and preserves paired outputs, exact tool/input hashes, frame counts,
packet tails and bitrate measurements. Local FFmpeg 8.1.1 / OpenH264 2.6 evidence
with a terminal noise burst reproduced 12–13 dropped frames and 375–408 ms tails
with skipping enabled. Disabling it retained all 90 frames and reduced tails to
8 ms, but the 1080p case averaged 10.96 Mbps against a requested 6 Mbps and
exceeded the measured two-second rate-plus-buffer envelope. Neither setting is
qualified by this diagnostic. Shipping frame-skipping policy is unchanged;
the paired Windows run and the independent tone matrix remain separate evidence.
