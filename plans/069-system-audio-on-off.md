# Plan 069: System audio, on or off (the computer's sound in recordings and streams)

> Executor: implement the ordered slices below in an isolated worktree of current
> main. Read AGENTS.md and `.claude/skills/videorc-design/SKILL.md` first. Keep
> each slice independently testable. Planning authorizes no merge or release.
> This plan supersedes plan 017 and `docs/system-audio-capture-plan.md`. Both
> predate the session audio bus (`session_audio.rs`) and are stale.

## Status and decisions

- Status: **IMPLEMENTED (macOS) 2026-09-28** on `feat/069-system-audio`, S0 to
  S7. The S7 gates are green: `pnpm smoke:system-audio` passed 3 runs in a row,
  and end-to-end o_sys is within gate, so `SYSTEM_AUDIO_SYNC_OFFSET_MS` stays 0.
  Owner acceptance on the packaged app is owed:
  `docs/acceptance/2026-09-28-system-audio.md`. That doc also lists two findings:
  - Library Play opens the default external player, so System audio records it.
  - Orcle has no voice output today.

  Windows S8 is in progress on `feat/069-windows-system-audio`. Planned
  2026-09-27. Priority P1. Effort L+ (about 7 agent-days over 9 slices; S8
  Windows is its own PR). Risk HIGH: S2 changes the session audio bus that every
  macOS session and every Windows worker session writes through.
- Planned against desktop `origin/main` `5aa38286` (0.9.118). Paths are
  relative to `crates/videorc-backend/src/` (Rust) or
  `apps/desktop/src/renderer/src/` (renderer, "R/") unless they start with
  `apps/`, `scripts/`, `docs/` or `protocol-fixtures/`. "S/" is
  `apps/desktop/src/shared/`.
- Owner ask, 2026-09-27: "an option to turn on and off system audio so we can
  hear sound from the computer directly in the video... Make a proper plan for
  how to add system audio in Video Orc and have it be optional, on and off."
- Owner route: Orchestrator (fit 10): capture, the audio bus, the session
  graph, protocol and UI. Model lanes: S0, S2, S3, S4, S8 `fable-5`; S5
  `opus-4.8` (UI, copy); S1, S6, S7 `gpt-5.5`. In a harness without `gpt-5.5`,
  use `opus-4.8` for those slices.
- Commits: `feat(audio):` for backend and protocol, `feat(mixer):` for UI.
  One macOS PR (S0 to S7), one Windows PR (S8).

### Why it "disappeared"

