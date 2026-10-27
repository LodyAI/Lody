# Workspace provider guidelines

`CLAUDE.md` links here; ancestor rules apply.

## Mirrors over synced docs tolerate unknown root keys

Synced Mirrors require `ignoreUnknownProperties: true` or new peers block writes.
Test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

Session docs use `createSessionMirror`; only its HistoryWriter writes history.
Replacement contract: [shared rules](../../../shared/AGENTS.md#session-history).

## Streams connection cardinality

- Discovery/refresh reuse existing workspace Machine Flock/RPC transports, with no
  subscription per request. Connections follow workspace/machine topology; more configs
  add serialized RPCs only. Release unowned handles and subscriptions.
- Discover startup capabilities once per config/runtime, tracked in `refreshedConfigKeys`.
  Re-arm aborted passes after presence recovers; never re-probe answered configs. Probes launch real agents. Refresh defaults to machine
  cache; only user or setup/authentication actions set `force`.
  Intent: [capability refresh cache](../../../../specs/acp-capability-refresh-cache.md).

## Workspace switching

- Prompt Shortcuts instances belong to one initialization effect lifetime. Cleanup
  must retire the published instance immediately, before asynchronous durable close.
  Never reuse retired instances; fence platform, cloud capability and retry generation.
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
- Keep one Repo view across auth refresh and unrelated mode-cache changes;
  `WorkspaceTargetRouter` owns target/transport selection.
  Never restore a second writer or proxy-authoring/write-intent mirror.
- Runtime close cancels auth, joins attach/reconnect work, then destroys Repo.
  Failed startup shares this close path.
- Local-only bootstrap exchanges CRDT snapshots only from already owned documents
  in the same workspace. Merge into the receiving Repo; peer state is not authoritative,
  and requests must not open stores. Check disk first; Web Locks bound requests to live
  runtimes, and negative replies release missing-document waits. Seed cold documents
  before Repo subscribes; persist merged snapshots before adoption and storage-loaded
  versions before cursor advancement. Never replace live documents. Import before
  creating the history reader to avoid replaying bulk-import events.
- Repo storage, LoroDoc cursors and eager-sync high-water state share a per-renderer
  cache namespace. Independently persisted replicas must not share checkpoints.
  Meta/Flock cursors stay repo-owned; delete Meta progress via `repo.getReplicaCheckpointStore`.
- Open E2EE locally; keep host keys, a dedicated bucket, Loro history and waiting-key
  leases. No plaintext bypass. Keep retained-epoch sends; select confirmed keys per
  operation. Forward rejected tokens for exact eviction. Confirmed member removal
  retires and drains this renderer before scoped local deletion; keep a retry marker.
  [M2](../../../../.agents/notes/proposed/architecture/2026-10-22-e2ee-m2-product-integration.md),
  [transport](../../../../specs/workspace-streams-content.md).
- Select transport per room, never merge. Use `getReadinessTransportForRoom`;
  hooks without the router use `src/lib/room-readiness.ts`. Keep rules aligned.
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
- Resource monitoring follows machine ownership: local or optional remote transport;
  unknown ownership remains pending.
- Presence is merged by origin. For an origin represented by the local plane, the local
  snapshot is authoritative, including absence; do not resurrect cleared presence from a
  lagging replica. UI reads the transport's display sync state; raw state drives recovery.
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
