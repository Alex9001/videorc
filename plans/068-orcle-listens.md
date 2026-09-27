# Plan 068: Orcle listens (always-on stream transcript, Clip that, a transcript-aware Orcle, the post-stream pack, and chat you haven't acknowledged)

> Executor: implement the ordered slices below in an isolated worktree of current
> main. Read AGENTS.md and `.claude/skills/videorc-design/SKILL.md` first. Keep
> each slice independently testable. Planning authorizes no merge or release.

## Status and decisions

- Status: **IMPLEMENTED 2026-09-27** on `feat/orcle-listens` (desktop) and
  web `feat/orcle-listens`; owner acceptance stream owed (S10). Desktop
  worktree `~/projects/videorc-wt-orcle-listens`, rebased onto `origin/main`
  `278ff17b` (0.9.116); web worktree `~/projects/videorcweb-wt-orcle-listens`.
  Evidence and the owner checklist:
  `docs/acceptance/2026-09-27-orcle-listens.md`. Priority P1. Effort XL:
  about 8 agent-days over 10 slices in two repos.
  Risk MEDIUM-HIGH: touches the caption coordinator's lifecycle (not the
  audio thread), the co-host wire (v3, forward-tolerant), the Publish tab and
  clip export, and two web routes. No capture, preview, encoder or
  recording-output change.
- Planned against desktop `origin/main` `b772cb59` and web `origin/main`
  `af5191c6`. Desktop paths are relative to `crates/videorc-backend/src/`
  (Rust) or `apps/desktop/src/renderer/src/` (renderer) unless they start
  with `apps/`, `scripts/`, `docs/` or `protocol-fixtures/`. Web paths are
  relative to `~/projects/videorcweb/`.
- Owner ask, 2026-09-27: "I want Orcle to listen to the entire live stream
  without our captions even working", plus four features: Clip that, a
  transcript-aware regular Orcle check, an instant post-stream pack, and
  chat you haven't acknowledged.
- Owner route: Orchestrator (fit 10): two repos, five subsystems. Model
  lanes: S1, S3, S5, S6, S10 `fable-5`; S4, S7, S8 `opus-4.8` (UI, copy);
  S2, S9 `gpt-5.5` (web routes, smokes). In a harness without `gpt-5.5`,
  use `opus-4.8` for those slices.
- Commits: `feat(orcle):` for engine and UI, `feat(captions):` for the
  transcription split. One desktop PR and one web PR.

### What exists today (measured)

- Orcle hears speech only through caption finals: `note_caption_final`
  (`cohost.rs:2856`) is called from the two final emit sites in
  `captions.rs` (4945 realtime, 5373 chunked). With captions off, nothing
  arrives and "What I talk about" is inert.
- Production transcription is the server-metered 3 s chunk path
  (`CAPTION_CHUNK_SECONDS`, `captions.rs:25`; serial uploads; grok-stt at an
  observed $0.10/h). The realtime socket is kill-switched on the web.
- Silent chunks are uploaded and billed (`run_chunked_caption_session`,
  5209-5308); `pcm_has_speech_energy` (4218) is only a realtime watchdog.
- The renderer owns caption intent (`decideCaptionsRuntimeIntent`,
  `lib/captions-ui.ts:81-104`): with captions off and any backend caption
  intent visible it sends `captions.stop`. A listen-only session must not
  look like a caption session to it.
- The caption tap is one global, mic-only, post-gain/mute tap
  (`offer_caption_frame`, called from `session_audio.rs:2244`).
- Orcle runs only while a live-chat session exists (`start_cohost`,
  `cohost.rs:2911`), with per-session consent and Premium
  (`FeatureId::LiveCohost`).
- Publish tab (`components/tabs/ai-tab.tsx`) already builds title,
  description, summary, chapters, highlights and social posts from
  `<recording>.srt` without re-transcribing (`ai.rs:66-118`), but flattens
  the SRT to untimed text (`caption_cues_text`, `ai.rs:1076`), so chapters
  are guessed. Nothing runs it automatically.
- Clip suggestions are local chat-spike buckets snapped to SRT cues
  (`publish_clips.rs`); clips are not stored; export cuts the recording with
  FFmpeg. There is no marker/bookmark feature anywhere, no replay buffer,
  and stream-only sessions have no local file and discard their transcript
  at stop (`recording.rs:8498-8507`).
- A caption offset is file time: both count from `video_epoch`
  (`recording.rs:3156`, `captions.rs:3855-3970`).
