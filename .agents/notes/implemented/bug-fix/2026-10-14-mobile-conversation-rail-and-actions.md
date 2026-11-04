# Mobile conversation rail, round gap and message actions

Status: implemented
Translation: current

[中文](2026-10-14-mobile-conversation-rail-and-actions.zh.md)

## Abstract

On phones the conversation had three left edges, rounds that ran together, and
copy/info/fork/edit/pin buttons resting under every message. Everything now
starts on the prose rail, the round gap sits below the mobile footer instead of
containing it, and only the newest assistant turn rests with its buttons; a tap
on any other message reveals that message's buttons, one message at a time. The
trade-off is one extra tap to reach actions on older messages.

## Evidence

A phone screenshot (402px CSS width) measured prose at 18px from the screen edge,
the footer's "Worked for …" at 14px, the mobile disclosure chevron glyph at ~22px
and its label ("Ran 3 commands") at 38px. Causes:

- The mobile action bar carried no `conversation.railInset`.
- `ProcessDisclosureButton` put the chevron before the label on mobile only, so
  the label started a chevron plus gap right of the rail, and expanded steps
  (on the rail) no longer lined up with their header.
- The mobile live status (`AgentActivityStatus`) dropped the 4px left inset.

The rhythm Spec placed footer actions inside the `roundGap` reserve. That holds
on desktop, where actions rest at `opacity: 0`, but the mobile footer is always
visible, so the visible gap between it and the next user's timestamp shrank to
about 17px.

## Decision

- One rail: the mobile action bar gets `conversation.railInset`; the disclosure
  shows the label first on every layout with the chevron trailing (always shown on
  touch); the live status keeps the rail inset on mobile.
- Mobile round footer rows use `roundLastRow` (reserve below the footer) instead
  of `roundFooter` (reserve around it). The Spec now records this.
- `mobile-message-actions.ts` holds the one revealed message id in an external
  store; each row subscribes to its own boolean, so a tap re-renders two rows.
  Taps on links, controls, the action bar or a text selection do not toggle.
  Hidden buttons use `invisible`, so revealing never changes row height in the
  virtualized list. The newest assistant turn, and a turn with a fork in flight,
  keep their buttons visible. The duration slot (and its edge-swipe inset) stays.

Alternatives considered: long-press menus (conflict with native text selection,
which the conversation relies on) and hiding buttons on every turn (hides the
most common action, copying the latest answer).

## Verification

`tests/assistant-turn-action-inset.test.ts` covers resting visibility, one-at-a-time
reveal and the tap filter. `AssistantTurnAlignment.MobileConversationRhythm`
measured prose, disclosure label and footer label all at 18px in Chromium at
390px width. Not verified on a physical iOS device.
