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
open. The main Session's flag affects only its conversation tab, never its children,
sidebar row, running agent, pending work, terminal, or worktree. New close actions
only write this flag; even persisted empty conversations are not deleted.

The closed list includes `isTabClosed === true || isArchived === true`. This retains
historical child tabs whose close operation archived them. Reopening an archived
conversation runs the existing restoration checks and containment rules, then clears
the selected conversation's close flag. Root restoration includes direct children,
preserves their independent close flags, and excludes opened-by descendants. A failed
restore is visible and retryable. No bulk migration guesses the reason for an archive.

## Navigation and synchronization

Metadata uses the existing writer and CRDT synchronization. Disconnected writes
reconcile through that same field conflict policy. Background work never reopens tabs.
Reopening adds the tab everywhere but only selects it for the initiating viewer.
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
