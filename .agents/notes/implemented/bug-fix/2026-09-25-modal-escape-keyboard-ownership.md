# Modal Escape ownership while the chat composer retains focus

Status: implemented
Translation: current

[中文版](2026-09-25-modal-escape-keyboard-ownership.zh.md)

## Abstract

The desktop command palette could remain open after Escape when it was opened from
the chat landing while the composer retained focus. The landing's window-level
capture listener consumed Escape before the modal could handle it. The keyboard
navigation hook now yields Escape to an open modal even when focus has not yet
moved into it; a regression test covers that event boundary.

## Evidence and decision

The macOS arm64 `Desktop E2E (smoke)` run for PR #982 failed in
`LODY-SHORTCUT-001`: after `Meta+K`, the command-palette input remained visible
for the full five-second hidden assertion. The uploaded screenshot and trace show
the palette open over the chat landing. `useChatLandingKeyboardNav` listens on
`window` in capture phase; when the composer still owns focus, its Escape branch
calls `stopImmediatePropagation()` to exit composer focus mode. That prevented the
palette's own Escape handler from receiving the event, so a component-level
handler alone was insufficient.

The hook now checks for an open modal before applying its composer Escape behavior
and yields the event. This leaves modal dismissal to the modal that owns the
visible layer without changing the landing's Escape behavior when no modal is open.
The behavioral test keeps focus in the composer, mounts an open dialog outside its
subtree, and verifies Escape continues through the event path.

## Verification

- `pnpm --filter @lody/components test -- chat-landing-keyboard-nav-ime.test.tsx`
- `pnpm e2e:build && pnpm e2e:smoke`

These checks validate the event-ownership regression locally; the CI runner remains
the cross-platform confirmation for the macOS Electron path.
