# Keep local project removal transitions out of access errors

Status: implemented
Translation: current

[中文](2026-09-20-local-project-removal-race.zh.md)

## Abstract

Removing a local project hides its row optimistically as soon as the durable
Machine Flock command is written. The chat landing could still hold that project
as its selected state, so its normal availability check briefly reported
"Local project is not available" before the command result notification showed
successful removal. The landing now clears a stale URL-named local selection when
navigation returns to plain `/chat`, and treats pending and completion-notification
windows as an expected removal transition. Genuine access failures remain unchanged.

## Evidence and decision

The Machine Flock overlay intentionally removes projects with a pending delete
command from `MachineViewMeta.localProjects`, while
`usePendingLocalProjectRemovals` preserves the command as a separate lifecycle
view. Chat landing selection state outlives the sidebar navigation to plain
`/chat`, so `getChatLandingLocalProjectAvailability` can observe the selected
project after its optimistic metadata row has disappeared. Treating that missing
row as an authorization failure races the command result toast.

The availability check remains the source of truth for real authorization and
metadata failures. The landing clears a previous local URL selection before the
optimistic overlay can validate it, then additionally checks the existing
pending-removal map and a completion suppression set owned by the removal result
notification hook. The latter covers the interval after a completed command is
observed and before its row is deleted, so a success or warning result is the
only user-facing outcome for that removal. Suppression is removed once the
completed row disappears; a failed acknowledgement leaves the row available for
the existing retry path.

## Verification

`chat-landing-derived.test.ts` covers suppression during removal, reporting a
real unavailable project, and ignoring pending/available availability states.
The focused suite passes 77 tests. Type checking and formatting were run for the
changed components; repository-wide documentation and check commands remain to
be run before commit.
