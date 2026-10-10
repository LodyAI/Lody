# Configurable Send and Steer shortcut

Status: implemented
Translation: current

[中文](2026-10-07-configurable-send-and-steer-shortcut.zh.md)

## Abstract

Users who keep the queue default wanted one key, such as Cmd+Enter, that always
steers a busy prompt instead of remembering whether Cmd+Shift+Enter currently
inverts toward steer or queue. A new rebindable command, Send and Steer
(`session.sendSteer`), sends the focused session draft with a guide
`submitBehavior` override, which the submit-route resolver applies under the
existing steering guards. It ships unbound so nobody's habitual Cmd+Enter changes meaning;
users bind it on the Keyboard Shortcuts page. The command only runs while the
visible session composer textarea has focus, so a binding never sends a hidden
draft or captures Cmd+Enter in other text fields.

## Problem and decision

The [inverted send](2026-09-18-per-row-queue-steer-and-inverted-send.md) gave one
hard-coded chord whose meaning depends on the configured preference. Composer send
lived only in a local `onKeyDown`, so no binding could be changed or added.

- The command lives in the shared registry so it appears on the settings page and
  reuses recording, conflict detection, and cross-window persistence. A built-in
  placeholder keeps it listed when no session composer is mounted.
- The resolver takes one `behaviorOverride` in place of the configured preference.
  The command passes `guide`; Cmd+Shift+Enter now passes the opposite of the
  preference, computed in the composer at key press, instead of a separate
  `invertBehavior` flag. `forceQueue` and `forceDirect` still win. Steering still needs authoritative acknowledged-steer support,
  positive live prompt activity, and an unfinished assistant turn; otherwise the
  submission takes the ordinary queue or direct route.
- Binding-level `when` does not apply to user overrides, and this command has only
  user bindings. The command-level `when` therefore checks that the composer
  textarea is `document.activeElement` and its mention menu is closed, so a rebound
  plain Enter still selects a mention.
- Registry dispatch runs in the window capture phase before the composer handler.
  The composer handler now ignores Enter events already prevented, so Cmd+Enter or a
  rebound Cmd+Shift+Enter cannot send twice. Registry dispatch also ignores IME
  composing keydowns for every command.

## Alternatives considered

- A separate `forceSteer` flag beside `invertBehavior`: rejected in review because
  two overlapping flags needed their own precedence rule, while one override says
  the same thing. The analytics field `invert_behavior` became
  `submit_behavior_override`.

- Default binding `Mod+Enter`: rejected because Cmd+Enter already sends through
  the configured behavior and changing a muscle-memory key silently would reroute
  busy sends.
- Making the existing inversion chord rebindable instead: it would not give a
  preference-independent "always steer" key, which is what users asked for.
- Palette availability: the palette input takes focus, so the focus-scoped `when`
  hides the command there. It is a composer keystroke, not a navigation action.

## Limits and verification

- With two visible session composers in one renderer, only the most recently
  mounted registration owns the command; today retained tabs pass `isVisible=false`.
- A forced steer that the adapter rejects degrades exactly like an inverted steer:
  it becomes an ordinary next turn ahead of earlier queued rows.
- Verified by the route resolver, registry IME, and composer integration tests,
  which mount the real `CommandShortcutHost`. No live-agent steering was exercised.

## Evidence

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/lib/commands/{registry,shortcuts,built-ins}.ts`
- `packages/components/tests/{session-message-submit-route,commands-registry}.test.ts`,
  `packages/components/tests/session-chat-input-submission.test.tsx`