- Tick wire v2 (`videorc_api.rs:165-238`, `cohost.rs:35-39`). The web tick
  schema rejects Kick messages (`lib/ai/cohost.ts:64,128`): any tick with a
  Kick message fails 400 and the batch is lost. Messages already carry
  `first_message` locally (`live_chat.rs:230-269`); the tick drops it.
- `liveChat.send` posts to YouTube, Twitch, Kick and X (X capped at 140).
  Nothing auto-posts; Reply pre-fills the composer.

### Decisions (the recommendation is taken)

1. **One transcription engine, two intents.** The caption coordinator keeps
   one tap, one provider task and one timeline, and runs when
   `captions || listen` is wanted. `captions` owns presentation (overlay,
   `captions.update`, `captions.status`, cue render, burn). `listen` owns
   nothing visible in the captions UI. Turning captions off while listening
   keeps the task alive and flips presentation off; it never tears down the
   tap. Transcript records (`CaptionsCoordinator.chunks`) are kept in both
   modes, tagged with whether captions were presenting, because the SRT and
   the Publish tab need them.
2. **Listening is an Orcle setting, not a captions setting.** New
   `CohostSettings.listen: bool` (default `false`, persisted). While Orcle's
   session runs with consent and `listen`, the backend starts the listen
   intent; `stop_cohost` ends it. Listen never fails or delays a capture
   session and never raises the captions microphone block; with no eligible
   mic it reports `listening: blocked (no-microphone)` in Orcle state and
   stays quiet elsewhere.
3. **Consent is explicit and re-asked once.** Existing Orcle users see a
   one-time card in the Orcle pane: "Orcle can hear you while you're live",
   Turn on / Not now. Turning on sets `listen`. The consent sentence changes
   everywhere it appears (renderer and web privacy page) to say: Orcle
   hears your microphone while you're live, as text (never audio); a
   transcript is saved with your recording on this Mac; nothing is kept on
   Videorc servers.
4. **Silence is never uploaded.** The chunked path skips a chunk whose every
   50 ms window is below -45 dBFS RMS (both intents). Offsets are stamped
   before upload, so skipping keeps the timeline exact. Captions lose
   nothing (silence has no words).
5. **Listening has its own allowance.** The chunk request gains
   `purpose: captions | listen` (captions wins when both run: one upload,
   one charge). Web meters `listen` into a separate month key
   (`listen-quota-YYYY-MM`) with `VIDEORC_AI_LISTEN_MONTHLY_MINUTES`
   (default 6000 = 100 h, about $10 per user at worst) and a kill switch
   `VIDEORC_AI_COHOST_LISTEN_DISABLED` (fail-open is NOT allowed: missing
   means enabled only because it is the same metered path as captions;
   `true` disables). Caption sums exclude listen keys. Exhaustion blocks
   listening only, with its own status.
6. **Clip that is local and needs a recording.** Detection is a pure
   phrase matcher over transcript finals and their word segments ("clip
   that", "clip it", "clip this", "that's a clip", "make a clip"; English
   only). The mark time is the start of the phrase in file time. A manual
   mark exists too: remote intent `clip.mark`, an unbound global shortcut
   in the recorder, and a Stream Manager button. Marks persist in a new
   `clip_marks` table by session id. Each mark becomes a clip suggestion
   `[mark - 30 s, mark]` (snapped to cues) shown first in Publish → Clips as
   "You said 'clip that'" or "Marked"; export reuses `export_clip`. With
   recording off, the toast says the clip can't be saved and no mark is
   stored (stream-only sessions keep nothing, as today).
7. **Tick v3 carries speech, and stays stateless on the server.** Request
   adds optional `transcript` (finals since the previous tick, newest
   1500 chars), `summary` (the rolling stream summary the server returned
   last time, ≤ 600 chars), `openPromises[{id,text}]`, and per-message
   `firstMessage`; `messages` may be empty when `transcript` is present;
   `kick` becomes a valid platform in every version. Response adds optional
   `summary`, `topic` (≤ 60 chars), `promises[{id?, text, trigger:{kind:
   none|viewers|minutes, value?}}]` (full open set, like questions),
   `fulfilledPromiseIds`, `recap` (≤ 140 chars, only when chat asks what
   they missed), and per-question `onTopic: bool`. Transcript text goes
   only in the input JSON, never in instructions. Desktop pins v3 with a
   3 → 2 → 1 fallback ladder, and `rules` is sent for any version ≥ 2.
   A new cadence rule ticks when the transcript grew by ≥ 200 chars and
   20 s passed, even with no chat.
