# Soft-keyboard Return inserts a newline

Status: implemented
Type: bug-fix
Translation: current

[中文](2026-11-20-mobile-composer-enter-newline.zh.md)

## Abstract

On a phone, Return in the chat composer stopped inserting a newline. The composer is a Lexical contenteditable, which honors `preventDefault` on Enter, and the default mobile Return action was Send. A phone keyboard has no Shift+Enter, so Return could only submit. A phone rotated past the layout breakpoint also dropped the mobile Return setting and used desktop Enter-to-send. Return now inserts a newline on a soft keyboard unless the user has chosen Send. Desktop Enter-to-send and Shift+Enter are unchanged.

## Decision

Treat soft-keyboard Return as its own policy, not as `useIsMobile()`. A handheld device (phone, tablet, native shell, or an iPad that reports a desktop user agent) and an explicitly forced mobile layout follow `mobileKeyboardActionAtom`. The stored default is newline. Send remains an explicit choice and still submits on Return. Desktop browsers and Electron keep Enter-to-send and Shift+Enter-for-newline at every window width, including a narrow desktop window.

The mention editor inserts that newline itself when the caller's keydown has not called `preventDefault`. iOS does not turn a contenteditable keydown Enter into a line break, and preventing the key swallows the break the browser would have inserted. A plain textarea still lets the browser insert the newline. Modified chords (Cmd/Ctrl+Enter, including the session composer's inverted send) stay with the caller.

Queued-message editing uses the same decision. On a soft keyboard whose action is newline, Return does not commit the edit.

## Evidence

The previous textarea composer called `preventDefault` and submitted on Enter unless the mobile action was newline. On iOS, `preventDefault` during keydown does not stop a textarea from inserting a newline, so Return still produced a line break. Commit `1aedcfbeb` (`feat(components): edit the composer in one Lexical contenteditable`, 2026-11-11) replaced that textarea. Lexical's plain-text Enter handler on iOS returns without inserting and relies on `beforeinput`; a caller that preventDefaults the keydown stops that event. The default action in `mobileKeyboardActionAtom` was `send`, so a phone Return submitted and inserted nothing.

`useIsMobile()` is false when the viewport is at least 768px, even for a phone user agent. That is the desktop layout family. The Return setting was wired to that flag (`isMobile || isNativeAppShell()`), so a landscape phone used desktop Enter-to-send regardless of the stored action.

The rejected alternative was to keep the Send default and only repair the newline action. People who had never opened the setting would still be unable to break a line. Another rejected alternative was to follow the layout breakpoint, which leaves landscape phones on desktop Enter-to-send.

## Scope and verification

Session and landing composers, the mention editor, queued-message editing, and the settings fallback share this policy. Component tests cover a wide phone inserting a newline without sending, the explicit Send choice still submitting, desktop Enter still sending, and desktop Shift+Enter inserting a newline. They do not drive a physical iOS keyboard; the insertion is the editor command those keydowns call.

## Supersession

No active note owns soft-keyboard Return. The Lexical editor note remains the editor architecture; its handler-order decision links here.
