# The worktree project-ownership gap in Codex ACP

Status: proposed
Translation: current

[中文](2026-09-08-codex-worktree-project-persistence.zh.md)

## Abstract

Lody can persist its own project reference, worktree state and ACP session id today, but when it
creates a Codex session it passes only the execution directory and no separate project ownership.
Codex 0.153.4 already provides a project table and an experimental project-association interface;
isolated verification confirmed that a thread in a worktree can keep its real execution directory
while being associated with a different project root. The adapter's history listing still filters by
execution directory, so a query by original project path cannot cover its worktree conversations.
The proposal is to define an explicit project context through Core and have the Codex adapter map it
onto the native project API; this is an investigation conclusion and a proposal awaiting review, and
it has not changed the runtime or migrated any existing session.

## Scope and evidence

The later [local project ownership implementation](../../implemented/bug-fix/2026-09-08-local-project-acp-identity.md)
already covers this proposal's session-establishment and ownership back-fill parts; what follows
preserves the baseline at investigation time, while project-level history queries and the desktop
worktree presentation remain an unverified proposal.

- Lody inspection baseline: `c83e78a7ae43addbdf7f115114e6cb3ebfb5ea29`.
- Codex adapter submodule: `9b4c96140c90100ea60c1f4ce3a7fdd7e6cb4b4f`, package version 1.10.0.
- Codex native runtime pinned by Lody: 0.153.4; Core submodule:
  `7bc6332d3f007876895b4a3a827be0060f4d5318`.
- Local metadata of the current session was inspected; no real conversation, machine path, thread id
  or log was written into the repository.
- No existing Codex project-ownership contract was found in current Specs or active notes; this
  proposal does not represent an approved new guarantee.

## The persistence chain

Lody's `ProjectRef` distinguishes a GitHub repository from a local project; a local project has
`localProjectId` and `useWorktree`, and `LocalProjectMeta.rootPath` stores the project root. The
session itself also stores `isWorktree` and `acpSessionId`. Local worktree creation knows the
`originalRootPath`, but the parameters from `Session.createAgent` to `createAcpClient` carry only the
real `workdir`.

`AgentClient.getSessionStartMeta` currently passes session configuration and fork boundaries, with no
project or worktree context. `CodexAcpClient.newSession` hands the ACP `cwd` straight to
`thread/start`; `loadSession`, `resumeSession` and `SessionFork` likewise supply only the real
directory plus their own session operation parameters. The ACP session id corresponds to Codex's
thread id.

Codex stores rollouts in `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl`, including `session_meta`,
`turn_context`, `response_item` and `event_msg` records. In 0.153.4, `state_5.sqlite` holds the thread
index together with `projects`, `project_roots` and `threads.project_id`; paginated history also uses
`thread_turns`, `thread_items` and other tables in `thread_history_1.sqlite`. This describes an
observed internal layout and must not be treated as a contract for clients to write the database
directly.

The observed result for the current ACP session is: `cwd` is the worktree path, Git metadata contains
the commit, branch and remote URL, `originator` is the adapter, `source` is `vscode`, and `project_id`
is empty. `source` describes the client origin and cannot be used as a worktree marker. The JSONL Git
metadata does not express the original project path either. In the isolated sample, an explicitly
assigned project association lives in the state database, so one cannot assume that copying the
rollout alone restores complete project grouping.

## Native capabilities and the adapter gap

The protocol was obtained by running the following against the actual 0.153.4 binary, rather than
inferring it from an older desktop state:

```sh
codex app-server generate-json-schema --experimental --out /tmp/codex-project-schema
```

The experimental protocol has these capabilities:

| API | Relevant semantics |
| --- | --- |
| `project/create` | `idempotencyKey`, `name`, `roots: [{path}]` create an independent project |
| `project/list` / `project/read` | Query native projects and their roots |
| `thread/start.projectId` | Durable project ownership for a new thread, independent of `cwd` |
| `thread/metadata/update.projectId` | Assign an existing persisted thread to an existing project |
| `thread/list.projectId` | Query by project, independent of the exact-match `cwd` filter |

