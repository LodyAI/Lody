# Multi-repository projects

Status: draft
Translation: current

[中文](multi-repo-projects.zh.md)

## Scenario

Alice's product has the local folders `web` (remote `acme/web`) and `api` (remote
`acme/api`), plus `proto` (`acme/proto`), a submodule inside `api`. She is building
an "export report" feature that needs changes in all three repositories within one
conversation. She expects to end up with three linked PRs and to see their status
and CI from that conversation.

Today a conversation binds exactly one local project or one GitHub repository
(`ProjectRef`). It has one execution directory and one branch, and PR discovery
looks only at that branch.

## Concepts

- **Multi-repository project** (code type `WorkspaceProject`, called Project below): a workspace-level project made of **Members**. The UI has no separate concept for it: it is a project like a single folder or repository, only with several Members, and shares the project rows, menus and pickers. A Member can be
  a GitHub repository, a local Git repository (which may have no remote; it then
  gets a branch and backups, but no PR), or a local non-Git directory. A non-Git
  directory has no branch, backups or PR, and the conversation edits the original
  directory; see Member access.
- Members are deduplicated by **repository identity**: a GitHub repository (by
  numeric ID when known), or a local repository without a GitHub remote,
  identified by `(machineId, localProjectId)`. A repository added once as a local
  folder and once from GitHub, or added from two subdirectories of one monorepo,
  is a single Member.
- A Member is either a **repository Member** or a **machine-bound Member**. A local
  folder whose GitHub remote is known joins as a repository Member: it records the
  repository, not the machine, so the same Project runs on any machine. Only a
  local repository without a GitHub remote and a non-Git directory are
  machine-bound. All machine-bound Members of one Project are on one machine, and
  that machine is the Project's only execution machine; a Project without
  machine-bound Members can run on any machine.
- Each flattened Member has a directory name that is unique within the Project. It
  defaults to the repository name and the user can change it. A submodule Member's
  location is set by its submodule path.
- Existing single local projects and GitHub repositories stay as they are. Their
  existing conversations stay where they are, and do not move when the project
  joins a Project.
- There is no product limit on the number of Members.
- **Where it appears.** A Project with a machine-bound Member is listed under that
  machine, with the machine's folders. A Project without one runs anywhere and is
  listed with the GitHub repositories. This applies to the sidebar and to
  Settings › Projects.
- **Creating and editing.** Settings › Projects offers "Several repositories or
  folders" beside adding a folder or a GitHub repository. A project row's context
  menu offers "Edit project…": on a multi-repository Project it edits it; on a
  single folder or GitHub repository it opens the same editor seeded with it, which
  saves a new Project and leaves the original and its conversations as they are.
  On a phone the same action is the first row of a project's settings tab, and
  mobile Settings › Projects offers creating one. The composer's project picker
  also offers "Create project". Creation is a guided sequence of single questions,
  so folders and repositories are never mixed before the user has chosen where the
  project runs: first whether it includes local folders or only GitHub repositories;
  for local folders, which machine; then the folders on that machine (including
  direct selection) beside a separate tab of GitHub repositories, or for GitHub only,
  the repositories; finally the name, the selected Members and the instructions.
  Changing an earlier answer drops Members the new answer cannot hold. Editing an
  existing Project keeps the single editor, whose picker supports direct
  local-folder selection as well as repositories and folders already known to the
  workspace.

## Direct folder selection and standalone visibility

A user can create a Project by selecting local folders without first adding each
one as a standalone project. “Select local folders” is the primary local entry;
adding existing projects or repositories remains available. Show the selected
paths and whether members modify originals or use Git isolation before saving.

**Separate registration from display.** A directory registration records a
machine-local identity and path; a Project references it. Standalone visibility
controls whether that directory also appears as its own entry in the sidebar,
Settings › Projects and standalone project selection. It is not a second project
copy or an access-control boundary. Members remain visible inside their Project.
Existing standalone entries remain visible; adding them as members never hides
them. Absolute paths remain in the machine directory catalog.

