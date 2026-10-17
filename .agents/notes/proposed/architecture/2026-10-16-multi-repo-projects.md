# Multi-repository Projects: flat under one main directory

Status: proposed
Type: architecture
Translation: current

[中文](2026-10-16-multi-repo-projects.zh.md)

## Abstract

A feature often spans a frontend, a backend and their dependencies, and ends with
several PRs. A Lody conversation, however, binds one repository: one execution
directory, one branch, and PR discovery for that repository only. This proposal
adds workspace-level Projects. When a conversation is created, each Member gets an
editable worktree placed directly under one main directory, and that main
directory is the agent's execution directory. PR discovery and the meaning of
"current PR" become per-repository. This design simplifies the original
nested-layout proposal after review. The cost is that original nesting, such as
submodules and relative paths inside dependency folders, is no longer kept on
disk; the agent is only told about it. Nothing is implemented yet. Still
unverified: agent sandbox scope, `SessionMeta` size, and how older clients display
these conversations. The intended contract is in the
[draft Spec](../../../../specs/multi-repo-projects.md).

## Problem and requirements

- One conversation must change several repositories and track all of their PRs.
- Adding a Project fetches nothing; content is fetched only when a conversation
  starts.
- The product owner asked for the simplest model: every Member sits directly under
  the main directory, and every Member is editable.

## Where the code assumes one repository

- `ProjectRef` has only `github | local` variants, and each conversation has one
  (`packages/shared/src/project.ts`). `session/create` also carries a single
  `project`.
- `branchName`, `repoFullName`, `isWorktree`, `workspaceDirty`,
  `workspaceUnpushed` and `diffStats` in `SessionMeta` are all single values.
- `pullRequests` is already an array of URLs, and `pullRequestState` is keyed by
  URL. The PR reconciler, however, discovers by `(repo, branchName)` and defines
  "current PR = last item". UI code such as `session-tasklist-mapping.ts` and
  `archive-view.tsx` also reads the last item directly.
- Worktree GC covers `<data>/repos/<repo>/worktrees/<session>`: one directory per
  conversation.

## Decisions

1. **Flat.** The main directory is
   `<data>/repos/project-<name>-<projectId>/worktrees/<sessionId>`. This follows
   the existing `repos/<repo>/worktrees/<session>` structure, and the directory is
   identified by `projectId`. Each Member's worktree goes in
   `<main directory>/<directory name>`. The main directory is the agent's cwd, is
   not itself a Git repository, and uses no symbolic links.
2. **Every Member is editable.** Each Member has its own branch and may produce a
   PR. There is no read-only mode.
3. **Deduplicate by repository identity.** A repository added more than once is a
   single Member.
4. **Each Member allocates its own branch.** This follows the existing rule: a
   new branch from the base ref, with a suffix on collision. Repositories are not
   required to share a name, because when the name is already taken in one
   repository, renaming every repository together is hard to handle. PR discovery
   already works per `(repository, that Member's branch)` and does not depend on
   matching names. The conversation itself, and the links between the PR bodies,
   show that the PRs belong to one feature. The first-task branch-naming prompt
   applies to each Member separately.
5. **A conversation freezes its Member list.** This follows the same rule as
   freezing a Role's configuration when its Operation is accepted.
6. **Git repositories only.** A local Member must be a Git repository, though it
   may have no remote. Its worktree is created from the original repository, the
   same way as today's local-project worktree mode. A non-Git directory is
   rejected when the user tries to add it.
7. **Existing conversations do not move.** Single-project conversations stay where
   they are.
8. **No limit on the number of Members.** Metadata size, PR polling batches and
   materialization time can each be handled on their own. Member state is stored
   compactly. PR polling targets over the batch budget wait for the next batch,
   which the reconciler already does. Materialization time only affects startup.
   None of these needs a product limit.
