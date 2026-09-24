# Repair Desktop Daily: stale archive journey and Windows tag quoting

Status: implemented
Translation: current

English | [中文](2026-09-17-daily-e2e-cascade-and-windows-tags.zh.md)

## Abstract

Desktop Daily failure Issue #507 accumulated a comment per run for two
independent defects. `LODY-SESSION-004` still asserted the pre-#663
containment-only archive contract, so it failed deterministically once archive
began cascading through opened-by links; the scenario now verifies the cascade
contract end to end. Separately, the Windows leg never executed a single
scenario because the `e2e` package scripts quote the Cucumber tag expression
with single quotes, which pnpm's `cmd.exe` script shell does not group; both
suite scripts now use double quotes. Neither defect changed product code.

## Evidence

Daily runs [35193489771](https://github.com/LodyAI/Lody/actions/runs/35193489771),
[35067864414](https://github.com/LodyAI/Lody/actions/runs/35067864414), and
[34940772254](https://github.com/LodyAI/Lody/actions/runs/34940772254) fail
`LODY-SESSION-004` on ubuntu and macOS at `archiveRelationRoot`: the journey
expected the opened Sessions to stay active after the root archive, but the
[archive descendants decision](../bug-fix/2026-09-13-session-archive-descendants.md)
and the revised [relation Spec](../../../../specs/session-relations.md) archive
the child Tab and both opened Sessions. The same runs show the Windows leg dying
before Cucumber evaluates tags: `cmd.exe` splits `'@P0 or @P1'` into three
arguments, so Cucumber reads `or` and `@P1'` as feature paths and exits with
`ENOENT ... e2e\@P1'`. Windows therefore contributed zero scenario coverage to
every Daily on record.

## Decision

`SessionRelationLifecyclePage` now asserts the current contract instead of the
retired one:

- `archiveRelationRoot` expects the root row and both opened Session rows to
  leave the active sidebar, all four metadata rows archived, and the opened
  Sessions' agent processes and worktrees released — each archived Session
  keeps its ordinary teardown.
- `permanentlyDeleteRelationRoot` keeps the containment scope: only the root
  and its direct child Tab disappear while the opened Sessions remain archived
  and listed in Archive.
- `expectDanglingProvenanceAndCleanup` still proves the deleted-opener card is
  visible and non-navigable, then deletes each already-archived survivor
  straight from its Session route.

The Gherkin checkpoint no longer claims worktree retention — worktrees are
reclaimed by archive, not by the later deletion — and the journey registry row
records the cascade checkpoints with a recomputed fingerprint.

The `full` and `smoke` scripts quote `--tags` with double quotes, which both
POSIX shells and pnpm's `cmd.exe` script shell group correctly. Double-quoted
script arguments already appear in the root `package.json`.

## Verification and limits

`pnpm --filter @lody/e2e check` passes: suite contract (22 scenarios, matching
ids), Cucumber dry-run, type check, and script unit tests. `journey:coverage`
regenerates `COVERAGE.md` from the updated registry row. The repaired journey
and the Windows script path were not executed locally; both need a built
desktop and a real Daily leg to confirm green. Two intermittent failures seen in
the same runs — `LODY-COPY-001`'s hidden-but-present message text on macOS and
`LODY-MCP-001`'s empty MCP startup selection on ubuntu — did not reproduce in
run 35193489771 and remain unaddressed flakes to watch.
