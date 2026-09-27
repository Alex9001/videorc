# System audio spike (plan 069 S0), 2026-09-27

Scope: slice S0 of `plans/069-system-audio-on-off.md`. Prove the macOS
ScreenCaptureKit (SCK) system-audio assumptions before S1 to S4 build on them.
No product behaviour changed. The spike and the pure helpers it proved live in
`crates/videorc-backend/src/system_audio_capture.rs`; S3 grows that module into
the real producer and promotes or deletes the spike.

**Verdict: no STOP condition hit, but two plan assumptions are wrong** and S2 to
S4 must change (see "What S2 to S4 must do differently"):

1. App exclusion does **not** silence Electron renderer audio by default
   (decision 9). It works once Electron runs with
   `--disable-features=AudioServiceOutOfProcess`.
2. SCK delivers audio 22 to 52 ms after capture, so with PTS placement the
   bus's 50 ms playout delay would discard about 31% of system-audio frames.
   The system source needs about 100 to 150 ms of playout headroom.

## Host

| Item | Value |
| --- | --- |
| Base commit | `bbe5ceef` (plan 069 on `feat/069-system-audio`) |
| Machine | Apple M4, macOS 26.5.1 (25F80), `mach_timebase_info` = 125/3 |
| Output device | MacBook Pro Speakers, 48 kHz (only non-virtual output present) |
| Crates | `objc2-screen-capture-kit 0.3.2`, `objc2-core-media 0.3.2` (+ `objc2-core-audio-types` feature, already in the lockfile) |
| TCC | `CGPreflightScreenCaptureAccess() = true` for the host terminal (Ghostex). No new grant was requested or needed |
| Background audio | The owner's Spotify was playing throughout. Most runs exclude `com.spotify.client`, which also proves app exclusion (Q5) |
| Stimulus browser | Google Chrome 153.0.8010.54 |

## How it was run

The spike is an ignored test:

```sh
VIDEORC_SYSTEM_AUDIO_SPIKE=1 VIDEORC_SYSTEM_AUDIO_SPIKE_DIR=<scratch> \
VIDEORC_SYSTEM_AUDIO_SPIKE_LABEL=<name> VIDEORC_SYSTEM_AUDIO_SPIKE_SECONDS=<s> \
  env -u VIDEORC_PREMIUM_FEATURES cargo test -p videorc-backend \
  system_audio_spike -- --ignored --nocapture
```

Knobs (see the module docs):

- `..._EXCLUDE=<prefixes>|none|all` picks the excluded apps.
- `..._EXCLUDE_CURRENT_PROCESS=0` is the control for `excludesCurrentProcessAudio`.
- `..._SELF_TONE_AT=<s>` plays a 3 s, 0.3-amplitude 1 kHz sine from inside the
  test process through a CoreAudio default-output unit.
- `..._SCREEN=1` adds a second screen-only SCStream (320x180, 60 fps) for the
  sync measurement.

Each run writes `<label>.wav` (f32 48 kHz stereo), `<label>.json` (format,
buffer and timing stats, per-second peak dBFS, sync analysis) and
`<label>-buffers.csv` (per-buffer PTS, arrival, frames, peak). All media stayed
in the session scratch directory.

The stream under test is an audio-only SCStream:

- filter: `initWithDisplay:excludingApplications:exceptingWindows:` on the
  main display;
- config: `capturesAudio = true`, `excludesCurrentProcessAudio = true`,
  `sampleRate = 48000`, `channelCount = 2`, 2x2 px at 1 fps, queue depth 3;
- outputs: **only** `SCStreamOutputType::Audio`.

Other stimulus:

- Test tone: `vendor/ffmpeg/current/bin/ffmpeg -f lavfi -i
  sine=frequency=1000:sample_rate=48000:duration=3 -af volume=-6dB -ac 2
  tone-1k-3s.wav` (peak -24.1 dBFS), played with `afplay`.
- Sync stimulus: `scripts/lib/av-sync-stimulus.mjs`
  (`launchAvSyncStimulus` / `stopAvSyncStimulus`), a Chrome window at 16,16,
  1800x980 that flashes white and plays a 0.8-amplitude 1 kHz click every
  second.
- For the helper-process tests the same page was launched by hand so extra
  Chrome flags could be passed.
