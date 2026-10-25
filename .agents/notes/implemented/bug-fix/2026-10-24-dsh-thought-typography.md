# DSH thought prose typography

Status: implemented
Translation: current

[中文](2026-10-24-dsh-thought-typography.zh.md)

## Abstract

DSH thoughts remained gray and compact after becoming independently visible.
Their dedicated virtual row now reuses the normal answer Markdown component,
matching font, size, weight, line height and reading color. The thought disclosure,
search identity, tool folding and other provider paths stay unchanged.

## Evidence and verification

This supplements the [independent display decision](../feature/2026-10-22-dsh-independent-text-tool-display.md).
Only `AssistantThoughtVirtualRow`, emitted for builtin DSH, changes its renderer;
shared `ThoughtCard` and subagent/tool process styling are untouched. The existing
DSH Storybook case now asserts computed typography equality and hidden tool output.

A temporary browser preview used the actual thought row, MarkdownBlock,
MarkdownRenderer and StyleX tokens with synthetic prose. Session/search/file/diagram
services were stubbed and the tool disclosure was a preview-shell element, so this
is not a full desktop or tool-folding integration test. Chromium confirmed equal
font family, 16px size, 400 weight, 27.4286px line height and rgb(33, 33, 33) color.
The screenshot was visually inspected; it contains no captured conversation.
The full Storybook play test and package build were not run in the dependency-free
worktree. Screenshot upload via the available CLI was blocked by expired login;
the local artifact is retained outside source control.
