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
  its own policy — never share the desktop one. Widen the candidate scope through
  `policy.stages` rather than a single large `candidateWindow`: the ladder starts on
  the pinned / on-screen / running set and steps outward only after the queue has
  drained AND the app has then stayed idle for that stage's hold. A stage must never
  advance on wall-clock time alone.
- Prefetching yields to the user through the `interaction` port
  (`eager-sync-interaction.ts`): while it reports true the coordinator starts nothing
  new. It does NOT abort in-flight work for interaction — that costs a fresh room
  join later and buys no frame back now; only offline/hidden aborts. The signal is
  fed by direct-manipulation events only and deliberately ignores `scroll`, because
  the conversation view auto-scrolls itself while an agent streams and would
  otherwise starve background sync for as long as any session runs.
