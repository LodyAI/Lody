# Markdown file-link context menus

Status: implemented
Translation: current

[中文](2026-09-17-markdown-file-link-context-menu.zh.md)

## Abstract

Assistant Markdown file links previously supported only in-app preview navigation or a fallback copy action. They now expose a context menu that always copies the file path and, only in a local Electron session with a resolved workspace, can open the file, invoke the header-selected editor, choose another configured launcher, or reveal it in the host file manager. The implementation reuses the shared session-file action boundary so remote or web content cannot hand an agent-provided path to the viewer's shell. Link line anchors remain an in-app navigation concern and are removed before native actions.

## Decision and evidence

`useSessionFileActions` builds the Markdown-specific menu from the same local-host
gate that protects the Files tree, preview notices, and side-panel actions.
`SessionDetail` provides that capability only to the conversation stream through
`SessionChatInterface`; other Markdown renderers retain no native menu. The menu reads the path-launcher
preference so its selected launch target follows the session header, while its
Open with submenu exposes the remaining available configured launchers.

The [draft Spec](../../../../specs/local-file-link-actions.md) records the user-visible
contract. The implementation evidence is the [Markdown renderer](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx), the [action hook](../../../../packages/components/src/hooks/use-session-file-actions.ts), and the focused [action test](../../../../packages/components/tests/use-session-file-actions.test.tsx).

## Verification

Focused component tests and type checking were requested but could not start in
this nested worktree because its `node_modules` dependencies are absent (`vitest`
and the Node type definitions cannot be found). The new tests cover local and
remote action sets, suffix removal before native calls, and the rendered context
menu's left- and right-click behavior. A complete dependency-backed run remains
required.
