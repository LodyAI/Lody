# Nonblocking authentication recovery

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1872

[中文](2026-10-25-nonblocking-auth-recovery.zh.md)

## Abstract

Exhausted authentication recovery opened a global alert dialog even though
exhaustion does not prove that the session is invalid. Recovery now appears as a
persistent icon beside the existing sidebar workspace control, with details and
recovery actions opened by the user. No status row is added. The page retains focus and available operations, while
protected operations keep their existing authentication gates and bounded retry
policy. This first implementation has deterministic component/provider coverage
and Chromium acceptance screenshots; live credential expiry and visual approval
remain outside that evidence.

## Decision and ownership

[`AuthRecoveryErrorView`](../../../../packages/components/src/components/auth-recovery-error.tsx)
composes the existing Button and nonmodal Popover primitives with localized copy
and StyleX tokens. It does not open automatically, capture focus or add a backdrop.
Closing details leaves the status entry available; Escape returns focus to it.
A polite live region announces status changes. The panel may cover nearby content
only after the user opens it.

[`AuthRecoveryEntryProvider`](../../../../packages/components/src/components/auth-recovery-entry.tsx)
projects a 28px control with a 16px icon into `AuthRecoveryEntrySlot` beside the existing workspace
control in `LoroSidebar`: the desktop footer or mobile header. The composer and
footer keep their existing height, and healthy state has no icon. The entry follows
sidebar visibility. A stable ref context carries only slot registration, leaving
recovery state out of shell subscriptions. A
persistent entry keeps recovery actions discoverable; a transient toast would lose
them. Fixed viewport corners were rejected because nearby controls and sidebar
contents vary. This follows contextual status with details on demand, without
claiming to reproduce Linear's current implementation.

The entry uses the sidebar action geometry and a 4px gap when present. Offline,
reconnecting and warning glyphs crossfade with blur in one fixed icon slot;
reduced-motion preferences retain only the opacity transition.

Without a mounted sidebar slot, including pre-workspace surfaces,
a small floating entry remains above the bottom safe area. This fallback
retains access to recovery but is outside the desktop non-overlap evidence below.

The [`AuthenticatedConvexProvider`](../../../../packages/components/src/providers/authenticated-convex-provider.tsx)
continues to own scheduling and retry. It supplies recovering, exhausted and browser
offline presentation using its existing network observation, with no new scheduler. Explicit retry keeps the same surface mounted and updates its
status; successful recovery removes it. Session identity keys the surface so its
pending sign-in/error state cannot cross sessions. Sign-in uses the existing
sign-out action, disables duplicate actions while pending and contains rejection
with retryable inline feedback.

This partially replaces the dialog presentation in the
[bounded-recovery decision](../bug-fix/2026-10-10-bounded-auth-recovery.md).
Six attempts, per-attempt deadlines, session fencing, sustained-health budget reset,
protected-request gating and confirmed-rejection handling remain intact. Offline
transitions do not replenish exhausted attempts. The UI does not replay mutations,
clear local data, promise delivery or claim that exhaustion proves session expiry.
Cold-start admission and the local-only composition retain their existing behavior.
This React presentation change adds no Effect boundary or dependency migration.
The [behavior Spec](../../../../specs/auth-recovery.md) remains a draft.

## Evidence and limits

The owning component and provider suites pass 17 tests covering nonmodal mounting,
draft focus, sidebar-slot placement/removal, on-demand details, explicit retry,
pending/failed sign-in, offline and
recovering presentation, and the existing retry/deadline/session-fencing behavior.
Playwright 1.58.2 with installed Chrome verifies the 1440×900 English dark-mode
workspace: recovery arrival preserves input focus and continued typing; Escape
returns focus to the status trigger; composer and sidebar footer geometry are
unchanged. The icon is inside the footer without intersecting sibling actions or
the update button. Trial clicks confirm
existing Help, Archive, Settings, update, new-tab and Send controls remain reachable.
Before/after and on-demand-details screenshots use real `LoroSidebar`,
`SidebarUpdateBanner`, `WorkspaceCard`, session tabs, conversation stream, info bar
and composer with synthetic data. No live credentials or captured conversations
are used. Local preview requires an uncommitted compatibility shim for missing
subagent exports in reused ACP dependencies; it does not replace these UI components.

Scoped type-aware lint, repository formatting and i18n checks pass. Root `pnpm check`
stops at `packages/ignore` typechecking because its dependencies are unavailable.
Component-package typechecking is blocked by missing/mismatched reused dependencies
and workspace exports; it emits no diagnostics in the changed files. Documentation checking retains existing links
into unavailable ACP submodules. Neither check establishes a clean full-repository
build. Live auth expiry, physical-device keyboard/safe areas, and product-wide action
availability require separate verification; this change preserves their gates.
