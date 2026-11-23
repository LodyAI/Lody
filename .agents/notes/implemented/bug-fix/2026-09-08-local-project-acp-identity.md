# Local project ACP ownership metadata

Status: implemented
Translation: current

[中文](2026-09-08-local-project-acp-identity.zh.md)

## Abstract

A local project's worktree conversation previously passed only the execution directory to Codex, so
the original project ownership was lost at the ACP boundary. The original root directory now travels
through Core's versioned `worktreeProject` extension, and the adapter uses the native project API to
persist thread ownership while keeping the worktree execution directory. The implementation covers
creation, back-filling ownership on load/resume, fork, and host capability negotiation, and isolated
verification against a real Codex 0.153.4 confirmed the persisted result. The change is in the linked
PR and Core 0.1.2 is published while the adapter is not; project-level history queries and desktop
worktree lifecycle features are outside this implementation.

## Problem and responsibilities

The initial
[investigation proposal](../../proposed/architecture/2026-09-08-codex-worktree-project-persistence.md)
distinguished the execution directory, project ownership, and Codex-managed worktrees. The user then
chose to fix local project ownership; this implementation note covers that scope and does not replace
the proposal's still-unimplemented project-level history queries. The
[Spec](../../../../specs/local-project-acp-identity.zh.md) remains draft.

- Core defines `LodyWorktreeProject` and the `worktreeProject` v1 capability. The metadata rides on
  the standard session-establishment request under `_meta.lody.worktreeProject`, shaped as
  `{ version: 1, originProjectPath: "/original/project" }`, and adds no custom JSON-RPC method. This
  naming was settled before release with no legacy draft field aliases retained; project mapping and
  execution-directory semantics are unchanged.
- Lody resolves the original root directory from the existing project record by `localProjectId`. The
  resolution callback is passed through Session and the ACP runner to AgentClient, and runs after
  capability negotiation and the final directory claim. Pre-creation, sub-sessions, resume and
  replacement sessions all follow the same division of labour; GitHub-only never guesses a local root.
- The Codex adapter realpaths the original root, looks it up among the native project roots or creates
  it idempotently, with the creation key derived from the normalized root, avoiding one project per
  worktree.
- New threads use `thread/start.projectId`; resume only fills empty ownership and preserves an existing
  user choice; fork uses the target project, updates the target thread, and always releases the fork's
  temporary subscription.

## Trade-offs and compatibility

Only adapters that advertise the v1 capability receive local project metadata; older adapters keep
their current behavior. The adapter's project API rests on the pinned Codex 0.153.4 experimental
protocol and uses narrow type additions consistent with the existing background-terminal API rather
than regenerating the whole experimental protocol tree. A legacy `CODEX_PATH` override may not support
the native interface, and a failure must not be disguised as a successful association.

When one root matches several native projects, the ambiguity is reported explicitly instead of
arbitrarily overwriting one of them. Historical threads only have empty ownership back-filled when they
are reopened; there is no bulk scan or migration, and an existing user project choice is never
overwritten. Project root metadata adds no trusted or writable directory, does not change cwd, and
touches neither SQLite nor desktop global state files.

Core and Codex were first validated jointly through the root workspace's
`acp-extension-core: workspace:*` override. After Core 0.1.2 was published, Codex's independent npm
dependency was updated to exactly 0.1.2, with the lockfile using the real registry tarball and
integrity; the existing Codex version declaration in the lockfile's root entry was also corrected to
match the manifest's ^0.153.4, with no other dependency upgraded. An independent temporary checkout
passed npm ci, typecheck, build and the full tests (579 passed, 27 skipped), confirming the new
contract can be consumed directly from the published Core. After both submodule PRs merged, Lody pins
Core's 0.1.2 release commit `9c47fec` and the test-fix commit `89b1208` built on Codex's merge commit
`400384e`, retaining the goal lifecycle fix added on Codex main; the adapter is not published.

