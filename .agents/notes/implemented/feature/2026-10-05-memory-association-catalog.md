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
