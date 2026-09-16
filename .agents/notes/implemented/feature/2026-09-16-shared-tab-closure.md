# Shared conversation tab closure

Status: implemented
Translation: current

[中文](2026-09-16-shared-tab-closure.zh.md)

## Abstract

Main tabs could not close, while child closes archived or deleted conversations.
Tab visibility now uses shared `SessionMeta.isTabClosed`, without lifecycle cleanup.
The closed list also includes historical archives and reopening restores them.
Selection stays local and can explicitly resolve to an empty workspace surface.

## Decisions and evidence

Window-local closure was rejected: the workspace shares its open conversation set.
Only the flag is shared; selection and order retain their existing URL/local storage
owners. A confirmed close narrowly invalidates the current URL; missing metadata
never means closed. This extends the [routing contract](../../../docs/sessions-tabs-routing.md).

Archive remains a lifecycle operation, with the target rules in
[session relations](../../../../specs/session-relations.md). Legacy archives stay in
the unified closed list instead of being bulk rewritten. Reopen uses restoration
checks and retains independent child close flags. Running work and worktrees are
unaffected by new close writes.

The [Spec](../../../../specs/session-tab-closure.md) remains draft. Hook, tab, routing
and mobile tests plus components typechecking validate the implementation; replica
tests exercise the real LoroRepo metadata boundary. Mixed old/new clients cannot
provide uniform tab behavior. Private-host allowlists and end-to-end native app
behavior are not established by unit tests.
