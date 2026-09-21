# Shared conversation tab closure

Status: draft
Translation: current

[中文](session-tab-closure.zh.md)

Closing a main or top-level child conversation tab changes the workspace's shared
open-tab set. Other viewers close the same tab, but retain their own selected tab
and ordering. A selected tab closes to the next open neighbour, right then left,
or a local new-conversation draft inside the same Session workspace.

## State and lifecycle

`SessionMeta.isTabClosed?: boolean` is independent of `isArchived`. Missing means
open. The main Session's flag closes only its conversation tab; children, sidebar row
presence, running agent, pending work, terminal, and worktree remain intact. New close actions
only write this flag; even persisted empty conversations are not deleted.

The closed list includes `isTabClosed === true || isArchived === true`. This retains
historical child tabs whose close operation archived them. Reopening an archived
conversation runs the existing restoration checks and containment rules, then clears
the selected conversation's close flag. Root restoration includes direct children,
preserves their independent close flags, and excludes opened-by descendants. A failed
restore is visible and retryable. No bulk migration guesses the reason for an archive.

Closed and archived conversations do not contribute unread indicators to the desktop
sidebar, the mobile session list, tabs, parent summaries, project counts, or window
badges. Existing closed conversations and later background output obey the same rule.
The one surface that shows their unread state is the desktop top bar's
closed-conversations list: its trigger shows an unread dot while any listed
conversation has output newer than its `lastReadAt`, and that row shows the dot. Closing does not
change `lastReadAt` or add another state: reopening resumes the timestamp comparison,
and viewing the conversation sends the normal read receipt. Open children still
contribute unread even when the main tab is closed. Working and permission indicators
remain independent of unread suppression.

## Navigation and synchronization

Metadata uses the existing writer and CRDT synchronization. Disconnected writes
reconcile through that same field conflict policy. Background work never reopens tabs.
Reopening adds the tab everywhere but only selects it for the initiating viewer.
An in-conversation card that opens a child conversation restores that tab first
when it is closed, waits until the restored state is projected locally, then selects
that exact child in the current Session workspace. Open siblings are not fallbacks for
an explicit restore request.
Changing the current Session invalidates the pending restore even when both routes omit
`?tab`; a restore started in one Session cannot select a child in another.
The URL remains the selected-view authority; `tab=empty` is a compatible entry into
the default draft. After metadata hydration, reuse an existing local draft or create
one, then replace the sentinel with its explicit draft URL. A confirmed close may replace the still-current URL choice;
missing metadata remains pending and stale asynchronous navigation is discarded.

The default draft uses the existing composer and creates a real Session only on send.
It remains device-local, preserves existing input, retains the closed-list reopen action,
and does not deactivate a mobile viewer. Hidden
conversations do not receive read receipts or composer commands. Input drafts remain
local. Local unsent drafts, Side Chats, and file/tool panels retain their own lifecycle.
The close accelerator closes the focused tab; closing the final draft returns to a
fresh local draft. File/tool panels retain their existing close behavior.

## Compatibility and evidence

Older clients can read the additional metadata, but do not honor the new flag and
may still archive when closing. Uniform behavior requires updated clients. Any hosted
metadata allowlist must preserve the field; private backend compatibility cannot be
established by this public repository alone.

Implementation owners: shared SessionMeta, components session actions, tab URL
resolution, SessionDetail, SessionTabBar and the responsive mobile tab sheet.
Tests cover close/reopen lifecycle isolation, neighbour/empty selection, and real
LoroRepo replica convergence. See [relations](session-relations.md) for archive targets.
