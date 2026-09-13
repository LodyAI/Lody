# Message queue interactions

Status: draft
Translation: current

[中文](message-queue-interactions.zh.md)

## Scenario

A user writes while an agent is working and chooses Queue or Steer as the default
behavior. They may need the opposite behavior for one message, or may decide that
any already queued message should steer the active response without first rearranging
the queue by hand.

## Contract

- `Mod+Shift+Enter` sends the current composer draft with the opposite of the stored
  Queue/Steer preference. This is a one-shot submission intent: it does not mutate the
  preference, and it still obeys the ordinary availability, live-activity, and unfinished-
  transcript safeguards.
- While steering is available for the active turn, every queued message exposes Steer.
  Selecting a later item targets that exact item. Native acknowledged steering removes
  and applies the selected item directly; the compatibility path first moves it to the
  queue head and interrupts only after the reorder succeeds.
- The number and non-editing message body form the drag target for queue reordering.
  Steer, edit, and remove remain separate controls and must not begin a drag.
- Editing keeps its existing keyboard and focus behavior and disables reordering for
  that row until editing ends.

## Limits and review questions

The shortcut changes routing only when Queue and Steer are meaningfully distinct. An
idle session still dispatches normally, and a session without positive live prompt
activity retains the conservative queue barrier even if the inverse intent would be
Steer. Touch and pointer interactions share the same drag target; installed-app and
physical-device coverage remains separate from component tests.

## Implementation evidence

- `packages/components/src/components/sessions/session-message-submit-route.ts`
- `packages/components/src/components/sessions/session-chat-input-area.tsx`
- `packages/components/src/components/sessions/message-queue/`
- `packages/components/tests/{session-message-submit-route,queued-message-steer,message-queue-row-editing}.test.*`
- [Decision record](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.md)

This is a draft for human review. Implementation and passing tests do not approve it.