- Electron probe: the repo's Electron 39.8.10 binary
  (`node_modules/.pnpm/electron@39.8.10/.../Electron.app`) running a
  throwaway `main.js`. A 200x100 BrowserWindow plays a 0.5-gain 1 kHz WebAudio
  beep every second, optionally with
  `app.commandLine.appendSwitch('disable-features', 'AudioServiceOutOfProcess')`.
- Output state: read with `osascript -e "get volume settings"` and changed
  with `set volume ...`. Default-output switching was attempted with a scratch
  CoreAudio tool (see Q4).

## The seven answers

### 1. Does an audio-only stream start without a Screen output, on the Screen Recording grant alone?

**Yes.** Every one of the 24 runs started with only an Audio output attached,
and none needed a dummy Screen output. No extra permission prompt appeared
under the existing grant. SCK logged no errors.

| Measure | Typical | Outliers |
| --- | --- | --- |
| `startCaptureWithCompletionHandler` completion | 109 to 189 ms | 737 ms (run excluding all 49 apps) |
| First buffer arrival after start request | 113 to 253 ms | 741 ms (same run); 836 ms (a 120 s run where SCK held the first ~33 buffers and delivered them in a burst) |
| First buffer's PTS after start request | 55 to 130 ms | 679 ms |

This fits decision 12 (usually 100 to 300 ms), but S4 must tolerate about
1 s.

macOS 13 was **not tested**, because only the owner's macOS 26.5.1 machine was
available. Every API used (`capturesAudio`, `sampleRate`, `channelCount`,
`excludesCurrentProcessAudio`, `SCStreamOutputType.audio`,
`initWithDisplay:excludingApplications:exceptingWindows:`) is macOS 13.0+.
A macOS 13 pass belongs in the S7 owner checklist.

### 2. Buffer format

**Float32, planar (non-interleaved), exactly 48000 Hz stereo, 960 frames
(20 ms) per buffer**, identical in every run:

- ASBD: `lpcm`, flags `0x29` (float | packed | non-interleaved), 32 bits per
  channel, 4 bytes per frame and per packet, 1 frame per packet, 2 channels.
- The AudioBufferList has 2 AudioBuffers of 1 channel each.
- `CMSampleBufferGetNumSamples` = 960.

In all 24 runs the frames-per-buffer histogram was a single bin, 960. PTS is
a CMTime on the host-time clock with **timescale 1_000_000_000**, not 48000.

`interleaved_stereo_f32` and `pcm_layout_from_stream_description` handle this
shape. Defensively they also handle interleaved, i16, i32, mono (duplicated)
and more than 2 channels (first two kept). Any rate other than 48 kHz is
rejected with an error, because none was ever seen.

Capture is bit-transparent. The in-process 0.3 sine (-10.46 dBFS) came back
at -10.5 dBFS, and the stimulus's 0.8 click (-1.94 dBFS) at -2.3 dBFS. The
`afplay` tone lands 3 dB under its file peak (-27.1 vs -24.1 dBFS) because of
`afplay`'s own output gain; the in-process tone proves SCK itself adds no gain.

### 3. While nothing plays: silent buffers or none?

**Silent buffers, continuously.** With every audible source excluded (all 49
listed apps, or just Spotify), SCK kept delivering 960-frame buffers of
digital zero:

- The `excl-spotify` run delivered 301 of 301 buffers of exact zero.
- The 30 s and 180 s runs delivered zeros for everything outside the `afplay`
  tone.
- PTS stayed contiguous: zero gaps over 5 ms in any run.
- Delivered frames matched wall time to within one buffer.
- The arrival cadence stayed at 20 ms (max interval 22 to 32 ms, once 87 to
  120 ms).

Caveat: the owner's Spotify kept the output device running for the whole
session. The case where no process at all is using the device could not be
isolated without stopping the owner's music. Keep decision 11 (exempt the
system producer from the 2 s stall rule) as written. S3 must not treat a
buffer gap as loss.

### 4. Does output volume, mute or the output device affect capture?

**Volume and mute: no.** The in-process tone captured at exactly -10.5 dBFS
under each of these states:

- the owner's volume;
- output muted;
- volume 12;
- volume 0 (which macOS also reports as muted).

SCK taps the mix **before** the master volume and mute. Consequences:

- Muting the Mac does not remove system audio from a recording.
- Users can mute their speakers to avoid the mic hearing them, and system
  audio stays in the recording.

