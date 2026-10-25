# Multi-repository Project groups: one main directory

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
nested-layout proposal after review. Declared submodules retain their nesting; other
members are flattened. A local folder with a GitHub remote joins as a repository
Member that runs on any machine with a copy of it; only folders without a remote
bind a Project to one machine. Shared and daemon implementation is under review. Agent sandbox
scope and older-client presentation still need product verification. The intended contract is in the
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
  /** preferLocal: a repository Member, see "Revision: repository Members". */
  | { kind: 'github'; repoFullName: string; repoId?: number; baseBranch?: string; preferLocal?: true }
  /** Machine-bound: a folder without a GitHub remote, or a non-Git directory. */
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
  /** One top-level snapshot: only the owner daemon serially updates it after creation. */
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
  repoFullName?: string; // GitHub identity observed for a local Member remote
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
registered in its own repository. Git derives the internal administrative name from
the checkout directory, suffixing collisions. Lody identifies Members by frozen path
and branch, not this internal name.

## Path dependency survey (preparing for local directories)

If local directories outside the main directory are supported later through
`additionalDirectories`, a conversation will have several file roots. Today every
file feature assumes a single session workspace root, and represents paths
relative to that root:

| Location                                               | Current behavior                                                                                                                         | Paths outside the root              |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| Code Collab file RPC (`code-collab-v2-service.ts`)     | An absolute path is converted to a relative one only when it is inside the workspace root                                                | `invalid_path`                      |
| File index Flock (`<ws>:fi:<session>`)                 | One row per path, keyed by the workspace-relative path; the watcher rejects absolute paths and `..` (`workspace-watch-path-policy.ts`)   | Cannot be represented               |
| Turn diffs (`code-collab-v2-diff-evidence.ts`)         | `normalizeRelativePath` keeps only paths inside the root                                                                                 | Silently dropped from the turn diff |
| File preview (`file-preview-path-policy.ts`)           | The workspace root plus a few fixed extra directories                                                                                    | `path_not_allowed`                  |
| Agent output files (`message-handler.ts`)              | A `resource_link` must be inside the workspace; history **deliberately** stores only the relative path so that no host path is published | Rejected                            |
| Desktop Markdown links and local file paths            | Only paths under the known workspace root are made relative; an absolute path is built from the root plus a relative path                | Treated as external                 |
| File index and All Changes (`file-index-scan-core.ts`) | `git ls-files` and a Git diff base are used only when `isInsideGitWorktree(root)` is true                                                | Not applicable                      |

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

## Shared contract implementation

The first implementation slice exports `WorkspaceProject` and `SessionProjectRun` from
`packages/shared/src/workspace-project.ts`, with the Member types shown above. Workspace
Flock now normalizes `project` rows and exposes list/write/delete helpers. Both catalog
and run schemas reject unsafe portable paths, duplicate identities, missing parents,
cycles and overlapping sibling placements. A run requires at least two Members; ordinary
single-repository sessions keep the existing contract. The create payload uses the full
`SessionProjectRun` shape, including placement, rather than the abbreviated field list
above. The daemon must resolve and verify `base` (especially submodule gitlinks), and
must not trust client-supplied runtime observations.

`deduplicateProjectMembers` accepts a machine-owned local-to-GitHub identity resolver.
Known numeric IDs take precedence; name-only aliases use an unambiguous known ID when
available. Conflicting numeric IDs are not collapsed by name. `getCurrentPullRequestsByRepository`
returns each repository's last valid GitHub PR in input order. `resolveSessionFilePath`
is a portable lexical longest-root resolver; callers operating on disk must still check
realpaths to reject symlink escapes. Absolute roots remain machine-local.

`multiRepoProject: 1` is defined and negotiable, but is deliberately not included in the
current daemon advertisement until materialization and lifecycle support are implemented.
This contract slice does not enable creation on existing daemons. Runtime implementation,
owner-serialized metadata writes and lifecycle behavior remain to be verified.

