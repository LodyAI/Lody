# Created-session cards reopen closed tabs

Status: implemented
Translation: current

[中文](2026-09-17-created-session-card-reopens-closed-tab.zh.md)

## Abstract

After a child conversation tab was closed, the creating turn's “View session” card
still routed to the child as though it were a standalone root Session. The parent
then observed the shared close flag and replaced that selection, so the button could
not reopen the conversation. Navigation now recognizes known child targets in the
mounted workspace and runs the existing lifecycle-aware reopen action before selecting
a closed tab. Selection waits until the open state is projected locally, so stale close
metadata cannot redirect an explicit request for child C to an open sibling A or B;
unrelated Sessions keep their normal route navigation.

## Decision

The persisted operation result intentionally needs only the created Session id. It
should not duplicate the child's parent id because current metadata is the authority
for containment, and the same card can also point to a top-level Session. The
Session-detail navigation boundary therefore resolves a bare target against its
complete ordered tab set. A match is a local tab navigation; if the matched metadata
is closed or historically archived, the shared reopen action restores it before the
URL selects it. The reopen write can settle before its metadata projection reaches the
mounted workspace, so selection is held as a request keyed by the exact child id. The
request navigates only after that id is no longer closed; a newer user navigation cancels
the pending selection. The request also records its source Session, because comparing only
`urlTab` would let a delayed restore cross from a tabless Session A into tabless Session B.

Routing every card through the child root URL was rejected. That route can discover
the parent, but it cannot express the user's reopen intent and correctly loses to the
parent workspace's close reconciliation. Globally reopening any clicked Session was
also rejected because cards for unrelated Sessions must preserve normal navigation.

This is a correction to the shared closure behavior recorded in
[the feature note](../feature/2026-09-16-shared-tab-closure.md) and specified in
[session tab closure](../../../../specs/session-tab-closure.md).

## Verification

The navigation regression test covers bare created-child targets, explicit root-plus-
tab targets, and unrelated Sessions. Component typechecking and the focused session
navigation, action, and tab-bar tests are the required executable checks. Native visual
acceptance remains outside the unit-test boundary.
