# Canonicalize local project roots before publishing worktree identity

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1029

[中文](2026-09-26-local-project-symlink-worktree-path.zh.md)

## Abstract

An older local project registration could retain a symbolic-link path while the
daemon created its worktree from the link's real target. The renderer hashed the
published link path, so Copy path and Open in VS Code addressed a nonexistent
worktree directory. The owning daemon now canonicalizes roots on project writes
and repairs older rows at workspace startup without changing their project IDs.
An unavailable target retains the stored path until it can be resolved.

## Decision

The project row is the shared source for local worktree path derivation. The CLI
already normalizes the root before creating a worktree, so the same owner must
publish that normalized root to Machine Flock. `upsertMachineLocalProject`
canonicalizes valid directory paths, including writes that preserve an older
project ID and history. `LodyFleet` reconciles existing rows after the workspace
starts; this covers registrations written before normalization was enforced.
Reconciliation shares the machine catalog write lock with history providers so
the row rewrite cannot discard a concurrent history update.
The renderer keeps its platform-neutral path builder and requires no filesystem
access or new native dependency.

Changing the row's `rootPath` retains its `id`, name, creation time, and history.
This prevents old Session references from losing their project. If the target is
unavailable, the daemon keeps the stored path instead of recording an unverified
replacement. A link retargeted after worktree creation remains a separate
durable-identity problem: the project row alone does not record which historical
target an existing Session used.

## Evidence and verification

The reported symbolic link resolved to the same repository as the worktree, but
hashing the link spelling and its real path produced different local repo IDs.
The repair and subsequent-write regression uses a real temporary symbolic link
and checks the published Machine Flock row. See
[`local-project-meta.test.ts`](../../../../apps/cli/src/lib/local-project-meta.test.ts).
All 81 targeted local-project metadata and history tests pass. The nested
checkout omits ACP submodules and most `node_modules`, so root `pnpm check`,
`pnpm format`, and `pnpm run docs check` cannot complete here; the touched
files were formatted with Oxfmt directly. The installed desktop app has not
been replaced or clicked through.

This decision complements the [host-path derivation fix](2026-09-14-lody-data-dir-path-root.md).
