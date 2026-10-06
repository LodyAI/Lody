# Pi shell output keeps its line breaks

Status: implemented
Translation: current

[中文](2026-10-06-pi-shell-output-line-breaks.zh.md)

## Abstract

When Pi ran a shell command, its multi-line output in an expanded step showed up as one
paragraph. History did not recognize Pi's result shape as terminal output, so the
result stayed a plain text block, and Markdown turned its single line breaks into
spaces. History now stores an execute call's Pi result as `terminal_output`.
The step sheet also shows any other plain text in an execute call as program output,
so sessions recorded earlier render correctly too. The fix applies only to execute
calls; other Pi tools return results in the same shape, and those are not terminal
output.

## Problem and evidence

On 2026-10-06 the owner reported a screenshot of a Pi `bash` step whose output appeared
as one long line. The command section looked correct. Code path:

- `acp-extension-pi` (`toolCall`) sends the command as `rawInput: { command }` and the
  result as `rawOutput: { content: [{ type: 'text', text }], details }`. It also sends
  each streamed partial and the final result as plain text `content` blocks.
- `extractTerminalOutputContent` (`packages/shared/src/acp/history-apply.ts`) recognized
  only Codex's `{ aggregated_output, exit_code }` and Claude/Kimi's string `rawOutput`.
  Pi's object matched neither, so no `terminal_output` was derived. Because generic
  `rawOutput` is not stored, the text block was the only copy of the output.
- The step sheet (`view.tsx`) renders a text block that is neither JSON nor a single
  fenced block with `MarkdownRenderer`, where a lone `\n` is a soft break.

## Decision

- History: for `kind === 'execute'`, an object `rawOutput` whose `content` array holds
  text blocks becomes one `terminal_output` (texts joined). The existing plain-text
  dedupe then drops the mirrored `content` block. That dedupe now also compares the
  untrimmed text, so output that starts with indentation (`launchctl print`) still
  matches.
- Render: in an execute call, a text block that is not JSON, not a single fenced block
  and not a command echo goes through the same bounded tail preview as
  `terminal_output`. This covers Pi histories written before the history fix.

## Alternatives

- Fence the output in `acp-extension-pi`: this fixes only new Pi sessions. Existing
  history would stay broken, and every ACP agent that follows the spec and returns
  shell output as text would need the same workaround.
- Treat every `{ content: [...] }` `rawOutput` as terminal output: Pi's read, edit and
  search tools return the same shape. Their results would then look like shell output,
  the confusion the [tool-step sheet note](../feature/2026-09-26-tool-step-detail-sheet.md)
  recorded for `TaskStop`.

## Evidence and limits

`packages/shared/tests/acp-history-apply.test.ts` replays a synthetic Pi stream (a
partial, then the final result with indented output). It asserts one `terminal_output`
with the exact text and no leftover text block, and that a Pi `edit` result produces
no `terminal_output`. `packages/components/tests/agent-activity-row.test.tsx` renders a
stored Pi execute step and asserts that its text is shown in `<pre>`, not Markdown.

Limits:

- Pi reports a failed command only as text ("Command exited with code N"), so no
  `Exit N` badge is derived.
- Not verified against a live Pi session in the packaged app.
