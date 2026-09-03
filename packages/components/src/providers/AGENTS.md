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

## Session store history

- `createSessionStore` composes its state through `session-doc-state-source.ts`.
  With `isConversationViewEnabled()` (on unless `VITE_LODY_CONVERSATION_VIEW=0`
  or `localStorage['lody:conversationView']='0'`) the Mirror uses
  `sessionControlDocSchema` and `SessionDocStore.conversationView` is the
  history reader; off is the untouched full-Mirror path, kept as rollback.
- On the view path `getState().history` is a lazy bridge over
  `conversationView.readAll()`, bound once per snapshot and memoized per
  (control root, view version). Compare snapshots through
  `readSessionDocHistoryRevision`, never by touching `history`: the first read
  materializes the transcript. A history-only doc event never produces a new
  control root, so control-plane identity checks keep working.
- `setState` must not reach `history` on the view path; the store throws
  `SessionHistoryWriteThroughMirrorError` instead of persisting nothing. Every
  history write goes through `WorkspaceWriter` (`workspace-writer-impl.ts`),
  which routes to `lib/conversation-view/history-writer` when the store has a
  view and to `setState` otherwise. Store-level reads that hooks need
  (`lib/session-store-history.ts`) branch the same way.
