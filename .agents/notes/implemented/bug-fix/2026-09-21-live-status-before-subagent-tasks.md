# Place live status above the subagent task summary

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/867

[中文](2026-09-21-live-status-before-subagent-tasks.zh.md)

## Abstract

A running reply displayed its task summary above “Working”, separating the live
status from the reply. The trailing task row now places the live status above
its card, whether or not the turn has footer actions. Task expansion and
completed-turn folding retain their existing behavior.

## Decision

The [live-duration placement](2026-09-18-desktop-live-duration-alignment.md)
previously put status in a footer or a separate trailing row when a task card
ended the content. The stream now chooses that task row as the status owner.
This keeps the existing virtual row identities and task-panel state, and
suppresses duplicate status in the footer and after the conversation.

## Verification

The existing `packages/components/tests/agent-activity-row.test.tsx` suite covers
status ordering and uniqueness with and without footer actions, plus expansion
and collapse of a three-task summary. All 26 tests across that suite, virtual-row
identity, and turn-action insets passed in an isolated checkout. Workspace type
checks, lint, formatting, and document checks passed. The full check encountered
test failures under Node 26 experimental Web Storage; all 22 failed suites
(188 tests) passed with `NODE_OPTIONS=--no-experimental-webstorage`. The full
root command was not rerun.
Native desktop visual inspection was not performed.
