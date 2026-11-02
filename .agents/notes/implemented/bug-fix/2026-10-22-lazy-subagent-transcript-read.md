# Read child transcripts only when their detail opens

Status: implemented
Translation: current

[中文](2026-10-22-lazy-subagent-transcript-read.zh.md)

## Abstract

Windowing the parent conversation did not bound child transcript materialization:
reading one visible turn recursively converted every nested run to JSON, including
closed task dialogs. The Loro display reader now keeps task metadata and a bounded
latest-step preview, and the mounted detail reads only its selected run. Export,
copy, replay and command reads keep complete authoritative history. This avoids
materializing all child bodies on open without changing persisted data; importing
the full CRDT snapshot and reading every item of the selected run remain separate
memory costs.

## Read ownership

`SessionHistoryReader` exposes an optional pair: `readTurnForDisplay` and
`readSubagentRun`. The Loro adapter projects turn/items/task/run maps individually,
never recursively serializing `run.items` for the main conversation. The preview
contains only the last meaningful step's small fields, with at most 512 text
characters; legacy Text fields use a bounded slice. Tool content/raw output is not
read for this preview. Detail lookup binds the owning turn, root ACP session and
run id. Inline legacy JSON remains readable but cannot undo bytes already decoded
as one primitive value.

The reader-backed view selects this pair only when both methods exist; its existing
membership/content epochs still fence display hydration. It attaches a display-only,
non-enumerable `history` capability to a copied task; functions never enter storage,
wire DTOs or full export. The capability uses a weak reader reference and is
invalidated at view disposal: render-item caches must not retain a CRDT document
through a closed task. Other backends/static shares keep their complete reads.
`readTurn`, `readAll`, snapshot copy and command behavior do not change. Parent
permission/goal/scheduling/diff facts consume root items and remain available.

Task rows use the bounded preview for current activity. Only mounted detail activity
reads the full selected run, follows new projected task sources during streaming,
and discards late results when the source changes or unmounts. Failure is retryable,
not represented as an empty or complete transcript. The full run lives in detail
component state, not a global cache. This intentionally reads one run at a time;
per-item windowing inside a huge opened run is deferred.

Same-run refreshes retain the mounted transcript and its fold state. A completed
read follows the end only while the user remains pinned there. Display projection
also preserves unknown own fields such as `toString`, rather than consulting
prototype methods as field projectors.

## Alternatives and verification

Hiding or virtualizing dialog DOM is too late: parent `toJSON` has already allocated
child bodies. Reducing the tail's turn count also leaves a single huge turn costly.
Lazy getters over mutable CRDT containers would blur snapshot timing and make a
summary consumer accidentally trigger a full read; the explicit display/detail pair
keeps that operation visible. Do not strip payloads during reads or treat previews
as copy provenance. New-write filtering is a separate
[decision](2026-10-22-bound-child-tool-history.md).

Real Loro regressions forbid eager root/run exports and offscreen child-body reads,
verify exact run ownership, preserve full exports and prove reads author no CRDT ops.
Shipped-view tests cover complete readAll, live preview/detail updates and disposal;
React tests cover unopened tasks, selection changes, late reads and retry. Existing
async epoch regressions exercise the display port. Operational captures and memory
measurements remain outside the public repository. Import-memory and actual iPhone
cold-open acceptance are not claimed by these reader tests.