Linked drafts: [Lody #534](https://github.com/LodyAI/Lody/pull/534),
[Core #6](https://github.com/LodyAI/acp-extension-core/pull/6),
[Codex #35](https://github.com/LodyAI/acp-extension-codex/pull/35).

## Verification

- Core build/typecheck, Codex adapter build/typecheck, and repository-wide `pnpm typecheck` pass.
  Checking the CLI alone initially revealed that the Claude adapter had not been built; after running
  the standard adapter preparation, the repository-wide typecheck passed.
- Codex's full suite after trimming: 579 passed, 27 skipped. ACP negotiation and new/load/resume/fork
  request validation check that the final worktree cwd and the original root metadata are both present;
  project resolution does not run when the capability is not advertised.
- Project-mapping tests cover reusing a native project, directory aliases, pagination, the concurrent
  idempotency key, resume preserving a user choice, fork changing only the child thread, compatibility
  without metadata, and rejection of invalid or ambiguous metadata.
- Verification used a temporary Git repository and worktree, an isolated CODEX_HOME, and a real 0.153.4
  app-server with no user credentials, driving the modified CodexAcpClient directly. Model catalog
  discovery was replaced offline, and a synthetic history item made the thread land on disk; the three
  threads from creation, resume with empty ownership, and fork were each confirmed by read-only SQL to
  retain the worktree cwd and point at the same project, with a total project count of one.
- No real model inference was run and no user history was modified; desktop badges, Handoff, and
  project-level history lists were not verified.

## Ablation: 2026-09-09

The linked PR was created first, then Codex adapter commit `55b48510` was fixed as the baseline; each
round changed exactly one implementation detail in `src/WorktreeProject.ts` and ran the 13 behavioral
tests. Every round restored the baseline, and the passing deletions were finally combined and retested;
test retries were disabled so an incidental pass could not be mistaken for evidence.

```sh
./node_modules/.bin/vitest run --no-file-parallelism --retry=0 src/__tests__/CodexACPAgent/worktree-project.test.ts
```

| Variant | Result | Decision |
| --- | --- | --- |
| Original baseline | 13 passed | Control |
| Remove the pending Map with its get/set/finally and return the project lookup directly | 13 passed | Delete the cache |
| Remove the local `thread.projectId` write-back after the native update | 13 passed | Delete the write-back |
| Skip realpath on the input path | 1 failed: a directory alias produces a different project identity | Keep |
| Query only the first page of projects | 1 failed: an already registered project on a later page is not reused | Keep |
| Drop the guard for an existing project on resume | 1 failed: it tries to rewrite existing user ownership | Keep |
| Delete the cache and the local write-back together | 13 passed | Adopt; the module goes from 98 to 87 lines |

The cache only merged simultaneous lookups inside one adapter process; the native deterministic
idempotencyKey is what owns cross-process project identity. Removing the cache may increase the number
of lookups under same-process concurrency, and no performance claim is made. After a successful native
update, no caller depends on the rewritten temporary Thread object: load re-reads the thread, and the
session metadata returned by resume/fork does not use that field.

To avoid relying on mocks alone, a real Codex 0.153.4 under an isolated CODEX_HOME was run both before
and after the trim: two concurrent calls of the same resolver and a call from another resolver all
returned the same project; the three threads then landed on disk from creation, resume with empty
ownership, and fork still retained the worktree cwd and pointed at the single project. Both runs passed,
using a synthetic Git repository and an injected history item, reading no user history and issuing no
model inference.

Repository-wide `pnpm check` passed, including typecheck, lint, CI tests and boundary checks; the first
sandboxed run aborted on an EPERM for the IPC socket and passed on rerun in an environment that allows
local sockets. `pnpm format` and the document check were also run, and the unrelated Electron test
changes produced by formatting were reverted.

## Main-branch synchronization and CI

When synchronizing with main, CI did not trigger on the Lody PR's latest commit, because of a merge
conflict between the Codex submodule and the import order of the session-manager test; an earlier
revision's CI and Desktop E2E had passed. Merging main, selecting the already merged submodule commits
and keeping both sides' tests restored a mergeable state; no workflow was modified and no check was
skipped to work around the conflict.

The updated full Codex suite then revealed a test fixture error: `setupPromptFixture`'s
`awaitTurnCompleted` always returned `turn-id`, which did not match the `review-turn-id` the review
actually awaited. The goal lifecycle correctly retained the unfinished turn, so that case timed out. The
fix makes the mock return the threadId and turnId from its call arguments, preserving the association of
each native turn; the runtime completion condition was not relaxed and the test timeout was not extended.

That fix was reviewed separately in
[Codex #36](https://github.com/LodyAI/acp-extension-codex/pull/36), taking the full Codex suite from
599 passed with 1 timeout to 600 passed and 27 skipped. Repository-wide `pnpm check` passed after the
merge; the Lody submodule reference includes this test fix.

## Entry points

- [Core protocol](../../../../packages/acp-extension-core/README.md)
- [CLI metadata lifecycle](../../../../apps/cli/src/agent/README.md#local-project-identity)
- [Codex project resolution](../../../../packages/acp-extension-codex/src/WorktreeProject.ts)
- [Codex regression tests](../../../../packages/acp-extension-codex/src/__tests__/CodexACPAgent/worktree-project.test.ts)
