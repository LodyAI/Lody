# Workspace branch information

Status: draft
Translation: current

[中文](workspace-branch-state.zh.md)

A user opens a local Git project without a GitHub remote. Its conversation should
show the checkout branch using the same desktop info bar and menu as a worktree
conversation. A plain non-Git folder must not acquire an invented branch.

## Ownership and observation

The owning machine reads Git in the resolved execution directory. This capability
is independent of repository hosting, PR association, and agent provider. Child
Tabs share their parent’s workspace and publish branch observations to that owner.
Independent worktree Sessions retain independent branches.

Observe when activating or explicitly refreshing root workspace contents, binding an agent Session,
and completing, cancelling, or failing a running turn. Startup and file snapshot
responses do not wait for presentation metadata. Serialize observations and writes
per owner so an earlier slow read cannot overwrite a later checkout observation.
Only publish changes; no remote Git or authenticated cloud operation is required.
Ordinary file watcher and terminal diff refreshes do not repeat branch observation.
A failed turn must publish its failure without awaiting optional branch observation.

`SessionMeta.branchName` remains the last successfully observed named branch.
Detached HEAD and failed Git probes preserve it for worktree restoration and PR
lookup. Never substitute the base/start reference as the current branch. A new
non-Git Session has no branch. Idle external checkout changes become visible at the
next workspace refresh or turn; this contract does not promise continuous Git HEAD
watching. The existing mobile layout still omits branch text in its bottom bar.

## First-task branch naming

Ordinary new independent worktree Sessions, for both GitHub and local projects,
ask the agent in the first task prompt to inspect its branch and rename Lody's
allocated temporary ref (`session/<id>` or `lody/<id>`, including collision
suffixes) before starting work, committing, or pushing. The agent preserves an
already descriptive task branch, summarizes the task without copying sensitive
input into a ref, and never force-overwrites an existing branch. A conflicting
name gets another descriptive name; rename failure is reported without blocking
the task.

Eligibility follows first use of the Session, including adoption of a prepared
worktree. Direct local directories, shared child Tabs, Sessions with a prior ACP
session or an explicit resume request, subsequent turns, and the separate Fork
flow do not receive this first-task request. Naming is provider-independent and
requires no public API or persisted flag. This is agent guidance, not a guarantee
that the model performs a rename. The daemon neither derives refs from prompts nor
launches another ACP generator. Existing Git observation publishes an agent's rename;
Provider-owned session title updates remain independent.

## Evidence

- [Branch owner](../apps/cli/src/session/workspace-git-service.ts)
- [Execution lifecycle](../apps/cli/src/session/session-execution-service.ts)
- [Workspace refresh](../apps/cli/src/lib/code-collab/code-collab-v2-service.ts)
- [Decision and verification](../.agents/notes/implemented/bug-fix/2026-09-24-workspace-branch-observation.md)
- [First-task naming decision](../.agents/notes/implemented/feature/2026-10-08-new-worktree-branch-prompt.md)
