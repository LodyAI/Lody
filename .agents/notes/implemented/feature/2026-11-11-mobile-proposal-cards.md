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

## Consequences

The Android vendored runtime is re-snapshotted for the new projection and command and
exposes `decideProposal` through its bridge. A created schedule's card opens the
Schedules page on iOS; Android shows the receipt only. Agent files open on iOS like
attachments; Android shows name, type and size.

## Verification

`pnpm contract:check` keeps the Swift contract in step with the runtime methods.
The new command and cards have no dedicated tests yet. Native builds,
Swift and Kotlin compilation, and device behavior were not exercised in this change.
