# Multi-repository Project groups

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

- **Project group** (code type `WorkspaceProject`, called Project below): a workspace-level group of **Members**. Each Member is a Git
  repository: a GitHub repository, or a local project that is a Git repository.
  A local repository may have no remote; it then gets a branch and backups, but no
  PR. A local directory that is not a Git repository cannot be a Member; adding one
  prompts the user to run `git init` first. Non-Git directories are deferred
  until ACP `additionalDirectories` is widely supported.
- Members are deduplicated by **repository identity**: a GitHub repository (by
  numeric ID when known), or a local repository without a GitHub remote,
  identified by `(machineId, localProjectId)`. A repository added once as a local
  folder and once from GitHub, or added from two subdirectories of one monorepo,
  is a single Member.
- Each flattened Member has a directory name that is unique within the Project. It
  defaults to the repository name and the user can change it. A submodule Member's
  location is set by its submodule path.
- Existing single local projects and GitHub repositories stay as they are. Their
  existing conversations stay where they are, and do not move when the project
  joins a Project.
- There is no product limit on the number of Members.

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
their original nesting, and it does not use symbolic links.

Directory nesting other than submodules is flattened as well. A repository that
relies on a relative path such as `../lib` keeps working when the user gives that
Member its original directory name.

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
- It can be selected only together with its parent Member. If the user unticks the
  parent, its submodule Members are not materialized either.
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
creates a worktree and a new branch for each Member under the main directory.
All Members are included by default; a Member the user unticks when creating the
conversation is not fetched. Every Member is editable; there is no read-only mode.

- Each Member allocates its own branch under the existing rules. Branch names are
  not required to match across repositories.
- A conversation freezes its Member list at creation, so later Project edits
  affect only new conversations.
- A local Member must have a binding on the execution machine. A Member without
  one cannot be selected; Lody does not silently clone a copy instead. The
  open-source desktop runs in local-only mode, so it supports only local Members
  and observes their PRs with the machine's own credentials.
- Multi-Member conversations always use worktrees. Single-Member conversations
  keep today's behavior, including the mode that uses the original directory
  directly.

## PR association

- Each Member's branch, uncommitted/unpushed state and diff statistics are
  observed separately. PR discovery is keyed by
  `(repository, that Member's branch)`.
- `pullRequests` still stores every PR by URL. "Current PR" changes from "the
  last item of the whole array" to "the last item per repository", so a
  conversation can have several current PRs at once, at most one per repository.
- The Info Bar lists PRs and CI by repository. Create PR opens one PR for each
  Member that has changes, and links the PRs to each other in their bodies.
- PR auto-archive fires only after all current PRs reach an enabled terminal
  state, not when one of them does.
- Compatibility: `project`, `branchName` and `repoFullName` stay as a projection of
  the first Member for older clients. Only a daemon that advertises this protocol
  capability can create multi-Member conversations.

## Lifecycle

Archive makes a backup commit for each Member and removes its worktree, one Member
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
  and Agent Role catalogs. A local Member references only
  `(machineId, localProjectId)`; its path still lives only in that machine's Flock.
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
the main directory is the root `main`. Synced data identifies a file as
`(rootId, relativePath)`, and paths under the main directory keep today's plain
relative form. The machine boundary accepts absolute paths and maps them to a root
through a single resolver; a path under no root is rejected. Supporting local
directories outside the main directory later only adds roots and does not change
this format. Survey: [proposal note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.md#path-dependency-survey-preparing-for-local-directories).

## Evidence

These describe the current code, not an implementation of this Spec:

- Single binding: [`ProjectRef`](../packages/shared/src/project.ts) and
  [`SessionMeta`](../packages/shared/src/schema.ts).
- Single-branch PR discovery and "the current PR is the last item":
  [PR reconciler](../apps/cli/src/lib/pr-poller/AGENTS.md).
- [Branch observation](workspace-branch-state.md) and
  [local PR observation](local-github-pr-observation.md).
- Decision and alternatives: [proposal note](../.agents/notes/proposed/architecture/2026-10-16-multi-repo-projects.md).
