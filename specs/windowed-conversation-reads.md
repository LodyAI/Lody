# Windowed conversation reads

Status: draft
Translation: pending

## Scenario

Opening a long conversation should show a useful window without first constructing every
turn body in JavaScript. Existing history remains unchanged. The document import and a
lightweight directory may still scale with total entries.

## Responsibilities

The renderer acquires the visible range and releases obsolete ranges. A directory answers
identity and status queries without requiring full bodies. Background derived facts do not
own the complete turn objects used to calculate them. Their identity hints are weak, and
closing their owner clears facts and cancels further work.

The shared HistoryWriter is the only history writer in both windowed and full-reader modes.
Changing the reader flag must not change authored-input validation or stored-copy semantics.
Read projections must never be treated as complete write baselines.

Explicit export/search operations may read more history; they must release acquired ranges.
Pinned ranges and the streaming tail are exempt from the LRU target. One giant turn can
exceed a chunk's nominal item budget, so this design does not promise bounded total memory.

## Acceptance

Compare current main and the integrated reader on the same synthetic 3000-user-round data.
Measure first usable window, updates, scrolling, background completion and close/reopen
memory in desktop and mobile environments. Unit tests cover preserved unknown history,
mode-independent writes and structural-event invalidation; they do not replace that
end-to-end acceptance.

Implementation rationale: [reader integration](../.agents/notes/implemented/architecture/2026-09-10-windowed-reader-integration.md).
