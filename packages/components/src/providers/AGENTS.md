# Workspace provider guidelines

`CLAUDE.md` is a symlink to this file. Parent `AGENTS.md` files also apply.

## Mirrors over synced docs tolerate unknown root keys

Every `new Mirror(...)` over a doc that syncs between clients must pass
`ignoreUnknownProperties: true`. Peers on a newer schema write root keys this
build does not declare; without the flag loro-mirror rejects the entire state
with `Unknown property: <key>`, so the older client can never write to that doc
again. Contract test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

## Streams connection cardinality

- Capability discovery and refresh must reuse the workspace runtime's existing Machine
  Flock and Machine RPC transports.
- Never create or retain a Streams/Flock subscription per agent config or refresh request.
  Live connection cardinality must stay bounded by workspace/machine topology and must not
  grow with the number of agent configs. More configs may add serialized RPC requests, not
  live Streams connections.
- Release any one-shot document handle or subscription that is not already owned by the
  workspace runtime.

## Workspace switching

- The `$workspaceName` route owns the render-time target slug. Workspace-scoped UI must
  require that target, the active runtime, and the runtime-owned doc-meta snapshot to agree
  before reading singleton caches. Shared visibility and sharing hooks enforce this gate by
  default when mounted under `WorkspaceRouteTargetProvider`; scope mismatch returns an empty
  projection and disables queries, Machine Flock, sharing, and eager-sync inputs. Provider-
  external consumers such as `RuntimeProvider` retain their existing default behavior. Explicit
  `workspaceId` / `enabled` options remain fenced by the route scope and cannot reopen stale work.

## Background eager-sync

- `background-sync-coordinator.ts` stays PURE and dependency-injected: no loro-repo,
  no React, no real timers. Every new signal is an injected port with a fake in
  `tests/background-sync-coordinator.test.ts`, driven by that suite's fake clock.
- Mobile is not desktop with a smaller screen. Each prefetch deserializes a Loro doc
  on the one main thread a phone has, so `resolveEagerSyncPolicy('mobile')` must keep
  its own policy — never share the desktop one. What protects the phone is the PACING
  (concurrency, batch cooldown, resident cap), not a smaller eventual scope: mobile
  reaches the same `candidateWindow` as desktop.
- `warmupCandidateWindow` narrows that scope until the queue has drained AND the app
  has then stayed idle for `warmupHoldMs`. It must never widen on wall-clock time
  alone — queued work, in-flight work, or an interacting user all hold it — and a
  suspended phone does not run timers, so a hold armed before backgrounding is
  overdue the moment it resumes. Clear it on pause and restart the warm-up on resume,
  or every resume widens instantly with no warm-up at all.
- Do not gate candidates on a `priorityOf` FLOOR. `visibility.isVisible` is fed from
  `useVisibleSessionMetas`, which is a permission filter over every non-archived
  session, not a viewport filter — so a floor at the visible weight excludes nothing.
  The window is what bounds the scope; priority only orders it.
- Prefetching yields to the user through the `interaction` port
  (`eager-sync-interaction.ts`): while it reports true the coordinator starts nothing
  new. It does NOT abort in-flight work for interaction — that costs a fresh room
  join later and buys no frame back now; only offline/hidden aborts. The signal is
  fed by direct-manipulation events only and deliberately ignores `scroll`, because
  the conversation view auto-scrolls itself while an agent streams and would
  otherwise starve background sync for as long as any session runs.
- That gate is in `drain()` and so is POLICY-INDEPENDENT: any surface handed an
  `interaction` port defers, warm-up or not. Which surfaces want it is
  `policy.deferWhileInteracting`, beside concurrency and the batch cooldown, and the
  runtime must not create or bind the signal when a policy does not ask for it.
  Deferring costs prefetch throughput, and a slower session open is the thing
  eager-sync exists to prevent, so it is only worth paying where the main thread is
  the bottleneck: mobile and web yes, Electron no. Web defers because it may be a
  phone browser and nothing can tell — its already-bounded scope is what keeps that
  cheap on a workstation.