Contract PR: [#1641](https://github.com/LodyAI/Lody/pull/1641).

## Runtime storage finding and worktree primitives

The locked `loro-repo` implementation does **not** turn nested metadata records into
Loro maps: `MetadataManager.upsert` writes each top-level key to one Flock value
`['m', docId, key]`. The product owner selected a single-writer contract:
`projectRun` remains one top-level SessionMeta value. Clients write only the initial
snapshot with session/create metadata. Afterwards, only the owning daemon writes it.
Observations, member additions and legacy projections share the branch observation
owner queue, serializing read-modify-write per conversation. No nested Record merge,
upstream loro-repo change or separate member rows are needed. A future second writer
requires a separate row per member. Code type names stay unchanged; user-facing and
first-turn agent text calls this a “Project group”. “Project” continues to mean a
single local folder or GitHub repository.

The preparatory worktree change adds an explicit frozen Project placement to
WorktreeManager. Repository data and leases remain keyed by repoId; placement-aware
instances are not put in the repo-only global cache. Native observations use the same
member suffix. Git may suffix the administrative worktree name when member directory
basenames repeat across sessions; the directory and branch, rather than that internal
name, identify the Member. This corrects the earlier assumption that Git always uses
sessionId as its administrative registration name.

Submodule primitives compose the existing native WorktreeGit service. They validate
`.gitmodules` and the actual gitlink before checkout, initialize recursively, allocate
from the gitlink commit, and save backup branches by local fetch into persistent storage
before deinit. Restore retrieves that branch. Non-fast-forward persistence and repository
mismatch fail closed. These primitives have real-Git tests.
The runtime integration below composes them into materialization and GC.

The Project mutation owner triggers from the frozen create/restore snapshot,
serializes mutations of the same owner session, retains partial directories and branch receipts
on failure, and releases all raw Git processes before handoff. WorktreeGit already owns
command cancellation and cleanup; the existing manager/setup/GC orchestration remains
Promise-based. A whole-manager migration pulls in unfinished dependencies and is deferred.
The new native submodule leaf does not claim that migration is complete. Tests verify
local Git checkout, backup, restore, member observation and stable branch receipts.
Live managed credentials remain outside the deterministic local test fixtures.

Worktree primitives PR: [#1642](https://github.com/LodyAI/Lody/pull/1642).

## Owner serialization and runtime integration

The owning daemon shares the existing WorkspaceGitService queue across service instances
for the same document manager and owner Session. Reads occur after queue acquisition;
failed writes do not poison recovery. Materialization publishes each successful member's
branch before continuing, so a later failure retains both directories and branch receipts.
Observations use each member's Git directory and publish the snapshot with legacy projections.
Unknown probes retain prior facts; detached HEAD retains the last named branch. Children
publish to their owner. The surrounding session/setup/GC orchestration remains Promise-based;
this change does not claim a native lifecycle migration. WorktreeGit still owns process release.

Session startup uses the frozen group directory and first-use prompt context says “Project group”.
ACP originProjectPath points to the stable group directory. With archive/GC, PR reconciliation
and member-based file indexing connected, the runtime advertises `multiRepoProject: 1`.

Local GitHub discovery needs a durable machine-observed repository identity for each local
member, without opening Git during metadata-wide poller scans. `SessionProjectMember` adds
optional `repoFullName`, populated by the owner from the member remote. This additive field
is compatible with existing consumers; `src` remains the frozen local binding. The creation
request cannot supply an authoritative observed identity. PR discovery still requires the
member's observed branch and revalidates both identity and branch before writing.

Runtime archive backs up all members before removing any root. Submodule refs are fetched
into persistent repository storage before parent backup records the new gitlink. Restore
seeds submodule objects from that store, including commits absent from the remote, and
keeps the original base. Git requires forced worktree removal even after deinit; the
manager first verifies the saved branch, a clean checkout and deinitialized submodules.
Unselected submodule commits without a persistent Member store, or unresolved repositories,
retain the group. Root files outside members are not recursively deleted. Reproducible
`.lody/attachments` copies can be removed after backup.

PR discovery targets and idle fingerprints include Member ID. Fresh-meta revalidation
checks that same member's repository and branch; current-PR ordering is repository-local.
File-index workers scan each Member with Git and prefix relative paths; All Changes pins
a merge base per Member. Code Collab, preview, ACP diff evidence and upload containment
share `resolveSessionFilePath`, retaining realpath checks at filesystem boundaries. POSIX
backslashes remain literal characters, preventing a sibling path from masquerading as a
child. UI components and desktop presentation remain owned by the separate UI session.

The public mid-conversation add-member request remains a follow-up: no RPC shape was defined
by this contract slice. Any such request must materialize and publish through the same owner
queue; clients must never replace the snapshot after creation. Live managed-credential and
UI end-to-end acceptance are not covered by the deterministic Git fixtures.

Validation: CLI typecheck and `check:quick` passed; PR reconciliation suites passed 101 tests.
The final session/owner/prompt/Git transport run passed 74 tests, including all three group
lifecycle layouts, with one native SSH credential fixture failing `context_unreadable`.
The full repository check is not green; UI and live credential acceptance remain outstanding.

Runtime integration PR: [#1644](https://github.com/LodyAI/Lody/pull/1644)。

## UI/daemon handoff

`buildSessionProjectRun(project, selectedMemberIds)` freezes definition order, source,
placement, paths, stable root and instructions. `selectProjectMembers` recursively drops
children of deselected parents; unknown IDs fail. Fewer than two remaining members returns
`undefined`, so callers use the existing single-repository flow (zero disables Create).
Root bases use `baseBranch ?? 'HEAD'`; submodules use `PROJECT_SUBMODULE_BASE = 'gitlink'`.
The owner resolves placeholders to named root base refs and submodule commit IDs before publishing materialization
receipts; root HEAD uses the local current checkout or GitHub default branch. Explicit
base branches remain unchanged. A single-member fallback never carries `projectRun`.

Machine RPC `project/probe-local-member` takes `{ localProjectId }` in `params`, alongside
normal `machineId`/`workspaceId`. Its result has type `project/probe-local-member`, optional
`repoFullName`, and `submodules: { path, url, repoFullName? }[]`; transport retains the normal
`{ ok, result }` envelope. It only reads a registered member in that workspace/machine,
rejects session-scoped calls, never fetches/initializes/syncs/writes Git config, and reads
the working `.gitmodules` without includes. Invalid paths are omitted; unsafe/oversized
configuration fails. Absolute local/file URLs are redacted to `url: ''`; no host root is
returned and command error details are not exposed. No GitHub identity is guessed for
redacted local URLs. UI may leave those relationships unconfirmed.

Shared `getProjectRepositoryFullName` resolves GitHub HTTPS/SSH/SCP and parent-relative URLs.
`matchProjectSubmoduleMember` matches against GitHub members or machine-resolved local
identities and returns no match for ambiguity. The daemon's gitlink validator uses the same
`projectRepositoryUrlIdentity` normalization. `session/create` keeps the first selected
member's `project` projection and optional `projectRun`, gated by `machineSupportsMultiRepoProject`.

Probe trigger/owner: a read-only authenticated machine RPC; the finite native Effect probe
uses WorktreeGit/FileSystem, awaits command release, and retains no background state. The
existing Legacy entry bridges the Promise dispatcher; failure returns a path-free error and
a retry reads fresh state. No surrounding dispatcher migration is claimed.

Remote machines expose the same method through Streams.
`LoroStreamsMachineRpcClient.requestProjectProbeLocalMember({ localProjectId, requestedByUserId, timeoutMs? })`
returns the typed result or null on transport/handler failure. The daemon checks machine/project access
before probing. Local IPC uses the existing authenticated machine RPC envelope.

The HEAD root receipt preserves the named base ref (so PR bases remain branch names);
a detached checkout or recovery without a base receipt pins the commit. GitHub HEAD reads
the current remote symbolic HEAD rather than preferring main or a stale cached default.
Validation includes 37 shared, 124 Streams, 13 RPC-scope and 12 Git/owner tests, plus
two remote base tests including a changed default branch. Full workspace typecheck,
`check:quick`, format and docs check passed; full repository tests remain separate.

Shared `withProjectGroupPrScope(prompt)` scopes either PR creation or Commit & Push to
member repositories. It preserves the requested action and draft status, publishes children
before parent gitlinks, and cross-links all related PR bodies after URLs are known. Commit &
Push alone does not create PRs; a failed child publication blocks publishing its parent pointer.
The member inventory supplies directories because the Project group root is not a Git repository.
The final local-member observation field remains `SessionProjectMember.repoFullName?: string`;
UI code using `repo` must switch to `repoFullName`. No synonymous storage field is introduced.

The initial GitHub `project` projection uses `branch: baseBranch ?? 'HEAD'`; an empty
branch is rejected by the existing `ProjectRefSchema`. Local projections retain `useWorktree: true`.

## UI implementation

In the UI this is simply a project with several repositories or folders (see
"Revision: one project concept" below); type names in code are unchanged.

- **Settings → Projects**: "Several repositories or folders" in the add menu
  opens the editor, and multi-repository projects are project rows there, placed
  like the sidebar's. The editor writes to the workspace catalog document; a save is done once
  it is durable locally, and the upload is neither awaited nor reported. The
  member list is ordered as directories nest, so it doubles as a preview of the
  conversation's main directory. The UI reads a GitHub member's `.gitmodules`
  through the GitHub API and sets submodule relationships automatically; local
  members wait for a read-only daemon probe RPC. Detection only moves a default
  or previously detected placement, never one the user set by hand, and a
  detected result that would form a cycle is discarded. Only the creator can
  edit or delete a project.
- **Sidebar**: a multi-repository project is a project row. One with a
  machine-bound member sits under that machine after its folders; one without
  sits in GitHub Worktrees. A defined project is listed even with no
  conversations, so one can be started there;
  conversations of a deleted group stay grouped under the name in their
  snapshot. A conversation with `projectRun` no longer appears under the local
  project or GitHub group of its first member. A group row behaves like a local
  project row: its mark turns into the fold chevron on hover, the row starts a
  conversation, and the hover controls are ⋯ (edit the group, archive its
  chats), new chat, and a drag handle; the order is saved per workspace like
  local projects. A folded machine's mark counts its multi-repository projects'
  conversations too. In the Updated view and Pinned, their conversations appear
  with the project's mark and name.
- **New conversation**: a group sits on top of the plain chat context, leaving
  the existing local/GitHub logic and the mobile views unchanged. Choosing a
  group lets its local members' machine decide the execution machine. A conversation always gets the whole group as configured; the composer only lists
  the members, read-only (a submodule is checked out by its parent anyway, and a
  different set belongs in the group's settings). A group with a single member
  starts an ordinary single-project conversation. If the daemon does not advertise `multiRepoProject`,
  submission is blocked with a prompt to update.
- **Info Bar**: a new Repositories chip (never staged) lists each repository in
  snapshot order with its path, branch, uncommitted/unpushed state, current PR
  and CI. The context stage shows only the first member's own current PR.

Not done yet: submodule detection and repository identity for local members
(waiting on daemon fields), a Project group variant of the Create PR prompt, and
mobile entry points. The UI is verified only in Storybook and unit tests, not
end to end against a real daemon.

## Revision: non-Git Members and multiple roots

This section revises the conclusion under Alternatives that deferred non-Git
directories. The product owner is implementing `additionalDirectories` for more
ACP providers, and Lody's own Claude and Codex adapters already support it
(`readAdditionalDirectories` in `packages/acp-extension-codex/src/CodexAcpClient.ts`),
so non-Git Members are introduced now:

- **The daemon decides access at materialization.** Git Members (GitHub or local)
  always use worktrees. A non-Git Member is passed as an additional directory when
  the provider declares `additionalDirectories`; otherwise it is a symbolic link
  under the main directory (a junction on Windows).
- **Link boundaries.** Each earlier reason for rejecting links now has a
  countermeasure. Write access comes from the additional directory or full-access
  mode, never from the link itself. Indexing and watching work on registered
  roots and do not depend on following links. Cleanup removes only the link and
  never recurses into its target. Link targets are resolved only from the local
  project registry and recreated if changed.
- **No isolation is a deliberate trade-off.** As with today's single-project mode
  that uses the original directory, a non-Git Member edits the original directory
  and has no branch, backups or PR; the UI must say so.

**File capabilities across roots.** The survey found that same-machine Electron
preview can already open any path read-only, but remote preview, edit and save,
LSP, the file tree, All Changes, `@` search, turn diffs and agent output files
all recognize only the single workspace root (see the path dependency survey).
Opening additional directories without changing these would let users see the
agent change files they cannot edit, search or find in a diff in Lody. These
capabilities are therefore extended to every root using `(rootId, relativePath)`:
authorization resolves the real path before comparing it with registered roots,
and the main directory's plain relative path format is unchanged.

**Split of work.** The logic session implements the daemon side: root
registration, authorization, indexing, watching and diffs. The UI session
implements file tree grouping by root, `@` search and opening files by `rootId`.
Neither side is implemented or verified yet.

## Multi-root file contract

Contract branch: `multi-repo-extra-roots-contracts`. Only the daemon writes
`access?: 'worktree' | 'additional' | 'link'`. `MAIN_SESSION_FILE_ROOT_ID` is `main`;
`getProjectMemberRootId(id)` returns `member:<id>` and `parseProjectMemberRootId` reverses it.
`SessionFileRootIdSchema` validates optional file RPC rootId; omission means main.
Remote content retains its existing encrypted envelope.

`encodeSessionFilePath` / `decodeSessionFilePath` preserve plain relative main paths.
Other roots use `\u0000lody-root:member:<id>/<relativePath>` with an actual leading NUL.
NUL cannot occur in a real filename, so this cannot collide with any main file and reserves
no same-named physical directory. This is a sync key, never a filesystem path, URL or shell
argument: decode it, resolve the local registry, then authorize realpaths. File-index rows,
per-turn diff paths and attachment sourcePath share the encoding. Old clients cannot operate
on these new keys; extra-root compatibility is not claimed. RPC sends separate rootId and
relative path fields, never the encoded key.

The probe adds `isGit: boolean`; parsing older successful probes defaults to true because
older daemons accepted only Git repositories. This commit provides contracts and the Git
probe field only; non-Git probing, materialization, authorization and full file access follow
in the runtime PR.

## Daemon multi-root integration

`multi-repo-extra-roots-runtime` stacks on the contract branch. Non-Git members and root-aware
file requests require `machineSupportsProjectFileRoots` (`projectFileRoots: 1`). The older
`multiRepoProject: 1` only establishes Git Project group support.

Local registrations are the sole authority. Materialization allocates branches only for Git
members; non-Git directories are registered before ACP initialization. Each startup reads the
actual `sessionCapabilities.additionalDirectories` declaration, then the owner mutation queue
publishes additional/link access. Supported providers receive real directories on lifecycle
requests; others receive repaired links (junctions on Windows). A real same-named entry blocks
link access and is preserved; additional-directory access does not reserve that name. The first-turn inventory says non-Git members are not isolated;
actual extra-root paths are supplied only to the runtime Agent prompt, not synced metadata.

File access resolves registrations and realpaths afresh, repairing changed links from the
registry without expanding authority. An unavailable member blocks only its own file access;
startup still requires every selected member. Preview never activates indexing. Root-scoped
file state shares the physical-file save queue and owner publication chain. Publications merge
root snapshots and watch subscription identities include the root, so one root cannot replace
another's subscription. Main retains per-Git-member scanning; non-Git roots use existing FS
scanning and diff snapshots. LSP's existing backend is not wired: all roots retain
`lsp_not_wired`, with the same root authorization before that response.

Turn evidence, Agent resource files and attachment provenance share root resolution. The local
snapshot library disallows NUL keys, so the CLI adapter maps non-main keys to
`/lody-roots/member:<id>/<relativePath>` and reverses them on reads. Leading slash cannot collide
with legacy relative keys; these local keys never become filesystem paths. No upstream storage
change is needed. Archive skips non-Git backups, unlinks known member links, checks for residual
symlinks, then cleans the group directory. Missing targets do not prevent unlink; real entries
and unknown links are preserved rather than traversed.

The native Effect probe returns isGit=false only for ordinary absence of a Git repository;
corruption, permission and process-release failures remain errors. Access and publication use
the existing Promise session owner, with no additional background owner or broader migration.
Root helpers perform finite filesystem operations and retain no resources. Failures preserve
published state and directories for retry; one unavailable root does not fence others. Tests
use temporary directories, real Git and a fake Provider boundary. Real providers, Windows
junctions and UI end-to-end behavior still require cross-platform acceptance.

## UI for multiple roots

The UI adds no path format of its own. It mounts each extra root under the
member's directory name: encoded keys in the file index and All Changes
(`\0lody-root:member:<id>/…`) are translated to `<member dir>/…` where the file
provider is built, and the conversation diff panel translates encoded keys from
history the same way. Every file request is split back into `rootId` and a
relative path in the runtime adapter
(`packages/components/src/lib/session-file-root-mounts.ts`). The file tree, `@`
search, opening, editing, saving and diffs therefore need no knowledge of roots.
The daemon does not reserve the member's name in the main directory for
additional-directory access, so a real main-directory entry with the same name
can coexist; the file tree then shows the member root's files at that path, and
requests for it go to the member root. A root the snapshot no longer mounts is
shown as `member-<id>/…`, never with a visible NUL.

A preview with a member `rootId` never takes the Electron same-machine fast path,
which resolves relative paths against the main directory and would read a
different file; such requests always go to the machine. The editor marks a
non-Git member as edited in place and does not let it be a submodule or a
submodule's parent. The Info Bar's repository list shows such members as
"Original directory · not isolated". The UI mounts a root only when the snapshot records
`access: 'additional' | 'link'`, which only a daemon with `projectFileRoots`
(#1674) writes, so older daemons never produce mounts. All of this
is verified only by unit tests and type checks; nothing has run end to end.

## Revision: repository Members

**Problem.** Members added from local folders were recorded as
`(machineId, localProjectId)`. The editor therefore listed every machine's copy of a
repository as a separate row (`lody` three times in a workspace with three machines),
and once one local Member was chosen it disabled every other machine's folders, each
with the same long reason. In a workspace with several machines most rows were grey.
The user means "this repository", not "the copy on that machine", and a group bound
to one machine could not be used from another machine that has the same repositories.

**Decision** (confirmed by the product owner after reviewing mockups):

- A local folder whose GitHub remote is known joins as a **repository Member**,
  `{ kind: 'github', repoFullName, preferLocal: true }`. Only a local repository
  without a GitHub remote and a non-Git directory remain machine-bound `local`
  sources. A Project's execution machine follows from its machine-bound Members
  (`getProjectBoundMachineId`); a Project without any runs on any machine.
- **Materialization.** The daemon looks for a local project on its own machine whose
  remote is the repository, picking the most recently opened one
  (`pickProjectRepositoryLocalCopy`), and re-observes that folder's remote rather than
  trusting the published value. It creates the worktree from that copy with native
  credentials, exactly like a local Member. Without a copy, a managed deployment
  clones like a GitHub Member; local-only mode reports the Member unavailable on that
  machine instead of cloning.
- **Publication.** `LocalProjectMeta.githubRepoFullName` is written by the owning
  daemon from the folder's remote. The normalizer drops a malformed value instead of
  rejecting the project row. Clients use it to merge copies into one picker row and
  to say which machines can run a Project without probing every folder.
- **Compatibility.** `projectRepositoryMembers: 1` gates starting a Project that
  contains a repository Member; the contract branch declares the checker and the
  daemon branch advertises it. `preferLocal` is optional, so an older client reads
  the Member as a plain GitHub Member; an older client that re-saves the Project
  drops the flag (its Zod object strips unknown keys) and the Member degrades to a
  managed clone. Saved Projects are not rewritten in the background: the editor
  converts a local Member whose machine publishes a remote when the Project is next
  saved, keeping the Member's ID, directory and submodule placement.

**Alternatives.**

- *An explicit machine per Project, with the picker showing only that machine.* The
  smallest change, but a group stays unusable on any other machine that holds the
  same repositories, and the duplicate rows remain within one machine's view of
  GitHub plus local copies.
- *Keep per-machine rows but group them by machine.* Less noise, but every
  repository still appears once per machine and still binds the group to one.
- *A new source kind `repo`.* Clearer in code, but a discriminated union in an older
  client rejects the whole Project row; an optional field degrades instead.

**UI.**

- *Editor picker.* One row per repository: the GitHub repository cache merged with
  local projects publishing a remote, keyed by the lowercase repository name. Rows
  are grouped as Repositories, directories on this machine, and directories on other
  machines. Repositories that exist only on GitHub are not listed until the user
  searches (or already selected), so a long repository list never pushes local rows
  out of view; the list ends with "N more GitHub repositories, type to search". A
  row of source filters (All, Repositories, This machine, then each machine) sits
  under the search field, following the iOS simulator picker. Once the group has a
  machine-bound Member, other machines' directories are disabled and the reason is
  stated once under their group label, not per row.
- *Composer.* Machine first, as for single projects: groups bound to another
  machine are not listed, and choosing a group never switches the machine. A group
  without machine-bound Members is listed on every machine with its availability
  there, and its member list marks repository Members the machine lacks. In
  local-only mode such a group is shown unavailable on that machine, since a
  conversation always gets the whole group.

**Split of work.** This branch holds the Spec, this section and the shared contract.
The logic session implements the daemon: publishing `githubRepoFullName` when a
project is added and on startup, materializing repository Members from a local copy
with native credentials (falling back to the managed clone, or reporting unavailable
in local-only mode), extending the prompt inventory and PR observation to the copy's
credentials, and advertising the capability. The UI session implements the picker,
editor migration and composer filtering. The contract branch verified the shared contracts; daemon verification is described below.

**Daemon integration** ([PR #1682](https://github.com/LodyAI/Lody/pull/1682)). Add/startup publication preserves `githubRepoFullName` across
other row writers. Materialization re-observes ranked local copies, rejects duplicate
identities, and uses native auth; missing copies use managed cloning or fail with
`project_repository_not_on_machine`. The additive owner-written
`SessionProjectMember.repositoryCheckout` receipt pins `{ kind: 'github' }` or
`{ kind: 'local', machineId, localProjectId }` before branch creation, without host
paths. Retries and archive/restore retain that store rather than repicking; local
copies save branches to the original repository and retain `src.repoFullName` for
PRs. Mixed runtimes freeze native repositories in the existing credential lease;
host Git, shell Git/gh and PR polling select credentials per member, and PR batches
separate native from managed queries. Prompt inventory identifies local copies;
the daemon advertises `projectRepositoryMembers: 1`. Real temporary Git tests and
fake provider boundaries cover selection, stale/missing copies, duplicates,
publication/preservation, credentials and root/submodule archive/restore. Live
GitHub, Windows and desktop UI end-to-end behavior remain unverified. Startup
refresh stays off the prompt path. Existing session serialization and lease release
remain the owners; Effect migration is deferred because worktree mutation/setup/GC
and Flock orchestration still have unfinished dependencies.

Focused suites, production typechecks, `check:quick`, formatting and docs checks pass.
The broad workspace test stage of `pnpm check` was stopped before completion.

**Daemon startup investigation (2026-10-18, [PR #1688](https://github.com/LodyAI/Lody/pull/1688)).** The baseline at #1682 serializes
independent member creation, then remaining submodules, then setup. Selected
submodule checkout also uses `--recursive`: it clones nested selected members
before their own credential boundary, plus unselected descendants. The later pass
skips directories with `.git`, so this is not generally two full downloads; nested
selected members still repeat update/inspection/branch work. There are no explicit
fetch jobs or object references. Required unselected submodules remain required;
this change does not silently omit them.

The relevant deadline is the daemon's `session-active-presence.ts` initialization
watchdog, enforced by `awaitInitializationStall` in `session-execution-service.ts`.
The materializer itself never selected a Git stage or reported progress. The outer
`shouldPrepareWorktree` check selects `git-clone` only from the compatibility
`project` field: Git-backed first members normally take that path, whereas a missing
compatibility project or direct/non-Git first member leaves a group on generic
`initializing` with a 180,000 ms silence limit. Restore initially uses `resuming`
(900,000 ms). ACP starts afterward; its handshake timer does not cover this preparation. `WorktreeGit` separately limits each Git command to 600,000 ms;
`withRepoLock`'s 120,000 ms is lock acquisition, not a whole-clone deadline. The
existing `git-clone` watchdog budget is 1,800,000 ms. Fake-clock regression reproduces
the generic-stage failure at 180 seconds, survival in the Git stage, renewal on a
changed member milestone, and eventual failure on silence. No affected production
session log was supplied: this establishes the code defect and reproducible timer,
not proof of the timer that fired in the specific field report.
`MessageHandler.handleSessionCreate` sends success before awaiting `startSession`,
so the normal create acceptance/RPC wait does not enclose materialization.

The fix reports the existing Git stage from credential preflight through real
member/submodule/setup milestones, without heartbeat fakery or new protocol fields.
It runs at most four independent member mutations, waits for parents, serializes
siblings that share parent config, and serializes immutable branch receipts. All
started tasks settle before the owner is released on failure; retries retain pinned
`repositoryCheckout` and published branches. Selected submodules initialize without
recursion under their own auth; local copies use `--reference` plus `--dissociate`
to reuse objects without depending on future source retention. Remaining submodules
initialize in bounded member batches and `git submodule update --jobs 4` batches.
Setup stays in the prior serial traversal order because scripts can depend on one another.
Managed empty caches are not treated as useful object references, and we do not add
persistent alternates or broaden the existing file-transport permission policy.

Startup reconciliation previously awaited every local-project remote before PR
poller/schedule registration. It now starts after runtime readiness. The runtime
owns its promise and abort signal: shutdown stops between projects and joins the
current operation before closing the document. Errors remain logged; the next
startup retries the scan. Observation and mutation still use their existing native
Git boundary and Promise owners; no partial Effect migration is claimed.

Measurements use the owning real-Git `workspace-git-service.test.ts` fixture: three
independent roots, two selected nested members, one unselected nested leaf and one
unselected sibling, empty setup hooks with file-read verification. Git URLs resolve
to `file://` transport with `GIT_ALLOW_PROTOCOL=file`; no network or sleeps. Native
`/usr/bin/git` avoids this development shell's credential wrapper overhead. A paired
isolated run (baseline #1682 versus this change; process import/fixture creation
excluded) measured the following wall-time spans. These are small local-fixture
samples, not statistically established network performance forecasts.

| Phase | Before (ms) | After (ms) |
| --- | ---: | ---: |
| Resolution and owner preparation | 594 | 558 |
| Member checkouts (including selected submodules) | 874 | 715 |
| Remaining submodule initialization | 147 | 139 |
| Setup hooks | 3 | 4 |
| Whole materialization | 1,619 | 1,419 |

A separate twelve-project real-Git Flock scan took 398 ms. That scan used to be
awaited on readiness; it now contributes no awaited scan time there, but still
consumes background work. No end-to-end daemon readiness benchmark is claimed.
Set `PROJECT_STARTUP_MEASUREMENTS` or `PROJECT_SCAN_MEASUREMENTS` to an output file
when running the corresponding focused test to collect timings; assertions use
explicit barriers and resulting Git/Flock state, never elapsed-time thresholds.
Coverage includes three roots meeting at a credential barrier, parent-before-child
checkout, absence of prematurely cloned selected descendants, no retained local
alternates, serial setup, failure draining before owner handoff, archive/restore,
scan cancellation between rows and shutdown joining observation. The UI can render
existing `initializing` status with stage `git-clone` and its detail (for example,
`Prepared web (1/5 ready)`); no new error codes or availability fields are added.
Live GitHub transfers, large object-volume throughput, Windows and desktop E2E
remain unverified. Existing per-command deadlines still apply to a single silent
clone; completion milestones are not byte-level transfer progress.

Verification: 150 tests across eight focused CLI suites pass; the final setup-order
regression also passes on rerun. `check:quick`, production typechecks, formatting
and docs checks pass. Full `pnpm check` reached 4,342 passing CLI tests and two
failures: #1682's exhaustive registration fixture omitted the newly advertised
capability (fixed here), and the native SSH transport fixture inherited the dev
shell's `GIT_EXEC_PATH` wrapper (`context_unreadable`). Both affected suites pass
with a native Git execution path (27 tests). An earlier broker test also exceeded
its 30-second test timeout with that wrapper and passes with it cleared. The full
workspace sweep was not rerun after these corrections; later package test stages
and desktop E2E remain unverified. No unrelated component source was changed.

**UI implementation.** `lib/project-member-sources.ts` builds the picker rows:
local projects are merged by the remote their machine publishes, one copy per
machine (the one the daemon would pick), and every merged folder's old source key
is kept so groups saved earlier still resolve. `groupProjectMemberSourceOptions`
lays out the groups, the filters and the disabled folders.
`ProjectGroupSourcePicker` renders them with a controlled query, so GitHub-only
repositories appear once the user types. When the editor opens a saved group, it
converts local members whose machine publishes a remote and saves the result
with the group. A repository Member's submodules are read from a copy on an
online machine when there is one, so detection works without GitHub integration.
In the composer, `getProjectGroupMachineAvailability` hides groups bound to
another machine, appends "N cloned on start" or "N not on this machine" to the
others, and in local-only mode disables a group the machine lacks a copy for. Starting a group
with repository Members requires `projectRepositoryMembers` on the machine. The
picker was checked in Storybook (Chinese, both filters). Pure helpers have unit
tests. Nothing has run end to end against the daemon from #1682 yet.

**Preparation progress in the UI.** #1688 reports Project group preparation under
the existing `git-clone` initializing stage, but the composer showed that stage as a
fixed "Cloning repo" and ignored `detail`, which was English free text. The detail
is now a bounded structured value (`encodeProjectPreparationProgress`:
`resolve`, `member` with done/total/path, `submodules`, `setup` with path), which the
UI renders in the product language, e.g. "Preparing repositories 2/5 · lody-oss".
Following the presence-channel rules, the daemon publishes it at lifecycle steps
only: once at the start, once per finished member, once for the submodule pass and
once per setup script (2N+2 updates for N members, each under 200 bytes, on the
session's single presence key). Older clients ignore the detail for this stage, and
plain text from older daemons falls back to the generic message.

## Revision: one project concept

**Decision** (product owner, 2026-10-21). The UI drops "Project group" as a
separate concept. A multi-repository project is a project with several Members
and reuses the project surfaces instead of a section and a Settings tab of its own:

- **Placement.** A project with a machine-bound Member is listed under that
  machine after its folders; one without runs anywhere and is listed in GitHub
  Worktrees (`placeProjectGroups`). A project bound to a machine the sidebar does
  not list, or the conversations of a deleted project, also go to GitHub
  Worktrees. Settings › Projects follows the same rule, with an "Any machine"
  section for the second kind.
- **Entry points.** Settings › Projects' add menu has "Several repositories or
  folders". A folder row's context menu has "Edit project…", which opens the
  same editor seeded with that folder (as a repository Member when its machine
  publishes a remote); saving creates a new project and leaves the folder and its
  conversations untouched, because existing conversations cannot change layout.
  A GitHub repository row's context menu (and its hover ⋯) offers the same,
  seeded with the repository. A multi-repository project row's menu edits it.
  On a phone, a project's settings tab starts with an "Edit project…" row seeded
  with that project, and mobile Settings › Projects lists multi-repository
  projects by the same placement with a "Several repositories or folders" row.
  One host
  (`ProjectEditorHost`, driven by `projectEditorRequestAtom`) owns the editor and
  the delete confirmation for every surface.
- **Removed.** The Project groups Settings tab and route, the separate sidebar
  section and its collapse state. Copy says "project" throughout; rows use the
  stacked-folders mark.

The shared contract, daemon and composer behavior are unchanged. Deleting a
multi-repository project is desktop-only (Settings › Projects). Verified with unit
tests and type checks;
the sidebar placement was checked in Storybook, not against a real workspace.

