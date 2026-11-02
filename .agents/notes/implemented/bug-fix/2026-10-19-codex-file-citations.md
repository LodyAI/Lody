# Codex file citation cards

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1706

[中文](2026-10-19-codex-file-citations.zh.md)

## Abstract

Codex output-file directives appeared as raw syntax in conversation Markdown.
The renderer now converts complete citations in prose into existing file cards,
opening files through the session's existing Markdown file-link boundary.
No attachment upload or additional filesystem authority is introduced.
Code examples and incomplete or invalid citations remain non-card content.

Conversation rendering confirms relative citations through the owning file index; absolute paths render immediately. Copy retains the original unencoded path and never invokes file discovery.

## Decision and evidence

A remark transform runs before URL/path linkification. It trims surrounding path
whitespace, rejects ambiguous duplicate paths and URI targets, and encodes literal
filename punctuation before passing the target to the existing resolver. Windows drive
prefixes are exempt from URI rejection and stay literal while separators normalize.
Only nodes with a children array are traversed: adding `children: undefined` to a
math leaf changes how mdast-to-hast classifies it and crashes rendering. Optional
artifact metadata does not assert file type, size, or existence. The shared card
layout accepts a span frame so cards remain valid inside paragraphs. No opener means
copying the original path, matching existing file-link behavior.

This extends the [file-link action decision](../feature/2026-09-17-markdown-file-link-context-menu.md)
and is documented in [file rendering](../../../../packages/components/src/components/ai-gui/session-files-rendering.md).
An isolated checkout with the frozen dependency lock passed all 106 tests in the
Markdown/file-link, streaming renderer and file-card suites, including the existing
inline/display-math tests and new Windows drive-path cases. The full static and
CLI 2 GiB and normal-budget desktop build checks are also exercised before delivery.

The PR smoke CLI build pins `NODE_OPTIONS=--max-old-space-size=2048`, matching the
existing CLI build budget: its macOS runner otherwise failed during CLI chunk
rendering under a lower host-derived default. The separate desktop build retains
`build-app.mjs`’s existing renderer budget; it must not inherit the CLI-only cap. The unrelated duplicate `now` fixture
property reported by static CI is removed without changing its value.