The adapter's `generate-types` in `package.json` has no `--experimental`, so the committed
`ThreadStartParams` and `ThreadMetadataUpdateParams` lack these fields and ClientRequest lacks the
project methods. Initialization already sets `experimentalApi: true` but consumes none of the
corresponding capabilities. `Thread.projectId` already appears in the return type yet is not returned
in the ACP session listing; `project/changed` and `thread/project/updated` are also ignored.

`CodexAcpClient.listSessions` passes an absolute `cwd` to `thread/list` and then compares the
directory again, returning only id, cwd, title and update time. That is listing history by execution
directory; covering associated worktrees by logical project would require defining additional query
semantics rather than quietly widening the standard cwd filter.

`createSessionConfig`'s `projects[path].trust_level = "trusted"` is a configuration-layer directory
trust setting, not the creation of a project record. `additionalDirectories` and
`runtimeWorkspaceRoots` express working directories and access scope and likewise cannot substitute
for project ownership.

## Verification and limits

Verification used a temporary `CODEX_HOME`, a synthetic Git repository and an associated worktree,
connecting directly to the pinned app-server, with no real account credentials and no modification of
the user's Codex data:

1. Created a project whose root is the source checkout; from the same worktree, started one cwd-only
   thread and one with an explicit projectId, which returned null and the expected project id
   respectively.
2. Used a synthetic `thread/inject_items` to make the threads land on disk, then unsubscribed; the
   state database retained the real worktree cwd and the explicit project id.
3. Called `thread/metadata/update` on the persisted cwd-only thread; `thread/read` and read-only SQL
   both then confirmed successful project ownership.
4. An empty thread may still have no rollout right after start, and the metadata update reports
   "no rollout found"; back-filling history ownership must target already persisted threads.

Injecting items is not a normal user turn: the sample's `has_user_event` was 0 and the list query
returned empty, so this result is not counted as end-to-end verification of the project listing. A
separate synthetic turn against a locally unreachable mock provider timed out waiting for the
completion event, and the test process was ended. Real model turns, the desktop project display,
worktree badges and Handoff were not verified. The conclusion that cwd listing misses these threads
comes from the adapter implementation and the native filter schema.

## Proposed division of responsibility

- Lody supplies an explicit logical project root and worktree context when establishing new, load,
  resume and fork sessions, while keeping the real cwd; the shared extension should be defined by
  `acp-extension-core` and version-negotiated.
- The Codex adapter resolves or reuses a native project from the project root and associates the
  thread through the project API. It must handle path normalization, idempotent creation, multi-process
  concurrency, projects a user already assigned by hand, and compatibility with older runtimes.
- New sessions use `thread/start.projectId` directly; resume or historical back-fill goes through a
  controlled metadata update. Fork's project inheritance needs separate verification — one must not
  assume that changing cwd changes ownership automatically.
- Project-level history queries and returned metadata must be filled in at the same time; otherwise
  fixing only creation still does not let history be listed from the source project.
- `cwd` continues to point at the worktree; do not add the original directory to write permissions to
  simulate grouping, and do not modify SQLite or desktop global state files directly.

The current GitHub worktree mode uses a shared bare repository and may have no unique original
checkout; only a local project worktree explicitly holds an `originalRootPath`. The Git common-dir can
explain the repository relationship but cannot decide which project the user wants ownership assigned
to, and that choice should be supplied explicitly by the host.

The [official worktree documentation](https://learn.chatgpt.com/docs/environments/git-worktrees) also
distinguishes a Codex-managed temporary worktree from a permanent worktree treated as an independent
project. Project grouping does not mean Codex takes over worktree creation, Handoff or cleanup; Lody's
external worktree lifecycle must stay in Lody. Making the desktop show exactly the same worktree
marker would still require separately verifying the desktop recognition contract.

## Implementation entry points

- [Project model](../../../../packages/shared/src/project.ts)
- [Lody session creation](../../../../apps/cli/src/session/session.ts)
- [Lody worktree origin](../../../../apps/cli/src/session/session-manager.ts)
- [ACP start metadata](../../../../apps/cli/src/agent/agent-client.ts)
- [Codex session creation and listing](../../../../packages/acp-extension-codex/src/CodexAcpClient.ts)
- [Codex fork](../../../../packages/acp-extension-codex/src/SessionFork.ts)
- [Core extension ownership principles](../../../../packages/acp-extension-core/README.md)
