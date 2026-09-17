# Side-session Markdown file-link capability scope

Status: implemented
Translation: current

[中文](2026-09-17-side-session-file-link-capability-scope.zh.md)

## Abstract

Markdown file-link menus initially received the root Session's file-action callback through a shared conversation-surface helper. A remote side Session could therefore expose native actions authorized only for a local root Session and target the root workspace. The menu provider now derives actions from the Session whose conversation it renders, so a remote side Session is limited to Copy Path and cannot call the local Electron bridge. This corrects the original [feature note](../feature/2026-09-17-markdown-file-link-context-menu.md).

## Decision and evidence

`SessionChatInterface` now owns the `SessionAgentFileLinkMenuProvider` boundary, rather than accepting a callback selected by `SessionDetail`. The provider uses the rendered `SessionMeta`; the existing file-action resolver consequently applies its local-machine and resolved-workspace gates to that exact Session. This keeps mounted child and side chat surfaces safe even when their opener is local but their machine or workspace differs.

The behavior test renders a local root Session beside a remote `side-panel` Session, asserts that the root may expose Open File while the side menu is exactly Copy Path, then invokes Copy Path and observes no local open, reveal, or launcher IPC. The user-visible contract is updated in the [local file-link Spec](../../../../specs/local-file-link-actions.md). PR: [#789](https://github.com/LodyAI/Lody/pull/789).

## Verification

Run the focused provider regression and i18n check with installed workspace dependencies. This nested worktree has no `node_modules`, so type checking and formatting cannot run locally; CI remains the complete dependency-backed verifier.