Videorc never had working system audio. The Studio mixer once showed a
"System Audio" row. It was a placeholder device
(`system-audio:native-adapter-pending`, `devices.rs:340-350`) that was
always "Unavailable". `37b28f13` (in `f1beb51b`, #375, 2026-09-21) removed
that row because a permanent Unavailable badge looked like a fault. The
placeholder is still on the wire.

### What exists today (measured)

- **Nothing captures system audio on any platform.** The one ScreenCaptureKit
  stream sets `setCapturesAudio(false)` (`preview_screen.rs:5408`). Its
  delegate drops every non-screen buffer (`preview_screen.rs:4978-5018`).
  No WASAPI code exists, and the `windows` crate lacks `Win32_Media_Audio`
  (`Cargo.toml:65`). Linux deliberately filters out `.monitor` sources
  (`linux_pulse_audio.rs:71`).
- **The screen SCStream can't carry the audio.** There is one global screen
  stream (`PreviewScreenRuntime`, `preview_screen.rs:125`). It restarts on
  every screen-source switch, and it stops when the scene has no screen
  source (`retire_unused_sources_after_commit`, `live_layout.rs:2061-2087`).
  System audio needs its own SCStream with its own lifecycle.
- **Bindings are already in the tree.** `objc2-screen-capture-kit 0.3.2`
  exposes `setCapturesAudio`, `setExcludesCurrentProcessAudio`,
  `setSampleRate`, `setChannelCount` and `SCStreamOutputType::Audio`.
  `objc2-core-media` supplies the CMSampleBuffer access. No new crate is
  needed on macOS.
- **Permission.** SCK audio uses the Screen Recording grant the app already
  asks for (System Settings calls it "Screen & System Audio Recording"; see
  `docs/releases/release-runbook.md:395`). No new entitlement or usage
  string is needed. CoreAudio process taps would need
  `NSAudioCaptureUsageDescription`, which is missing from
  `apps/desktop/electron-builder.yml:80-86`, plus macOS 14.2. The app
  supports macOS 13+ (`README.md:18`).
- **The session audio bus handles one source.**
  - `session_audio.rs` runs one `AudioTimeline` with one `SourceClock` (60 s
    drift regression, ratio clamp 0.999–1.001). It is paced by the wall
    clock from `video_epoch + PLAYOUT_DELAY(50 ms)`.
  - Gaps render as zeros (`render_with_provenance`, :226-262). Output is one
    48 kHz stereo f32le FIFO (`run_bus_owned`, :1836-2283).
  - On macOS every mic path ends in this bus: CoreAudio native, the
    AVFoundation worker, and the paced-silence writer when no mic is
    selected (`recording.rs:3129-3289`).
  - On Windows the worker path uses the bus. The DirectDshow fallback and
    Linux Pulse are direct FFmpeg inputs and bypass it.
- **Mic processing is applied to the whole chunk at write time.**
  `write_chunk_with_clock` (:2290) runs `process_interleaved_f32`
  (`audio.rs:821-854`) on the rendered chunk. That call applies gain and
  mute and also folds the chunk to "dual mono" (`centered_voice_sample`,
  `audio.rs:1020`). A mixed chunk would be mono-folded and take the mic's
  mute and gain.
- **Global producer cap `PRODUCER_LIMIT = 2`** (`session_audio.rs:289-332`).
  Mic hot-swap needs both slots. An always-on system producer in the same
  pool would break live mic switching.
- **Stall = loss.** A producer silent for `NATIVE_AUDIO_SOURCE_STALL_TIMEOUT
  = 2 s` (`audio.rs:36`) is retired as lost. A system-audio source that
  delivers no buffers while nothing plays would be killed by this rule.
- **One audio input per FFmpeg process, shared by every leg.** Record, tee,
  copy fan-out, and split output (caption split and vertical simulcast) all
  clone the one bus input (`recording.rs:15524`, :15566, :15722, :16174).
  Audio mixed in the bus therefore reaches the file and every stream leg
  with no FFmpeg graph change.
- **Mic sync offset shifts the whole track.** `capture_audio_filter`
  (`recording.rs:16827-16875`) applies `adelay` (positive) or `atrim`
  (negative) to the single track, and only when a Microphone track exists.
  Stream legs add `STREAM_OUTPUT_AUDIO_ADVANCE_MS = 130` (:824).
- **Captions, Orcle and voice activity hear the bus output.**
  `offer_caption_frame` (`session_audio.rs:2244`) receives the post-gain,
  post-mute chunk. Consent copy says "your microphone audio"
  (`R/lib/cohost-view.ts:49,53,768,772`; `captions-controls.tsx:250,500`;
  `captions-reader.tsx:98`).
- **Meters.** `stats.record_live_peak` (:2232-2243) feeds `micLiveLevel` and
  `micLivePeakDb` on the 1 Hz `diagnostics.stats` event. The Studio mixer's
  mic bars come from a renderer WebAudio analyser that can only open the
  mic, so a system-audio meter must use levels from the backend.
- **Settings are renderer-only.** `captureConfig.audio` lives in the
  localStorage key `videorc.captureConfig`. `normalizeAudioSettings`
  (`R/lib/capture.ts:1396-1422`) rebuilds the object field by field, so a
  new field is dropped silently unless it is added there.
  - `session.start` sends `audio` loosely
    (`S/backend-rpc-contract.ts:1742`).
  - Live changes go through `audio.processing.update`
    (`recording.rs:2485-2560`).
- **Traps.**
  - `sourceSelectionSchema` is strict (`allowUnknown: false`,
    `S/backend-rpc-contract.ts:791`).
  - `optionalSchema` rejects `null` (`S/runtime-schema.ts:218`); see the three
    outages, including `docs/releases/0.9.80.md:8-16`.
  - `app-shell.tsx:100` reports ready only when the device list is
    non-empty, and the system-audio device guarantees that on a machine with
    no camera or mic. The device must stay on the wire.
- **Noise cleanup is a Library job, not live.** It refuses files with more
  than one audio track (`noise_cleanup.rs:47`).

### Decisions (the recommendation is taken)

1. **One switch: System audio On/Off. Default Off.**
   - Off means not captured at all: no SCStream audio, no loopback client.
     A muted-but-running capture is not "off", because notifications, calls
     and music are private.
   - On mixes everything the computer plays, except Videorc's own sounds,
     into the recording and every stream leg.
   - The name is "System audio", the owner's word. OBS says "Desktop Audio".
2. **The switch works any time, including mid-session.**
   - Turning it on mid-session starts capture and attaches it to the running
     bus.
   - Turning it off ramps the source to zero over 5 ms and stops capture.
   - There is no separate mute; On/Off is the mute.
   - This reuses the bus's chunk-boundary handoff and zero ramp
     (`ramp_through_zero`, `session_audio.rs:1782`).
3. **Mix in the Rust bus, not with FFmpeg `amix`.**
   - The bus already owns pacing, drift, gaps and the video-epoch trim.
     `amix` would add a second clocked FFmpeg input per session and graph
     changes for every leg shape. It would also need FFmpeg restarts to
     toggle live.
   - Each source gets its own timeline, clock, gain and enable ramp. They are
     summed at render.
4. **One mixed track everywhere.**
   - Platforms accept one audio track.
   - Local files keep one track too, so the Library, Noise cleanup, clips and
     the editor keep working.
   - Separate stems (mic and system as separate tracks in the MKV) are a
     later plan.
5. **Captions, Orcle and voice activity stay mic-only.**
   - The caption tap moves to the mic source before the sum, with the mic's
     gain and mute applied. That is the same signal as today.
   - Game audio and music would pollute transcripts, and the consent copy
     would become false. No consent string changes.
6. **Mic-only output stays bit-identical.** When system audio is off and was
   never attached in the session, the bus writes exactly the bytes it writes
   today:
   - the mic is folded and gained as before;
   - no limiter;
   - the offset handling is unchanged (decision 8).

   A unit test pins this.
7. **Headroom.**
   - System audio defaults to -6 dB, adjustable from -24 to +12 dB in
     Sources. Games and music are mastered near 0 dBFS and voice sits
     around -18, so -6 keeps the voice on top.
   - The sum passes a peak limiter: -1 dBFS ceiling, instant attack, 50 ms
     release. It runs only while a system source is attached, and clipped
     samples are counted for Diagnostics.
   - The mic stays mono-folded. System audio stays stereo.
8. **Sync.** Each source s has an offset `o_s` in ms: positive delays the
   audio, negative advances it.
   - `o_mic` is the user's `microphoneSyncOffsetMs`. `o_sys` is a backend
     constant measured in S0; it is not a user setting in v1.
   - The FFmpeg whole-track shift becomes `min(o_mic, o_sys)`, fixed at
     session start whether or not system audio is on at start, so a live
     toggle never needs an FFmpeg change.
   - Each bus source gets a non-negative delay of `o_s - min(o_mic, o_sys)`.
   - The bus can only delay, never advance (it plays out 50 ms, or 150 ms
     per decision 13, behind the wall clock). This split keeps every bus delay at zero or above.
   - When `o_mic <= o_sys` the mic path is byte-identical to today.
9. **Own-app exclusion.**
   - macOS: filter by display with `excludingApplications` set to every
     running application whose bundle id starts with Videorc's (the Electron
     main process and helpers), plus `excludesCurrentProcessAudio`.
   - Windows: WASAPI process loopback in
     `PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE` mode, rooted at the
     Electron main PID.
   - Library playback, Orcle voice and UI sounds therefore never land in the
     recording.
   - **Amended after S0.** Excluding the app does not silence Chromium or
     Electron renderer audio. It plays from the out-of-process audio service
     helper, which SCK neither lists nor attributes to the app. On macOS the
     Electron main process therefore appends
     `disable-features=AudioServiceOutOfProcess`, so renderer audio plays
     from the main process. The SCK filter then excludes the Electron main
     app, found by the backend's parent PID.
   - S5 and S7 re-check Library playback, the mic meter and Orcle with the
     flag on. If the flag breaks any of them, STOP: the only other route is
     CoreAudio process taps (macOS 14.2+).
   - **S7 re-check (2026-09-28): the flag breaks nothing.**
     - With the flag, no out-of-process audio service runs.
     - Renderer `getUserMedia`, WebAudio analysers and media elements all work,
       and renderer audio is excluded (`smoke:system-audio` case `self`).
     - But the Library's Play button opens the default external player, which
       is not Videorc, so it IS recorded.
     - Orcle has no voice output.
     - See `docs/acceptance/2026-09-28-system-audio.md`.
