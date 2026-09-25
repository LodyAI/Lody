# Answering a permission request

Status: draft
Translation: pending

## Scenario

An agent is working and stops to ask: may it run `pnpm install`, edit two files,
reach `registry.npmjs.org`, or leave plan mode? The person answering needs three
things, in this order: what the agent wants to do in plain words, exactly what
that would run or touch, and the answers the agent offers. They answer where
their hands already are, and they must not answer by accident.

## Contract

- **One live surface.** A pending request is answered in the prompt that stands
  in for the composer. The conversation shows the request's place in the turn
  ("Waiting for your answer"), never a second set of answers. Once answered, the
  conversation keeps a one-line record of the choice; a withdrawn request leaves
  none.
- **The provider's words.** The heading and reason are the ones the agent sent,
  when it sent them. Otherwise the heading is a question derived from the tool
  kind. The answers are the agent's own option names and descriptions, never
  rewritten or merged, because "Yes, and don't ask again for `git` commands"
  says what the answer means.
- **Exactly what would happen.** A command shows in full, with its directory; a
  file request lists each path once; anything else shows the agent's title for
  the call. A plan decision has no subject: the plan is the message above it.
- **The suggestion.** One answer is marked as suggested: the first one-time
  refusal when the provider marks the request `defaultToNo`, otherwise the first
  one-time allow. An "always" answer is never the suggestion.
- **Shape.** The composer's scale, not a dialog's: the question and why, the
  subject, and one row of answers at the end — a split button for refusing and
  one for allowing. Each shows its one-time answer (the suggestion is primary)
  and keeps the answers that change what happens from now on ("don't ask
  again", "block this host") in its menu, in the provider's words.
- **Keyboard.** The arrows walk the answers, starting on the suggestion; Enter or
  Space answers the one focused. Escape refuses once and never picks an "always"
  refusal; with no one-time refusal, Escape answers nothing. Enter on the prompt
  itself answers nothing, so an Enter meant for a message that the prompt just
  replaced cannot approve the request.
- **Focus.** The prompt takes focus when it appears only if nothing else holds
  it, which is where focus lands when the composer it replaced unmounts.
- **One at a time.** Several requests can be pending at once. The prompt shows
  one, says which of how many, and walks between them; answering one brings up
  the next in the same place.
- **Failure is visible.** An answer that does not reach the agent says so in the
  prompt, and the prompt stays answerable. While the workspace is connecting,
  the answers are disabled and the prompt says why.
- **A way out.** The prompt offers Stop, because the composer that holds Stop is
  hidden while a request is pending.
- Questions (AskUserQuestion forms) are answered in the same place and queue,
  with the question form rather than the option list.

## Open questions

- Edit requests arrive without their diff: history drops edit `diff` content
  before storage, so the prompt can show the paths but not the change.
- The iOS Live Activity approves with the `allow_always` option when one exists,
  which contradicts "an always answer is never the suggestion".
- The 20-minute server timeout is not shown before it withdraws the request.

## Evidence

- Implementation: `packages/components/src/components/sessions/floating-permission-request.tsx`,
  `packages/components/src/lib/permission-request-presentation.ts`.
- Validation: `packages/components/tests/permission-prompt.test.tsx`.
- Decision record: [permission prompt note](../.agents/notes/implemented/feature/2026-09-24-permission-prompt.md).
