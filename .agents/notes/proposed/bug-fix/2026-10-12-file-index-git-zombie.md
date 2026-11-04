# Join both Git listings before a file-index scan returns

Status: proposed
Translation: current

[中文](2026-10-12-file-index-git-zombie.zh.md)

## Abstract

Code Collab file-index scanning runs two `git ls-files` children in parallel. When
the first one failed, the scan returned straight to the filesystem fallback without
waiting for the second, and inside the Tinypool worker that unjoined child could be
left as a `git` zombie of the CLI daemon on macOS
([#1507](https://github.com/LodyAI/Lody/issues/1507)). The fix keeps both queries
parallel but waits for both to settle before choosing the Git result or the
filesystem fallback. A deterministic subprocess test proves the sibling is joined
and reaped; the macOS zombie itself was observed in the issue, not re-reproduced
against this change in the desktop app.

## Problem and evidence

- `runGitLsFiles` in `apps/cli/src/lib/code-collab/file-index-scan-core.ts` awaited
  `Promise.all([listing, deletedListing])`. The listing call could reject, so a
  failure ended the `Promise.all` while `git ls-files --deleted` was still running.
  The outer `catch` returned `{ ok: false }` and the caller fell back to the FS scan.
- The worker runs under Tinypool, whose default is `useAtomics: true`. Once the task resolves,
  the idle worker parks in `Atomics.wait`, so its libuv loop may not get to
  `waitpid` the abandoned child before the worker is torn down. `worker_threads`
  children keep the daemon as their PPID, which is why the zombies appear under
  `index.js start` (see the issue for the `ps` capture and the isolated fixture).
- The shipped desktop bundle calls the same function through
  `runCommandTextLegacy`, so the fix belongs in the source function, not in the
  bundle or `node_modules`.

## Decision

Both listings go through `runGit`, which never rejects, and the function inspects
the two results only after both children have finished. A failed primary listing
still returns `{ ok: false }` and keeps the FS fallback; a failed deleted-path
listing still means "no deletions to filter". Scan architecture, Tinypool options,
and watcher/ACP/MCP/Electron code are unchanged.

Rejected alternatives:

- Adding another `exit` listener or reaping hook does not help: the child is not
  reaped because the owning loop is parked, not because nobody listens.
- `useAtomics: false` would change the pool's idle behavior for every task to hide
  one unjoined child.
- Running the two listings sequentially also joins both, but doubles the scan's Git
  latency for no extra safety.

## Verification and limits

`apps/cli/src/lib/code-collab/file-index-scan-worker.test.ts` puts a fake `git`
on `PATH`. Its `--deleted` invocation records its PID and blocks on a FIFO; its
`--cached` invocation exits 1 only after that child is running. After the primary
rejection reaches the scan core and one macrotask turn has passed, the scan must
still be pending and the sibling present; after the test terminates the sibling,
the scan resolves to `null` (FS fallback) and `kill(pid, 0)` reports `ESRCH`, so
the child is neither running nor a zombie. The test fails on the previous
`Promise.all` code. A second test keeps the success path honest: paths deleted
from the worktree stay excluded. The fixture uses POSIX `sh` and `mkfifo` and has
no timers, so it runs on Linux and macOS but not Windows.

The issue's production evidence (two daemon-owned `git` zombies after a reboot) is
consistent with this path; this change does not re-verify the zombie count on a
packaged Nightly build.