10. **Platforms.**
    - macOS 13+ ships first, through ScreenCaptureKit.
    - Windows 11 follows in S8 through WASAPI process loopback.
    - Linux is out of scope (see Out of scope); its row stays hidden.
    - Where the source isn't supported, the row is hidden, never shown as a
      permanent "Unavailable" (the #375 lesson).
11. **Silence is not loss.** The system producer is exempt from the 2 s
    stall rule. Its liveness comes from the platform: the SCStream delegate
    `didStopWithError`, or the WASAPI device-invalidated result. It has its
    own producer pool (limit 1) and its own cleanup counter, so it never
    blocks mic admission or mic hot-swap.
    - PR #477 review: its freshness is judged by arrival, not by its PTS (an
      output clock that runs fast must not drop every buffer in silence).
      Buffers that keep arriving but can't be placed for 2 s are a loss
      (`system-audio-lost`), and one bad SCK buffer is dropped, not a loss.
    - Its close ticket is kept apart from the mic's, so a mic retry never
      waits on a closing system capture.
12. **It never slows Record.** System audio attaches late:
    - the session starts on the mic timeline exactly as now;
    - the system source joins when its first buffer arrives, usually
      100–300 ms in;
    - the bus renders zeros for it until then.

    `smoke:record-latency:gate` budgets must not move.

    A delayed startup burst whose early frames are already behind the
    cursor is trimmed, not queued.
