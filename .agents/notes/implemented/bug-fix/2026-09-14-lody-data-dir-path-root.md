# Derive every session path from the installation data directory, in the host's own separators

Status: implemented
Translation: current

[中文](2026-09-14-lody-data-dir-path-root.zh.md)

## Abstract

A Windows user reported the workspace path being shown as a POSIX path and sessions
failing with `fatal: Invalid path '<home>/.lody': No such file or directory`, after
which no chat could be started or resumed. Two independent defects made that state
reachable: the browser-safe path builders joined every derived path with `/`, so a
Windows machine's worktree and chat paths were spelled `C:/Users/...` while every
path the daemon actually created with `path.join` was spelled `C:\Users\...`; and
four CLI modules joined a literal `~/.lody` instead of calling `getLodyDataDir()`,
which is the only function that honors `LODY_DATA_DIR` and the OSS `.lody-oss`
profile. Derived paths now carry the separator of the host path they came from, the
four modules use the derived root, and the root is created and reported as Lody's own
directory before any path inside it reaches git. The exact `/mnt/c/...` value in the
report was not reproduced — that string cannot be produced by a Windows Node process
and most plausibly reached the machine as durable state written by an earlier install
— so this fixes the class of failure rather than a confirmed single trigger.

## The two defects

`packages/shared/src/worktree-paths.ts` is browser-safe, so it cannot use `node:path`
and joined segments with `/` after normalizing away backslashes. The original comment
justified that with `vscode://file/...` URI safety, but
`buildVSCodePathLauncherFallbackUrl` already normalizes separators itself, so nothing
depended on the forward-slash form. Everything else did depend on it being a real host
path: the renderer shows it as the session workspace path, hands it to path launchers,
and joins file paths onto it in `session-local-file-path.ts` — whose separator choice
is `WINDOWS_ABSOLUTE_PATH.test(root) && !root.includes('/')`, so a `C:/...` root
silently selected POSIX separators. On the CLI side `terminal-workdir-resolver.ts` put
the same string into a `workdir_unavailable:path_not_found:<path>` error and
`local-project-control-service.ts` used it to read worktree files. A Windows machine
therefore displayed `C:\Users\...` for local-project sessions and `C:/Users/...` for
worktree and chat sessions, two spellings of one directory that never compare equal.

Separately, `speculative-worktree.ts`, `session-fork-operation-store.ts`,
`machine-lifecycle.ts`, and `code-collab-v2-diff-store.ts` each built
`path.join(os.homedir(), '.lody', …)`. `getLodyDataDir()` resolves `LODY_DATA_DIR`
first — which the Electron main process sets on every CLI it spawns — and otherwise
picks `.lody` or `.lody-oss` from the installation profile. On any installation where
those differ, these four modules read and wrote a sibling directory that need not
exist, while `WorktreeManager` and the chat workdir used the real one. The CommonJS
mirror `node/worktree-paths.cjs` had already been corrected to read
`dataDirectoryName` from the profile; its TypeScript twin had not, which is how the
divergence stayed invisible.

## Decision

Separator style follows the shape of the input path, never `process.platform`. These
builders run in a renderer against a `dotlodyPath` the Flock carries from whichever
machine owns the session, so a Windows desktop routinely builds paths for a Linux
machine and the reverse; `isWindowsStyleHostPath` therefore tests for a drive-letter
root or an embedded backslash on the value itself. `getLodyReposBaseDir` and the
`homeDir` form of `getWorktreeHostPath` now delegate to the `dotlodyPath` builders so
one rule covers both families, and the CJS mirror carries the same helper.

`getLodyDataDir()` is the only supported way to name the data root. The four literal
joins now call it, and the doc comments on the browser-safe `.lody` fallbacks state
that they are a fallback for a machine with no published `dotlodyPath` row rather than
the installation's real root.

A missing data root is reported as Lody's own directory. `ensureLodyDataDir()` creates
it and throws `LodyDataDirUnavailableError` naming the path and `LODY_DATA_DIR` when
it cannot. `WorktreeManager.ensureRepoLocked` calls it before either branch runs git,
and `ensureDefaultSessionWorkdir` calls it before creating a chat workspace. The
local-shared branch of `ensureRepoLocked` also now creates `worktreesDir`, which only
the bare branch did; previously the first thing to create it was `git worktree add`,
which reports such a failure as a path git was handed.

## Alternatives considered

Parsing git's stderr for `Invalid path '<data dir>'` and rewriting it was rejected:
it is a stringly-typed read of another program's diagnostics, and it would still let
the daemon reach git with an unusable root. An explicit precondition fails earlier and
states the same thing without depending on git's wording.

Normalizing to `/` on Windows everywhere instead — Node's `fs` accepts both — was
rejected because the mixed spelling, not the syscall, is the defect: the two forms are
what the user reads, and they break `path.relative`/`startsWith` containment checks
against `path.join` output.

Deleting the unused `homeDir` builders was rejected as out of scope; they are exported
from `@lody/shared` and may have consumers outside this repository's boundary.

## Verification and limits

`packages/shared` (1208 tests) and the CLI suite pass. New cases cover Windows,
drive-rooted forward-slash and UNC inputs in `tests/worktree-paths.test.ts`, the
Windows workspace path a session shows in
`packages/components/tests/session-workspace-path.test.ts`, and both
`ensureLodyDataDir` outcomes in `tests/installation-profile.test.ts`.

All separator coverage is string-level: CI runs on Linux, so no test executes these
paths against a real Windows filesystem. The reporter's `/mnt/c/...` value remains
unexplained — `os.homedir()` on Windows derives from `USERPROFILE` and cannot yield
it, and git only names `<...>/.lody` as the failing component when every parent
resolved, which a Windows git could not do for a `/mnt` prefix. If that path is still
displayed after this change, the remaining suspect is durable state written by an
earlier install: the machine Flock `dotlodyPath` row, which self-heals whenever the
daemon reconnects, or absolute paths inside git's own worktree administrative files.