8. **Promises and recaps are private until the streamer acts.** Promises
   appear in the Orcle pane with Done / Dismiss; the engine fires a private
   reminder when the trigger is met (viewers ≥ N from viewer stats, or N
   minutes elapsed) or after 20 minutes open. A recap appears as a card
   with "Post to chat", which pre-fills the composer; nothing is sent by
   Orcle. A manual "Draft a recap" button uses the latest `summary`
   (no extra call).
9. **Acknowledgement is local and pure.** Each Orcle session keeps an
   author ledger (first seen, first-message flag, message count, greeted
   at/how). Greeted by voice = fuzzy name match of a transcript final
   against display names (normalise case, digits, underscores, camelCase,
   @; exact for names < 4 chars; edit distance 1 for ≥ 6; a stop-list of
   common words). Greeted by chat = the streamer's own send mentioning the
   name, a reply to their question, or a highlight of their message.
   Manual "Greeted" button. The pane shows "Say hi" (first-time chatters
   not greeted, oldest first, max 5, drop after 15 min). Dead-air nudge:
   voice activity is computed in the caption task from the frames it
   already receives (never on the audio thread); when live, not muted,
   silent ≥ 20 s and a question or ungreeted first-timer waits, a private
   keyed toast suggests it, at most once per 2 minutes.
10. **The pack runs itself at stream end.** When a streamed session that
    Orcle listened to finalizes with a recording and the AI consent is on,
    the renderer runs the existing post-recording workflow
    (`publish_pack` + `social_posts`) once, with a timed transcript
    (`[h:mm:ss]` every ~30 s block) instead of flattened cues, so chapters
    carry real timestamps. It toasts "Your post-stream pack is ready" with
    Open Publish (dispatching the existing `videorc:open-publish`). New
    setting "Make my post-stream pack automatically", default on when
    `listen` is on. Over-limit transcripts (> 110k chars) are cut from the
    start at a block boundary with a visible note.

## Slices

### S1. Web: listen allowance, Kick in the tick (gpt-5.5)

Files: `app/api/ai/captions/chunks/route.ts`, `lib/ai/captions.ts`,
`lib/ai/cohost.ts` (platform enum only), `lib/ai/jobs.ts` (kill switch),
tests in `tests/ai-captions.test.ts`, `tests/ai-cohost.test.ts`.

- Optional multipart `purpose` (`captions` default | `listen`). `listen`
  checks the listen kill switch, reserves into `listen-quota-YYYY-MM`
  against `VIDEORC_AI_LISTEN_MONTHLY_MINUTES` (default 6000), and returns
  the same response shape with listen remaining/limit. Caption sums and the
  legacy query exclude `listen-quota-%` keys.
- Kick is accepted by the tick schema in v1 and v2.
- Done when: `pnpm typecheck`, `pnpm test` green; new tests cover purpose
  routing, separate exhaustion, exclusion from caption sums, kill switch,
  Kick messages in a v2 tick.

### S2. Web: tick v3 (gpt-5.5)

Files: `lib/ai/cohost.ts`, `lib/ai/cohost-route.ts`, tests,
`app/privacy/page.tsx`.

- Add version 3 per D7: schemas, strict model JSON schema (every key
  required, nullable where optional), prompt rules (use the transcript to
  mark on-topic questions, extract concrete promises with triggers, carry a
  compact rolling summary, return a recap only when chat asks), sanitizer,
  `shape()` per version. `gateQuestionPriorities` still applies. v1/v2
  responses unchanged byte-for-byte.
- Privacy page copy per D3.
- Done when: tests cover v3 parse/shape, empty messages with transcript,
  transcript never in instructions, promise/recap sanitising, v2 unchanged.

### S3. Desktop: the transcription split (fable-5)

Files: `captions.rs`, `cohost.rs`, `recording.rs` (only the caption
auto-start and finalize seams), `videorc_api.rs`, `state.rs`, `protocol.rs`,
`main.rs`, `apps/desktop/src/shared/backend-rpc-contract.ts`, fixtures.

- Coordinator intents `{captions, listen}` replacing `desired_enabled`
  semantics where they gate the task; `caption_session_expects_audio`
  counts listen. A shared presentation flag gates every emit and side
  effect listed in "What exists today" (`captions.update`,
  `captions.status`, `captions.cleared`, overlays, cue render requests,
  burn registration, caption health events). Listen-only never publishes a
  caption status that `decideCaptionsRuntimeIntent` could read as active.
- `stop_captions` while listening flips presentation off; `stop_listen`
  while captions run clears the listen intent; the task ends when neither.
- Silence skip per D4, both intents, with a pure helper and tests.
- `purpose` on `transcribe_caption_chunk`; listen quota exhaustion is a
  listen block, not a caption block.
