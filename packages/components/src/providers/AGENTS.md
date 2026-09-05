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

## Prompt Shortcuts

- `prompt-shortcut-provider.tsx` is mounted once by `MainLayout`, behind its scoped
  readiness gate. It uses the platform identity and public cloud operation descriptors;
  local mode never requests cloud grants. Account, route and doc-meta must agree.
- One `PromptShortcutRuntime` owns the working catalog/outbox and protected index/body
  sync. Do not create services or Streams rooms in settings/composers. The service's
  repo has no workspace transports: its local ledger must never be uploaded.
- `lody-shortcut-data-<workspace>:<user>` is durable user data, not a disposable
  replica cache. Ordinary cache clear (including late extraNames) preserves it;
  explicit hard reset may delete it. No raw Prompt goes into localStorage.
- Render-time identity fencing hides the previous instance immediately. Every cloud
  callback checks the captured identity before and after awaiting; cleanup also closes
  late initialization and releases the protected repo. Reopening the same IndexedDB
  waits for its previous writer to close. Save resolves on local durability.
- The reactive authorization directory contains body/revision pointers, not labels or
  Prompt text. Directory membership owns live catalog rooms; bodies load only on selection
  or outbox recovery. Cached shared content still requires an actual body grant.
