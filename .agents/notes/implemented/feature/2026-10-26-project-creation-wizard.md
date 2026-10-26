# Guided project creation

Status: implemented
Translation: current

[中文](2026-10-26-project-creation-wizard.zh.md)

## Abstract

Creating a multi-member Project used one editor whose picker mixed GitHub
repositories, local copies and machine-bound folders in a single list, so users
could not tell how the two kinds combine or where conversations would run. Creation
is now a short sequence of single questions: local folders or GitHub only, then the
machine, then the members, then the name and instructions. The run location is
decided before any member is chosen, and changing it drops what no longer fits.
Editing an existing Project keeps the previous editor; the composer's project
picker gained a "Create project" entry.

## Decision

The user asked for a redesign of creation, not of editing, and for the composer
picker to offer creation beside Settings and the sidebar menu.

- `ProjectCreateWizard` is presentational. `ProjectGroupEditorDialog` still owns
  detection, direct folder preparation and saving, and renders the wizard only in
  `add` mode, so save, registration and submodule behavior are unchanged.
- Scope is wizard state, not stored data. `retainProjectGroupScope` removes members
  a scope cannot hold: folders on another machine, and for GitHub only every folder,
  including a picked folder whose remote made it portable (its registration would
  otherwise be written for a project that runs anywhere).
- With a machine chosen, a repository it holds a copy of is listed only among that
  machine's folders, so no row appears in both tabs. Repository members keep the
  existing `preferLocal` semantics.
- A seeded request (sidebar "create from this project") starts at the member step
  with the scope inferred from the seed.
- The review step names the run location and how each member is used: edited in
  place, a local copy, or cloned per conversation.

Considered and not taken: replacing the editor for edits too (submodule placement
and directory naming need the full form) and adding a second machine-selection
protocol (the existing visible-machine list and `projectFolderSelection` gate are
sufficient). Direct browsing remains limited to the current machine, as before.

## Validation and limits

`tests/project-group-form.test.ts` covers scope retention and name suggestion.
`tests/e2e/project-create-wizard.spec.ts` drives the real component in Storybook:
choosing a machine, mixing tabs, changing machine (dropping its folder), switching
to GitHub only, and removing a member on review. Screenshots came from the same
stories with synthetic data; no end-to-end session was started from a created
Project, and the full `pnpm check` was not run.