- `CohostSettings.listen` (default false, serde default) and
  `cohost.settings.set` patch field. `start_cohost` starts listen when
  `listen && consent`; stop paths end it. Listen status in `CohostState`:
  `listening: {state: off|starting|on|blocked, reasonCode?, message?,
  remainingSeconds?}` (optional, `skip_serializing_if`).
- Transcript finals always reach `note_caption_final` and a new 5-minute
  `RecentSpeech` buffer (for S5), and records are kept with a `presented`
  tag. At finalize, the SRT is written for recording sessions whenever
  records exist; cue render/burn run only for presented records and only
  when the session's burn target asked for them. Stream-only sessions keep
  discarding at stop.
- Voice activity: the caption task updates `cohost_voice.last_voice_at`
  from windowed RMS of frames it receives (S6 reads it).
- Tests: intent matrix (captions only, listen only, both, toggles mid
  session), presentation gating (no emits in listen-only), silence skip
  keeps offsets, purpose routing, listen block isolation, SRT written for
  listen-only recording, no cue render for listen-only.
- Done when: `cargo test -p videorc-backend captions`, `... cohost`,
  clippy, fmt, `cargo build --release -p videorc-backend`, desktop contract
  tests green; `pnpm smoke:captions-contract` still passes.

### S4. Renderer: listening UI (opus-4.8)

Files: `components/cohost-settings-section.tsx`, `components/cohost-pane.tsx`,
`components/cohost-status.tsx`, `components/stream-manager/stream-manager.tsx`,
`lib/cohost-view.ts`, `hooks/use-studio.tsx`, tests.

- Settings: Switch "Orcle hears you while you're live" with the new
  consent sentence and listen minutes left; "What I talk about" helper
  copy no longer says it needs captions.
- One-time card per D3 (dismiss persisted locally).
- Indicator: a small "Listening" state in the Orcle status and Stream
  Manager Orcle tab (blocked reasons shown plainly).
- Done when: typecheck, lint, desktop tests green; by-eye screenshots dark
  and light.

### S5. Desktop: tick v3, promises, recap, on-topic (fable-5)

Files: `cohost.rs`, `videorc_api.rs`, contract + fixtures, renderer
`components/cohost-pane.tsx`, `components/cohost-question-row.tsx`,
`lib/cohost-view.ts`, `hooks/use-studio.tsx`, `scripts/lib/fake-cohost-service.mjs`.

- Wire per D7 with serde defaults, `lenient_items`, fallback ladder, rules
  gate `>= 2`, `firstMessage` sent, cadence rule for transcript growth.
- Engine: summary/topic carried, promises merged like questions with
  dismissal memory, triggers checked locally each scheduler pass, reminders
  as a keyed `promiseReminder` state field; recap as `recap` state with
  expiry 5 minutes.
- UI: Promises section, recap card with Post to chat (composer pre-fill),
  "On topic" badge and sort, topic line under the Orcle header.
- Done when: Rust tests for wire round trip, ladder, cadence, promise merge
  and triggers; renderer tests; `pnpm smoke:cohost-fake` passes with the
  fake service speaking v3.

### S6. Desktop: chat you haven't acknowledged (fable-5)

Files: `cohost.rs` (ledger and nudge), `live_chat.rs` (own-send hook only),
renderer pane/Stream Manager/toast files.

- Ledger, matcher and nudge per D9 as pure functions with table tests
  (mangled handles, short names, stop-list, camelCase, digits).
- State: `sayHi: [{authorKey, name, platform, firstSeenAt}]`,
  `deadAirNudge: {key, text, at}` (both optional); RPC
  `cohost.author.greeted {sessionId, authorKey}`.
- UI: "Say hi" section with Greeted; dead-air toast via the existing keyed
  toast pattern.
- Done when: Rust + renderer tests green; fake smoke covers a greeting by
  voice.

### S7. Desktop: Clip that (opus-4.8 for UI, backend part fable-5)

Files: `captions.rs` or a new `clip_marks.rs`, `storage.rs` (table),
`publish_clips.rs`, `remote_control.rs`, `docs/remote-control.md`,
`apps/desktop/src/shared/global-shortcuts.ts`, renderer
`lib/remote-surface.ts`, `components/tabs/ai-tab.tsx`,
`components/stream-manager/stream-manager.tsx`.

