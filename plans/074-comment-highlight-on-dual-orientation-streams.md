# Plan 074: Comment highlight never reaches the video on dual-orientation streams

**Status:** IMPLEMENTED 2026-09-28 on `fix/074-highlight-simulcast` (S1 + S2);
owner acceptance (S3) owed. **Priority:** P0 (a live feature that lies:
Stream Manager says "On stream" and viewers see nothing). **Size:** S for the
fix (S1), M for the vertical card (S2).
**Planned against:** `origin/main` `4d36bd76` (0.9.120).
**Owner route:** Diagnose → Implementation (fit 9). **Model lane:** `fable-5`
(recording-output behaviour; release-critical).

## Owner report

Live stream 2026-09-28 (session `453bf8f5-60fd-4ba4-bbe6-7c67b47b7a4c`,
14:06–15:06Z): clicking a comment to highlight it shows it as highlighted in
Stream Manager, but the card is not on the video.

## Evidence (verified, do not re-derive)

Session row in `videorc.sqlite3` / `diagnostics_json`:

- `mode = record+stream`, primary 1920×1080@30, 6000 kbps.
- `streamOutputWidth: 1080`, `streamOutputHeight: 1920` — the separate
  "stream" encoder was the **vertical simulcast leg**.
- `encoderBridgeActiveEncodedOutputEncoders: 2` — recording + vertical. The
  horizontal destinations shared the recording's encode (the primary leg).
- `backend.log`: `[simulcast-leg] vertical scene changed live: VerticalSplit`.
- `backend.log` has zero highlight lines — set/install/expire are never logged,
  so the failure was invisible in diagnostics.

## Root cause

