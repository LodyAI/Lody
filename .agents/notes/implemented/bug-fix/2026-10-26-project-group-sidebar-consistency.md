# Project groups follow single-project sidebar rules

Status: implemented
Translation: current

[中文](2026-10-26-project-group-sidebar-consistency.zh.md)

## Abstract

A Windows report showed a GitHub-side multi-member project staying in the sidebar
after all its conversations were archived, offering no delete, and, once deleted in
Settings, reappearing with a collapse button that did nothing when a conversation was
restored. Project groups were listed from their definitions rather than their
conversations, had no removal action, and a deleted group's header hard-coded
`collapsed: false`. Each group now follows the project beside it: with the GitHub
repositories it is listed while it has conversations; under a machine it stays like a
folder; its creator can remove it from the menu; a deleted group's header folds.

## Decision and evidence

The user asked that multi-member projects behave like single projects where
possible. Repository groups in `buildGroups` only exist while they have
conversations, and folder rows under a machine stay listed and offer "Remove project".

- `placeProjectGroups` drops GitHub-side states without conversations. A deleted
  project's restored conversations still show under its snapshot name, as a
  disconnected repository's do; that header now carries real collapse state.
- The header menu adds "Remove project" for the creator (`canManageWorkspaceProject`),
  reusing the existing delete request and its confirmation. Deletion keeps its
  conversations, as before.
- Not changed: a group bound to a machine still shows while idle, and a new
  GitHub-only project appears in the sidebar after its first conversation, like a
  newly connected repository; the composer picker lists it immediately.

## Validation

`sidebar-navigation-model.test.ts` drives the real placement and list model: idle
GitHub-side groups are hidden, machine groups stay, and a folded deleted group hides
its rows; it fails with either fix reverted. `project-group-launch.test.ts` was
updated for the new rule. The Playwright story check confirms the creator sees
"Remove project" and a teammate does not. Not reproduced on Windows itself.