- Pure phrase matcher over finals + segments (boundary-spanning: keep the
  previous final's last words), dedupe within 10 s, mark time = phrase
  start. Manual mark stamps `active_capture_elapsed_seconds()`.
- `clip.mark` intent in the remote allowlist, shortcut, Stream Manager
  button; `clip.marked` event → toast "Clip marked at 12:34" (or the
  recording-off message).
- Storage and Publish integration per D6.
- Done when: matcher table tests, storage tests, `pnpm smoke:remote-control`
  passes with the new intent, Publish clips test shows marks first.

### S8. Desktop: the pack runs itself (opus-4.8)

Files: `ai.rs` (timed transcript), `hooks/use-studio.tsx`,
`components/tabs/ai-tab.tsx`, settings, tests.

- Timed transcript builder (pure, tested): cues → ~30 s blocks with
  `[h:mm:ss]`, 110k cap cut from the start with a note.
- Auto-run per D10 exactly once per session (persist a ran flag), toast
  with Open Publish.
- Done when: Rust + renderer tests; a fake-job run proves one call per
  session.

### S9. Smokes, fake services, docs (gpt-5.5)

- `scripts/lib/fake-caption-service.mjs`: accepts `purpose`.
- `scripts/lib/fake-cohost-service.mjs`: v3.
- A smoke scenario: captions OFF, Orcle listening ON, injected audio →
  transcript reaches Orcle, a "clip that" mark lands, no caption emits.
- Docs: `docs/remote-control.md`, changelog entry draft,
  `docs/acceptance/2026-09-27-orcle-listens.md`.
- As executed: the fake caption service records `purpose` (node test in
  `test:scripts`); `smoke:captions-contract` gained the listen-only scenario
  (purpose=listen, record kept, Orcle `listening: on`, zero `captions.*`
  events). A "clip that" mark needs a recording, so it stays proved by the
  `clip_marks` Rust tests, not a smoke. `smoke:captions-live` now asserts
  that a muted window uploads nothing (D4). No changelog draft: entries are
  written only at release time (`changelog/README.md`).

### S10. Review and owner acceptance (fable-5, Review route)

- Review both PRs: serde-null trap on every new optional field, contract
  `allowUnknown:false` coverage, listen never blocks capture, presentation
  gating complete, consent copy everywhere, quotas.
- Owner acceptance on one real stream: captions off, Orcle hears; say
  "clip that"; greet a first-timer by name; leave dead air with a question
  open; stop and see the pack.

## Edge cases

- Captions turned on mid-stream while listening: presentation flips on;
  same task, same timeline, purpose switches to `captions`.
- Captions turned off mid-stream while listening: presentation flips off;
  overlays clear; task continues.
- Orcle turned off mid-stream: listen intent ends; if captions are off the
  task drains and ends.
- Mic muted: silence skip means nothing uploads; no dead-air nudge while
  muted.
- Listen quota exhausted: Orcle state shows it; captions unaffected.
- No mic selected: listen blocked quietly; capture unaffected.
- "Clip that" said twice within 10 s: one mark.
- Recording off: no mark stored; toast explains.
- Kick messages: accepted by the web in every version.
- Old server (no v3): ladder falls back to v2; listen `purpose` is ignored
  by an old chunk route and meters as captions (acceptable during
  rollout).
- Old desktop, new server: all new fields optional.

## Out of scope

Replay buffer for stream-only clipping, platform VOD edits (YouTube
chapters written back), posting to X, non-English clip phrases, the stream
delay idea for caption sync, and the chat-clip startup-offset bug in
`publish_clips.rs`.

## Verification gates

- Desktop: `pnpm typecheck`, `PATH=/opt/homebrew/bin:$PATH pnpm lint`,
  `pnpm format:check`, `PATH=/opt/homebrew/bin:$PATH pnpm --filter @videorc/desktop test`,
  `cargo fmt --check --all`, targeted `env -u VIDEORC_PREMIUM_FEATURES cargo test -p videorc-backend <module>`,
  `cargo clippy -p videorc-backend -- -D warnings`,
  `cargo build --release -p videorc-backend`, `pnpm smoke:captions-contract`,
  `pnpm smoke:cohost-fake`, `pnpm smoke:remote-control`.
- Web: `pnpm typecheck`, `pnpm test`.
- Rollout: web first (S1, S2) → desktop release → owner acceptance.

## Handoff (cold start)

Goal: Orcle hears the streamer for the whole live stream without captions,
and uses it for Clip that, a transcript-aware regular check (promises,
recap, on-topic questions), a post-stream pack that runs itself, and "Say
hi" plus dead-air nudges. Web S1+S2 run in parallel with desktop S3.
Desktop S4-S8 run in order after S3 in the same worktree. S9 and S10 last.
