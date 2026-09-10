# Workspace provider guidelines

`CLAUDE.md` is a symlink to this file. Parent `AGENTS.md` files also apply.

## Mirrors over synced docs tolerate unknown root keys

Every `new Mirror(...)` over a doc that syncs between clients must pass
`ignoreUnknownProperties: true`. Peers on a newer schema write root keys this
build does not declare; without the flag loro-mirror rejects the entire state
with `Unknown property: <key>`, so the older client can never write to that doc
again. Contract test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

Session docs use `createSessionMirror`; only its HistoryWriter writes history.
Replacement contract: [shared rules](../../../shared/AGENTS.md#session-history).
Task-proposal decisions locate the current item by proposal id after store acquisition
and update only decision fields through HistoryWriter; never replace a rendered entry.

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
  readiness gate and `promptShortcutsFeatureEnabledAtom`. Disabling closes the
  runtime and skips directory queries without deleting local data. It uses the platform identity and public cloud operation descriptors;
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
  or outbox recovery. The last directory and discovered index persist locally;
  cold-start readiness and cached reads never depend on a fresh cloud grant.
  Learned revocations hide cached shared content; offline revocation is not instantaneous.
  The cloud port stages/activates immutable snapshots and atomically settles superseded
  jobs. It never uploads the mutable working body or gates subsequent local saves.

## Workspace runtime

- `create-workspace-runtime.ts` maintains one Repo view. `WorkspaceTargetRouter` owns
  target ownership and transport selection; do not restore a second writer or a
  proxy-authoring/write-intent mirror.
- Transport state is selected per room, never merged. Runtime stores use
  `getReadinessTransportForRoom`; hooks without the router use the structural binding in
  `src/lib/room-readiness.ts`. Keep those selection rules aligned.
- The local renderer identity comes atomically from the Electron local-platform snapshot
  and uses the CLI catalog's persistent `local:*` id. Do not substitute a constant or
  temporary user.
- Controls for a machine resolved as local use Electron local session control,
  independent of cloud-token or sync state. A failed local bridge is an error; never
  fall back to a remote RPC path.
- Cloud Electron waits for the first **Run local agent** setting snapshot before creating
  its workspace runtime. Enabled uses dual sync; disabled uses cloud-only sync and must
  not attach the local data plane or surface its reconnect state.
- Meta-room attachment is single-flight per runtime. Token, network, and visibility edges may
  force one immediate recovery attempt, but they must preserve the current outage's retry history;
  only a sustained healthy dwell resets backoff. Every attempt after the first is a `recovery`
  phase, including one prompted by a rotated token.
- Workspace-level rooms without a machine owner use the platform fallback. Task rooms and
  the Task Index depend on this behavior; returning no transport silently disables task
  synchronization.
- Resource monitoring follows target ownership: local machines use the local monitor
  transport, remote machines use the optional remote transport, and unknown ownership
  remains pending.
- Presence is merged by origin. For an origin represented by the local plane, the local
  snapshot is authoritative, including absence; do not resurrect cleared presence from a
  lagging replica.
- Doc-metadata bootstrap and the live repo watch overlap by design: merge per field with
  live winning (`mergeBootstrapMetaCache`), never letting the snapshot undo an archive
  already applied live.
