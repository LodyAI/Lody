# Make ACP login runtime downloads visible and cancellable

Status: proposed
Translation: current

[中文](2026-09-21-acp-auth-runtime-download.zh.md)

## Abstract

A failed Codex sign-in could be followed by a bogus prompt to re-download the
acp-codex managed runtime (LodyAI/Lody#828, Bug 2). The login path resolved the
managed runtime without an abort signal or progress callback, so a download ran
invisibly, neither Cancel nor the authentication timeout could interrupt it, and
its failure was returned as the login error. The login path now forwards its
cancellation signal and reports a new `runtime-download` progress event that the
sign-in panel renders. A second defect found during the same investigation — a
runtime cache whose metadata no longer matched the pinned definition hard-failed
every status check and reinstall — was fixed upstream in #906 while this PR was
in review, so this change drops its own overlapping cache fix and keeps the
login-path half.

## Discovery

Desktop builtin login spawns the managed provider binary directly:
`AcpAuthenticationManager.authenticate` → `resolveBuiltinAuthenticationProcessLaunch({ action: 'login' })`
→ `resolveManagedRuntimeForLaunch` → `ManagedAgentRuntimeManager.resolveRuntimeForLaunch`,
which downloads the runtime on the spot when it is not installed.

- The login call passed neither `signal` nor `onManagedRuntimeProgress`, unlike
  the status probe path (`probeBuiltinAuthentication` passes both). During a
  download the sign-in UI showed nothing, and Cancel/timeout only took effect
  after the download finished, because the interruption checks ran after launch
  resolution.
- Any failure from that resolve (including download errors) was returned by
  `authenticate()`'s catch as the login error, so a runtime problem presented as
  a sign-in failure.
- Separately, `readCurrentInstallation` threw when the cached `metadata.json` did
  not exactly match the pinned definition (same-version re-pin), dead-ending
  status, launch, and retry until the cache directory was deleted by hand.
  Upstream #906 fixed this half first: pin-mismatched entries are treated as
  absent and reinstalled, startup cache maintenance tolerates per-runtime
  failures, and unparseable metadata still rejects launch. The owner-approved cache repair below
  replaces the former permanent install/status rejection.

## Decision

- Login launch resolution (`apps/cli/src/agent/acp-authentication.ts`) passes
  `running.abortController.signal` and an `onManagedRuntimeProgress` callback
  that republishes download progress as a new `AcpAuthenticationProgressEvent`
  variant, `runtime-download` (`runtimeName`, `runtimePhase`, optional
  `runtimePercent`). The event crosses the wire on
  `machine/acp-authentication-progress`; the schema (`message-schemas.ts`), the
  hand-written interface (`message.ts`), and both local-session-control
  validators (`.ts` + `.cjs` mirror) were extended together. The sign-in panel
  renders an i18n status line while `phase === 'running'` and clears it on
  `starting`, `complete`, cancel, and error. Cancellation reuses the manager's
  consumer-lease semantics: aborting the login only releases that consumer, and
  a concurrent Settings install keeps the shared download alive.
- `AcpAuthenticationManagerOptions` gains a `resolveAuthenticationProcessLaunch`
  seam (matching the existing `spawnProcess`/`resolveLoginShellEnv` injections)
  so tests can observe the signal/progress wiring without a real download.

Alternatives considered:

- Refusing to download on the login path (require a Settings download first):
  safer, but changes first-run UX; download-on-login is now visible and
  cancellable instead.
- Corrupt metadata remains unlaunchable, but status reports not-installed with a
  warning and the shared installer renames it to a sibling `.corrupt-<time>-<uuid>`
  before verified download/publication. Bad older entries are skipped during reuse.
  The former complete-marker argument cannot repair corruption after publication;
  preserving the bytes and verifying a replacement avoids permanent blockage.
  Downloads stop after 60 seconds without data, with no total deadline: a fixed
  ten-minute cap interrupts healthy slow transfers. Streaming writes directly to
  `.downloads/*.part`, retained after idle timeout for the next Range request.
  The outer cancellation catch only moves an already-complete archive back from
  scratch; partial streaming recovery does not depend on that outer signal.
  Consumer cancellation retains the existing independent leases and cleanup join.
  Session/provider orchestration stays Promise-based; migrating those owners would
  exceed this local fix. Provider setup passes its stop signal, but forwarding it
  inside session-execution-service remains follow-up work outside this PR.

## Evidence

- `apps/cli/src/agent/acp-authentication.test.ts`: new tests assert the login
  path forwards an `AbortSignal`, republishes progress as `runtime-download`,
  and that Cancel during launch resolution settles the flow as `cancelled`
  without spawning. On the pristine base the progress test fails and the cancel
  test hangs past its timeout.
- `packages/shared/tests/message-schemas.test.ts` and
  `local-session-control.test.ts` accept the new message shape and reject
  `runtime-download` payloads missing `runtimeName`/`runtimePhase` (TS + CJS).

## Verification

- `vitest run src/agent/managed-agent-runtime.test.ts src/agent/acp-authentication.test.ts`
  (apps/cli): all pass except two `probeBuiltinAuthentication` failures that
  reproduce identically on the pristine base in this environment (host Node 26;
  the repo supports Node 22.14–22.x / 23.6+).
- `vitest run tests/message-schemas.test.ts tests/local-session-control.test.ts`
  (packages/shared): all pass.
- Root `pnpm typecheck`, `pnpm lint`, `pnpm lint:i18n`, `pnpm format`, and the
  three boundary guards pass. The `packages/components` suites fail locally with
  the known `localStorage`/jotai environment issue, identically on the pristine
  base.

Remaining limits: when the download itself fails during login, the login error
is still the runtime install message — now accurate and preceded by visible
progress, but not a distinct "download failed" wording. The status-probe path
already had signal/progress and is unchanged.