**Save and reuse.** Selection is a draft: cancelling before save creates no
registrations. Saving validates the folders, reuses existing registrations and
registers missing ones without standalone visibility. Within the same workspace
and machine, the same canonical directory has one registration, regardless of
its display name. Different clones or machines have separate registrations;
repository-member deduplication still follows the rules above. A partial save
failure is reported and can be retried using registrations already created; it
must not publish an incomplete Project or delete shared registrations.

**Adding the same folder later.** Explicitly adding a registered folder as a
standalone project enables its standalone visibility and reuses its identity.
If already visible, locate that entry. For example, adding `backend` through a
multi-folder Project and later adding it alone yields one registration with two
entry points. Neither action moves or merges conversations or changes membership.

**Deletion.** Use the existing Settings › Projects “Delete project” action, without
an extra confirmation or a separate “Remove from list” feature. The owning daemon
checks Project members and existing multi-repository conversation snapshots. If
referenced, it cancels standalone display while preserving the registration and
conversations; otherwise it follows the existing local-project deletion flow.
These dependencies stay internal. No action deletes the original directory.
Removing a member or deleting a Project changes its definition only; automatic
cleanup of unused hidden registrations is outside this change. Explicitly adding
a retained directory restores its existing identity and standalone entry.

**Preserve execution semantics.** Direct selection does not introduce exact-copy
binding: known GitHub-backed folders still become portable repository members;
other members retain the existing machine constraint. Explain this distinction
in the editor. Ordinary folders modify originals without worktree isolation;
selecting a repository subdirectory does not promise independent Git isolation.
No new CLI/MCP interface, automatic directory relocation, or permission model is
included. Legacy registrations default to standalone-visible for compatibility.

## Flat layout

A conversation has a main directory, and every Member except submodule Members
sits directly under it:

```text
<data>/repos/project-<name>-<projectId>/
  worktrees/<sessionId>/   ← main directory
    web/       ← worktree of acme/web
    api/       ← worktree of acme/api
      proto/   ← acme/proto, checked out as a submodule of api
```

This follows the existing `<data>/repos/<repo>/worktrees/<session>` structure.
`<name>` is the Project name converted into a safe path segment, used only to make
the directory recognizable. The directory is identified by `projectId`, so renaming
a Project does not move it. The main directory is the agent provider's execution
directory. It is also the root for terminals, file search and previews. The main
directory is not itself a Git repository. Each Member's Git data stays in its own
repository: in `<data>/repos/<repo>/bare.git` for a GitHub Member, and in the
original repository's `.git` for a local Member. Lody does not arrange Members by
their original nesting. Git Members do not use symbolic links; non-Git Members follow the access rules below.

Directory nesting other than submodules is flattened as well. A repository that
relies on a relative path such as `../lib` keeps working when the user gives that
Member its original directory name.

## Member access

When it materializes a conversation, the daemon decides how each Member enters the
agent's working scope, from the Member's kind and this conversation's provider
capabilities, and records the result in the snapshot's runtime fields:

| Member                                                             | Access                                                                                                                                   |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub repository                                                  | A worktree under the main directory                                                                                                      |
| Local Git repository                                               | A worktree under the main directory                                                                                                      |
| Local non-Git directory, provider declares `additionalDirectories` | The original directory's real path is passed to the provider as an additional directory; nothing is placed in the main directory         |
| Local non-Git directory, provider does not                         | A symbolic link named after the Member's directory, under the main directory, pointing at the original directory (a junction on Windows) |

- ACP sessions started later (resume, provider change) decide again: when
  additional directories are unavailable the link is created, and when they are
  available the link is no longer relied on.
- Non-Git Members are not isolated: conversations using the same directory edit
  the same files. The UI says so wherever such a Member is chosen or used. It has
  no branch, backup commit or PR.
