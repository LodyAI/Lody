# Prompt Shortcut domain and persistence

`CLAUDE.md` is a symlink to this file. Parent repository instructions apply.

## Boundaries

- `model.ts` owns strict saved-state schemas, explicit scope and dependency
  eligibility. Scope is author input, never inferred from mentions or active UI.
- `compiler.ts` freezes invocation snapshots, derives variables and compiles
  ordered inline segments. Injected values are literal; never hydrate/parse them
  again as mentions, shortcuts or variables. Offsets are UTF-16, byte quotas UTF-8.
- `document.ts` saves coherent immutable revisions with explicit parent ancestry.
  Concurrent heads are a conflict, not a field-wise merge of text and ranges.
  Only live heads retain materialized content; old operations remain in CRDT
  history. Sharing must create a fresh document from current state, never export
  a private snapshot (which includes history).
- `catalog.ts` stores only bounded index projections in a business Flock, never
  repo meta. Permanent deletion has a separate monotonic tombstone. Do not use
  that tombstone for visibility withdrawal: re-sharing the same id is valid.
- `local-store.ts` owns the local working catalog, pointer-only write intents
  and publication outbox. Validate, persist intent, persist body, persist working
  row/outbox, clear intent. Startup completes post-body saves and discards
  pre-body intents. Never infer repair work by scanning all bodies.
- `runtime.ts` owns discovery, authorized lazy body reads and publication:
  stage → upload body → prepare empty index → activate CAS → upload projection
  → withdraw old domain. An empty index carries no staged Prompt metadata.
  UI resolves Save on local durability. Pending publication identities cannot
  be replaced after an ambiguous response. Runtime, not UI lifetime, retries.
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
- The repo has no workspace transports; only exact body/index resources enter
  Streams. The local ledger must NEVER enter sync. Host storage is scoped by
  account AND workspace and survives ordinary cache clear (it may be the only
  copy of offline work). Host integration fences identity/route changes before
  and after cloud calls. Directory revocations hide stale indexes immediately.
- The authoritative directory owns a live room per active index domain, not body
  joins. Keep the Flock subscription: activation can arrive before the index append,
  and a one-shot read would miss that publication until an unrelated refresh.
  Reads still authorize the exact body even when cached. Only an owned pending
  working copy bypasses cloud reads for offline editing/inspection.

## Validation

From the outer installation root:

```sh
pnpm --filter @lody/shared exec vitest run tests/prompt-shortcuts.test.ts tests/prompt-shortcut-runtime.test.ts tests/prompt-shortcut-sync.test.ts
pnpm --filter @lody/shared typecheck
```

Runtime tests reopen real filesystem-backed LoroRepo stores; do not replace
that boundary with mocked persistence. Sync tests cover adapters and leases,
not a deployed Streams gateway. Production authorization/control-plane code is
owned by the private composition, not imported here.
