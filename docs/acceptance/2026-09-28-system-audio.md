# System audio acceptance (plan 069 S7), 2026-09-28

Scope: slice S7 of `plans/069-system-audio-on-off.md`, macOS. The first part is
the automated evidence this slice produced on the dev app. The second part is the
owner checklist, which must be run on the **packaged** app before the macOS PR
merges. Windows (S8) has its own acceptance on the Iris Xe tester box.

**Automated verdict: pass.** `pnpm smoke:system-audio` passed 3 runs in a row.
End-to-end o_sys is within the gate and no STOP condition was hit, so
`SYSTEM_AUDIO_SYNC_OFFSET_MS` stays 0. The flag re-check turned up two plan
assumptions that do not hold (see "Findings"). Neither blocks the PR, but the
owner should read them before signing.

## Host

| Item | Value |
| --- | --- |
| Branch | `feat/069-system-audio` (S0 to S7) |
| Machine | Apple M4, macOS 26.5.1, MacBook Pro Speakers (48 kHz), output volume 6 (never changed) |
| Dev app grant | Screen Recording granted to the worktree's Electron binary |
| Other apps | The installed Videorc (`dev.theorcdev.videorc`) was running; the capture excluded it as the packaged bundle id |
| Environment | `VIDEORC_PREMIUM_FEATURES=1` in the shell (one extra run without it, below) |

## Automated evidence

### `pnpm smoke:system-audio`

`scripts/smoke-system-audio-app.mjs` drives the real dev app with a screen-only
synthetic scene and no microphone. The pure verdicts live in
`scripts/lib/system-audio-gates.mjs` and are covered by `pnpm test:scripts`.
Every verdict comes from the finished artifact: ffprobe checks the streams, and
ffmpeg decodes the audio into a sliding 1 kHz Hann-Goertzel envelope. The tone is
a 1 kHz, -6 dBFS WAV played with `afplay`. File time is measured from the first
video frame. Toggle references are the backend's bus cutover sample
(`System audio joined/left the session mix at sample N`, at file time
`N / 48000`).

The final 3 consecutive runs used the bundled LGPL FFmpeg
(`vendor/ffmpeg/current`) for the tone and all analysis.

| Case | What it proves | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- | --- |
| on | Tone at 3 s is in the file (-12 dBFS, continuous), 1 kHz band silent elsewhere | 3.190-6.190 s | 3.191-6.191 s | 3.205-6.205 s |
| toggle-off | `systemAudioOff` at 5 s: the tone stops at the detach cutover | +2 ms | +2 ms | +2 ms |
| toggle-on | Off at start, `systemAudioOn` at 5 s: the tone enters after the attach cutover, never before | +149 ms | +143 ms | +150 ms |
| off (privacy) | Tone played, no tone and digital silence in the file (peak below -200 dBFS), no `system-audio` in any status, no active system source in diagnostics | pass | pass | pass |
| self | A 1 kHz WebAudio tone from Videorc's own renderer (AudioContext running, analyser peak 0.5) is absent (band below -200 dBFS); an `afplay` control tone in the same session is present | pass | pass | pass |
| stream | Record + stream to a local RTMP listener: the tone is in the MP4 and in the received FLV | 3.486 s / 3.356 s | 3.483 s / 3.354 s | 3.498 s / 3.369 s |

Earlier green runs with Homebrew FFmpeg matched these numbers: 3 in a row, plus
a fourth inside `smoke:local-gates` and one without `VIDEORC_PREMIUM_FEATURES`.
Toggle-off was always +2 to +3 ms, and toggle-on +142 to +158 ms.

Notes:

- Toggle-off: the tone stops 2 to 3 ms after the detach cutover, well inside the
  50 ms + 5 ms ramp gate. The confirmed `recording.status` (mixSources lost
  `system-audio`) arrives about 125 to 150 ms after that point in wall time. That
  gap is the bus's 150 ms playout delay: the cutover sample is 150 ms behind the
  wall clock.
- Toggle-on: the tone enters about 150 ms after the attach cutover, every time.
  The slot joins at the bus cursor on the capture's first buffer, and the cursor
  runs 150 ms behind the wall clock, so the first captured sample lands about one
  playout delay later. The gate is "at or after the cutover, within the playout
  delay + 50 ms".
- Stream: the FLV tone is 130 ms earlier than the MP4 tone. That is
  `STREAM_OUTPUT_AUDIO_ADVANCE_MS`, as designed.
- A silent `afplay` loop keeps the output device awake during a run. Before it
  was added, the first tone on a cold device started up to 1.9 s late.