9. **Submodule relationships are detected automatically when the Project is
   created.** Lody matches `.gitmodules` URLs and sets every relationship it
   detects. The user can remove one, or set one by hand when detection cannot find
   it. A submodule Member is not fetched on its own.
   It is checked out by `git submodule update --init --recursive` in the parent's
   worktree, and its task branch starts from the gitlink commit. The relationship is
   kept mainly for PR association: the submodule's PR is opened first, then the
   parent's PR that updates the pointer, and the parent PR links the child PR.
10. **Submodule branches are saved separately.** A submodule's Git data lives in
    the parent worktree's administrative directory and is deleted when the parent
    worktree is removed. Archive therefore makes the backup commit in the
    submodule and saves the task branch to a durable location for that repository
    before processing the parent; restore fetches it back. Also,
    `git worktree remove` refuses to remove a worktree that contains initialized
    submodules, so the submodules must be deinitialized once the backup is
    confirmed.

## Data format

This is a draft. Field names may change during implementation, but ownership and
merge semantics must not.

**Project definition**: the workspace Flock row `['project', ProjectId]`.

```ts
type ProjectId = string & { __brand: 'ProjectId' }; // UUID
type ProjectMemberId = string & { __brand: 'ProjectMemberId' }; // short ID, unique within the Project

type WorkspaceProject = {
  v: 1;
  id: ProjectId;
  name: string;
  /** Optional Project instructions, passed to the first turn of a new conversation. No length limit, like a Role's promptPrefix. */
  instructions?: string;
  ownerUserId: string;
  createdAtMs: number;
  /** Increments when content changes, following the Agent Role revision rule. */
  revision: number;
  /** Array order is display order; the first Member backs the legacy projection. */
  members: ProjectMember[];
};

type ProjectMember = {
  id: ProjectMemberId;
  source: ProjectMemberSource;
  placement: ProjectMemberPlacement;
};

type ProjectMemberPlacement =
  /** Directly under the main directory; dir is one safe path segment, unique within the Project. */
  | { kind: 'root'; dir: string }
  /** A submodule of the parent Member; path is the .gitmodules path the user confirmed. May nest. */
  | { kind: 'submodule'; parent: ProjectMemberId; path: string };

type ProjectMemberSource =
  | { kind: 'github'; repoFullName: string; repoId?: number; baseBranch?: string }
  | { kind: 'local'; machineId: MachineId; localProjectId: LocalProjectId; baseBranch?: string };
```

Deduplication identity: `repoId` for a GitHub Member (lower-cased `repoFullName`
when unknown); for a local Member with a GitHub remote, the GitHub identity of
that remote; for a local Member without one, `(machineId, localProjectId)`.
Deleting a Project deletes this row.

**Conversation metadata**: `SessionMeta` gains one optional field, present only on
multi-Member conversations.

```ts
type SessionProjectRun = {
  id: ProjectId;
  /** Project name at creation; still used for grouping after the Project is deleted. */
  name: string;
  /** Project instructions frozen at creation. */
  instructions?: string;
  /** Name of the main directory's parent under `repos/`, e.g. `project-acme-shop-<id>`; fixed at creation. */
  root: string;
  /** A Loro map keyed by Member ID, so writes for different Members do not conflict. */
  members: Record<ProjectMemberId, SessionProjectMember>;
};

type SessionProjectMember = {
  /** Display order. */
  o: number;
  /** Frozen snapshot: source and placement. */
  src: ProjectMemberSource;
  placement: ProjectMemberPlacement;
  /** Actual path relative to the main directory, e.g. `api/proto`, derived from placement and fixed. */
  path: string;
  /** Base resolved at creation: the base ref for an ordinary Member, the gitlink commit for a submodule Member. */
  base: string;
  /** Runtime observations below, written by the machine that owns the conversation. */
  branch?: string; // last observed named branch
  dirty?: boolean;
  unpushed?: boolean;
  diff?: LineChange;
};

// SessionMeta gains: projectRun?: SessionProjectRun;
```