13. **Playout headroom (added after S0).** SCK delivers buffers 22–52 ms
    after their last sample (median 35 ms), with startup bursts up to
    665 ms.
    - At the bus's 50 ms playout delay, about 31% of system frames would
      land behind the cursor, which means constant crackle. At 150 ms the
      loss is at most 0.45%, all from startup bursts.
    - Sessions on a platform that supports system audio therefore run the
      bus at `PLAYOUT_DELAY = 150 ms`, fixed at session start, whether or
      not the switch is on.
    - This changes only write timing. The FFmpeg input stays timestamped
      by sample count, so mic-only PCM bytes stay identical. S2 proves that,
      and S4 proves `smoke:record-latency:gate` stays green.
    - Measured `o_sys = 0 ms` (S0: system audio trails the screen by
      +5.6 ms on average at capture level). S7 re-measures it end to end.
    - PR #477 review: on stop the bus keeps writing until its cursor reaches
      the stop instant (flushed 60 ms after stop, bounded at playout +
      100 ms), so the playout delay costs no tail audio. stop→idle stayed
      in budget (`smoke:record-latency:gate` warm p95 116 ms).
    - A positive mic offset is a bus delay D, so a mic hot-swap may take
      up to 1 s + D + playout before it cancels.

## Slices

### S0. Spike and measurement: an audio-only SCStream (fable-5, Diagnose)

Goal: prove the macOS capture assumptions before building on them. Output is
an acceptance doc, not shipped code.

- Build a throwaway, debug-only capture behind
  `VIDEORC_SYSTEM_AUDIO_SPIKE=1`. It can be a `cargo test -- --ignored` or a
  bin under `src/bin/`, and it is deleted or promoted in S3.
  - Start an SCStream with a display filter that excludes Videorc's apps.
  - Set `capturesAudio = true`, `excludesCurrentProcessAudio = true`,
    `sampleRate = 48000`, `channelCount = 2`.
  - Keep the video config minimal (2×2 px, 1 fps) and add **only** an
    `SCStreamOutputType::Audio` output.
  - Write 30 s of PCM to a WAV.
- Answer and record each of these in
  `docs/acceptance/2026-09-xx-system-audio-spike.md`:
  1. Does the audio-only stream start without a Screen output, with only the
     existing Screen Recording grant, on macOS 13 and on the owner's current
     macOS?
  2. What is the buffer format (float or int, interleaved or planar,
     frames per buffer)? Is it exactly 48 kHz stereo?
  3. While nothing plays, does SCK deliver silent buffers or none at all?
     (Decision 11 assumes either can happen.)
  4. Is capture affected by the output volume, by mute, or by a Bluetooth or
     USB output device?
  5. Is Videorc's own audio excluded? Test with Library playback in the app.
  6. Measure `o_sys` with the existing stimulus
     (`scripts/lib/av-sync-stimulus.mjs`: a Chrome window that flashes and
     clicks each second, now captured digitally) and `measure:av-sync`.
     Report it against the screen video in a recording, over 3 runs.
  7. How does CMSampleBuffer PTS (host-time clock) map to `Instant`? Write
     down the exact conversion.

**Done when:** all seven answers are recorded with evidence, `o_sys` is
stable within ±15 ms across runs, and no product code has changed.

**STOP** if the audio-only stream needs a new permission, can't start
without a Screen output, or `o_sys` varies by more than 40 ms between runs.

### S1. Protocol, settings and a real device status (gpt-5.5)

- **`AudioSettings`** (`protocol.rs:1177-1186`) and the S/ mirror (S/backend.ts:1385):
  - Add `system_audio_enabled: bool` and `system_audio_gain_db: f32`, each
    with `#[serde(default)]`. The gain default is -6.0 via a fn default.
- **`AudioProcessingUpdateParams`** (:1198) and its mirror:
  - Add optional `system_audio_enabled` and `system_audio_gain_db` with
    `skip_serializing_if = "Option::is_none"`.
  - The TS side uses `optionalSchema(...)`.
- **`AudioTrackSource`** (:355) and its mirror: add `SystemAudio`.
- **`AudioTrack`**: add optional `mix_sources: Vec<AudioTrackSource>`, with
  skip if empty. It reports the sources currently in the one mixed track.
  Do not change the track `id` or its title metadata.
- **`diagnostics.stats`**: add optional `systemAudioLiveLevel`,
  `systemAudioLivePeakDb`, `systemAudioCapturedFrames`, `systemAudioActive`
  and `audioMixClippedSamples`. On the TS side use
  `optionalSchema(nullableSchema(...))`; in Rust, `skip_serializing_if`.
