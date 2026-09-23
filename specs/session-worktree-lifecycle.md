# Session worktree lifecycle

Status: draft
Translation: pending

A user archives a Session that ran in its own worktree. Lody must eventually remove
that worktree directory from the machine that owns it, keep the branch so the Session
can be restored, and do so without any request, acknowledgement, or queue: the
archived state of the Session is the only input.

## Scenario

Alice runs three Sessions against her local project, each in a Lody-created worktree
under the Lody data directory. She archives two of them from her laptop while the
machine that owns the worktrees is asleep. When that machine's daemon is back and has
synced workspace metadata, it sees both Sessions are archived and removes their
worktree directories. Their branches remain. A week later Alice restores one Session;
its worktree is recreated from the preserved branch. She deletes the other; nothing
further happens on disk.

## Responsibilities

The daemon that owns a machine is the only actor that touches that machine's disk.
It reconciles the directory tree it created against Session state:

- The universe is the Lody-managed worktree tree: `<data>/repos/<repo>/worktrees/<session>`.
  Each directory names the root Session that owns it. Nothing outside this tree is ever
  cleaned; a Session running directly in a user directory owns no worktree.
- A directory is removed when its root Session is archived or deleted. Child Tabs share
  the root's worktree and never decide its fate; archiving a Tab alone removes nothing.
- A directory whose Session is unknown is left alone. One machine may serve several
  workspaces, so an unknown directory may belong to a Session this daemon cannot see.
  Deleted Sessions are known: the workspace keeps a deletion marker, so deletion and
  "never heard of" are distinguishable.
- The daemon acts only after it has complete workspace metadata. Before that point it
  cannot tell a not-yet-synced Session from an archived one and must not guess.
- Removal preserves work. Uncommitted, non-ignored changes are committed to the
  Session branch first. The branch is never deleted by archive, restore, or delete.
  Ignored files (build output, local environment files) are discarded with the directory.
  A worktree whose repository cannot be resolved through git (the project directory
  is gone, or the repository is broken) is preserved and retried: there is nowhere to
  commit the backup, and the directory may hold the only copy of the work. A project
  registered as a subdirectory of a repository is owned by that repository.
- The branch name git reports at removal is written back to the Session, so a branch
  renamed in a terminal still restores.
- A configured cleanup script runs once, before the directory is removed. Its failure is
  reported to the user through the Session history and the daemon log; it does not
  prevent removal, and it does not run again once the directory is gone.
- Reconciliation is idempotent and repeatable. It runs when the daemon has synced
  metadata, when a Session's archived or deleted state changes, and periodically. A
  directory that fails to clean is retried later with backoff; no attempt is the last one.

## Operations

| Operation                   | Effect on disk                                                                                                                                  | Effect on branch |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Archive a root Session      | Worktree removed after a backup commit                                                                                                          | Kept             |
| Restore an archived Session | Worktree recreated from the branch                                                                                                              | Kept             |
| Delete an archived Session  | Nothing beyond archive; the deletion marker keeps the directory eligible for removal if archive cleanup had not converged                       | Kept             |
| Remove a local project      | Its Sessions are archived, so their worktrees follow the archive rule; the optional immediate cleanup in the removal dialog only changes timing | Kept             |

Archiving still releases the Session's runtime promptly: the agent process, terminals,
presence, and preview tunnel are closed when the daemon observes the archived state.
This is separate from disk reconciliation and does not wait for it.

Machines that are no longer part of the workspace are out of scope: nothing can act on
their disk, and no other machine may try.

## What this replaces

Earlier revisions used durable per-machine command queues (an archive request and a
delete request with a payload) that the daemon consumed and acknowledged. A command
consumed with a wrong result was gone; the required data (the project root path) could
arrive after the command, and a transient read failure could acknowledge a cleanup that
never happened. State reconciliation removes the acknowledgement and the ordering
dependency: a directory that still exists is the only evidence that work remains.
Deletion no longer deletes branches, so it no longer needs a payload.

Existing queue entries written by older clients are discarded without processing;
their Sessions are covered by the archived or deleted state those clients also wrote.

## Unresolved

- Whether a deletion marker survives long-term metadata compaction is not established
  here. If it does not, a worktree whose archive cleanup never converged before the
  marker vanished would remain until removed manually.
- The local-project removal dialog still offers an immediate cleanup that skips dirty
  worktrees and reports them as kept. Under this contract those directories are removed
  later by the archive rule (after a backup commit), so the dialog's wording overstates
  what "kept" means. Simplifying that dialog is a separate change.
- A Session deleted before its archive cleanup converged runs no cleanup script: the
  script configuration and the history that would record the run are gone with the doc.

## Evidence

- Reported behavior: [#377](https://github.com/LodyAI/Lody/issues/377).
- Intended target set for archive, restore, and delete: [session relations](session-relations.md).
- Reconciliation: [`worktree-gc.ts`](../apps/cli/src/session/worktree/worktree-gc.ts) and
  its wiring in [`message-handler.ts`](../apps/cli/src/lib/message-handler.ts).
- Removal with backup commit and preserved branch: [`worktree-manager.ts`](../apps/cli/src/session/worktree/worktree-manager.ts).
- Behavioral coverage: [`worktree-gc.test.ts`](../apps/cli/tests/worktree-gc.test.ts) and
  [`message-handler-terminal-cleanup.test.ts`](../apps/cli/tests/message-handler-terminal-cleanup.test.ts).
