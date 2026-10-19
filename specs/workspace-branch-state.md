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

For an ordinary new independent GitHub/local worktree Session, the daemon reads
the actual checkout after workspace preparation and setup. It requests naming only
when the branch matches this Session's allocated temporary ref, including numeric
name or namespace collision suffixes. Descriptive branches, another Session's refs,
detached HEAD and failed probes receive no naming request; cached metadata and the
base ref do not substitute for that read.

The first prompt directly asks the agent to rename the verified branch to a short
task name before starting work. The command names the verified old ref, so a
checkout change does not silently redirect the rename to another branch. The agent
avoids sensitive input and force-overwrites, chooses another name on collision,
and reports rename failure while continuing the task. It need not inspect the
checkout to decide whether naming is appropriate.

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