- `VIDEORC_PREMIUM_FEATURES`: the smoke does not depend on it. A full run
  without it passed.
- **Fixed flake.** Some launches refused every `recordStart` with "Cannot start:
  the camera preview source(s) produced no frames". The seeded screen-only layout
  had not survived the renderer reload while a camera was attached (the owner's
  iPhone Continuity camera comes and goes), and the dev app has no camera grant.
  The smoke now:
  - selects screen-only through the UI (`select-layout-preset`);
  - waits for a scene with no visible camera before any case;
  - prints the renderer's failure copy if a start is ever refused.

  `smoke:record-latency` seeds the same way and could hit the same flake, though
  it was not seen there.

### `pnpm smoke:local-gates`

Every step is green on this branch. That includes:

- `cargo test -p videorc-backend`: 2621 passed;
- clippy;
- `smoke:record-latency:gate`;
- `smoke:system-audio`;
- `smoke:recording-matrix`, remote-control and remote-lan;
- the 60-minute `capture-decay-soak:gate`: 1795 samples, no degradation;
- the 15-minute long recording.

The first pass stopped at `smoke:repair-encoder` because this worktree had no
bundled FFmpeg (`vendor/ffmpeg/current`, gitignored). After a local copy of the
main checkout's staged bundle, repair-encoder and every step after it passed,
run as the same chain.

### o_sys end to end: `measure:av-sync --system-audio`

The run records the flash+click stimulus (Chrome) through the real dev app with a
screen-only scene, System audio On and no microphone
(`real-source-baseline-app.mjs` with `VIDEORC_BASELINE_SYSTEM_AUDIO=1`). It then
pairs flashes with 1 kHz band-passed clicks. The recording already carries
`SYSTEM_AUDIO_SYNC_OFFSET_MS = 0`, so the offset is the residual. Positive means
system audio is late.

Final gate run (3 runs, 60 fps, 12 pairs each):

| Run | Median | Mean |
| --- | ---: | ---: |
| 1 | +15.1 ms | +20.0 ms |
| 2 | +1.8 ms | +4.8 ms |
| 3 | -0.1 ms | -5.5 ms |
| **Pooled (36 pairs)** | | **+6.4 ms** (gate ±25 ms) |

Earlier exploratory runs, made while the harness was being fixed, with the same
stimulus:

- 60 fps: medians -25.9, -1.0 and -17.0 ms. Pooled mean about -12.7 ms.
- 30 fps: medians -20.4, +25.6, +8.5 and -10.1 ms. Mean +0.9 ms.

Reading:

- Within a run, pair offsets sit on levels one video frame apart: 16.7 ms at
  60 fps, 33 ms at 30 fps. The screen capture and the compositor each sample the
  display once per frame, at a phase that is fixed for a session and random
  between sessions. Single runs therefore differ by up to a frame, and the pooled
  mean is the estimate.
- Over all ten runs, the mean is within a few ms of 0 and the sign is not
  consistent. No STOP (the rule is a mean beyond ±15 ms with every run on the
  same side), and the constant stays 0.
- This agrees with S0's capture-level +5.6 ms.
- A single run may be off by up to 25 ms plus one frame. The gate is the pooled
  mean.
- Harness fixes made on the way:
  - the stimulus now launches after the Studio and preview windows, so it opens
    in front of them;
  - it reports every pulse to a loopback readiness beacon, and recording waits
    until the page is running, focused and visible;
  - the baseline turns the renderer's System audio switch on first, because the
    renderer pushes its own switch state into any live session.

### Flag re-check (decision 9 amended): `disable-features=AudioServiceOutOfProcess`

Probed on the dev app with a scratch script, not committed:

| Check | Result |
| --- | --- |
| Flag applied | Every Electron process carries `--disable-features=AudioServiceOutOfProcess,...` |
| Audio service placement | No `audio.mojom.AudioService` utility process. The only utility processes are NetworkService and VideoCaptureService, so the audio service runs in the main process |
| Renderer microphone via `getUserMedia` (the meter's input) | Works: "Default - MacBook Pro Microphone (Built-in)". An AnalyserNode on it read live signal (peak 3.9e-4 in a quiet room) |
| WebAudio MediaStream to analyser path (the mixer meter's shape) | Works (peak 1.0 on a synthetic oscillator) |
| Renderer media element playback | An `<audio>` element plays (0.47 s advanced in 0.5 s) |
| Renderer audio excluded from the recording | Yes, the `self` case above, 3 of 3 |
| Studio mixer bars by eye | Not checked here (headless probe). It is on the owner checklist |

## Findings for the owner

1. **Library "Play" is not in-app playback.** The Library's Play button is "Play
   in the default player": it opens the file in QuickTime or whatever player is
   set as the default. That player is not Videorc, so **System audio records it**,
   like any other app. Plan 069 decision 9 ("Library playback ... never land in
   the recording") only holds for audio played inside Videorc. Today the only
   in-app sources are renderer WebAudio and media elements, both of which the
   `self` case proves excluded. Either accept this, and say so in help copy, or
   file a follow-up (for example, pause System audio while an external player
   opened from Videorc is playing, or add an in-app player).
2. **Orcle has no voice output today.** No text-to-speech or audio playback path
   exists in the app. "Orcle voice not captured" therefore holds trivially. If a
   voice is added in the renderer, the `self` case already covers it.
3. **The renderer owns the switch for any live session.** A session started on
   the backend directly with `systemAudioEnabled: true` is turned Off at once by a
   renderer whose switch is Off (`systemAudioProcessingDelta` sends the renderer's
   state when it does not know the session's state). Product paths all start in
   the renderer, so this only mattered to harnesses. It is noted in case a future
   backend-initiated start (for example, scheduled streams) is added.
4. Toggle-on enters about 150 ms after the attach cutover (see above). Nothing
   before the attach leaks in.

## Owner checklist (packaged app)

Build and install the packaged app from this branch. Run each item and tick it.
Write "fail" with a note if an item fails. Use headphones unless an item says
otherwise.

- [ ] **YouTube + voice by ear.** System audio On, microphone on. Record 2 minutes
  of a YouTube video while talking over it. Play the file back: the video's sound
  and your voice are both there, balanced (voice on top at the -6 dB default), no
  crackle, no doubling.
- [ ] **Game or music + a 20-minute stream to a real platform.** System audio On.
  Stream 20 minutes to YouTube or Twitch with a game or loud music. Watch the VOD
  and check:
  - lip sync at the start and at minute 20 (drift);
  - clipping on loud peaks (the -1 dBFS limiter should hold);
  - pumping (the level ducking audibly after peaks);
  - that the voice stays intelligible.
- [ ] **Bluetooth headphones.** Connect AirPods (or any Bluetooth output). Record a
  YouTube clip with a visible, audible beat (a clap or a metronome video). Check
  whether the recorded audio is **early** against the picture by roughly the
  Bluetooth latency (150 to 250 ms). SCK captures before the output device, while
  the player delays video to match the headphones (S0 Q4). Also switch the output
  device mid-recording and confirm capture continues.
- [ ] **Revoke Screen Recording.** In System Settings > Privacy & Security >
  Screen & System Audio Recording, turn Videorc off. Check:
  - the System audio row shows "Needs Screen Recording permission" with a button
    to Settings;
  - turning it on during a session gives the `system-audio-unavailable` message;
  - the session keeps recording the mic.

  Re-grant afterwards.
- [ ] **Mid-stream toggle.** During a live stream, turn System audio off and on
  from the Studio switch. The stream and the local file follow within a moment,
  and the switch shows the confirmed state.
- [ ] **Shortcut, phone, Stream Deck.** Bind "Turn system audio on/off" in
  Settings > Shortcuts and toggle it during a recording. Do the same from the
  phone remote's System audio key and from a Stream Deck "System audio" action.
  Each flips the Studio switch and the recording.
- [ ] **Library playback and Orcle.** Record with System audio On while playing an
  earlier recording from the Library's Play button (finding 1: expect it **in**
  the recording, because it plays in the default player). Also play any sound
  inside Videorc (none exists today; finding 2). Confirm the behaviour is
  acceptable or file the follow-up.
- [ ] **Studio mixer meter with the flag on.** With a session running, the mic
  meter bars move with your voice, and the System audio meter moves with the
  computer's sound.
- [ ] **Clip export and Noise cleanup on a system-audio recording.** Export a clip
  from a recording made with System audio On: the clip has the mixed audio. Run
  Noise cleanup on it: it succeeds on the one mixed track, and it also filters the
  music. Confirm that is acceptable, or file a follow-up (plan 069 S7).
- [ ] **macOS 13.** If a macOS 13 machine is available, repeat the first item
  there (S0 could only test macOS 26.5.1).
- [ ] **Echo check (FAQ).** With speakers (no headphones) and the mic on, confirm
  the helper text's warning is accurate: the computer's sound appears twice.

Owner sign-off: ____________________ Date: __________
