# Window subagent history writes down to child output

Status: implemented
Translation: current
PR: [#1612](https://github.com/LodyAI/Lody/pull/1612)

[中文](2026-10-16-subagent-history-windows.zh.md)

## Abstract

Subagent batches still exported and produced the full conversation after the
earlier tool-streaming optimization, and each normalized event searched runs
linearly. The same writer now resolves root tools, legacy tasks and normalized
runs by indexed identity, then projects sparse windows inside both owning turns
and child transcripts. The unchanged reducer processes notifications in order,
and every changed window is validated before any mutation. Synthetic real-Loro
checks preserve stored output and reject unrelated history reads; cold indexes
and remote imports still require a metadata scan, and structural/legacy-storage
fallbacks remain.

## Problem and decision

The [previous fix](2026-10-14-daemon-history-writes-scale-with-turn-size.md)
explicitly left subagents outside its window. The independent
[history harness](https://github.com/leynos/Lody/pull/1) reproduced full-history
routing and repeated run searches at baseline `a06a69f3`; its three relevant
source hashes also matched this task's starting head `14ca6d0c1`.
Those counts establish scaling, not production wall time or the cause of each
reported timeout/restore failure. The separate
[file-lock harness](https://github.com/leynos/Lody/pull/2) tests intentional queue
and cleanup boundaries and does not establish a circular deadlock.

`history-agent-window.ts` replaces the writer's tool-only window internals.
Dependencies are explicit: `(root, run)` plus parent runs/tools, legacy task ids,
and root/child tool ids. Related turns are exposed in stored order, with selected
items and only the active text/thought tail when needed. Child transcripts expose
requested tool/plan items and, for text/thought deltas, the last output item.
Snapshot/progress-only batches
retain the actual transcript without converting it. New items append at the end
of the actual owning list, including when that owner is an older turn.

The directory preserves the existing distinct duplicate-selection rules for
tools/tasks and normalized runs. Own writes update only affected entries; unknown
writes or imports invalidate its version. The reducer also builds one root/run
index per batch, updating it when snapshots introduce runs. Ancestry, root
isolation, terminal-state handling, sparse patches and content filtering remain
the reducer's responsibility. No storage schema, wire contract, transcript cap,
timeout or lock-policy change is needed. Pure computation remains ordinary
TypeScript; no Effect lifecycle unit changes.

Only caching `findRun` would leave the full-history conversion. Narrowing to the
whole owning turn would retain its conversion cost; narrowing only to the task
would repeat conversion of the entire child transcript. The selected nested
window avoids all three while retaining one shared validation/write owner.
Current responsibilities and fallback limits live in
[history writes](../../../docs/session-history-writes.md).

## Verification

The existing CLI storage suite now compares mixed streams against real
whole-history writes after each batch: older owners, identical run ids under
different roots, nested children, cyclic/unresolved ancestry, repeated plans,
terminal and late events, and Devin lifecycle/context notifications.
Another real-Loro test forbids whole-history/turn/child-list exports and reads of
unrelated historical items during 32 successive child batches. It checks the
resulting tool/text/progress state and retains an unrelated malformed legacy
child and its unknown fields. Peer import tests shift both owning rows and child
items and introduce a previously missing run. A malformed child edit rejects
the entire batch before its valid parent-text prefix commits.

The shared reducer suite bounds inspections for 128 stored runs and 32 progress
events and checks final state. Restoring the old router fails the export guard;
restoring the old `findRun` fails the inspection bound. These are deterministic
behavior/read-work assertions, not wall-clock performance thresholds.

An additional temporary synthetic real-Loro experiment used 192 turns, 3,072
root tools and a 2,048-tool child transcript (14.76 MiB JSON). Over 16 batches,
whole-history writes had an 81.82 ms median after the first batch; windowed writes
had a 0.205 ms median. The first window, including both metadata indexes, took
20.14 ms. Stored output was equal. These are one-machine measurements, not a
production latency budget or reproduction of the reported 6–19 second stalls.

The implementation was validated in a separate checkout with the locked
dependencies and pinned Core/DSH builds. All 1,507 shared tests and 85 CLI tests
in eight affected suites pass. Shared/CLI type checks and `check:quick` pass.
The documentation check retains the starting checkout's 82 broken-link errors
from absent submodule files; no new errors were introduced. No live provider/daemon,
production sync or release deployment acceptance is claimed.