- Additional directories and link targets are resolved only from the machine's
  local project registry (`localProjectId` → path). Paths supplied by the agent
  and link targets read from disk are never trusted; if the agent changes a link,
  the daemon recreates it from the registry.
- Archive cleanup removes only the link itself and never recurses into its target:
  it removes every Member link, confirms no symbolic link remains in the main
  directory, and only then deletes the main directory. Non-Git Members take no
  part in backup commits.
- A non-Git Member can only be top-level, never a submodule.

## Submodule Members

When a Project is created, Lody reads each Member's `.gitmodules` (without
changing anything), matches submodule URLs against the other Members and against
repositories about to be added. Relationships it can detect are set
automatically and shown in the UI as "`proto` is the submodule `proto/` of
`api`". The user can remove one, or set a relationship by hand when detection
cannot find it. Once set, the Member is a **submodule Member**:

- It is not fetched on its own and is not flattened into the main directory.
  After the parent Member's worktree is created, Lody runs
  `git submodule update --init --recursive`, and the submodule Member appears at
  the parent's submodule path, for example `api/proto/`.
- A submodule is checked out at a detached HEAD. Lody then creates the task branch
  at that path, starting from the commit recorded in the parent repository. The
  base is the gitlink commit, not the child repository's default branch.
- It is still a full Member: its branch and state are observed separately, and its
  PRs are discovered separately. Lody keeps the relationship mainly so that PRs
  are linked correctly. Create PR opens the submodule's PR first, then the parent's
  PR that updates the pointer, and links the child PR from the parent PR.
  Merge-order guidance puts the submodule first.
- It is always materialized with its parent; the parent's worktree checks out
  every submodule it declares anyway.
- Creating a conversation checks that the path is still a submodule pointing to the
  same repository in the parent's base commit. A mismatch is reported to the user;
  Lody does not silently flatten the Member instead.
- Submodules that are not Members are also initialized by `--recursive`. They can
  be edited, but they are not observed and produce no PRs.

## Project instructions

When creating or editing a Project, the user can fill in optional instructions
that are passed to the agent. The input's placeholder guides the user to describe
what each repository does and how they relate, for example: "web is the Next.js
frontend; api is the Go backend that serves the REST API; proto holds the
interface definitions both share, so change proto first when an interface
changes."

The first turn of a new conversation receives two pieces of context: the Member
list Lody generates (paths, repositories, branches, submodule relationships), and
these instructions. The instructions are frozen with the Member snapshot, so later
Project edits affect only new conversations. Like an Agent Role's prompt prefix,
they are ordinary configuration shared within the workspace and must not hold
secrets.

## Creation and materialization

Defining a Project only writes the definition. It does not clone, fetch, or create
worktrees. When a conversation is created, the daemon on the execution machine
creates a worktree and a new branch for each Git Member under the main directory; non-Git Members follow the access rules above.
A conversation always gets every Member, exactly as the Project defines them;
there is no per-conversation selection. A different set of repositories belongs in
the Project's settings (or another Project). Every Member is editable; there is no
read-only mode.

- Each Member allocates its own branch under the existing rules. Branch names are
  not required to match across repositories.
- A conversation freezes its Member list at creation, so later Project edits
  affect only new conversations.
- A machine-bound Member must have a binding on the execution machine; Lody never
  clones a copy in its place.
- A repository Member uses a local copy when the execution machine has one: a local
  project there whose GitHub remote is that repository. Its worktree is created
  from that copy with the machine's own Git credentials, as for a local Member.
  Without a local copy, a managed deployment clones the repository like a GitHub
  Member. The open-source desktop runs in local-only mode and never clones, so a
  Project with a repository Member the machine has no copy of cannot start there;
  the picker shows it as unavailable on that machine and says why. Repository Members observe their PRs with the same
  credentials that created their worktree.
