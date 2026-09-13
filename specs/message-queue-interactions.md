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
  Queue/Steer preference. The command passes `queueBehavior: "inverse"` directly to that
  submission; ordinary Enter passes no override. This one-shot intent does not mutate the
  preference and still obeys the ordinary availability, live-activity, and unfinished-
  transcript safeguards. Composer focus, content, and send readiness are command-level
  availability rules so user-rebound shortcuts retain them.
- While steering is available for the active turn, every queued message exposes Steer.
  Selecting an item sends its durable queue identity and the expected active turn to the
  owning daemon. The daemon revalidates both identities, atomically consumes only that row
  into the next durable user turn, and then stops the expected turn. Queue order is never
  rewritten as part of Steer: selecting C from `[A, B, C]` produces the active turn C and
  leaves `[A, B]`.
- A stale Steer selection is a failed no-op. If the selected queue identity is missing, or
  the expected turn no longer owns execution, the daemon must not stop any turn. The
  renderer waits for this acknowledgement and never removes or materializes the row itself.
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
- `packages/components/tests/{session-message-submit-route,session-chat-input-submission,message-queue-row-editing}.test.*`
- `apps/cli/{tests/session-execution-service.test.ts,src/lib/loro/doc-user-turn.test.ts}`
- [Decision record](../.agents/notes/implemented/feature/2026-09-13-queue-steer-controls.md)

This is a draft for human review. Implementation and passing tests do not approve it.
