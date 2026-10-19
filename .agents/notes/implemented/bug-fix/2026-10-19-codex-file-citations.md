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

## Decision and evidence

A remark transform runs before URL/path linkification. It trims surrounding path
whitespace, rejects ambiguous duplicate paths and URI targets, and encodes literal
filename punctuation before passing the target to the existing resolver. Optional
artifact metadata does not assert file type, size, or existence. The shared card
layout accepts a span frame so cards remain valid inside paragraphs. No opener means
copying the original path, matching existing file-link behavior.

This extends the [file-link action decision](../feature/2026-09-17-markdown-file-link-context-menu.md)
and is documented in [file rendering](../../../../packages/components/src/components/ai-gui/session-files-rendering.md).
The Markdown/file-link suite passed 30 tests under an isolated test configuration
using available dependencies, including real Markdown parsing and React rendering.
The full UI suite is blocked by missing `@stylexjs/unplugin` in the available dependency
installation; card interaction tests and Storybook states are added but not verified there.
