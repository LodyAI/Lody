# Bound the Roost input acceptance lookup

Status: proposed
Type: bug-fix
Translation: current

[中文](2026-10-19-roost-input-acceptance-paging.zh.md)

## Abstract

Roost's combined input acceptance checked the newest user by reading the entire
history directory, which hydrated old page bodies before its receipt. The shared
selector now uses reverse directory pages and stops at the newest readable match.
A real SQLite cold-reopen regression and controlled local comparison verify the
removed dependency on unrelated old history. This owner fix requires an updated
CLI; empty-history timing is unchanged and the original remote delay is not
attributed to this scan.

## Defect and change

`accept_input_and_dispatch` calls the shared `readLatestTurn` after immutable
native commit, before activation and its receipt. Unlike the backend wrapper's
paged selector, that helper requested `readDirectory(0, count)`. Node Roost routes
this through `readRangeEntries`, loading/projecting bodies outside the tail cache.
Unrelated old-page failure could therefore reject an already committed input.

The helper starts with the latest 40 directory rows, reads matching bodies, and
continues toward older pages only when no readable match is available. Non-paged
readers retain the scalar-directory path; page failures still propagate. The
wrapper delegates to the same selector. Receipt identity, writer serialization,
terminal/removed-input guards and activation ordering remain authoritative.
There is no receipt shortcut, replay, new lifecycle owner or Effect migration.
This is separate from [browser response recovery](2026-10-18-roost-remote-receipt-latency.md);
its wire contract is unchanged, but the remote CLI must update for this fix.

## Controlled local comparison

The versioned [benchmark](../../../../apps/cli/benchmarks/roost-first-input.mts)
uses production SessionDocument/backends and real native SQLite. Apple M4,
macOS arm64, Node 24.14.0; source baseline `17c76466b`; A–B–B–A order, one warmup
and five measured trials per phase/backend/size, ten samples per revision.
Each trial restores the identical closed SQLite/Loro snapshot, reopens the
session and native Worker, and sends the same first/follow-up input. Old rows
alternate handled users and finished assistants with 4 KiB text. OS caches are
warm; metadata setup and copying are excluded. Source hashes are recorded and
ablated files were restored byte-for-byte.

Median first acceptance/activation time after initialization:

| Old rows | Before | After | Older pages before → after |
| ---: | ---: | ---: | ---: |
| 0 | 10.7 ms | 11.4 ms | 0 → 0 |
| 100 | 162.8 ms | 82.0 ms | 2 → 0 |
| 1,000 | 969.9 ms | 88.8 ms | 25 → 0 |

At 1,000 rows, cold open plus acceptance was 1,059.3 → 159.0 ms and follow-up
acceptance 1,016.5 → 90.2 ms. Append/seal projection still reads the bounded tail
(80 physical page rows). Empty history is essentially unchanged. Loro's local
append/activation reference medians were 0.5–0.8 ms, excluding cold snapshot
import; its in-memory Repo has no SQLite immutable-receipt durability contract.
No network, remote metadata, renderer, IndexedDB or ACP is measured. These values
cannot explain the original remote 26.8 seconds or establish a general latency bound.

From `apps/cli`, choose a dedicated temporary `BENCH_DIR`, run once with
`BENCH_PHASE=prepare`, then measure with that phase unset and the same directory:

```sh
TSX_TSCONFIG_PATH=tsconfig.json node --experimental-wasm-modules --import ./node_modules/tsx/dist/loader.mjs benchmarks/roost-first-input.mts
```

Use identical fixtures across source revisions and retain source hashes.
`BENCH_VARIANT` only labels results; it does not select a simulated implementation.
The benchmark asserts resulting state, never a timing threshold. Its dedicated
TypeScript check (`pnpm exec tsgo --noEmit -p benchmarks/tsconfig.first-input.json`
from `apps/cli`) and formatting pass; scoped lint reports no errors.

## Verification and limits

The real SQLite regression imports 81 synthetic old messages, closes/reopens the
owner and refuses older-page reads. Baseline fails its first-input acceptance;
the fix returns the immutable receipt, stores the input and publishes activation
while old pages remain unavailable. Shared-reader coverage checks newest-body
selection, missing newest bodies across pages, exhaustion, non-paged readers and
page failure propagation. Existing retries preserve newer activation pointers,
terminal inputs and removed history. All 76 native contract tests pass; shared
passes 1,577 and CLI 4,397 with four skipped. Full verification is recorded in the
PR; docs retain six baseline broken ACP links and no protected-topic changes.
The owner fix has not been deployed or remeasured against the original remote session.
