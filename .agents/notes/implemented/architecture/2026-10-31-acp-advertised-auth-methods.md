# Show an ACP agent's advertised sign-in methods up front

Status: implemented
Translation: current

[中文](2026-10-31-acp-advertised-auth-methods.zh.md)

## Abstract

ACP agents publish their sign-in methods in the `initialize` response, but Lody only ever read
that list inside a sign-in attempt, so the account panel showed a single "Sign in" button and
users discovered that a Provider offered several methods (browser, device code, API key) only
after starting one. The capability probe now records the advertised methods on the Provider's
capability row, the account panel renders them as the sign-in entry point in both Provider
settings and the in-conversation `acp_auth_required` notice, and `machine/acp-authenticate
start` accepts the picked `methodId`. `initialize` lists supported methods whether or not the
stored credentials still work, so the panel no longer waits for a live `authRequired` probe; the
trade-off is one capability probe when the panel first renders for a Provider whose methods were
never recorded.

## Problem

`agent-client.ts` cached `initResponse.authMethods` on every `initialize`, but the only reader
was `authenticateProtocolDrivenAcp`: it auto-selected a lone method and emitted an `auth-methods`
progress event (with a picker) when several existed. Both paths run *inside* a sign-in attempt
that the user had already started, so the UI could not list the agent's methods beforehand. The
settings dialog additionally gated the whole Account panel for registry/custom/Devin Providers
on a live `authRequired` signal — `usesAcpProtocolAuthentication`'s comment stated that rule
explicitly.

## Decision

- `fetchAcpCapabilities` returns `client.getAuthMethods()` with the probe result.
- `AcpCapabilityCacheEntry.authMethods` stores the summarized list for agent-driven (registry,
  custom, Devin) Providers only. `undefined` means no probe asked; `[]` means the agent was asked
  and advertised none — the distinction stops the panel from re-probing forever.
- The capability refresh returns the same list, including from its persisted-cache path, so a
  probed Provider converges immediately. A capability write that never asked the agent
  (session-created updates) preserves a recorded list while the launch version is unchanged,
  and drops it when the launch changed, leaving discovery to probe the new target.
- `AcpAuthenticationPanel` reads the capability row and otherwise runs one capability refresh per
  target per mount. It renders agent-driven methods as rows instead of the single button, in both
  the settings Account section and the conversation auth notice.
- `machine/acp-authenticate start` carries an optional `methodId`, gated by the new
  `acpAuthenticationMethodSelection` protocol capability (v1) because the request schema is
  strict. The daemon re-reads the advertised list and uses the pick only while the agent still
  advertises it; otherwise it keeps today's single-method/auto-picker behavior.
- The settings dialog shows the Account panel for protocol-auth Providers regardless of
  `authRequired`; `authRequired` now only selects the hint text.

Alternatives considered:

- **A separate discovery RPC**: reuses nothing, and a new strict message would need its own
  capability and error surface. The capability refresh already spawns, initializes, and persists.
- **Renderer-only caching**: cheaper, but the conversation notice would have no list after a
  restart and the Fleet document already owns this probe result.
- **Auto-selecting the first advertised method**: hides the choice that motivated the change and
  can start a login the reader did not ask for.

## Evidence and limits

Behavioral coverage: `apps/cli/src/agent/acp-authentication.test.ts` covers a pre-picked method and a
stale pick; `apps/cli/src/agent/acp-capabilities.test.ts` covers returning the advertised methods;
`packages/shared/tests/message-schemas.test.ts` covers `methodId` and cached `authMethods`;
`packages/components/tests/use-machine-acp-authentication.test.tsx` covers forwarding the pick.
Verification limit: the ACP extension submodules and the supported Node runtime were unavailable
in the authoring environment, so these suites were not executed — `pnpm typecheck` and the
package test suites still have to run before merge. No automated test spawns a real agent for
discovery.

Limits: discovery costs one probe (and possibly a managed-runtime download) the first time a
protocol Provider's panel renders without a recorded list. A stale cached list can offer a method
the agent dropped; the daemon then falls back rather than failing. Older renderers reject a
newer capability object that carries `authMethods`, so mixed desktop/daemon versions should
upgrade together.