- Choosing where to run comes first, as for single projects: the new-conversation
  picker lists the Projects that can run on the selected machine. A Project whose
  machine-bound Members are on another machine is not listed there, so choosing a
  Project in that picker never switches the machine. For each listed Project the picker says which
  repository Members the selected machine lacks.
- In multi-Member conversations Git Members always use worktrees, and non-Git
  Members follow Member access. Single-Member conversations keep today's behavior,
  including the mode that uses the original directory directly.

## PR association

- Each Member's branch, uncommitted/unpushed state and diff statistics are
  observed separately. PR discovery is keyed by
  `(repository, that Member's branch)`.
- `pullRequests` still stores every PR by URL. "Current PR" changes from "the
  last item of the whole array" to "the last item per repository", so a
  conversation can have several current PRs at once, at most one per repository.
- The Info Bar's Repositories panel lists every Member, nested by placement, with
  its branch and current PR/CI. Selecting a Member makes the context stage and PR
  tab describe that Member's repository, branch, diff and PR; without a
  selection, the first Member's projection remains the default. A Member with no
  GitHub remote shows no repository or PR rather than another Member's.
  Create PR opens one PR for each Member that has changes, and links the PRs to
  each other in their bodies.
- PR auto-archive fires only after all current PRs reach an enabled terminal
  state, not when one of them does.
- Compatibility: `project`, `branchName` and `repoFullName` stay as a projection of
  the first Member for older clients. Only a daemon that advertises this protocol
  capability can create multi-Member conversations.
  A Project with repository Members starts only on a daemon that advertises the
  repository-Member capability; an older daemon would treat such a Member as a
  plain GitHub clone.

## Lifecycle

Archive makes a backup commit for each Git Member and removes its worktree, one Member
at a time. The main directory is deleted only after every Member succeeds.
Submodule Members are processed before their parents. Lody first makes the backup
commit in the submodule and saves its task branch to a durable location for that
repository: `<data>/repos/<repo>/bare.git` for a GitHub Member, or the original
repository for a local Member. This is needed because the submodule's Git data
lives in the parent worktree's administrative directory and is deleted with it.
The parent Member's backup commit then records the submodule's pointer after its
backup. Restore fetches the submodule branch back from the durable location. If any
Member cannot be resolved or its backup fails, the whole main directory is kept and
retried later. Branches are never deleted. Restore rebuilds the main directory
from the frozen Member list and each Member's own branch. Child Tabs share the
root conversation's main directory. Otherwise the
[Session worktree lifecycle](session-worktree-lifecycle.md) rules apply, with the
GC scope extended to `<data>/repos/project-*/worktrees/<session>`.

## Data ownership

- A Project definition is a row in the workspace Flock document, alongside the MCP
  and Agent Role catalogs. A machine-bound Member references only
  `(machineId, localProjectId)`; its path still lives only in that machine's Flock.
- Each machine publishes the GitHub repository of each of its local projects
  beside the project in its own Flock, observed from the folder's remote by the
  owning daemon. Clients use it to merge one repository's copies into one entry and
  to show which machines can run a Project. It names a repository, never a path,
  and only the owning daemon writes it.
- A Project saved before repository Members existed keeps its local Members as
  they are. When the editor saves it again, a local Member whose machine publishes
  a GitHub remote becomes a repository Member, keeping its ID, directory and
  submodule placement.
- Conversation metadata keeps the Member snapshot frozen at creation, including
  the Project name and the main directory name. Deleting or editing a Project does
  not affect existing conversations; after a Project is deleted, its conversations
  are still grouped and restored from the snapshot.
- `projectRun` remains one top-level SessionMeta value. Clients write only the
  initial snapshot at conversation creation. Afterwards, only the owning daemon
  writes it, including observations, member additions and legacy projections.
  Read-modify-write operations are serialized per conversation through the branch
  observation owner queue. A future second writer requires a separate row per member.
- The main directory name is fixed at creation and written to conversation
  metadata. It does not change when the Project is renamed.
