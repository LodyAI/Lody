# Machine memory association catalog

Status: implemented
Translation: current

[中文](2026-10-05-memory-association-catalog.zh.md)

## Abstract

Listing every external memory identity in Settings made provider inventory and
Lody configuration indistinguishable. Lody now persists explicit machine-scoped
associations in the existing Loro/Flock document and uses Agent Config's catalog
and editor layout. Users can create-and-link or select an existing identity;
editing and deletion affect Lody metadata only. Provider disappearance produces
a warning without deleting the association or rewriting frozen execution inputs.

## Decision and boundaries

This extends the [initial provider integration](2026-10-04-agent-role-memory.md)
with a separate association catalog, replacing its direct-inventory picker.
The [Spec](../../../../specs/agent-role-memory.md) remains draft.
Rows use stable provider/identity keys, validate their machine scope and flow through
the existing workspace writer. Local durability determines success; upload failure
does not reverse it. Put-if-absent preserves custom names on repeat linking, and
editing cannot recreate a concurrently removed association.

The alternative of continuing to display all provider identities cannot represent
the user's explicit Lody selection. No bulk migration imports identities.
Roles retain their provider/identity references, including when an association is
removed, so catalog maintenance cannot silently change execution. Provider-side
rename/delete commands are deliberately outside association editing.

The editor retains an enrolled identity when local saving fails, so retry only
links it. Background refresh preserves form state, skips outstanding requests and
is fenced by machine/provider generation. Only a successful authoritative list
proves an identity missing; transport failure does not. Ready inventories refresh
on entry, focus and a visible-page interval.

## UI and evidence

The provider rail, create/link tabs, settings surfaces and machine selectors reuse
existing UI primitives. Cards expose hover/focus edit/delete, name then grayscale
logo, and second-line description. The supplied
[Nowledge logo](https://github.com/user-attachments/assets/249e8b3e-54a2-49eb-b28a-07c2cfaf2236)
is stored locally and rendered with a grayscale filter.

Behavioral tests cover enrollment/link retry, metadata editing/unlinking, Role
selection, missing-vs-unreachable states, native Flock writes and machine isolation,
and refresh while enrollment is pending. Storybook was inspected in Chrome for
the two-pane editor and association cards. No personal provider identity was
created for validation; the full Electron settings window was not exercised.

Implementation: [PR #1246](https://github.com/LodyAI/Lody/pull/1246).

## Editor refinement

User feedback identified pane-relative centering as the cause of the offset dialog.
The editor now matches Agent Config's window centering and desktop dimensions.
Name precedes ID on one row, with lowercase automatic ID until a manual override.
Space stays hidden; enrollment explicitly attributes source-app to lody.ai.
Provider profile details travel only in the inventory response and appear read-only
after selection; they do not broaden persisted association metadata.

Follow-up feedback makes Name mandatory (trimmed, non-empty) and removes the
expanded profile view. Selection now keeps only name and description; the unused
profile-detail RPC payload and adapter parsing are removed.

## Role association navigation

The Role editor now separates Configuration and Memory into tabs sharing its
existing draft and save boundary. Memory uses the same selectable catalog cards;
switching the Role's machine still clears the binding. Unassigned imports offer
a machine-scoped Role-settings shortcut before edit/delete. Assignment detection
uses the shared accessible Role catalog and waits for its loaded state; navigation
does not auto-bind or save. Role settings retain all machine groups without machine tabs or filtering; the
shortcut scrolls to the target group and preselects the machine for creation. No tests were run for this UI
follow-up at the user's request; component typechecking was used.

Assigned rows now expose their accessible Role emojis and names through desktop
tooltips or mobile tap popovers. This reuses the same exact-machine binding lookup
as the unassigned shortcut, without revealing private inaccessible Roles.

## Redundancy ablation (2026-10-06)

The cleanup keeps the existing provider and persistence contracts. Remove the
unused hook refresh method (the page uses its refresh token), an unused style,
and the duplicate editor association-save branch. Create, import and edit now
converge on one save; schema validation remains at the association writer boundary.
Enrollment results still survive a local-save failure so retry does not enroll again.
A byte-identical 61-line Flock test copy was also removed; its original remains.

Baseline: 10 UI/refresh tests and 12 writer tests passed. Removing the unused API
and style preserved the 10 tests and component typechecking. Consolidating the
save path preserved all 22 tests. Removing the duplicate left 11 writer tests
passing. As a negative control, temporarily removing the pending-request guard
made the background-refresh enrollment test fail: creation returned undefined
instead of its new identity. The guard was restored, not included in the cleanup.
The final retained changes passed 21 scoped tests, root typecheck, check:quick,
format and docs check. These are deterministic behavioral checks, not an Electron
visual or performance benchmark. The cleanup does not claim that all remaining code is indispensable.
