# Own the file-tree test scroll clock

Status: implemented
Translation: current
PR: [#1252](https://github.com/LodyAI/Lody/pull/1252)

[中文](2026-10-04-file-tree-scroll-test-clock.zh.md)

## Abstract

The component CI shard passed all 1701 assertions but failed with an unhandled
React update after jsdom teardown. The file-tree scrolling test left the virtualizer's
scroll-end debounce on the real clock. The suite now owns fake timers, exercises
scroll completion explicitly, and drains remaining callbacks before restoring the
real clock. Runtime behavior is unchanged.

## Evidence and decision

[The failing CI job](https://github.com/LodyAI/Lody/actions/runs/37202036948/job/111435612581)
traces `window is not defined` through TanStack Virtual's debounced offset observer
to React's state dispatcher, after `file-tree-virtual-rows.test.tsx` teardown.
Virtual-core 3.13.23 removes the scroll listeners but does not cancel that timeout.
The isolated baseline run passed locally, consistent with a teardown timing race.

The existing scrolling test now advances the fake clock and checks that the mounted
window remains nonempty, bounded and at the same scrolled position after scroll end.
Teardown unmounts the root and drains pending timers while jsdom is still alive.
This follows the per-file cleanup boundary retained in the
[module-graph decision](2026-09-10-components-test-module-graph.md); it does not disable
Vitest's unhandled-error reporting or add sleeps.

## Verification

The focused file-tree suite passes all seven tests. The matching component shard
(`--maxWorkers=4 --shard=1/3`) passes all 185 files / 1701 tests without unhandled
errors. Targeted formatting and diff checks pass. Root checks in this dependency-free
worktree remain blocked by missing tools; validation uses the isolated dependency-equipped copy.