- The legacy fields `project`, `branchName`, `repoFullName` and `isWorktree` are a
  projection of the first Member. `workspaceDirty` and `workspaceUnpushed` are the
  OR across all Members, and `diffStats` is their sum, so the commit-and-push
  prompt keeps working in older clients.
- Submodule relationships are part of the Project definition, confirmed by the
  user, and frozen in the conversation snapshot.
- Which Member a PR belongs to is derived from the repository in the PR URL and is
  not stored separately. A repository is at most one Member of a Project, so the
  derivation is unique.

The draft format is in the [proposal note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.md#data-format).

## ACP project association

The existing `worktreeProject.originProjectPath` is the original root directory of
a local project. Providers use it to group several worktree conversations of one
project under a single native project. It grants no directory access and does not
change `cwd`. A multi-Member conversation sends the Project directory
`<data>/repos/project-<slug>-<projectId>`, so all conversations of one Project
fall under one native project, while `cwd` remains each conversation's own main
directory.

## File paths

Synced data contains no absolute host paths. A conversation's list of file roots,
`{ id, absolutePath }`, is kept only on the machine that owns the conversation;
the main directory is the root `main`, and each Member accessed as an additional
directory or a link is a root `member:<memberId>`. Synced data identifies a file
as `(rootId, relativePath)`, and paths under the main directory keep today's
plain relative form. The machine boundary accepts absolute paths and maps them to
a root through a single resolver; a path under no root is rejected.

Every root gets the same file capabilities in Lody as the main directory:

- File preview (including remote viewing), opening for edit, saving and LSP are
  authorized against the list of roots. Authorization resolves the real path
  first and then checks that it lies in a registered root, so a path that escapes
  a root through a symbolic link is still rejected. Only a file outside every
  root is `external` (read-only); same-machine Electron's read-only preview of any
  path is unchanged.
- The file tree, All Changes and `@` file search cover every root, grouped by
  root; each root is scanned and watched separately. Non-Git roots keep the
  existing non-Git scanning and snapshot approach.
- Turn diffs, agent output files and attachment source paths are recorded per
  root, so edits in additional directories are not dropped.
- Remote clients request files by `rootId` and relative path, never by absolute
  host path. Survey: [proposal note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.md#path-dependency-survey-preparing-for-local-directories).

## Evidence

Direct folder selection and standalone visibility are implemented in this change.
Registration reuse is in
[local-project-import](../packages/components/src/lib/local-project-import.ts);
[research and trade-offs](../.agents/notes/implemented/architecture/2026-10-26-project-direct-folder-selection.md)
record the behavior, validation and remaining limits. The broader Spec remains a draft.

These describe the current code, not an implementation of this Spec:

- Single binding: [`ProjectRef`](../packages/shared/src/project.ts) and
  [`SessionMeta`](../packages/shared/src/schema.ts).
- Single-branch PR discovery and "the current PR is the last item":
  [PR reconciler](../apps/cli/src/lib/pr-poller/AGENTS.md).
- [Branch observation](workspace-branch-state.md) and
  [local PR observation](local-github-pr-observation.md).
- Places that recognize only one root today: [preview path policy](../packages/shared/src/node/file-preview-path-policy.ts),
  [Code Collab path resolution](../apps/cli/src/lib/code-collab/code-collab-v2-service.ts),
  [turn diff path normalization](../apps/cli/src/lib/code-collab/code-collab-v2-diff-evidence.ts).
- Decision and alternatives: [proposal note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.md).

Creation snapshots use `HEAD` for unspecified root bases and `gitlink` for submodule bases;
the owner daemon resolves root placeholders to base refs and submodule placeholders to commits during materialization. Deselecting a parent
also deselects all its descendants. Local submodule probing is read-only and returns no
absolute host paths; machine-local URLs are redacted.

Non-main sync file keys use a NUL-prefixed encoding that cannot collide with real filenames. File RPC uses optional rootId, defaulting to main. See the Note’s multi-root file contract for encoding details.
