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
- With a machine chosen, its copies of GitHub repositories appear among its
  folders (`preferLocal`), and the GitHub tab lists every repository, ticked as a
  plain clone. Ticking one repository in both tabs is allowed and only noted: the
  project keeps one member, using the folder. The wizard remembers the second tick,
  so either tab can be unticked independently. GitHub-only scope also turns
  copy-preferring members into plain clones.
- Lists show every row; search filters but nothing is held back for it.
- The answers are raised cards that press in, and progress is an ink fill in a
  recessed well, following the `@lody/ui` materials rather than flat outlines.
- "Next" and "Create" are separate keyed elements. Sharing one slot let React reuse
  the button, which became `type="submit"` during the click that advanced, so the
  browser submitted the form and created the project without its last step.
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
to GitHub only, removing a member on review, ticking one repository in both tabs,
and that advancing to the last step does not create the project (this assertion
fails when the buttons are not keyed). Screenshots came from the same
stories with synthetic data; no end-to-end session was started from a created
Project, and the full `pnpm check` was not run.
