# Workspace provider guidelines

`CLAUDE.md` is a symlink to this file. Parent `AGENTS.md` files also apply.

## Mirrors over synced docs tolerate unknown root keys

Synced-doc Mirrors must set `ignoreUnknownProperties: true`: newer peers' unknown
root keys otherwise reject the whole state and block writes. Test:
`packages/shared/tests/session-doc-forward-compat.test.ts`.

Session docs use `createSessionMirror`; only its HistoryWriter writes history.
Replacement contract: [shared rules](../../../shared/AGENTS.md#session-history).

## Streams connection cardinality

- Capability discovery and refresh must reuse the workspace runtime's existing Machine
  Flock and Machine RPC transports.
- Never create or retain a Streams/Flock subscription per agent config or refresh request.
  Live connection cardinality must stay bounded by workspace/machine topology and must not
  grow with the number of agent configs. More configs may add serialized RPC requests, not
  live Streams connections.
- Release any one-shot document handle or subscription that is not already owned by the
  workspace runtime.
- Startup capability discovery is once per agent config per runtime, recorded in the
  runtime-owned `refreshedConfigKeys` set. A pass aborted by presence leaving `synced` is
  re-armed, so a pass-level flag is not the gate: reconnecting must never re-probe a config that
  already answered, because each probe starts and kills a real agent process. Refresh requests
  default to the machine's cache; only a user action or a setup/authentication workflow sets
  `force`. Intent: [capability refresh cache](../../../../specs/acp-capability-refresh-cache.md).

## Workspace switching

- Prompt Shortcuts instances belong to one initialization effect lifetime. Cleanup
  must retire the published instance immediately, before asynchronous durable close.
  Returning to the same account/workspace must never reuse a retired instance;
  render-time fencing also covers platform, cloud capability, and retry generation.
- The `$workspaceName` route owns the render-time target slug. Workspace-scoped UI must
  require that target, the active runtime, and the runtime-owned doc-meta snapshot to agree
  before reading singleton caches. Shared visibility and sharing hooks enforce this gate by
  default when mounted under `WorkspaceRouteTargetProvider`; scope mismatch returns an empty
  projection and disables queries, Machine Flock, sharing, and eager-sync inputs. Provider-
  external consumers such as `RuntimeProvider` retain their existing default behavior. Explicit
  `workspaceId` / `enabled` options remain fenced by the route scope and cannot reopen stale work.
- Each `resolveWorkspaceDataScope` wait names its `blocker`; keep scan failures on the scope.
  [Stuck report](../../../../.agents/notes/implemented/feature/2026-09-26-workspace-sync-stuck-telemetry.md).

## Workspace runtime

- A neutral local warm spare may initialize the implicit workspace runtime without
  publishing route context. A matching claim must retain that runtime or its in-flight
  initialization. Do not infer a cloud workspace. Only the main-owned macOS local
  prepared-window lifecycle may mount a speculative Session; it must gate read
  receipts, workspace ownership, autofocus and external-history refresh until
  presentation. Raw background prefetch never gains this exception.

- Background Session prefetch must never acquire a UI Session store or create a
  Mirror. Its disposable worker owns raw Doc import/export and a separate,
  rebuildable snapshot cache. Keep one worker task per renderer, terminate before
  releasing its slot, and detach local peers from the parent on cancellation. The
  parent must check the durable activity checkpoint before constructing a worker;
  scope cache rows by workspace and room so auxiliary windows share them.
  Keep the timestamp-only high-water index as the pre-queue startup filter; it
  must not load snapshots, Docs, histories, or foreground cursor state.
  Foreground acquisition cancels that room's prefetch and merges cached binary
  state into the existing repo document; never replace unsent local edits or share
  the UI repo's persistence/cursors with the worker. Intent:
  [background prefetch](../../../../specs/session-background-prefetch.zh.md).
- Keep one Repo view; `WorkspaceTargetRouter` owns target/transport selection.
  Never restore a second writer or proxy-authoring/write-intent mirror.
- Runtime close cancels auth, joins attach/reconnect work, then destroys Repo.
  Failed startup shares this close path.
- Local-only window bootstrap may exchange same-workspace CRDT snapshots from
  already owned documents. Merge into the receiving Repo; never treat peer state
  as authoritative sync or open stores solely to answer bootstrap requests.
  Check disk before requesting peer exports; Web Locks inventory bounds requests
  to live runtimes, and negative replies must release missing-document waits.
  Seed cold documents before Repo subscribes, persisting the merged snapshot before
  adoption; storage-loaded versions must be durable before cursor advancement. Never
  replace a live document. Import before constructing the history reader to avoid
  replaying bulk-import events through an initialized projection.
- Repo storage, LoroDoc cursors and eager-sync high-water state share a per-renderer
  cache namespace. Independently persisted replicas must not share checkpoints.
  Meta/Flock cursors stay repo-owned; delete Meta progress via `repo.getReplicaCheckpointStore`.
- Required Streams protection rejects missing providers or plaintext rooms
  ([contract](../../../../specs/workspace-streams-content.md)).
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
- Workspace-level rooms without a machine owner use the platform fallback.
  Returning no transport silently disables synchronization for those rooms.
- Resource monitoring follows target ownership: local machines use the local monitor
  transport, remote machines use the optional remote transport, and unknown ownership
  remains pending.
- Presence is merged by origin. For an origin represented by the local plane, the local
  snapshot is authoritative, including absence; do not resurrect cleared presence from a
  lagging replica.
- Doc-metadata bootstrap and the live repo watch overlap by design: merge per field with
  live winning (`mergeBootstrapMetaCache`), never letting the snapshot undo an archive
  already applied live.

## Attachment transfer ownership

Workspace `sendResources` owns preparation, cancellation and store borrows across
React unmount. Close before transports/caches; join IPC, cancel I/O, fence late
results and await multipart cleanup. Only the cache disposes stores.

Ready sends: local commits, then best-effort RPC; no persistence or retry. Unready
sends live only in `pendingSends`; archive/delete cancel/join them. Never
replay uncertain steers. [Why](../../../../.agents/notes/implemented/simplification/2026-09-29-remove-session-send-journal.md).
