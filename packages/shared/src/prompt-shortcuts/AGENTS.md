# Prompt Shortcut domain and persistence

`CLAUDE.md` is a symlink to this file. Parent repository instructions apply.

## Boundaries

- `model.ts` owns strict saved-state schemas, explicit scope and dependency
  eligibility. Scope is author input, never inferred from mentions or active UI.
- `compiler.ts` freezes invocation snapshots and compiles
  ordered inline segments. Injected values are literal; never hydrate/parse them
  again as mentions or shortcuts. The optional semantic renderer lowers
  stable targets during the same segment pass and contributes to the byte budget.
  Offsets are UTF-16, byte quotas UTF-8.
- `document.ts` saves coherent immutable revisions with explicit parent ancestry.
  Concurrent heads are a conflict, not a field-wise merge of text and ranges.
  Only live heads retain materialized content; old operations remain in CRDT
  history. Sharing must create a fresh document from current state, never export
  a private snapshot (which includes history).
- `catalog.ts` stores only bounded index projections in a business Flock, never
  repo meta. Permanent deletion has a separate monotonic tombstone. Do not use
  that tombstone for visibility withdrawal: re-sharing the same id is valid.
- `local-store.ts` owns local working state, crash intents, publication jobs and
  discovery cache; `runtime.ts` owns publication and authorized lazy reads.
  Read [storage-protocol.md](storage-protocol.md) before changing either.
  Working bodies NEVER upload. Pending publication NEVER locks local authoring.
- `access.ts` places protected streams OUTSIDE ordinary workspace-token prefixes:
  `shortcut-index:<workspace>:<owner>:<visibility>` and `shortcut-body:<id>`.
  Shared catalogs are per-author so another member never receives write access
  to the author's index. The cloud publication transaction coordinates logical
  catalog slug uniqueness and byte/item quota across author indexes.
- `sync.ts` owns one reference-counted StreamsCrdt/replica lease per exact resource.
  No workspace token, Meta room, or per-composer transport. Read-only adapters
  suppress local exports in addition to read-only gateway grants. Release every
  replica, including late opens after disposal. The host must consistently choose
  the same access mode for concurrent leases of one room.
- `lifetime.ts` stops cloud waits on disposal, not server effects. Preserve the
  durable job identity; never wait for connectivity before closing local storage.
- The repo has no workspace transports; only exact body/index resources enter
  Streams. The local ledger must NEVER enter sync. Host storage is scoped by
  account AND workspace and survives ordinary cache clear (it may be the only
  copy of offline work). Host integration fences identity/route changes before
  and after cloud calls. Directory revocations hide stale indexes immediately.
- The authoritative directory owns a live room per active index domain, not body
  joins. Keep the Flock subscription: activation can arrive before the index append,
  and a one-shot read would miss that publication until an unrelated refresh.
  Local readiness and cache hits never obtain cloud grants. Learned revocations
  persist; offline devices cannot learn them immediately. Explicit owner deletion
  tombstones hide clean replicas, while conflicts preserve local work.

## Validation

This temporary feature has no dedicated test suite. Preserve the general shared
contracts and run typecheck from the outer installation root. Product-cloud
integration remains the host's responsibility; no live gateway validation is claimed.
