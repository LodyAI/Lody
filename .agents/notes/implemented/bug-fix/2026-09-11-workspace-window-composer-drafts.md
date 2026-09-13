# Isolate composer drafts per workspace window

Status: implemented
Translation: current

[中文](2026-09-11-workspace-window-composer-drafts.zh.md)

## Abstract

New-conversation attachments were already isolated per workspace, but the persisted text, pasted
content and mention ranges still used a user-level localStorage key, so different workspace windows
displayed and overwrote each other's drafts. The whole landing draft is now keyed by user/surface
together with the workspace slug. Workspace windows are peers: all of them use durable localStorage,
and draft lifetime does not change with how a window was opened. Old global drafts cannot be
attributed to a workspace reliably, so they are not migrated automatically.

## Problem

`buildChatLandingDraftKey` already combined the workspace slug for attachments and the reserved
session id, but `chatLandingSessionStateAtomFamily` received only the user key. Electron's
BrowserWindows share localStorage, so typing in two workspace windows wrote the prompt, pasted text
and mention ranges into the same entry.

## Decision

- All landing draft state uses the same `buildChatLandingDraftKey`, isolating by the stable route
  slug while the workspace id is not yet resolved.
- Every workspace window persists composer drafts in localStorage. `windowStorage`'s per-window
  storage suits navigation and layout, not workspace-owned drafts.
- Do not read or copy the old user-level draft key. That data has no workspace ownership, and
  migrating it automatically into the current window would leak content into the wrong workspace.

This fix implements the workspace draft isolation required by the
[desktop multi-window Spec](../../../../specs/desktop-windows.zh.md), and covers the landing
composer state that the
[multi-window implementation proposal](../../proposed/feature/2026-09-10-desktop-windows.md)
left out.

## Verification

Component tests cover one user persisting and restoring prompts separately in two workspaces, and
a workspace window not changing its persistence behavior based on how it was opened. Attachments,
the reserved session id, restoration after route unmount, and clearing remain covered by the same
suite.

- `pnpm --filter @lody/components exec vitest run tests/chat-landing-draft-persistence.test.tsx`
- `pnpm check`
- `pnpm run docs check`
