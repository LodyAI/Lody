# Workspace provider guidelines

`CLAUDE.md` links here; ancestor rules apply.

Standalone login must render without authenticated Convex context; keep protected
queries and E2EE hosts in its optional authenticated child.
Commands and imperative subscriptions follow [cloud auth admission](../hooks/README.md#cloud-query-recovery).

## Mirrors over synced docs tolerate unknown root keys

Synced Mirrors require `ignoreUnknownProperties: true` or new peers block writes.
Test: `packages/shared/tests/session-doc-forward-compat.test.ts`.

Session docs use `createSessionMirror`; only its HistoryWriter writes history.
Replacement contract: [shared rules](../../../shared/AGENTS.md#session-history).

## Streams connection cardinality

- WebSocket defaults off; enabling it must retain HTTP shards and HTTP-only prefetch.
- Discovery/refresh reuse existing workspace Machine Flock/RPC transports, with no
  subscription per request. Connections follow workspace/machine topology; more configs
  add serialized RPCs only. Release unowned handles and subscriptions.
- Discover startup capabilities once per config/runtime, tracked in `refreshedConfigKeys`.
  Re-arm aborted passes after presence recovers; never re-probe answered configs. Probes launch real agents. Refresh defaults to machine
  cache; only user or setup/authentication actions set `force`.
  Intent: [capability refresh cache](../../../../specs/acp-capability-refresh-cache.md).

## Workspace switching

- Prompt Shortcut instances retire on effect cleanup and never cross platform, capability,
  retry generation, account/session or workspace boundaries. Legacy admission gates cloud
  work: unknown waits, encrypted disables; preserve local stores. V2 token owners retain
  local retry counts and one diagnostic per fault until success, notify auth recovery,
  and never cache authorization; see [retry reporting](../../../../.agents/notes/implemented/bug-fix/2026-11-17-shortcut-token-retry-diagnostics.md).
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

- Background prefetch keeps raw Doc import/export in one disposable worker per renderer
  with a separate rebuildable snapshot cache. Never acquire UI Session stores or Mirrors.
  Terminate workers before releasing slots or workspace/room/authorization/plane
  locks; cancellation detaches local peers. Recheck checkpoints under the claim before
  constructing workers; skip unavailable locks. Bound metadata waits; retries
  never confirm sync. Classify `apply_incomplete` separately from network failures; checkpoints retain
  its 24-hour cap (`eager-sync-admission.ts`).
  Scope cross-window cache rows by workspace/room. Queue filtering uses
  timestamp-only high-water marks, never snapshots, Docs, histories or foreground cursors.
  Foreground acquisition cancels that room's prefetch and merges cached binary
  into its existing Repo document, preserving unsent edits. Keep worker/UI
  persistence and cursors separate. Seed empty foreground cursors only after
  durable merges under cross-window exclusion. Intent:
  [background prefetch](../../../../specs/session-background-prefetch.zh.md).
- Keep one Repo view and recovery owner across auth refresh, adapter replacement
  and unrelated mode-cache changes. `WorkspaceTargetRouter` owns target/transport selection.
  Never restore proxy-authoring/write-intent mirrors or additional writers.
- Runtime close retries recoverable cleanup, retaining fencing until confirmed Repo destruction.
  Failed startup shares this close path.
- Local-only bootstrap exchanges CRDT snapshots only from already owned documents
  in the same workspace. Merge into the receiving Repo; peer state is not authoritative,
  and requests must not open stores. Check disk first; Web Locks bound requests to live
  runtimes, and negative replies release missing-document waits. Seed cold documents
  before Repo subscribes; persist merged snapshots before adoption and storage-loaded
  versions before cursor advancement. Never replace live documents. Import before
  creating the history reader to avoid replaying bulk-import events.
- Storage, cursors, recovery metadata and eager-sync high-water marks share a per-renderer
  cache namespace. Independently persisted replicas must not share checkpoints.
  Meta/Flock cursors stay repo-owned; delete Meta progress via `repo.getReplicaCheckpointStore`.
- Unknown workspace mode permits local Repo access, never ordinary body egress.
  Preserve drafts until authenticated classification; retire and cancel provisional
  transports before recording an encrypted or contradictory verdict.
- Open E2EE locally; keep host keys, a dedicated bucket, Loro history and waiting-key
  leases. No plaintext bypass. Keep already sealed old-epoch sends and historical reads;
  hosts prefer installed current keys; genuine absence permits retained published keys within
  the durable fifteen-minute grace, then fails for retry. Cached hints never select write keys. Never persist content tokens; forward rejected tokens for exact eviction. E2EE caches/inputs bind account/workspace/genesis/signing key.
  Drain before deleting that instance; retain exact receipts.
  [Sealing](../../../../.agents/notes/implemented/architecture/2026-10-27-e2ee-epoch-receive-barrier.md),
  [M2](../../../../.agents/notes/proposed/architecture/2026-10-22-e2ee-m2-product-integration.md),
  [transport](../../../../specs/workspace-streams-content.md).
- Missing-key notices start thirty seconds after explicit post-grace seal failure and clear on successful saves; they never retry, gate, or discard edits.
- Select transport per room, never merge. Use `getReadinessTransportForRoom`;
  hooks without the router use `src/lib/room-readiness.ts`. Keep rules aligned.
- The local renderer identity comes atomically from the Electron local-platform snapshot
  and uses the CLI catalog's persistent `local:*` id. Do not substitute a constant or
  temporary user.
- Controls for a machine resolved as local use Electron local session control,
  independent of cloud-token or sync state. A failed local bridge is an error; never
  fall back to a remote RPC path.
- Cloud Electron dual runtimes await the first **Run local agent** snapshot; encrypted
  runtimes always sync through cloud and ignore the setting. Enabled uses dual sync;
  disabled uses cloud-only sync without the local data plane or reconnect state.
- Meta-room attachment is single-flight per runtime. Token/network/visibility retries preserve
  outage history; sustained health alone resets backoff. Attempts after first use `recovery`,
  including token rotation. Periodic repair honors per-`kind:id` error backoff (30s–5min), clears
  it on leaving error, charges attempted rooms only, and cannot revive waiting rooms or delay failures.
  [Recovery](../../../../.agents/docs/components-package.md#cloud-room-recovery).
- Workspace-level rooms without a machine owner use the platform fallback.
  Returning no transport silently disables synchronization for those rooms.
- Resource monitoring follows machine ownership: local or optional remote transport;
  unknown ownership remains pending.
- Presence: local origin/absence wins over cloud; UI uses display state, recovery raw state.
  Encrypted presence uses its authorized bucket and shared minimal plaintext allowlist
  on publish/cloud/local read; unimplemented protected side channels stay disabled.
- Doc-metadata bootstrap and the live repo watch overlap by design: merge per field with
  live winning (`mergeBootstrapMetaCache`), never letting the snapshot undo an archive
  already applied live.

## Attachment transfer ownership

The Loro pending queue admits new protected images/files and validates their manifests before writing history. Queue records remain bound to their originating workspace; Roost remains unavailable in protected mode.

`sendResources` owns preparation/I/O/borrows; cancel/join before transports/caches
close. Only caches dispose stores. Loro commits locally, then dispatches best-effort.
Roost freezes input/target and shares ordered leases with queues. Ordinary input
negotiates `sessionInputDispatch` v1: one owner request commits history and activation;
the sender uses its receipt without history readback or a second dispatch RPC.
Guide handoff still needs an owner receipt. Archive/delete cancel durable work beyond local
snapshots and join leases. Unready Blobs stay in memory; uncertain steers never replay.
[Decision](../../../../.agents/notes/proposed/architecture/2026-10-13-backend-independent-send-acceptance.md).

- Protected leases retain captured account/reader until confirmed close. Preallocated
  leases fence cold opens. Begin native fencing with renderer cleanup. Retain full
  incomplete owners; only overlapping custody bindings or Repo namespaces wait.
  Independent workspaces remain usable. Device replacement shares its
  account/workspace/genesis writer. First key reception keeps admission pending; usable epochs wake content.