- **Device.** Replace `system_audio_placeholder()` with
  `system_audio_device()`: id `system-audio:default`, name "System audio".
  - The status comes from a platform probe. On macOS that is the Screen
    Recording preflight, the same check `system-access` uses.
  - Values: Available, PermissionRequired, or Unavailable (unsupported
    platform).
  - Keep it on the list on every platform (the `app-shell.tsx:100`
    readiness rule). Update the `devices.rs:1236` test and the comment at
    `R/lib/capture.ts:2505`.
- **Renderer.**
  - Add the fields to the defaults (`capture.ts:1228-1235`) and to
    `normalizeAudioSettings`: clamp the gain, and default `enabled` to
    false.
  - `session-params.ts` passes them through.
  - `live-audio-processing.ts` carries them on the latest-wins queue.
- **Fixture.** Update `protocol-fixtures/high-risk-contracts.json` and prove
  it in both suites.
- **Nothing reads the new fields yet.** The backend accepts and ignores
  them.

**Done when:** the Rust serde round trips pass, including the omitted-key and
explicit-false cases. The TS contract tests pass, including a `null`
rejection proof and old configs loading as Off at -6 dB. The fixture passes
in both suites.

**Verify:** `cargo test -p videorc-backend protocol`,
`cargo test -p videorc-backend devices`,
`pnpm --filter @videorc/desktop test -- capture backend-rpc-contract protocol-contract-fixtures live-audio-processing session-params`,
`pnpm typecheck`, `pnpm lint`.

### S2. The bus mixes sources (fable-5), the riskiest slice

Change `session_audio.rs` from one timeline to N source slots (mic,
system). Pure logic, no platform code:

- **`SourceSlot`**:
  - own `AudioTimeline`, `SourceClock`, producer and generation;
  - own processing handle (`AudioProcessingSettingsHandle`);
  - own enable ramp and own non-negative bus delay in frames (decision 8);
  - a `SourceRole::{Microphone, System}`.
- **Mic slot.**
  - Keeps today's fold, gain and mute (`process_interleaved_f32`), applied
    to the mic's rendered chunk before the sum instead of to the whole
    chunk.
  - Mic hot-swap (`PendingHandoff`, :1643-1780) stays scoped to the mic
    slot.
- **System slot.** Gain only, stereo preserved, no fold.
- **Late attach and live detach.**
  - `SessionAudio::attach_system(producer)` and `detach_system()` switch at
    a chunk boundary with the 5 ms zero ramp.
  - An attach that races stop is refused cleanly.
- **Sum.**
  - Mic + system, then the peak limiter (decision 7), only while a system
    slot is attached.
  - Clipped samples are counted.
  - With no system slot ever attached, the write path is the old path.
- **Caption tap.** `offer_caption_frame` moves to the processed mic chunk,
  pre-sum. Voice activity follows it.
- **Stats.**
  - The mic live peak comes from the processed mic chunk, not the sum.
  - Add a system live peak, captured and generated frames, and a clip
    counter.
- **Producer pool.**
  - Add a separate system pool (limit 1) and a separate owned counter, so
    `cleanup_pending` and mic admission ignore system producers.
  - Exempt the system role from the stall retirement; it retires on an
    explicit platform-failure signal only.

**Tests** (deterministic, synthetic producers):

- mic-only output is bit-identical to the pre-change writer over 10 s of
  fixture PCM (golden bytes);
- mixed sum and limiter ceiling, and the clip counter;
- system stereo preserved while the mic is folded;
- per-source gain; mic mute does not mute system, and system off does not
  mute the mic;
- late attach at t=300 ms is silent before and aligned after;
- detach ramps to zero, with no click (max step ≤ the ramp slope);
- system silence for 10 s does not retire the producer;
- a system producer does not block a mic hot-swap;
- the caption tap receives mic-only samples while system is loud;
- pre-epoch trim applies per source;
- per-source bus delay shifts by exactly N frames.

**Done when:** all new tests pass and the existing `session_audio` and
`audio` tests pass unchanged.

**Verify:** `cargo test -p videorc-backend session_audio`,
`cargo test -p videorc-backend audio::`, `cargo clippy -p videorc-backend -- -D warnings`,
`cargo fmt --check --all`.

### S3. macOS system-audio producer (fable-5)

- **New `system_audio_capture.rs`** (`cfg(target_os = "macos")`). It owns an
  audio-only SCStream on its own dispatch queue, per S0.
  - Convert each audio CMSampleBuffer into an `AudioFrame` of 48 kHz,
    stereo, interleaved f32. `timestamp_micros` comes from PTS, and
    `captured_at` uses the S0 host-time mapping.
  - Push with `try_send` into a bounded channel. Drops are counted.
  - Map `didStopWithError` to a typed failure that the bus reads as
    "system source lost".
- **Pure helpers with tests:**
  - planar to interleaved, int to float if S0 saw ints, and the channel map;
  - PTS to `Instant` mapping;
  - the error to `DeviceStatus` and health-kind mapping;
  - the exclusion list builder (bundle-id prefix match against a
    fixture list).
