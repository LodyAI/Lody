# Archive and tab closure are orthogonal

Status: implemented
Translation: current

[中文](2026-09-24-archive-independent-of-tab-close.zh.md)

## Abstract

Every archived conversation counted as a closed tab, and reopening a closed tab
restored its archive. So opening an archived Session from the archive list showed an
empty draft instead of the conversation, and reopening its main tab from the closed
list unarchived it. Tab visibility now reads the close flag against the workspace's
archive state: an archived workspace shows the tabs it had open, reopening only clears
`isTabClosed`, and restore never writes the close flag. The one remaining overlap is
deliberate: an archived child inside a live workspace stays out of the strip and is
offered with an explicit Restore action. An archived workspace is also review-only: its
drafts and new-conversation action are hidden until Restore.

## Decisions and evidence

The [shared tab closure](../feature/2026-09-16-shared-tab-closure.md) revision kept
historical close-by-archive child tabs in the closed list by making
`isSessionTabClosed` return true for any archived Session and by making
`reopenSessionTab` call `restoreSession`. Both ends leaked into Sessions the user had
archived on purpose: the archived root was always "closed", so the route fell back to
the draft, and the only way back to the conversation unarchived it.

`isSessionTabClosed(meta, workspaceArchived)` is now
`isTabClosed === true || (isArchived && !workspaceArchived)`. The root is its own
workspace, so only its close flag counts. An archived root's children (archived with it)
become tabs again for review. `reopenSessionTab` was removed; the closed-list action
writes `isTabClosed: false` alone, and `restoreSession` writes only `isArchived: false`.

Legacy close-by-archive children cannot be told apart from children archived on purpose,
and no migration guesses. Showing archived children of a live workspace as open,
read-only tabs was rejected: it would bring every legacy-closed child back into existing
strips. They stay hidden, and their closed-list row says Restore instead of Reopen
(desktop popover and mobile tab sheet). Restore runs the existing restoration checks,
then clears that child's close flag so it returns to the strip. The toolbar's "Restore
session" now calls `restoreSession` directly instead of going through the tab reopen
path.

Walking the journeys in the built desktop app found two more traps. A draft tab's id is
remembered as the last-active tab, and the old fallback had already materialized the
`empty` sentinel into a draft, so an affected Session reopened from the archive list could
still land on that draft. Sending from any draft in an archived workspace would also
create a live child under an archived root whose worktree may already be reclaimed. The
archived workspace therefore hides drafts (they stay stored), removes the new-tab button,
Alt+N path and mobile New Chat row, resolves a draft or `empty` URL to an open
conversation and replaces the URL, and shows the main conversation when every tab is
closed. Rejected: deleting stored drafts on archive, which would lose input a Restore can
bring back.

Children archived before their root was archived still come back as open tabs when
reviewing that archived root; the data does not distinguish them. The
[Spec](../../../../specs/session-tab-closure.md) is updated and remains draft.

The [suspended LODY-SESSION-004 assertion](../testing/2026-09-18-session-004-provenance-assertion-suspended.md)
waited for exactly this decision; it is re-enabled with its original registry row
(fingerprint `44fb98c9…`). `LODY-SESSION-002` and `-004` pass against the built desktop.
A throwaway desktop exploration (not committed) confirmed: an archived child of a live
workspace leaves the strip and restores from its Restore row; archive-list entry shows the
transcript with the Archived badge and a disabled composer; drafts, the new-tab button and
Alt+N are absent; reopening and closing a tab keep it archived; header Restore keeps tabs;
an all-closed archived workspace shows its main conversation.

Tab-bar tests render an archived workspace (open tabs visible, closed tab offered as
Reopen) and a live workspace (archived child offered as Restore). Tab-URL tests cover the
predicate; session-action tests cover reopen without restore and restore without
touching close flags against the metadata repo. Components typecheck passes. Mobile
tab-sheet tests cover the Restore label and the missing New Chat row. The mobile surface
was not exercised in a real app.