`pullRequests` and `pullRequestState` are unchanged. A repository's current PR is
the last item in `pullRequests` for that repository. PR reconciler discovery
targets change from `(session, repo, branch)` to
`(session, memberId, repo, branch)`; status targets stay keyed by PR URL.

**Protocol**: `session/create` gains an optional `projectRun`, holding the Member
list (`id`, `dir`, `src`, `base`) that the client froze from the Project row when
the request was accepted. This follows the same approach as freezing a Role's
configuration when its Operation is accepted; the daemon never reads the mutable
Project row back. Clients send this field only after the daemon advertises
`multiRepoProject: 1` in `protocolCapabilities`. Adding a Member mid-conversation
uses a separate request, and the daemon writes the new Member into `members`
only after materializing it.

**Disk**: an ordinary Member is at `<data>/repos/<root>/worktrees/<sessionId>/<dir>/`;
a submodule Member is at its submodule path under the parent Member's path. The name part of
`<root>` is the Project name lower-cased, reduced to `[a-z0-9-]` and truncated to
32 characters, falling back to `project` when empty. Each Member's Git worktree is
registered in its own repository under the sessionId as the registration name. A
conversation has only one Member per repository, so the names cannot collide.

## Path dependency survey (preparing for local directories)

If local directories outside the main directory are supported later through
`additionalDirectories`, a conversation will have several file roots. Today every
file feature assumes a single session workspace root, and represents paths
relative to that root:

| Location | Current behavior | Paths outside the root |
| --- | --- | --- |
| Code Collab file RPC (`code-collab-v2-service.ts`) | An absolute path is converted to a relative one only when it is inside the workspace root | `invalid_path` |
| File index Flock (`<ws>:fi:<session>`) | One row per path, keyed by the workspace-relative path; the watcher rejects absolute paths and `..` (`workspace-watch-path-policy.ts`) | Cannot be represented |
| Turn diffs (`code-collab-v2-diff-evidence.ts`) | `normalizeRelativePath` keeps only paths inside the root | Silently dropped from the turn diff |
| File preview (`file-preview-path-policy.ts`) | The workspace root plus a few fixed extra directories | `path_not_allowed` |
| Agent output files (`message-handler.ts`) | A `resource_link` must be inside the workspace; history **deliberately** stores only the relative path so that no host path is published | Rejected |
| Desktop Markdown links and local file paths | Only paths under the known workspace root are made relative; an absolute path is built from the root plus a relative path | Treated as external |
| File index and All Changes (`file-index-scan-core.ts`) | `git ls-files` and a Git diff base are used only when `isInsideGitWorktree(root)` is true | Not applicable |

The file watch protocol already supports several roots (`replace-roots` carries
`roots: string[]`). Everything else knows only one root.

**The survey also found a problem that needs handling now.** In the flat layout
the main directory is not itself a Git repository, so `isInsideGitWorktree(main
directory)` is false. The file index then falls back to a plain filesystem scan,
which ignores only a fixed list of names (`node_modules`, `dist` and so on) and
does not read `.gitignore`. All Changes likewise switches to non-Git snapshot
reconstruction instead of each Member's own Git diff. Phase 2 must therefore make
the file index and All Changes use Git per Member. This is needed whether or not
local directories are ever supported.

**Decision: do not switch synced data to absolute paths; use "root plus relative
path".** Making every path absolute was considered, but history deliberately
avoids publishing host paths. Absolute paths in synced Flock keys would carry the
user name and the main directory's location, and would mean nothing on another
machine. The product owner adopted the following approach in review:

- A conversation holds an ordered list of roots `{ id, absolutePath }`. Only the
  machine that owns the conversation knows the absolute paths. The main directory
  is the root with `id = 'main'`; each future extra directory gets its own id.
- Synced data identifies a path as `(rootId, relativePath)`. Paths under the main
  directory keep today's plain relative strings, so existing data and older
  clients are unaffected. Only paths under other roots need a `rootId`.
