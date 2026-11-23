# The share inventory opens its source conversation

Status: implemented
Translation: current

[中文](2026-09-15-share-inventory-session-jump.zh.md)

## Abstract

Settings > Shares listed a published copy by title, status, conversation count
and time, but offered no way back to the conversation it was made from: a member
reviewing the inventory had to remember which session a title belonged to and
find it in the sidebar by hand. Each row now carries a "View conversation"
action that closes the settings overlay and navigates to the share's
`rootSessionId`. The action is gated on the local session-metadata cache holding
that session, for the same reason the existing "Update deployment" action is —
a share outlives its source, and a jump to a deleted or unreadable session would
land on an empty page. The tab itself moved below AI Usage in the workspace
section, which is ordering only and carries no behavioral consequence.

## Problem and decision

A published share is a frozen copy; the live conversation it came from is a
different object with a different lifetime. The inventory had no edge between
them, so the two most common follow-ups — "what did I actually publish?" and
"is this still the conversation I want public?" — both required leaving settings
and searching. The row already resolved the source session to decide whether
"Update deployment" could be offered, so the jump adds a caller to an existing
lookup rather than a new cloud read: `share-management-setting.tsx` now keeps
the resolved `SessionMeta` instead of a boolean, and both actions read it.

Navigation on desktop must dismiss the settings modal, because settings renders
as an overlay above the workspace and the destination would otherwise be hidden
behind it; on mobile settings is a route and the navigation replaces it, so one
code path serves both. The alternative — opening the share's public link
instead — was rejected: that shows the frozen copy the member is already looking
at a row for, not the live conversation, and it is unavailable to every member
who does not hold the link credential on this device.

Gating on local metadata rather than always rendering the action is deliberate.
An admin sees the whole workspace inventory, including shares whose sessions
this client cannot read, and a button that reliably lands nowhere is worse than
an absent one. The cost is that the action appears only after the metadata cache
hydrates; that cache already gates "Update deployment" in the same list, so the
row does not gain a second readiness behavior.

## Verification limits

`packages/components/tests/share-management-setting.test.tsx` covers both
states: the action is absent while the source session is unknown, and clicking
it closes the settings dialog and navigates to the session route with the
resolved workspace slug. The suite mocks the router, so it establishes the
requested navigation, not that the destination route renders. Tab ordering has
no test; it is a static array position in `settings-tabs.tsx`.

Related: [static session sharing](../../proposed/architecture/2026-09-12-static-session-sharing.md),
[the session header's share control](2026-09-14-session-header-share-control.md).
