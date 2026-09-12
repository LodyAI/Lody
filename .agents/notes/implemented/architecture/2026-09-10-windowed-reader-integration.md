# Windowed conversation reads with one shared writer

Status: implemented
Translation: pending

## Abstract

Long conversations still materialize their entire history through the full Mirror reader.
PR #376 now composes a windowed reader with the shared HistoryWriter introduced by #460;
the rollback switch changes only readers. Derived facts use weak turn identity hints and
clear their caches on disposal, so the identity cache cannot retain evicted turn bodies.
Cold snapshot import and the initial directory still scale with total history, and real
desktop/mobile performance acceptance remains outstanding.

## Ownership

```mermaid
flowchart LR
  D[LoroDoc] --> C[Control fields Mirror]
  D --> V[Windowed directory and bodies]
  V --> U[Visible rows]
  V --> F[Derived facts with weak identity hints]
  W[Shared HistoryWriter] --> D
```

`createConversationSession` composes the readers. In windowed mode the writer receives
no full-history callback; it reads its target from the document. Rollback uses
`createSessionMirror`, whose writer is the same shared implementation. The component-local
writer and materializer are removed. Input validation, opaque history preservation and
rollback remain shared-package responsibilities, independent of this read optimization.

Review found that two target-local commands still used the shared writer's whole-history
fallback: permission responses and renderer task-proposal decisions. Permissions now
inspect stored request metadata from newest to oldest (or restrict lookup to a supplied
turn id), then call `updateEntry` for the match. Proposal decisions also use `updateEntry`.
This retains the single validation/write owner rather than disabling either command or
passing the incomplete read projection as a baseline. Generic cross-turn `update` remains
explicitly whole-history. Missing-id permission lookup still scans metadata; legacy JSON
fields are read in their existing representation, without storage migration.

The append test no longer treats raw `Mirror.setState` container layout and operation bytes
as the new-write oracle. That equality becomes false when #584 intentionally adopts
storage hints only the shared materializer consumes. Instead it checks authored values
through both readers after snapshot reload, plus actual editable streaming Text and CID
preservation. Storage-policy-specific assertions remain owned by the shared package; the
reference is not a second invocation of the same writer.

The old derivation identity Map retained complete turns after range release. Its values
are now WeakRefs, used only to skip repeated derivation while the object still exists.
Derived facts remain consumer-owned values and can themselves retain selected payloads;
this is not a hard total-memory bound. Disposal clears facts and identity hints. The idle
summary cursor advances across chunks instead of rescanning the completed suffix each time;
document changes restart the cursor against current positions.

Markdown export and image sharing explicitly acquire full ranges and release them when
finished. They are deliberately not claimed to have window-sized peak memory. Pinned
ranges and the tail may exceed the LRU target; a single giant turn is still indivisible.
No persisted history is migrated or rewritten by reading.

Range ownership was corrected after review reproduced positional cleanup releasing
another reader's pins. `acquireRange` now returns an idempotent release handle over
captured container ids; releasing it also stops pending hydration chunks. Explicit
`structure` events distinguish list edits from token and summary updates. Mounted
viewports reacquire their positional range, derivations restart missing coverage and
invalidate replaced facts, and open search acquires current membership. Search cache
entries also include the current position so a surviving turn cannot retain an old
jump target. These changes preserve the shared writer and existing persisted history.

Role readiness review found a separate durable failure: the composer could send after
store load but before the idle pass reached an older explicit Role. It then froze a
fallback Role/None into the next turn, which later index completion could not correct.
User index rows now read the shallow Role-selection config synchronously, including
legacy JSON config and explicit None. Config replacement/deletion, nested peer edits
and inserted user rows update that metadata before notifying consumers. Summaries and
body counts remain deferred; old turn bodies are not hydrated for Role lookup. This
adds one small config read per user row to initial indexing instead of blocking the
composer on the entire idle pass. Reads neither migrate storage nor change the shared
writer. Regression tests control idle scheduling and assert the Role written by an
immediate send survives snapshot reload, with an old-body materialization guard.

## Session data port

Session business code (renderer hooks, `WorkspaceWriter`, CLI `SessionDocument`, MCP)
still named Loro containers, the Mirror and `HistoryWriter` callbacks directly, so a future
database CRDT would force an edit at every consumer. `packages/shared/src/session-data`
now owns a CRDT-neutral seam: `SessionHistoryReader` (`count`/`readTurn`/`readRange`/
`readVisiblePage`), `SessionHistoryCommands` and a separate durability port. Nothing in the
port names Loro, Mirror, a CID or a storage offset; business identity is a turn/request id or
an opaque raw cursor.

