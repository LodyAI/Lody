# Native proposal and agent file cards

Status: implemented
Translation: current

[中文](2026-11-11-mobile-proposal-cards.zh.md)

## Abstract

Web renders Agent Role proposals, schedule proposals and agent-shared files as cards,
but the native iOS and Android transcripts showed a generic "event" row (iOS) or
dropped them (Android), so a proposal made from a phone-driven conversation could not
be confirmed there. The shared cloud runtime now projects well-formed proposals and
adds one `decideProposal` command that saves the Role or creates the schedule and
records the outcome in the notice; both clients render cards over it. The command
reuses the runtime's existing Agent Roles and schedule writers instead of porting web's
session-store turn replacement. Android's file card is display only because the client
has no session-file download yet.

## Decision

The runtime's `protocol/proposals.ts` reads `agent_role_proposal` and
`schedule_proposal` meta into a bounded presentation (`proposal` on the system-notice
summary); malformed meta stays a plain notice. `decideProposal` follows web's
[Role proposal](2026-10-17-agent-role-proposals.md) rules: only the requester decides
a Role proposal, a create retry keeps an existing Role, and an update writes only the
proposed fields through the existing `roleSettings` path. A schedule follows web
`resolveScheduleProposalTarget`: the conversation's Agent, mode and project unless the
proposal names a Role, Agent, machine or project, a different Agent gets Lody's builtin
default mode, and the machine owner and schedule protocol support are checked. The
proposal id is the schedule id and `proposal-<id>` the activity id, so a retried
Create cannot make two schedules.

The outcome is written by setting fields on the notice's `meta` inside the open
session document and appending the update, the same path as permission answers. An
append that fails keeps the version in `unsent`, and the projection hides that
unconfirmed outcome so the card keeps its buttons for an explicit retry; nothing is
replayed automatically. Web's in-card Edit for schedules is not ported; a person who
wants to change the rule edits the schedule afterwards.

Schedule edit proposals (`schedule_edit_proposal`, from LodyAI/Lody#3181) reuse the
same command: an `inspectProposal` read compares the live schedule with the proposal
(deleted, edited since `baseActivityId`, owner, machine capability, Agent present) and
returns the prompt line diff, and accept saves the patched fields over the live
schedule under web's `scheduleEditProposalActivityId`, so a retry on either client
replays the same save. The same projection carries web's other system rows (agent
warnings, fork origin, resumed history, worktree scripts); unknown notice names are
hidden as on web instead of reading as a generic event.

## Consequences

The Android vendored runtime is re-snapshotted for the new projection and command and
exposes `decideProposal` through its bridge. Open on a created or
updated schedule, and beside Apply on an edit, opens that schedule's existing editor
on both clients. There is no schedule subscription, so an edit card reads its schedule
again when the conversation returns to the screen. Agent files open on iOS like
attachments; Android shows name, type and size.

## Verification

`pnpm contract:check` keeps the Swift contract in step with the runtime methods.
`apps/mobile/ios/apps/ios/tests/schedules/edit-proposal.test.mjs` drives `inspectProposal`
and `decideProposal` for edit proposals against in-memory schedule streams. The iOS
`proposal-cards` UI case and Android `SystemCardsDeviceTest` render the cards with
synthetic runtime answers; the Role and schedule create paths still have no
runtime-level test.
