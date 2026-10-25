# Session links in Markdown file previews

Status: implemented
Translation: current

[中文](2026-10-22-markdown-preview-session-links.zh.md)

## Abstract

Markdown previews lacked SessionLinkProvider, so Session links were inert.
The viewer now reuses the chat deep-link mechanism, with navigation disabled by default.
In a locally built desktop app, the author clicked a `lody://session/...` link in the right-panel Markdown preview and opened its target session.

## Decision and scope

SessionFileContentView wraps both Markdown branches in SessionLinkProvider.
SessionDetail enables it from the same navigation callback as chat.
We chose viewer ownership over wrapping it in SessionDetail to test both branches at the viewer entry while keeping standalone viewers disabled.
Exact-target dispatch follows the existing [deep-link decision](../architecture/2026-09-29-lody-deep-links.md).

MarkdownRenderer, URI parsing, Electron protocol policy, file-link callbacks, and heading anchors are unchanged.
Relative paths still copy, HTTP(S) links open externally, and images use document/provider resolution.

## Evidence

`NODE_ENV=test pnpm --filter @lody/components exec vitest run tests/session-file-content-view.test.tsx`

The new cases fail on the unchanged baseline. With the fix, all 41 tests pass.
Coverage includes exact URI dispatch, legacy links, disabled navigation, relative paths, external links, and images.
