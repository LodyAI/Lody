# Workspace provider guidelines

`CLAUDE.md` is a symlink to this file. Parent `AGENTS.md` files also apply.

## Mirrors over synced docs tolerate unknown root keys

Synced-doc Mirrors must set `ignoreUnknownProperties: true`: newer peers' unknown
root keys otherwise reject the whole state and block writes. Test:
`packages/shared/tests/session-doc-forward-compat.test.ts`.

Session docs use `createSessionMirror`; only its HistoryWriter writes history.
Replacement contract: [shared rules](../../../shared/AGENTS.md#session-history).

## Streams connection cardinality

- Discovery/refresh reuse existing workspace Machine Flock/RPC transports, with no
  subscription per config/request. Connections stay bounded by workspace/machine
  topology; more configs add serialized RPCs only. Release unowned one-shot handles
  and subscriptions.
- Discover startup capabilities once per config/runtime, tracked in `refreshedConfigKeys`.
  Re-arm passes aborted when presence leaves `synced`; reconnect must not re-probe answered
  configs or use a pass-level gate. Probes launch real agents. Refresh defaults to machine
  cache; only user or setup/authentication actions set `force`.
  Intent: [capability refresh cache](../../../../specs/acp-capability-refresh-cache.md).

## Workspace switching

- Retire published shortcut instances before durable close; never reuse them.
  Render-time fencing covers account/workspace, platform, cloud and retry changes.
  Failed workspace/database close stays retryable and gates only its storage.
  Cleanup diagnostics must exclude private payloads.
- `$workspaceName` owns the render-time target slug. Before reading singleton caches,
  workspace UI requires agreement with the active runtime and its doc-meta snapshot.
  Under `WorkspaceRouteTargetProvider`, visibility/sharing hooks return empty and disable
  queries, Machine Flock, sharing and eager-sync on mismatch; explicit `workspaceId` /
  `enabled` cannot bypass this gate or reopen stale work. External consumers such as
  `RuntimeProvider` keep their existing defaults.
- Each `resolveWorkspaceDataScope` wait names its `blocker`; keep scan failures on the scope.
  [Stuck report](../../../../.agents/notes/implemented/feature/2026-09-26-workspace-sync-stuck-telemetry.md).

## Workspace runtime

- Readers require backend identity and their Meta plane. Provisional absence/empty
  history is not legacy evidence; release waits on resolve/retire. Keep Roost
  capabilities live and wake its bridge on arrival.

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
- Repo ownership: [contracts](../../../shared/src/workspace-data/AGENTS.md).
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
- Renderer Streams keeps `createStreamIfMissing: true`: Session pre-create is a warm-up.
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

`sendResources` owns preparation/I/O/borrows; cancel/join before transports/caches
close. Only caches dispose stores. Loro commits locally, then dispatches best-effort.
Roost freezes input/target and shares ordered leases with queues. Ordinary input
negotiates `sessionInputDispatch` v1: one owner request commits history and activation;
the sender uses its receipt without history readback or a second dispatch RPC.
Guide handoff still needs an owner receipt. Archive/delete cancel durable work beyond local
snapshots and join leases. Unready Blobs stay in memory; uncertain steers never replay.
[Decision](../../../../.agents/notes/proposed/architecture/2026-10-13-backend-independent-send-acceptance.md).
