# Give ACP authentication control messages their own queue lane

Status: proposed
Translation: current

[中文](2026-09-20-acp-authenticate-queue-lane.zh.md)

## Abstract

Clicking Cancel during a managed-agent login (for example Codex "Sign in with ChatGPT")
had no effect until the login finished or hit the daemon's 285-second timeout: the local
control queue serialized the `machine/acp-authenticate` cancel message behind the
still-running start message on the shared default lane. `MessageProcessor.extractQueueKey`
now maps `start` onto a dedicated lane and `cancel`/`submit-code`/`submit-input` onto a
shared control lane, so control actions dispatch while a login is in progress. One race
remains by design: a cancel that arrives before the start has registered with
`AcpAuthenticationManager` resolves as `not-running`, and the user can cancel again.

## Discovery

Renderer cancel is fire-and-forget: it posts `machine/acp-authenticate` with
`action: 'cancel'` and waits for the daemon's `cancelled` progress event. On the desktop
local path that message travels
`MachineRuntime.dispatchLocalMessageForResponse` → `MessageProcessor.enqueue`
(`apps/cli/src/lib/machine-runtime.ts`), where two defaults composed badly:

1. `extractQueueKey` assigned lanes only to `session/*` messages; every `machine/*`
   message — authenticate start and cancel alike — fell through to `null`.
2. `ConcurrentQueue.enqueue` maps a `null` key to one shared `__default__` serial chain.

The start task holds that lane until `handleMessage` returns, which awaits the spawned
login process (`codex login --device-auth`) exiting or the 285 s authentication timeout
in `apps/cli/src/agent/acp-authentication.ts`. `AcpAuthenticationManager.cancel()` itself
was already correct — cancelled flag, abort signal, SIGTERM to the process group, SIGKILL
escalation — but it was never dispatched while the start it targets was still running.
The same stall also delayed unrelated `machine/*` control messages (status, ping, ...)
behind a running login.

## Decision

Lane assignment in `extractQueueKey` (`apps/cli/src/lib/message-processor.ts`):

- `start` → `machine:acp-authenticate:start`. Starts stay serialized against each other,
  matching prior behavior; per-provider mutual exclusion stays with
  `AcpAuthenticationManager.runningByAgentType`.
- `cancel`, `submit-code`, `submit-input` → `machine:acp-authenticate:control`. Control
  actions bypass a blocked start and keep their mutual order.

Alternatives considered:

- Lane per `authenticationRequestId`: a cancel would queue behind its own start in that
  lane, reproducing the deadlock.
- Moving only `start` off the default lane: also unblocks cancel, but permits concurrent
  starts; serializing starts stays closer to prior behavior, and the login UI already
  drives one flow at a time.
- Renderer-side optimistic cancel state: not needed for correctness — the panel updates
  on the daemon's `cancelled` progress event once the cancel is actually dispatched.

## Evidence

- `apps/cli/tests/message-processor-permission-response.test.ts` gains two tests: cancel
  and submit-code dispatch while a start handler is still blocked, and consecutive starts
  stay serialized. Without the lane change the cancel test times out waiting.
- Root cause report and reproduction: LodyAI/Lody#828 (Bug 1).

## Verification

- `vitest run tests/message-processor-permission-response.test.ts`: 4 passed; the new
  cancel test fails (1 s timeout) when the lane change is reverted.
- `vitest run tests/session-execution-service.test.ts`: 130 passed.
- `pnpm --filter lody test`: 2812 passed; the two `probeBuiltinAuthentication` failures
  in `src/agent/acp-authentication.test.ts` reproduce identically on the pristine base
  in this environment and are unrelated to the change.
- Root `pnpm check`: typecheck, lint, and the three boundary guards passed; i18n lint
  (`settings.about.devbarWarmup*` keys) and the `packages/components` suites
  (`atomWithStorage`: `getItem is not a function` under the local Node 25; the repo
  supports Node 22.14–22.x / 23.6+) fail identically on the pristine base — both are
  pre-existing environmental failures unrelated to the change.

Remaining limits: the fix covers the desktop local-control path, the only path routed
through `MessageProcessor`; remote machines dispatch authentication through Machine RPC
without this queue. The renderer still applies no optimistic cancel state. The second
half of #828 (login surfacing managed-runtime download failures) is unchanged and
remains open.
