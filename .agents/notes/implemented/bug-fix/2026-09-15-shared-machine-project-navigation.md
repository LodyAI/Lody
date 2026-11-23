# Local project rows follow visibility, not machine ownership

Status: implemented
Translation: current

[中文](2026-09-15-shared-machine-project-navigation.zh.md)

## Abstract

A local-project row in the sidebar only activated the chat landing when the hosting
machine belonged to the signed-in user, so a project on a machine a teammate shared
with the workspace rendered as an inert label with no new-chat button — while the
landing's own composer already offered that same machine and project to that same
user. The row's capability now follows project visibility instead of machine
ownership: every project the sidebar renders activates its machine and project on
the landing and offers a new chat. Removal stays owner-only, because it is dispatched
to the owning device. This widens no permission surface: the sidebar and the landing
read the same visible-project index, which admits only the user's own machines and
projects explicitly shared with the workspace.

## Decision and evidence

`buildVisibleLocalProjectIndex` is the single gate on which local projects a user may
see at all — an own-machine row, or a Convex access row for a project shared with the
team. `chat-landing.tsx` consumes that index directly for its machine and project
pickers, and biases the default selection towards an own-machine project only as a
preference, explicitly falling back to a shared one. The sidebar consumed the same
index but then re-gated navigation on `machine.ownerUserId === userId`, which made the
two surfaces disagree about the same project: the landing would accept it, the sidebar
would not offer to reach it.

Ownership still decides removal. A remote project is removed by queueing a request on
that device's machine Flock doc, which only its owner may do, so `canRemoveProject`
keeps the ownership test and the context menu keeps its owner-only Remove item.

`LocalProjectItem`'s `canNavigateProject` prop became true at every call site once the
gate was gone, so it was removed rather than left as a permanently satisfied
condition. Pending removal is now the only reason a project row is inert, which is why
that branch — `role`/`aria-disabled`, the cursor, and the hidden new-chat button —
still exists and is still exercised.

The alternative of gating on machine reachability instead of ownership was rejected:
an offline own-machine project already stays reachable in the sidebar, and the
landing, not the row, owns telling the user a machine cannot currently run anything.

## Validation

A new component suite renders a project row hosted on a teammate's machine and asserts
both halves of the contract: the row activates with its machine and project id, the
new-chat button appears and starts a fresh chat without doubling as a plain
activation, and a row with a pending removal stays inert with no new-chat button. The
existing `LocalProjectItem` suites and the package type check pass. Verification is at
component level; the sidebar's section assembly, where the ownership gate lived, has
no test harness of its own, so the guard against a reintroduced gate is the removal of
the prop that carried it rather than a test.