Two rules make it trustworthy and distinguish it from a renamed CRDT API. A field change is
explicit: `set(value)` or `clear`, never an `undefined`-means-delete contract that cannot
cross JSON/worker/Rust. A command result states its phase: `accepted` (retrying duplicates
it), `rejected` (nothing applied, safe to fix and retry) or `indeterminate` (never auto-retry).
Local acceptance stays separate from local durability (`waitDurable`) and remote sync. A
conditional field write re-locates its target inside the adapter's commit, so a peer edit
between read and write cannot be overwritten outside the named field; `clear` removes only
that field and leaves unknown stored fields intact.

`createLoroSessionData` is the only Loro implementation and delegates to the one shared
`HistoryWriter`; the session entrypoint injects `mirror.historyWriter` so no second writer
exists. `createMemorySessionData` is an independent array/Map implementation with no Loro,
Mirror or CID import, and both run the same contract (`tests/session-data-contract.ts`),
including hidden-row paging, bad raw slots, unknown-field preservation and the
accepted/durability split. `tests/session-data-consumer.test.ts` then drives the real
`createDirectWorkspaceWriter` against the in-memory implementation, which is what proves the
renderer consumer depends on the port rather than on Loro.

Migrated callers: `SessionDocument` exposes `sessionData` and its assistant reopen/create
(`openAssistantTurn`) and permission outcome (`respondPermission`) use it, so opening a turn
no longer materializes unrelated history and an answer locates only its own turn; the
renderer `WorkspaceWriter` routes append/replace/permission/task-proposal/assistant-open
through it and surfaces a rejected command instead of silently dropping it; MCP
`session_history` pages through `readVisiblePage`, where `limit` counts displayable turns,
the cursor is a raw position, and a hidden tail is never reported as an empty history.

Not migrated in this change, and therefore still raw: `SessionDocument.init` builds the full
`sessionMirror` and `getHistory()` materializes it (a control-plane Mirror plus a shared
reader is still outstanding), `ConversationView` continues to read the raw list as the UI's
display cache, and queue/fork/import paths still use whole-history `updateHistory`. Owner/
seal mapping and old-format migration remain separate work, as does replacing the Mirror
`WeakMap` copy provenance with a storage-owned handle. `setTurnField`/`resumeAssistant`/
`clearField` are implemented and contract-tested but have no production caller yet.

Verification: shared `session-data` contract plus real-Loro regressions for clear
round-trips, unknown fields, a bad raw slot and two-replica convergence; the components suite
(469 files / 3538 tests) and the CLI suite (2695 tests, 4 skipped) pass, along with the
shared, components and CLI typechecks. These are library-level checks; they do not establish
device-scale cold-open, memory or owner/seal behaviour.

## Verification

The control-plane suite runs both modes with opaque stored history and the shared writer.
Existing mixed-event and derivation tests cover invalidation and disposal; fixtures now
use the current authored-input schema. Timing assertions are kept out of unit tests.
See the PR for the current executed commands and outcomes; browser layout, mobile memory,
and 3000-user-round end-to-end acceptance are not established by these unit tests.

Regression coverage uses real Loro documents, peer update imports and controlled
React scheduling: 100-turn bulk appends, same-length replacements, overlapping
range owners after insertion, cancellation/failure during hydration, and search
positions after insertion/deletion. Timing and whole-device memory acceptance remain
separate from these correctness checks.

Target-local write regressions reject whole-history body reads while asserting the final
permission/proposal state, missing-target and invalid-command no-ops, legacy JSON support,
opaque-field preservation and concurrent peer edits. Role-readiness coverage adds an
immediate pre-idle send with explicit Role/None, Map/legacy JSON config, snapshot reload,
and synchronous peer config replacement/deletion/insertion without old-body hydration.

The Role fix passed the component suite (457 files / 3433 tests), history-import's
39 tests, both package typechecks, type-aware lint, i18n, Code Collab imports and the
platform guard. Its isolated combination with #584 (`33177fda`) and #586 (`10cc1333`)
passed all 3464 component tests and both package typechecks. The earlier combination
also passed 92 shared writer/storage/ACP tests; those unchanged suites were not rerun
for this reader-only fix. The only integration conflict was the earlier shared
`AGENTS.md` wording; both contracts were retained.
Full root validation remains blocked by uninitialized ACP submodules (CLI manifest
imports, public-boundary resolution and documentation links). This is not a claim of
full repository or end-to-end acceptance.

Related: [shared writer](2026-09-07-single-history-writer.md),
[PR #376](https://github.com/LodyAI/Lody/pull/376).