- At the machine boundary (RPC input, paths reported by ACP, preview and
  attachment checks), absolute paths are accepted and handed to a single resolver.
  It matches the longest root prefix and returns `(rootId, relativePath)`, and
  rejects a path that is under no root.
- Preparation that can start now: route every containment check in the table
  through that one resolver, passing a single root for the moment. Supporting
  local directories later then only means registering more roots.

## Alternatives

- **An explicit layout forest (top-level, nested, submodule) with edit/read
  participation.** This was the first proposal. It keeps the original structure on
  disk and stops read-only dependencies from creating branches. Its Git behavior,
  archive ordering and UI were all more complex, and review asked for something
  simpler, so the design is now flat with every Member editable. If nesting turns
  out to be a real obstacle, it can be added back on top of the flat layout later.
- **Flattening submodules into separate Members, leaving the parent's submodule
  path uninitialized.** This was the previous revision. Rejected: the agent might
  initialize a second copy of the submodule inside the parent and edit the wrong
  copy, the parent's worktree cannot see the submodule's changes, and updating the
  pointer depends entirely on prompting.
- **A common parent directory with symbolic links.** Rejected. Tools that resolve
  realpath escape the root, and the agent sandbox's writable scope becomes
  unclear.
- **Projects only as sidebar groups, with one conversation per repository.** No
  single conversation would track all the PRs.
- **Symbolic links that put non-Git local directories in the main directory.**
  Rejected. The link points at the original directory, so the agent would edit
  the user's original files directly, and concurrent conversations in one Project
  would overwrite each other's work, with no branch and no backup commit. Sandboxes
  that check the real path may block writes. ripgrep and the file index do not
  follow symbolic links by default. If archive cleanup ever followed the link, it
  would delete the user's directory. Such directories have no PRs anyway.
- **Referencing a non-Git directory at its original path.** Deferred. The
  directory is not placed in the main directory. The agent is told its absolute
  path, and ACP `additionalDirectories` adds it to the provider's accessible scope.
  This is the multi-directory form of today's single-project mode that uses the
  original directory directly, and it offers no isolation. Most ACP adapters do
  not implement `additionalDirectories` yet, so this waits until support is
  widespread.
- **A shadow repository for a non-Git directory.** Deferred. Lody would create a
  private repository in its data directory, take a snapshot commit with the
  original directory as the work tree, and create a worktree from it. When the
  conversation ends, the user would confirm a merge back into the original
  directory, with the snapshot as the base. This keeps isolation and reuses the
  worktree lifecycle, but the first snapshot, default ignore rules and write-back
  conflicts all need further design, and there is not enough demand for that yet.
- **Copying the directory, or an overlay mount.** Rejected. Changes made in a copy
  can only be copied back by hand. Overlay mounts work only on Linux and need
  elevated privileges.

## Proposed phases

1. Project definitions (including instructions and automatic submodule detection)
   and sidebar grouping; existing projects as implicit single-Member Projects.
   Route every path containment check through the single root resolver.
2. Multi-Member conversations for local Members: flat materialization, submodule
   Members, per-Member branch and state observation, a file index and All Changes
   that use Git per Member, per-repository PR discovery, a PR list in the Info
   Bar, linked PRs from Create PR, and protocol capability negotiation.
3. Hosted GitHub Members, prepared worktrees, and Schedules that target a
   Project.

## Verification limits

This proposal is based only on reading the code and existing Specs. There is no
prototype and no test. Still to test: whether each agent sandbox can write to the
`.git` common directory outside the main directory, the size of multi-Member
metadata, how an older desktop displays a conversation with several PRs, and the
submodule Git behavior: where a worktree keeps submodule Git data, removing a
worktree that contains submodules, how SSH submodule URLs work with hosted
credentials, and whether a local parent can reuse the original repository's
existing submodule data instead of fetching over the network.
