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
Editing walks the same questions with the project's current answers marked
"Previously selected"; the composer's project picker gained a "Create project"
entry and now ranks projects with several members by recent use.

## Decision

The user asked for a redesign of creation, not of editing, and for the composer
picker to offer creation beside Settings and the sidebar menu.

- `ProjectCreateWizard` is presentational. `ProjectGroupEditorDialog` still owns
  detection, direct folder preparation and saving, and renders the wizard for
  creating and for editing by the owner, so save, registration and automatic
  submodule detection are unchanged. Someone who may not change a project still
  sees it read-only in `ProjectGroupForm`.
- Editing starts at the first question. The scope a saved project implies (a
  folder's machine, or the machine holding a used copy, this machine first) is
  preselected, and every earlier answer and member carries a "Previously selected"
  badge. The review step lists members and their paths only; usage labels and the
  run-location line were removed as noise.
- Scope is wizard state, not stored data. `retainProjectGroupScope` removes members
  a scope cannot hold: folders on another machine, and for GitHub only every folder,
  including a picked folder whose remote made it portable (its registration would
  otherwise be written for a project that runs anywhere).
- With a machine chosen, its copies of GitHub repositories appear among its
  folders (`preferLocal`), and the GitHub tab lists every repository, ticked as a
  plain clone. Ticking one repository in both tabs is allowed and only noted: the
  project keeps one member, cloned from GitHub (the user chose GitHub to win). The
  wizard remembers the folder tick, so either tab can be unticked independently;
  unticking GitHub returns the member to the local copy. GitHub-only scope also turns
  copy-preferring members into plain clones.
- The GitHub tab lists only repositories the workspace's GitHub integration lists
  (`ProjectMemberSourceOption.onGithub`). A repository known only from a local
  folder's remote is offered as that folder; ticking it as a clone would need
  access the workspace does not have. A member already cloned from one keeps its
  row so it can be unticked.
- Lists show every row; search filters but nothing is held back for it. A records
  card clips its rows, so list cards opt out of flex shrinking; otherwise the
  GitHub-only list shrank to the dialog and could not scroll.
- A repository whose submodules cannot be read is no longer flagged: most have
  none, so the warning was noise.
- The answers are raised cards that press in, and progress is an ink fill in a
  recessed well, following the `@lody/ui` materials rather than flat outlines.
- "Next" and "Create" are separate keyed elements. Sharing one slot let React reuse
  the button, which became `type="submit"` during the click that advanced, so the
  browser submitted the form and created the project without its last step.
- A seeded request (sidebar "create from this project") starts at the member step
  with the scope inferred from the seed.
- The composer picker sorts by the newest conversation, but conversations started
  from a multi-member project (`projectRun.id`) were never counted, so such projects
  always sank below every used one. Landing recency now indexes them by id.
- The review step names the run location and how each member is used: edited in
  place, a local copy, or cloned per conversation.

Trade-off: the wizard has no controls for directory names or manual submodule
placement. Saved placements are kept and detection still nests new members; the
"cannot read submodules" hint, which pointed at those manual controls, no longer
appears for owners. Considered and not taken: adding a second machine-selection
protocol (the existing visible-machine list and `projectFolderSelection` gate are
sufficient).

Direct browsing now works on any online machine the user owns whose Lody supports
`projectFolderSelection`, not only the current one: the earlier note limited it to
this machine, but preparation, registration and the directory browser already go
through machine RPC by id, as Add folder does for remote machines. The browser opens
on the machine chosen in the wizard and offers only that machine, so a picked folder
cannot bind the project elsewhere. A daemon without `projectFolderSelection` (an
already released one) cannot inspect a folder without registering it, so for those
machines `pickProjectGroupFolder` registers the picked folder at once, hidden from
standalone lists as a save would, and adds it as that machine's folder; its GitHub
remote turns it into a repository member once the daemon publishes it. Cancelling
then leaves a hidden registration, which saves already tolerate. Newer daemons keep
the draft-until-save behavior. This supersedes the current-machine limit in the
[direct folder selection note](../architecture/2026-10-26-project-direct-folder-selection.md).

## Validation and limits

`tests/project-group-form.test.ts` covers scope retention and name suggestion.
`tests/e2e/project-create-wizard.spec.ts` drives the real component in Storybook:
choosing a machine, mixing tabs, changing machine (dropping its folder), switching
to GitHub only, removing a member on review, ticking one repository in both tabs,
that advancing to the last step does not create the project (this assertion fails
when the buttons are not keyed), and editing with marked answers.
`tests/chat-landing-derived.test.ts` covers recency by project id. Screenshots came from the same
stories with synthetic data; no end-to-end session was started from a created
Project, and the full `pnpm check` was not run.