Three pieces that were each correct alone; the dual-orientation simulcast
(`e46bb2b1`, #121, shipped 0.9.94) broke their combination:

1. `crates/videorc-backend/src/recording.rs` `recording_compositor_stream_output_with_plan`:
   when `params.simulcast` is set, the auxiliary output **is the vertical leg**
   (`composes_simulcast_scene: true`). Horizontal targets ride the **primary**
   leg with the recording.
2. `recording.rs` (~L4026) builds the highlight plan with
   `highlight_overlay_leg_plan(record, stream, encoder_bridge_stream_output.is_some())`.
   `captions.rs` `highlight_overlay_leg_plan` reads "an aux exists" as "viewers
   watch the aux", so it returns `(primary=false, aux=true)`.
3. `crates/videorc-backend/src/compositor.rs` (~L7554) drops the highlight on
   any aux that `composes_simulcast_scene` ("vertical leg streams clean in
   Phase 1").

Net: primary = off, aux = suppressed → the card is drawn on **no** output.

Meanwhile `comment_highlight_available()` (`recording.rs` ~L18880) is just
`stream_enabled && use_encoder_bridge`, so `comments.highlight.set` validates,
installs the PNG into `state.highlight_overlay`, and returns `phase: live`. The
renderer publishes that to Stream Manager — hence the false "highlighted" UI.

Captions do not have this bug only because stream-burned captions are refused
at validation when simulcast is armed (`simulcast_refuses_mixed_horizontal_profiles_and_stream_burned_captions`).
The highlight never got an equivalent guard or plan branch.

Scope of impact: every `stream` session with a vertical simulcast leg since
0.9.94, macOS and Windows (the generic compositor path is shared; the D3D11
pump never composes simulcast). Horizontal-only streams are unaffected, which
is why `smoke:comment-highlight-stream` (stream-only + split-record-stream
scenarios, no simulcast) stayed green.

## Owner decisions

- **O1 — Card on the vertical stream too: YES** (owner, 2026-09-28: "We also
  need that highlighted in the vertical stream as well"). S2 is in scope.
- **O2 — Vertical corner:** the same corner pick as horizontal (the plan's
  default). Revisit after the by-eye pass if it covers a face.
- **O3 — Recording:** accepted by default. With a vertical leg, horizontal
  viewers share the recording's encode, so the card lands in the recording
  too, as it already does for any record+stream session on one leg.

## Slices

### S1 — Put the card on the horizontal stream, and never claim "On stream" when no leg burns it

Files: `captions.rs` (`highlight_overlay_leg_plan` + tests), `recording.rs`
(plan call site ~L4026, `comment_highlight_available`, the Windows D3D11
call site ~L3737 for symmetry), `comment_highlight.rs` (logging).

1. Change the plan input from "an aux exists" to "the aux carries the
   horizontal stream": pass `aux.is_some() && !aux.composes_simulcast_scene`.
   A simulcast session then plans `(primary=true, aux=false)`.
2. Derive availability from the effective plan: the session records
   `comment_highlight_available = use_encoder_bridge && (plan.0 || plan.1)`
   instead of `stream_enabled && use_encoder_bridge`. Keep the plan the single
   source for both the compositor flags and the availability bit so they can't
   drift again.
3. Log one INFO line per set/clear/expire (`session`, `generation`, anchor,
   which legs burn) so a future report is diagnosable from `backend.log`.
4. Unit tests: extend `highlight_leg_plan_follows_the_stream_leg` with a
   simulcast case; extend `comment_highlight_requires_a_composited_stream_leg`
   with "record+stream+simulcast → available, primary-leg"; add a test that a
   plan with no burning leg makes `set_comment_highlight` return
   `UnsupportedOutput` (`highlight-unavailable`), not `live`.
5. Smoke: add a `dual-orientation-record-stream` scenario to
   `scripts/smoke-comment-highlight-stream-app.mjs` (simulcast armed, local
   RTMP listener on the horizontal target) and assert the card is in the
   horizontal stream artifact via `analyzeCommentHighlightArtifact`.

**Done when:** new unit tests pass; `pnpm smoke:comment-highlight-stream`
passes all scenarios including the new one; a manual record+stream with a
vertical destination shows the card on the horizontal output and in the
recording; `backend.log` shows the highlight lines.

### S2 — Card on the vertical leg too (if O1 = yes)

The vertical leg was left clean because the PNG is rasterized at the
horizontal width (`use-studio.tsx` ~L2576 uses `streamOutputVideoSettings(...).width`,
the card is up to 60% of it — 1152 px, wider than a 1080 px vertical canvas).

As built:

1. Backend: a second single-card slot, `AppState.simulcast_highlight_overlay`,
   installed and cleared together with `highlight_overlay` (set, replace,
   expire, clear, session boundaries). The compositor feeds it to an aux that
   `composes_simulcast_scene`; the plan returns `(true, true)` for simulcast.
2. Backend authority for the topology: the session records
   `comment_highlight_vertical_canvas` at start, and a read-only
   `comments.highlight.canvases` RPC (observation lane, like
   `comments.highlight.status`) tells the renderer whether to rasterize a
   second card and at what size. A vertical PNG sent for a session without a
   vertical leg is ignored.
3. Wire: `SetCommentHighlightParams.verticalPngBase64` (optional,
   `#[serde(default)]`). Old renderers still get S1 behaviour.
4. Renderer: `highlightMetrics(width, height?)` sizes text off the long edge,
   so a 1080x1920 card uses the same type as the 1920x1080 one, and a portrait
   card may span 85% of the width (was 60%, which cropped nothing but made
   23 px text). Vertical-preset primary streams get the same readable card.
5. Hardening found on the way: single-slot overlay revisions are now
   process-wide monotonic. They restarted at 1 after every clear, and the
   Metal texture cache keys on `(namespace, revision, size)` per source index,
   so a same-size card after an expired one could replay the old pixels.
6. Tests: leg-plan, availability, vertical-canvas, install/replace/expire/clear,
   set-path gating, renderer layout and provider integration; the smoke's new
   `dual-orientation-record-stream` scenario proves the card on BOTH received
   streams and that the vertical destination got the 720x1280 portrait leg.

**Done when:** both legs show the card at the chosen anchor in the smoke and
in an owner by-eye stream with a vertical destination.

### S3 — Owner acceptance

Stream with a horizontal + vertical destination, highlight three comments
(one per corner incl. default), confirm on the YouTube horizontal player, the
vertical player (if S2), and the local recording.

## Verification gates

- `cargo fmt --check --all`
- targeted `cargo test -p videorc-backend highlight` and `... comment_highlight`
  (owner directive: targeted cargo tests + clippy locally, not the full suite)
- `cargo clippy -p videorc-backend -- -D warnings`
- `cargo build --release -p videorc-backend` (release-build cfg gap)
- `pnpm typecheck && pnpm lint && pnpm --filter @videorc/desktop test` (S2)
- `pnpm smoke:comment-highlight-stream`

## Out of scope

- Keeping the recording clean while the horizontal stream carries the card
  with a vertical leg armed (needs a third encode).
- Stream-burned captions on simulcast sessions (still refused at validation).