Owner state: the volume was read as 31, unmuted, immediately before the test.
It was restored to 31, unmuted, and read back. A hard-coded restore briefly
set 44 (an earlier reading) for about one second before the fix.

**Output device: not testable here.** The only non-built-in outputs are
virtual (Microsoft Teams Audio, ZoomAudioDevice). CoreAudio accepted
`kAudioHardwarePropertyDefaultOutputDevice` writes with status 0 but kept
MacBook Pro Speakers as the default both times. No Bluetooth or USB output was
available. The default device was never changed; it read back as MacBook Pro
Speakers.

This stays on the S7 owner checklist, with a specific risk to measure there:

- Media players delay video to match a Bluetooth output's latency (typically
  150 to 250 ms).
- SCK captures the mix before the device.
- So with AirPods, a correctly synced YouTube video may record with its audio
  **early** by roughly the Bluetooth latency.
- The device's clock drift against host time (see Q7) also needs a 20-minute
  Bluetooth run.

### 5. Is Videorc's own audio excluded?

**`excludesCurrentProcessAudio` works:**

| Run | In-process tone (0.3 sine) | Captured |
| --- | --- | --- |
| `selftone-excluded` (`excludesCurrentProcessAudio = true`) | played at 2 to 5 s | 352 of 352 buffers digital zero |
| `selftone-included` (`= false`, control) | played at 2 to 5 s | -10.5 dBFS at 2 to 5 s |

In Videorc this only covers the **backend** process, which plays nothing. It is
harmless and should be kept, but it does not protect the renderer's audio.

**App exclusion only silences the excluded app's own process:**

