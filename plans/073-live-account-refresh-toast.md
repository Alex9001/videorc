# Plan 073: A refresh during a live session shows a raw account error and does nothing

Status: investigated 2026-09-28; **IMPLEMENTED 2026-09-28** on
`plan/073-live-account-refresh-toast` (all four slices, see
[Implementation record](#implementation-record-2026-09-28)). Priority P1:
while live, any full Studio refresh shows a raw IPC error and throws away its
own results. That includes Sources → Refresh, which is meant to find a newly
connected camera. Recording and streaming continue normally.

## Incident

Owner screenshot, installed **0.9.120**, taken during or right after the
livestream `453bf8f5-60fd-4ba4-bbe6-7c67b47b7a4c` (September 28, about 14:06 to
15:06 UTC, see `backend.log`). This red toast appeared over the Assets tab:

> Error invoking remote method 'account:refresh': Error: Account maintenance is
> deferred until the live session is idle.

The error comes from the renderer, so no backend log records it.

## Root cause

All paths below are on `origin/main` `4d36bd76`.

1. **Main deliberately refuses account refresh during capture.**
   `apps/desktop/src/main/account-refresh-broker.ts:12-16` rejects with a plain
   `Error` whenever `captureStateBlocksInterruption(mainCaptureState, …)` is
   true, meaning the state is recording, streaming, starting, stopping, or
   `unknown` (`src/shared/capture-state.ts:16`). The rejection is intended
   (from #297), so network maintenance stays off the machine during capture.
   Across Electron IPC it arrives only as a string with Electron's
   `Error invoking remote method '<channel>': Error: ` prefix.

2. **Two renderer callers handle that rejection differently.**
   - The focus/timer/cold-launch path (`use-studio.tsx`,
     `refreshAccountSnapshot` in the account-ready effect, about line 7262)
     catches and drops it. That is correct.
   - `refreshBackend` (`use-studio.tsx:7124`) awaits
     `refreshAccountSnapshotForClient(activeClient)` (line 7183) inside the
     batch `try`. A rejection there skips every setter that follows (health,
     devices, sessions, screens, platform accounts, metadata validation,
     noise-cleanup jobs). Control jumps to `catch → reportError`, and
     `showBackendError` toasts the raw message.

3. **Several triggers reach `refreshBackend` while live:**
   - Sources → **Refresh** (`sources-tab.tsx:249`). This is the worst case: the
     device list fetched by the refresh is discarded, so the button fails at
     its only job while live.
   - Settings → Permissions → Refresh (`settings/permissions-settings.tsx:39`).
   - Every window **focus** while Settings is open (`settings-tab.tsx:48`) or
     the permissions dialog is open (`permissions-onboarding-dialog.tsx:48`).

   Sonner toasts stay on screen for several seconds, and the timer pauses while
   the pointer hovers the toast. That explains why the toast showed over Assets
   after the owner left the tab that triggered it.

4. **The promise in the message is never kept.** No code reruns the deferred
   refresh when the session goes idle. A purchase or avatar change made during
   a stream waits for the next focus or for the 5-minute signed-in timer
   (`SIGNED_IN_ENTITLEMENT_REFRESH_INTERVAL_MS`).

5. **General issue:** no code strips Electron's IPC error prefix
   (`git grep "Error invoking remote method"` finds nothing). Every rejected
   `window.videorc.*` call that reaches `reportError` toasts the wrapped
   message.

### Why tests missed it

`account-refresh-broker.test.ts` tests the rejection only in isolation. No
test calls `refreshBackend` while capture is active: in
`studio-provider.integration.test.ts`, `refreshAccount` always resolves.

## Fix: ordered slices

Owner route: Implementation (fit 8). Model lane: `gpt-5.5`. It is a clear,
non-cosmetic, renderer and IPC-contract change. Slices 1 and 2 can ship
without 3 and 4.

### 1. Account refresh can never sink `refreshBackend` (the functional fix)

In `refreshBackend`, isolate the account step so that its failure only skips
the account and AI-readiness commit, and the rest of the batch still commits:

- Wrap the `refreshAccountSnapshotForClient` and `refreshAiReadinessForClient`
  block in its own `try/catch`, which keeps the current snapshot (same
  contract as the focus path: "Failures keep the current snapshot").
- A deferral is **silent**, because deferring is the designed behaviour.
- For any other account failure, keep today's `setLastError` diagnostic.
  Report it only **after** the batch has committed, and never let it cancel the
  batch.

**Done when:** a new integration test in `studio-provider.integration.test.ts`
passes. The test sets `refreshAccount` to reject with the broker's deferral,
calls `refreshBackend({ fresh: true })`, and asserts that (a) a changed
`devices.list` payload is committed, (b) the account snapshot is unchanged, and
(c) no `toast.error` or `showBackendError` fires. The test must fail on
current `main`.

### 2. Deferral is a typed result, not a thrown string

String-matching an Electron-wrapped message is fragile. Change the contract:

- `AccountRefreshBroker.refresh()` resolves
  `{ outcome: 'deferred' } | { outcome: 'refreshed'; snapshot }` and no longer
  rejects for capture. Real request failures still reject.
- Update the `'account:refresh'` result schema in
  `src/shared/electron-ipc-contract.ts:935`, the `refreshAccount` type in
  `src/shared/backend.ts`, the preload, and the contract tests
  (`electron-ipc-contract.test.ts:82-99`).
- `refreshAccountSnapshotForClient` maps `deferred` to `null`, its existing
  "nothing to commit" value. The `account.get` fallback (no preload) keeps
  returning `refreshed`.

**Done when:** `account-refresh-broker.test.ts` asserts a `deferred`
resolution with no admin request, the contract tests accept both variants and
reject malformed ones, and the slice 1 test still passes after switching its
mock to the typed result.

### 3. Honour "deferred until idle": replay once when capture ends

Track in a ref that a refresh was deferred (set when the result is
`deferred`). When `recordingRef.current.state` changes from active to idle,
run one `refreshAccountSnapshot()` and clear the flag. If nothing was
deferred, do nothing: no extra network call after every take.

**Done when:** a unit or integration test shows that a deferral during
`streaming` followed by a transition to `idle` produces exactly one extra
`refreshAccount` call, and that an idle-to-idle transition produces none.

### 4. Strip Electron's IPC wrapper from user-visible errors

Add a small `ipcErrorMessage(error)` helper in `src/renderer/src/lib/` that
removes `^Error invoking remote method '[^']+': (Error: )?`. Apply it in
`reportError` before `setLastError` and the toast. This fixes the same
prefix leak on every other `window.videorc.*` rejection.

**Done when:** a unit test covers a wrapped message, a double `Error:`, and an
unwrapped passthrough, and `reportError` uses the helper.

## Out of scope

- Whether `refreshBackend` should run network-touching calls such as
  `platformAccounts.validate` during capture. It already does today without
  errors. If needed, file this separately with evidence.
- Changing which capture states count as blocking (`unknown` included).

## Verification gates

```bash
pnpm --filter @videorc/desktop test -- account-refresh-broker electron-ipc-contract studio-provider.integration
pnpm typecheck && pnpm lint && pnpm format:check
pnpm build
```

This does not change recording or native preview, so those smokes are not
required. Manual check on a dev build: start a local recording, open Sources,
click **Refresh**, and focus the window with Settings open. Expect no toast,
and the device list updates. Stop the recording and confirm that exactly one
`account:refresh` IPC call follows (for example, with a temporary `console.debug` in
the broker).

## Implementation record (2026-09-28)

- **Slice 1:** `refreshBackend` wraps the account and AI-readiness step in its
  own `try/catch`. A deferral commits nothing and stays silent. Any other
  failure is reported through `reportError` only after every other result has
  committed.
- **Slice 2:** the discriminant is `outcome`, not `status`, because the
  snapshot already has its own `status` field. The broker resolves
  `{ outcome: 'deferred' }`. The IPC schema is a strict union, so a bare
  pre-073 snapshot or a deferral that carries data is rejected. The
  `account.get` fallback is wrapped as `refreshed`.
- **Slice 3:** a deferral sets `accountRefreshDeferredRef`. An effect keyed on
  `isActiveRecordingState(recording.state)` replays exactly one refresh after
  `ACCOUNT_REFRESH_IDLE_REPLAY_DELAY_MS` (1 s). The delay exists because Main
  and the renderer receive the idle status on separate sockets, and an
  immediate replay could race Main into a second deferral. A successful
  refresh clears the flag.
- **Slice 4:** `lib/ipc-error-message.ts` strips the wrapper, including a
  rethrown `TypeError:` or similar class name, and `reportError` uses it.

### Evidence

With only `use-studio.tsx` reverted to `origin/main`, all three new
integration tests fail: the deferred-Refresh test, the failed-refresh test,
and the idle-replay test. With the fix, all three pass.

### Gates

- `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, and `pnpm build` pass.
- Focused tests pass: `account-refresh-broker`, `electron-ipc-contract`,
  `ipc-error-message`, and `studio-provider.integration` (115/115, run twice).
- In the full `pnpm --filter @videorc/desktop test` run, 2377 of 2380 tests
  passed and 1 was skipped. Each of two full runs had timing flakes in files
  this change does not touch: `bounds a hung X END` in one run, and two
  `backendClient` 1 s timeouts in the other. The machine's load average was
  about 60 at the time. Each flaky file passes when run alone.

### Still owed

The manual dev-build check from the verification section: Refresh during a
local recording with no toast, and one replay after stop.

**The renderer asset budget is red, and this is an owner decision.**
`pnpm check:renderer-assets` was already failing on `main` after #484. CI run
36421574521 measured 2,000,010 raw eager bytes against the 2,000,000 ceiling.
This change adds about 1.8 KB of Studio provider logic, for a total of
2,001,780 raw bytes, so the gate stays red either way. Before merging, the
owner decides between two options: recalibrate the raw ceiling in
`scripts/check-renderer-asset-budget.mjs` (earlier provider-correctness growth
was handled this way), or re-split the Studio chunks.
