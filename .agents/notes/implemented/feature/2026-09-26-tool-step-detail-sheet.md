# An expanded tool step is one sheet

Status: implemented
Translation: current

[中文](2026-09-26-tool-step-detail-sheet.zh.md)

## Abstract

Expanding a tool step in a conversation showed a different object for each shape of
tool: a gray terminal slab for shell commands, a terminal panel with a `>_` header
repeating the row's title for any tool whose result happened to be a string, a large
bordered Markdown card for a prose result, and — when an agent sent the command as a
text block too — the same script twice, the first copy mangled by Markdown. Every
expanded step now opens onto one header-less sheet in the conversation's card
material, holding what the step did and what came back as ruled sections in the order
they happened. Only the command is syntax-highlighted, in the shared Shiki worker;
output keeps its ANSI colours and is never tokenized. The sheet does not change what
history stores: every rule here is applied at render time.

## Problem and evidence

Owner screenshots (2026-09-25) showed, in one turn: `ToolSearch` → a 16px bordered
card saying "Tool: TaskStop"; `TaskStop` → a terminal panel whose header repeated
"TaskStop" above a JSON line; a Claude Bash step → a gray panel ("too gray, make it
whiter"); a dark-theme `python3 -c` step → the script as Markdown (`*` as emphasis,
a path turned into a file chip) and then again as a command.

Causes, all in `ToolCallCard` (`view.tsx`):

- `TerminalComponent` painted VS Code's `terminal.background`, gray in Lody Light, and
  showed its own header whenever the step was not an `execute` call.
- History stores a Claude tool's plain-string `rawOutput` as `terminal_output`
  (`extractTerminalOutputContent`), so a non-shell tool got the terminal treatment and
  was counted by `isCommandToolCall` — the row read "Ran TaskStop" and "Ran N
  commands" included it.
- A multi-line text block equal to the command was not the "terminal title" (that
  only takes single-line text), so it fell through to `MarkdownBlock`.
- Text results were framed in `CONVERSATION_PANEL_FRAME_CLASS` at body size.

## Decision

- `tool-call-detail.tsx` (StyleX) owns the sheet: fill `--composer` (white in light,
  the input surface in dark — the composer's own fill), `shadow.card`, `radius.medium`,
  no header. Sections are divided by an inset `separator` rule, never above the first.
- Command section: `$` prompt and Shiki tokens from `useMarkdownCodeTokens` with the
  `shellscript` grammar, which tokenizes in `markdown-highlight.worker.ts` and caches
  finished blocks. A search's stored "command" is its pattern, so it gets no prompt and no shell
  colours. The `--lody-shiki-*` palette moved to a shared `[data-shiki-palette]` rule.
- `tool-call-command.ts`: `formatToolCommand` unwraps `bash|sh|zsh -lc <script>` (Codex
  argv) and quotes other arguments a shell would split; `isToolCommandEcho` drops a text
  block that restates the command (fenced, inline-code or reflowed).
- Output section: the tail preview as before, ANSI colours, secondary label colour; a
  caption when earlier output was cut; `Exit N` in the destructive colour for a non-zero
  exit — the only fact in the sheet that earns a colour.
- Text results: JSON or a single fenced block render verbatim in mono; prose renders as
  compact Markdown at 0.9× the conversation size, flush with the other sections.
- A diff stays its own surface and splits the sheet; the permission record stays a line.
- `isCommandToolCall` needs a `terminal_command` for non-shell kinds; output alone no
  longer makes a tool a command.

## Alternatives

- Restyling `TerminalComponent` in place: it also serves the worktree-script notice,
  whose header is information there, and its terminal-background surface is the part
  that read gray.
- Highlighting output as well: output is not source, tokenizing it costs worker time on
  the longest strings in the transcript, and ANSI already carries the program's colours.
- Whitening Markdown fenced code blocks to match: left for a separate decision; they
  still use `--code-background`.

## Evidence and limits

`tests/agent-activity-row.test.tsx` expands real rows and asserts one sheet per step,
the echoed script present once and never as Markdown, the Codex wrapper removed,
`Exit 2`, and a string result with neither prompt nor header; it also asserts the
group counts `TaskStop` as a tool. `tests/tool-call-command.test.ts` covers unwrapping,
quoting, worktree shortening, and echo matching. The `Sessions/ToolCallSteps` story
(light and dark) was screenshotted in Chromium. Not verified in the packaged desktop
app, or with every agent's real payloads beyond the shapes listed above.
