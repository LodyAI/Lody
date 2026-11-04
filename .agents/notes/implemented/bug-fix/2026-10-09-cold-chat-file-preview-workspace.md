# Cold chat file preview loses its workspace

Status: implemented
Translation: current

[中文](2026-10-09-cold-chat-file-preview-workspace.zh.md)

## Abstract

File preview could open a regular chat's artifacts while its runtime Session existed,
then reject the same files after that instance disappeared. The preview workspace
resolver reconstructed local-project and GitHub workspaces from metadata but omitted
the default chat directory. An isolated execution of the actual resolver reproduced
the reported error while the synthetic artifact remained readable on disk. The
resolver now reconstructs the existing chat owner directory without starting an
agent or creating a directory. The particular incident's eviction trigger remains
unverified; the implementation covers the loss of the resident runtime itself.

## Evidence

- `Session.getWorkdir()` in [session.ts](../../../../apps/cli/src/session/session.ts)
  uses `ensureDefaultSessionWorkdir(sessionId)` for an ordinary chat. The path is
  `<getLodyDataDir()>/chats/<sessionId>`; it is not an absent workspace.
- [MessageHandler](../../../../apps/cli/src/lib/message-handler.ts) wires both
  `file/preview` and local `file/resolve-local` through the same workspace resolver.
  Before this fix, `resolveCodeCollabWorkspaceRoot` accepted an active or pending
  Session's host directory. Without one, its metadata branches handled local
  projects, a live parent, and GitHub worktrees, then returned exactly
  `Session has no local project or GitHub repository workspace.`
- [FilePreviewService](../../../../apps/cli/src/lib/file-preview/file-preview-service.ts)
  returns a workspace error before resolving the requested path or reading bytes.
  Absolute paths therefore do not bypass this failure either.
- [GC](../../../../apps/cli/src/lib/session-gc-manager.ts) defaults to a 20-minute
  idle timeout with eligibility checks, and also supports memory-pressure eviction.
  `cleanSessionForGC` terminates the runtime and unloads transient state;
  `SessionManager` removes exited/terminated instances from its in-memory map.
  Daemon restart also removes that map. These are possible triggers, not proof of
  which one occurred in the reported incident. Merely reopening the UI is not
  established as the cause of runtime termination.
- [Renderer workspace derivation](../../../../packages/components/src/lib/session-workspace-path.ts)
  already derives chat directories. The
  [terminal resolver](../../../../apps/cli/src/lib/terminal-workdir-resolver.ts)
  also handles cold chats, but creates directories, so it is not a drop-in
  read-only preview resolver.

This is separate from the earlier
[renderer route/cache fix](../../implemented/bug-fix/2026-09-29-local-file-preview-route-cache.md)
and [home-rooted path handling](../../implemented/bug-fix/2026-10-08-home-rooted-file-link-paths.md).

## Correction

The shared workspace resolver now resolves a metadata-only ordinary chat to
`getDefaultSessionWorkdir(parentSessionId ?? sessionId)`, and requires that directory
to exist. It validates the cold chat owner: missing/deleted, archived, wrong-machine,
project/worktree-backed, and nested-parent metadata cannot grant a chat fallback.
Local-project and GitHub resolution keep their existing branches and failures.
Both `file/preview` and `file/resolve-local` benefit, as do explicit Code Collab
requests, matching their existing behavior with a resident chat runtime. Resolving
the directory itself does not activate Code Collab, publish Flock state, or restore
an agent. The terminal resolver was not reused because it creates directories.

## Verification and limits

The actual resolver was first reproduced in isolation with synthetic dependencies:
a resident Session allowed reading an artifact; removing only that instance yielded
the exact reported error while the bytes remained on disk. The cold child case also
failed. The new Machine RPC integration suite exercises the real MessageHandler and
FilePreviewService against temporary files, including warm-to-cold relative/absolute
reads, local file identity, child ownership/mismatch, missing directories/files,
invalid session/parent metadata, and unresolved parent workspaces. Agent creation,
document mutation, and Code Collab access are forbidden by the test dependencies;
success therefore requires the read-only path. Temporary fixtures contain no user data.

The new integration suite fails six of nine cases on the baseline and passes all
nine with the fix. Together with the existing file-preview suites, 50 tests pass
and three filesystem-dependent cases skip. `pnpm format`, `pnpm run docs check`, and full `pnpm check` pass. The full check
uses a test subprocess without the enclosing agent-session Git wrapper and inherited
`GIT_*`/`LODY_GIT_*` variables: the initial run otherwise failed the unrelated native
Git credential fixture with `context_unreadable`. CLI tests: 3522 passed, four skipped;
components: 4888 passed; shared: 1295 passed. Documentation retains only existing warnings.
No full Electron UI run or inspection of the user's specific artifact was performed.
