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

Archive and tab closure are orthogonal: closing never archives, reopening never
restores, and restoring never changes a close flag. An archived workspace (its main
Session archived) keeps the tabs it had open, so opening it from the archive list shows
the archived conversation instead of a draft; its closed tabs reopen and stay archived.
An archived workspace is review-only: local drafts stay stored but are hidden, there is
no new-conversation action, a draft or `tab=empty` URL resolves to an open conversation,
and with every tab closed it still shows the main conversation. Restore brings drafts
and the new-conversation action back. Root restoration includes direct children and
excludes opened-by descendants.

In a live workspace, an archived child conversation stays out of the tab strip; this
includes historical child tabs whose close operation archived them. The closed list
shows such a child with an explicit Restore action, not Reopen: it runs the existing
restoration checks, then clears that child's close flag. A failed restore is visible
and retryable. No bulk migration guesses the reason for an archive.

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
Explicit tab close on the final draft returns to a fresh local draft. The desktop
close accelerator follows [window-close behavior](desktop-windows.md), including
window close for a lone conversation/draft, and the opt-in
[semantic targeting beta](semantic-action-targeting.md). File/tool panels retain
their existing close lifecycle.

## Compatibility and evidence

Older clients can read the additional metadata, but do not honor the new flag and
may still archive when closing. Clients predating orthogonal archive still hide an
archived workspace's tabs and unarchive when reopening one. Uniform behavior requires
updated clients. Any hosted metadata allowlist must preserve the field; private
backend compatibility cannot be established by this public repository alone.

Implementation owners: shared SessionMeta, components session actions, tab URL
resolution, SessionDetail, SessionTabBar and the responsive mobile tab sheet.
Tests cover close/reopen lifecycle isolation, archived-workspace tab visibility, the
Restore action for archived children of a live workspace, neighbour/empty selection,
and real LoroRepo replica convergence. Desktop E2E `LODY-SESSION-004` opens archived
Sessions by route and expects their opened-by provenance card. See [relations](session-relations.md) for archive targets.