| Run | Audio source | Excluded | Captured |
| --- | --- | --- | --- |
| `excl-default` | Spotify (plays from its main process) | nothing | music, -3 dBFS peaks |
| `excl-spotify` | Spotify | `com.spotify.client` | all zeros |
| `excl-chrome` | stimulus Chrome, default (out-of-process audio service) | both `com.google.Chrome` apps (owner's pid 656 and stimulus pid 86577) + Spotify | **clicks still captured**, -2.3 dBFS every second |
| `inproc-control` | stimulus Chrome with `--disable-features=AudioServiceOutOfProcess` | Spotify only | clicks, -2.3 dBFS |
| `excl-chrome-inproc` | same Chrome with the in-process flag | Chrome + Spotify | all zeros |
| `electron-excl-0` | Electron 39.8.10 renderer beep, default | `com.github.Electron`, `dev.theorcdev.videorc`, Spotify | **beeps still captured**, -6.0 dBFS |
| `electron-control-1` | Electron with `AudioServiceOutOfProcess` disabled | Spotify only | beeps, -6.0 dBFS |
| `electron-excl-1` | Electron with `AudioServiceOutOfProcess` disabled | `com.github.Electron`, `dev.theorcdev.videorc`, Spotify | all zeros |

Why:

- `SCShareableContent.applications`, even with
  `onScreenWindowsOnly = false`, lists only bundle **main** processes. No
  `com.google.Chrome.helper`, `com.github.Electron.helper` or
  `dev.theorcdev.videorc.helper*` entry ever appeared, even though those
  processes were running.
- By default, Chromium and Electron on macOS play all renderer audio from a
  `--utility-sub-type=audio.mojom.AudioService` helper process. Such a helper
  was under the default Electron; there was none with the flag.
- SCK's app filter does not attribute that helper's audio to the parent app.
- With the audio service in the browser process, the audio belongs to the
  main process, and excluding the app removes it.

**The full in-app test (Library playback, Orcle voice) is deferred to S7**
(step 5 of `smoke:system-audio`). It will fail unless the flag change below
has landed first.

### 6. o_sys, the system-audio offset against screen video

Method: the product shape of two streams, audio-only plus screen-only, both
stamped on the host clock. For each second of the stimulus:

- the flash onset is the first 60 fps frame whose mean luma crosses mid-range;
- the click onset is the first sample with |x| >= 0.05;
- flash and click are paired within ±300 ms.

That gives 12 pairs per run. Positive numbers mean the click comes later than
the flash.

| Run | audio PTS - screen PTS: median (min to max) | audio arrival - screen arrival: median |
| --- | ---: | ---: |
| sync-1 | +8.2 ms (+5.5 to +16.5) | +39.0 ms |
| sync-2 | +2.5 ms (-5.9 to +8.1) | +49.1 ms |
| sync-3 | +6.1 ms (+0.4 to +17.0) | +47.6 ms |
| **Mean of medians** | **+5.6 ms**, spread 5.7 ms | +45.2 ms, spread 10.1 ms |

Supporting numbers, all runs:

- Screen frame arrival minus PTS: median -2.2 ms (range -7.6 to +8.5). A screen
  PTS is roughly the display presentation time, and frames arrive about when
  their PTS says.
- Audio arrival minus buffer end: median 35 ms, with a floor of 21.6 ms. Most
  maxima were 50 to 52 ms, with outliers of 103, 139 and 665 ms, the last in
  the startup burst.
- The screen PTS cadence shows ProMotion quantization (8.3 ms minimum, 16.7 ms
  median). That quantization explains the ±5 ms pair-to-pair jitter.

The capture-level offset is stable, with a 5.7 ms spread across runs, well
inside ±15 ms and far from the 40 ms STOP.

**Mapping to the recording.** Assume S3 stamps system audio from its PTS (Q7)
and the screen keeps its current stamping:

- `preview_screen.rs` stamps a frame when its callback arrives, about PTS -
  2 ms.
- The compositor then takes the latest frame on its next output tick, which
  adds 0 to 1 frame (mean 8 ms at 60 fps, 17 ms at 30 fps).
- In the file, the click then lands about 0 to 11 ms **before** the flash.

**Recommended `SYSTEM_AUDIO_SYNC_OFFSET_MS = 0`.**

- It is within ±15 ms of both the raw capture offset (+5.6 ms, which would
  argue for -6) and the estimated in-app offset (which would argue for 0 to
  +11).
- Any o_sys of 0 or more keeps `min(o_mic, o_sys) = 0` for the default
  `microphoneSyncOffsetMs = 0`. Mic-only FFmpeg args stay byte-identical
  (decision 8), and no bus delay is added.
- The in-app o_sys will be **re-measured end to end in S7**
  (`measure:av-sync --system-audio`). If S7 finds the audio early by X ms,
  set o_sys = +X. A positive value still leaves the mic path untouched.

Do not use the arrival-based numbers (+45 ms) as o_sys unless S2 chooses
arrival stamping (see below). They are about 40 ms later and twice as noisy.

### 7. CMSampleBuffer PTS to `Instant`

Exact conversion, as implemented and unit-tested in the helpers:

```text
pts_host_ns = pts.value * 1_000_000_000 / pts.timescale        // cm_time_to_host_nanos (timescale seen: 1e9)
host_ns     = mach_absolute_time() * numer / denom               // MachTimebase::ticks_to_nanos (125/3 on Apple Silicon)
anchor      = (host_ns, Instant::now()) read back to back        // host_clock::sample_anchor, bracket <= 50 us
instant(h)  = anchor.instant + (h - anchor.host_ns)              // HostClockAnchor::instant_for_host_nanos
captured_at = instant(pts_host_ns + frames * 1e9 / 48000)        // HostClockAnchor::buffer_end_instant (the bus reads captured_at as the END of the frame)
```

Evidence:

- Apple's `CMClockConvertHostTimeToSystemUnits(pts)` converted to ns agrees
  with `pts_host_ns` to within 42 ns on every buffer.
- On macOS, Rust's `Instant` is `CLOCK_UPTIME_RAW`, the same counter as
  `mach_absolute_time`, so the anchor offset is constant. Two anchors taken
  30 s, 120 s and 180 s apart disagreed by 62 to 812 ns, and anchor brackets
  were 0.5 to 1.9 µs. One anchor per stream is enough.
- PTS advances by exact sample counts: every consecutive PTS difference is
  exactly 960/48000 s, with zero gaps.
- PTS is also locked to host time. Over 180 s, the per-10 s minimum of
  (arrival - PTS) stayed between 21.51 and 21.60 ms, a trend of 0.07 ppm. The
  audio clock does not drift against host time on the built-in output, and the
  bus's `SourceClock` ratio will sit at 1.0.
- Not verified on a Bluetooth or USB output (Q4).

## What S2 to S4 must do differently

1. **Decision 9 is insufficient on macOS (S3/S4, plus Electron main).**
   - Excluding `dev.theorcdev.videorc*` alone lets Library playback, Orcle
     voice and UI sounds into recordings. They play from the Chromium audio
     service helper, which SCK neither lists nor attributes to the app.
   - Add `app.commandLine.appendSwitch('disable-features',
     'AudioServiceOutOfProcess')` on macOS in `apps/desktop/src/main/index.ts`.
     Today there is no other `disable-features` switch, so merge if one
     appears. Renderer audio then plays from the Electron main process.
   - Then exclude that main app. Precise option: the backend's parent pid,
     since Electron main spawns the backend directly.
     `excluded_application_indices` takes pids as well as bundle prefixes.
     Alternatively use the packaged prefix, plus `com.github.Electron` only
     when it is the parent.
   - The flag moves the audio service into the browser process. S4 or S5 must
     re-check Library playback, Orcle voice and meters with the flag on.
   - S7 step 5 is the gate.
   - If the flag is rejected, the only exclusion path left is CoreAudio process
     taps (macOS 14.2+, per-pid), which the plan puts out of scope.
2. **Playout headroom (S2 decides, S3 stamps).**
   - With PTS stamping and the current `PLAYOUT_DELAY = 50 ms`, each buffer's
     start is already behind the bus cursor on arrival (arrival - PTS start is
     about 55 ms). `AudioTimeline::push` would trim it as overlap.
   - Measured from the per-buffer data, the fraction of frames lost at each
     playout delay:

     | Playout delay | Frames lost |
     | --- | --- |
     | 50 ms | 30.7 to 31.3% |
     | 80 ms | 0 to 0.5% |
     | 100 ms | 0 to 0.49% |
     | 150 ms | 0 to 0.45% |

     The tails are the startup burst.
   - Options for S2:
     - **(a), recommended.** Give sessions on system-audio-capable platforms
       a playout delay of about 150 ms, fixed at session start like decision
       8's shift. Keep PTS stamping, which is accurate and drift-free.
       - S2 must prove this changes write timing only. Mic-only bytes must stay
         identical, and the FFmpeg bus input must stay sample-count timestamped.
       - `smoke:record-latency:gate` must stay green.
     - **(b)** Stamp by arrival, as the mic does (`Instant::now()` in the
       callback).
       - The bus then sees the buffers about 40 ms late, and o_sys becomes
         about -40 ms.
       - That makes `min(o_mic, o_sys)` negative, which changes mic-only args
         and breaks decision 6, and it doubles the jitter.
   - A per-slot delay cannot fix this without shifting sync, because the mic
     and system share one output cursor.
3. **Decision 11 holds, with a correction.** On this machine SCK delivered
   zeros during silence rather than nothing, but the idle-device case was
   unprovable. Keep the stall exemption, and never treat "no buffers" as loss.
4. **Decision 12.** First audio is usually 110 to 250 ms after start, but
   reached 740 to 840 ms twice, once as a burst of a backlog. Attach-on-first-
   buffer must accept a burst whose early frames are already behind the cursor.
   Trimming them as overlap is correct; they fall before the slot joined.
5. **Formats for S3.** Use the S0 helpers as they are:
   `pcm_layout_from_stream_description` → `interleaved_stereo_f32` (planar f32
   → interleaved stereo), `cm_time_to_host_nanos` + `HostClockAnchor`
   (`timestamp_micros` from PTS, `captured_at` from `buffer_end_instant`).
   Read the samples with
   `CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer`, as the spike's
   `record_audio` does.
6. **Do not copy `setCaptureMicrophone(false)`** from `preview_screen.rs`
   `configure_stream` into the audio stream. That selector is macOS 15+, and
   this build's macOS 13/14 behaviour with it is unverified. It may be worth a
   separate look for the existing screen stream too.
7. **S5 copy.** Two facts are worth stating in the helper text: the Mac's
   volume and mute do not change what is recorded (Q4), and headphones are
   still needed to keep the mic from hearing the speakers.

## Gates

- `cargo fmt --check --all`: pass
- `cargo clippy -p videorc-backend -- -D warnings`: pass
- `env -u VIDEORC_PREMIUM_FEATURES cargo test -p videorc-backend system_audio`:
  11 passed, 1 ignored (the spike)
- Spike runs: 24 local runs, all passing, listed above by label.