- **Availability probe** for S1's device status. It never starts a stream
  just to list devices.
- **Wrap as `ProducerSource::system(...)`** so it plugs into S2's slot.
- **Promote or delete the S0 spike.** If it is kept, make it a
  `scripts/`-backed probe with a package script, per AGENTS.md.

**Done when:** the pure tests pass. A debug-only capture test (ignored by
default, run locally with the Screen Recording grant) captures a tone played
with `afplay`, and the tone's peak is above -30 dBFS.

**Verify:** `cargo test -p videorc-backend system_audio`, clippy, fmt,
and the ignored local capture test.

### S4. Sessions use it: start, toggle live, every leg (fable-5)

- **Session start** (`recording.rs:3129-3289`):
  - If `audio.system_audio_enabled` and the device is Available, prepare the
    system producer asynchronously after the bus attaches, and
    `attach_system` on first buffer (decision 12).
  - System-only sessions use the paced-silence mic path plus the system
    slot, so the bus is always present on macOS.
- **Live toggle.** `update_active_audio_processing` (:2485) handles the new
  fields:
  - `enabled` true starts and attaches;
  - `enabled` false detaches and stops;
  - a gain change goes to the slot's handle;
  - it is idempotent and latest-wins.
- **Offsets.**
  - `capture_audio_filter` uses `min(o_mic, o_sys)` whenever the platform
    supports system audio.
  - It applies whenever the session has a bus audio source, not only a
    Microphone track.
  - The bus gets the per-source delays (decision 8).
  - Pin with arg-builder tests: mic-only with `o_mic <= o_sys` produces
    unchanged args.
- **Track list.**
  - `capture_audio_tracks` reports `mix_sources`.
  - `recording.status` re-emits when a toggle changes it.
- **Health events** on `health.event`:
  - `system-audio-unavailable`: the permission is missing or the stream
    failed to start. Copy points to Settings → Permissions.
  - `system-audio-lost`: the stream stopped mid-session. The session keeps
    running on the mic.
  - `system-audio-mic-fallback-bypass` (Windows only, S8): the mic fell
    back to a direct dshow input, so system audio can't mix this session.
- **Stats.** `sample_native_audio_during_recording` (:7659) and
  `apply_audio_stats` (`diagnostics.rs:2124`) publish the S1 stats fields.
- **Legs.** No graph change is expected. Tests assert that record-only, tee,
  copy fan-out and split output (the vertical simulcast leg) all still map
  the single bus input.

**Done when:**

- the Rust tests cover: start on, start off then toggle on, toggle off
  mid-session, a permission-missing start (health event, session continues),
  lost mid-session, offset arithmetic, and the track list;
- `pnpm smoke:recording-studio` is green;
- `pnpm smoke:record-latency:gate` is inside budget with system audio on
  and with it off.

**Verify:** `cargo test -p videorc-backend recording`, clippy, fmt,
`pnpm smoke:recording-studio`, `pnpm smoke:record-latency:gate`.

### S5. The switch in the UI (opus-4.8, UI/Product Design)

Follow `.claude/skills/videorc-design/SKILL.md`: shadcn only, icons from
`@/components/icons` only (reuse `WaveformIcon`, `SpeakerOnIcon` or
`DesktopIcon`; the Nucleo licence is capped at 100 glyphs), no em dashes,
no toasts on routine toggles.

- **Studio audio mixer** (`R/components/studio/audio-mixer.tsx`):
  - Add a System audio row under the mic row, in the same row styling.
  - The row has an icon, the "System audio" label, a `Switch size="sm"`,
    and a 28-bar meter driven by `systemAudioLivePeakDb`. The meter shows
    only while a session is running and the switch is on. When idle, the
    row shows "Off" or "On".
  - Hide the row when the device is Unavailable.
  - When the status is PermissionRequired, the row shows "Needs Screen
    Recording permission" with a ghost button that calls
    `openSettings('permissions')`. The switch is disabled.
- **Sources panel** (`R/components/tabs/sources-tab.tsx:403-470`):
  - Rename "Microphone mixer" to "Audio mixer".
  - Add a System audio switch and a level slider (-24 to +12 dB, default
    -6).
  - One-line helper text: "Everything your computer plays, except Videorc.
    Use headphones so your mic doesn't pick it up twice."
- **Quick settings** (`R/components/studio/quick-settings.tsx:184-235`): add
  a System audio on/off row beside Mic.
- **Live sessions.** The switch works during a session through
  `audio.processing.update`.
  - The UI shows the confirmed state from `recording.status` `mix_sources`,
    not the optimistic click.
  - On `system-audio-lost` the switch stays On and the row shows the
    health copy.
- **Permissions tab.** The Screen Recording row says it also covers system
  audio.
