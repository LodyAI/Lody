# Share root and child tool history preprocessing

Status: implemented
Translation: current

The ACP schema preserves omitted content/location lists instead of inserting empty
lists. The image-generation client explicitly publishes initial status without
content, preserving its existing callback contract independently of schema defaults.

[中文](2026-10-22-bound-child-tool-history.zh.md)

## Abstract

Normalized child tools previously bypassed root history preprocessing and retained
full read/edit bodies, generic raw output and provider metadata. Both routes now
use one tool projection and merge function before writing CRDT history. Paths,
status, sparse updates, approval plans and turn-owned edit evidence survive; child
tool detail no longer retains complete read/edit bodies. This bounds newly received
tool payloads according to the existing root policy. Existing oversized documents
and import-memory improvements require separate work; no production data is rewritten.

## Decision and implementation

`packages/shared/src/acp/history-apply.ts` owns the shared
`buildToolCallMessageForHistory` and `mergeToolCallMessage` paths. Resolve kind from
the previous tool before filtering, derive locations before discarding diffs, keep
explicit list clears, preserve monotonic status, and reuse root command/output limits.
Generic raw fields and provider metadata do not bypass the projection. Both paths
retain only switch-mode `rawInput.plan`, plus the existing scheduling raw fields,
timezone and first-recorded timestamp. Child native identities remain separate.

`acp/schema.ts` preserves omitted initial-call content/locations instead of inserting
empty arrays; sparse and replayed initial calls must not silently clear prior data.
CLI edit callbacks still consume enriched execution notifications and the committed
run's original owner, independently of stored diff bodies. Permission enrichment
continues to preserve stored content; this is an ACP insertion policy, not a blanket
sanitizer for unchanged documents or ordinary image attachments.

This intentionally supersedes the complete child-diff retention choice in the
[image/resource cleanup](2026-10-11-drop-tool-images-from-history.md). The owning
[Spec](../../../../specs/subagent-events.md) records the changed retention intent.
Exact offline tool diff replay would need a separate bounded detail reader; a
current-file preview cannot replace historical edit evidence.

## Lazy import analysis

Loro `loro-crdt@1.16.3` (`ad5b2a6d4`) initializes fast-snapshot state lazily in
`state/container_store/inner_store.rs::decode`. Lazy container values and SSTable
blocks already have bounded caches (2048 values and 4 MiB per table). It does not
mean a viewport fetches byte ranges: the entire encoded snapshot is retained, the
WASM binding copies the JS input, and `encoding.rs::decode_snapshot` copies the body
into owned bytes. `LoroMap.toJSON()` recursively materializes children. Lody's
`session-data/loro.ts::asStoredTurn` uses that operation for one complete turn, while
`use-conversation-stream-items.ts` initially leases 40 turns. Closed child dialogs
therefore do not prevent loading their transcripts when their owning turn is read.

Incremental import also calculates state differences against old history; change
blocks can be decoded into the shared arena. A large increase on importing a small
update must be profiled separately from initial snapshot loading. Candidate upstream
work is an owned-input import API, tighter byte budgets for large decoded values,
and less historical decoding on incremental imports. Application work is reading
child/item ranges instead of whole turns; [on-demand child reads](2026-10-22-lazy-subagent-transcript-read.md)
are implemented separately. These are analysis and proposals, not
implemented optimizations or evidence that every old operation is decoded at open.

## Existing documents and validation

Deleting visible fields still retains their operations in a normal full snapshot.
A compact copy or shallow snapshot is a separate recovery mechanism. Same-session
cutover needs a generation/stale-writer design; shallow snapshots need compatibility
proof for frontiers, pending edits, persistence and reconnect. Do not silently replace
a live stream snapshot or rewrite history on read.

Real HistoryWriter tests compare root/child read/edit/execute/plan writes, raw output
forms, sparse kind/status/list updates, repeated initial calls and snapshot reload.
CLI integration tests verify filtered child tools still emit full edit evidence for
the original turn across later batches. Shared tests and typecheck, CLI history and
permission suites, formatting and document checks run in a standalone copy of the
pinned public source. Captured production documents and operational measurements
remain outside this public repository; iPhone memory acceptance is not established.
