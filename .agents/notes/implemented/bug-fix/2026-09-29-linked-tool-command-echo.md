# Suppress linked command echoes in tool details

Status: implemented
Translation: current

[中文](2026-09-29-linked-tool-command-echo.zh.md)

## Abstract

An ACP tool call may carry both a structured shell command and a text copy with
Markdown links around file paths. The text renders as the same command, but a raw
string comparison misses the links and shows the command twice. Tool details now
compare the visible link labels with the structured command and omit only a full
echo; result text remains visible. This changes presentation, not stored history
or terminal output delivery.

## Decision and boundary

The [tool step sheet](../feature/2026-09-26-tool-step-detail-sheet.md) already
removes exact command echoes. `tool-call-command.ts` now unwraps simple Markdown
links in a candidate text block before its whitespace and worktree-path
comparison. It still requires the entire candidate to equal a structured
command. A block with extra explanation or a different command stays visible.

## Verification and limit

`tool-call-command.test.ts` checks linked echoes and distinct text.
`agent-activity-row.test.tsx` checks that the expanded sheet shows the command
once and retains its output. The synthetic `Sessions/ToolCallSteps.CustomAcpEcho`
story was captured before and after the change with Playwright at the same
viewport. The original provider's raw ACP notification was unavailable, so the
story verifies the duplicate presentation shape, not that provider's exact bytes.