- **OBS import.**
  - `hasDesktopAudio` (`apps/desktop/src/main/obs-import.ts:217`) turns
    System audio on.
  - The report line changes from "on the Videorc roadmap" to "Desktop audio
    → System audio (on)" (`R/lib/obs-import-map.ts:387-393`). Update
    `obs-import-map.test.ts:262-275`.
- **Tests:**
  - `audio-mixer.test.ts`: a row visibility and state matrix;
  - `capture.test.ts`;
  - the quick-settings and sources render tests;
  - a studio-provider integration test: toggling during a mock session
    sends one latest-wins update.

**Done when:** the unit tests pass, `pnpm typecheck && pnpm lint && pnpm build` pass,
and a by-eye screenshot pass of the mixer covers all four states (Off, On
idle, On live with meter, Needs permission) at the narrowest Studio width.

### S6. Shortcut, remotes, Stream Deck (gpt-5.5)

- **Global shortcut** `system-audio-toggle`, unbound by default:
  - `S/global-shortcuts.ts`, `GlobalShortcutsConfig`;
  - the IPC allowlist (`S/electron-ipc-contract.ts:531-536`);
  - `R/lib/global-shortcuts.ts`;
  - the label "Turn system audio on/off" in `shortcuts-settings.tsx`.
- **Remote intents**:
  - `SystemAudioOn`, `SystemAudioOff` and `SystemAudioToggle` in
    `remote_control.rs:53-89`, with their own debounce bucket;
  - the renderer executor (`R/lib/remote-surface.ts:257-266`);
  - `systemAudioOn` in `RemoteSurfaceState`.
- **Phone remote.** Add a key in `crates/videorc-backend/remote_web/app.js`
  and add the state to the LAN projection. Write a leak argument in the PR
  (AGENTS.md).
- **Stream Deck.** Add a "System audio" action in
  `apps/streamdeck-plugin/src/plugin.ts`.

**Done when:** `pnpm smoke:remote-control` and `pnpm smoke:remote-lan` are
green, and the unit tests cover the allowlist, debounce, executor and
shortcut dispatch.

### S7. Gates and acceptance (gpt-5.5, then the owner)

- **New `scripts/smoke-system-audio-app.mjs` and `pnpm smoke:system-audio`**
  (macOS, local, needs the dev binary's Screen Recording grant; same
  constraint as the real SCK screen smoke):
  1. Generate a 1 kHz WAV with the bundled FFmpeg. Record 12 s with System
     audio on and no mic (the silent path), playing the tone with `afplay`
     at 3–6 s.
  2. Assert on the artifact with `analyzeMediaAudioAmplitude` and
     silencedetect: tone present, above -30 dBFS in 3–6 s, silence
     elsewhere.
  3. Repeat with the switch toggled off at 5 s via the remote intent.
     Assert the tone stops within 50 ms of the confirmed toggle.
  4. Repeat with System audio Off. Assert no tone. This is the privacy
     gate.
  5. Play the tone from inside Videorc (a hidden renderer `<audio>`).
     Assert no tone. This is the self-exclusion gate.
  6. Record + stream to the local RTMP sink used by existing smokes. Assert
     the tone is in the file and the stream capture.
- **Wiring.** Add it to `scripts/lib/recording-studio-gates.mjs` and to
  `smoke:local-gates`. Extend `measure:av-sync` with a `--system-audio`
  mode that re-measures `o_sys` and fails if it drifts more than 25 ms from
  the S0 constant.
- **Owner checklist** in `docs/acceptance/2026-09-xx-system-audio.md`, run
  on the **packaged** app:
  - YouTube playback + voice in a recording (by ear);
  - a game or music with a 20-minute stream to a real platform, watching
    for drift, clipping and pumping;
  - a Bluetooth headphone output;
  - a revoked Screen Recording permission;
  - a mid-stream toggle;
  - a Library clip export and Noise cleanup on a recording made with system
    audio on. Noise cleanup also filters the music; confirm that is
    acceptable or file a follow-up.
- **Docs.** Update `plans/README.md` (069 status; 017 superseded) and
  `docs/system-audio-capture-plan.md` (header: superseded by 069).

**Done when:** `pnpm smoke:system-audio` is green three runs in a row,
`pnpm smoke:local-gates` is green, and the owner has signed the checklist.

### S8. Windows: WASAPI process loopback (fable-5, separate PR)

- **Cargo.** Add `Win32_Media_Audio` (and any needed
  `Win32_System_Com_StructuredStorage` / `Win32_System_Variant`) to the
  `windows` features.
- **New `system_audio_capture_windows.rs`**:
  - `ActivateAudioInterfaceAsync` on
    `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK` with
    `AUDIOCLIENT_ACTIVATION_PARAMS { ProcessLoopbackParams { TargetProcessId: <Electron main PID>, ProcessLoopbackMode: EXCLUDE_TARGET_PROCESS_TREE } }`.
    The Electron main process passes its PID to the backend through an env
    var.
  - Event-driven shared mode; 48 kHz float stereo requested, with a
    resample through the existing linear resampler if the engine refuses.
  - QPC timestamps from `GetBuffer` mapped to `captured_at`.
  - Silent periods deliver no packets; the S2 exemption covers that.
  - `AUDCLNT_E_DEVICE_INVALIDATED` is treated as lost.
- **Bus.** It plugs into the S2 system slot. When the mic has fallen back
  to DirectDshow (bus bypassed), emit `system-audio-mic-fallback-bypass`
  and keep the session mic-only. Do not add `amix` in this plan.
- **Device status.** Available on Windows 11. S5's row appears on Windows
  automatically.
- **Gates.** Follow AGENTS.md's Windows rules:
  - explicit readiness channels, no fixed sleeps;
  - affected filters ×25 and the full Windows Rust suite ×3 from
    PowerShell 7;
  - a Windows twin of `smoke:system-audio` using a PowerShell
    `SoundPlayer` tone;
  - on-box acceptance on the Iris Xe tester machine.

**Done when:** the Windows gates above are green and a tester recording
contains the tone.

## Edge cases

- **Mic plus speakers, no headphones.** The mic hears the speakers, so the
  audio appears twice with room delay. The helper text covers it. Echo
  cancellation is out of scope.
- **Watching your own live stream in a browser.** The delayed stream audio
  is captured and re-streamed as an echo. The browser isn't Videorc, so it
  is not excluded. This goes on the acceptance checklist and in the FAQ; no
  auto-detection.
- **A permission revoked while a session runs.** SCK stops with an error,
  `system-audio-lost` fires, and the session continues on the mic.
- **The output device changes mid-session** (for example, AirPods connect).
  SCK follows system output. On Windows, process loopback is not tied to an
  endpoint; verify in S8.
- **A takeover session, or the phone remote muting the mic.** Mic mute never
  touches the system slot, and the reverse holds too.
- **A stream-only session.** Same bus, same result; no local file is
  needed.
- **Caption burn and Orcle.** They stay mic-only (decision 5). If the owner
  later wants Orcle to hear game audio, that is a new consent surface and
  its own plan.

## Out of scope

- Linux system audio. The mic there is a direct FFmpeg Pulse input that
  bypasses the bus, so Linux needs either the mic moved into the bus or an
  `amix` path, plus un-filtering `.monitor` sources. It gets its own plan
  after S8.
- Per-app capture ("only this game") and excluding specific apps other than
  Videorc.
- Separate mic and system tracks in the local file.
- Hearing yourself (monitoring), and echo cancellation.
- A user-adjustable system-audio sync offset.
- Adding system audio to captions, Orcle, or voice auto-highlight.
- CoreAudio process taps (macOS 14.2+). Reconsider only if S0 finds SCK
  audio unusable.

## STOP conditions

Stop and report to the owner if:

- S0 finds the audio-only SCStream needs a new permission, or `o_sys` is
  unstable (more than 40 ms spread).
- S2 cannot keep mic-only output bit-identical.
- Any existing `session_audio`, A/V-sync, `smoke:recording-studio` or
  record-latency gate regresses and the cause is not found within the
  slice.
- Mixed sessions drift more than 40 ms between mic and system over 20
  minutes (the plan 014 risk).
- The UI would need to show System audio as available before S4's session
  path passes its gates.

## Verification gates (whole plan)

`cargo fmt --check --all`, `cargo clippy -p videorc-backend -- -D warnings`,
targeted `cargo test -p videorc-backend` filters per slice (the owner
directive is targeted suites locally; CI runs the full suite), `pnpm typecheck`,
`pnpm lint`, `pnpm format:check`, `pnpm --filter @videorc/desktop test`,
`pnpm test:scripts`, `pnpm build`, `pnpm smoke:recording-studio`,
`pnpm smoke:record-latency:gate`, `pnpm smoke:system-audio`,
`pnpm smoke:remote-control`, `pnpm smoke:remote-lan`, and
`pnpm smoke:local-gates` before the PR.

## Handoff (cold start)

- **Goal:** an optional, default-off System audio switch that puts the
  computer's sound into recordings and streams, toggleable any time.
- **Current state:** nothing captures system audio. A placeholder device
  sits on the wire. The bus is single-source. See "What exists today".
- **Route:** Orchestrator owns it; the lanes are per slice (above).
- **Order:** S0 → S1 → S2 → S3 → S4 → S5 → S6 → S7 (macOS PR), then S8
  (Windows PR). S1 and S3 can run in parallel after S0. S5 can start on S1's
  fields with the S4 behaviour mocked. S6 is optional for the first PR if
  time is short.
- **Blockers:** the smokes need a Screen Recording grant for the dev binary.
  Camera and mic smokes can't run from a worktree (per-binary TCC).
