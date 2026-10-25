# Nested worktree file-link resolution

Status: implemented
Translation: current

[中文](2026-10-21-nested-worktree-file-links.zh.md)

## Abstract

[Issue #1788](https://github.com/LodyAI/Lody/issues/1788): relative links written
by an agent working in a nested worktree resolved against the session checkout,
reporting absence or silently opening the checkout's same-name file. Relative
Markdown links now collect candidates from the session root and same-repository
worktrees contained in it. A unique real path opens directly; several require a
user choice. Canonical tree/Diff paths and explicit absolute/home/parent-relative
links keep their behavior. Discovery never widens authorization.

## Decisions

- **Provenance gates discovery.** `session-file-open-target.ts` marks only relative
  agent hrefs; the shared resolver re-checks the same rule at the trust boundary.
- **Containment.** `git worktree list --porcelain -z` supplies roots, branch and
  HEAD. Roots must lie inside the session root lexically and by realpath; arbitrary
  subdirectories are not searched. `relativeBase` changes lookup only; the path
  policy still authorizes against the session root, and the selected path is
  reauthorized on read.
- **Every match is returned**, realpath-deduplicated, including the session root.
  Per-candidate permission/I/O errors fail the request rather than drop a match.
- **Discovery is best effort.** Missing Git, broken `.git`, `safe.directory`
  refusal, timeout (5 s), oversized output (256 KiB) or more than 128 worktrees fall
  back to the session root alone — the pre-fix behavior — instead of breaking links
  that used to open.
- **Version skew.** `markdownFileLinks` v1 gates `resolveMarkdownLink: true` on
  `file/preview`; the facade reports `unsupported_protocol` for older remote
  daemons and the renderer then opens the link against the session root as before.
  Same-machine Electron resolves directly without daemon metadata, preserving the
  [daemon-independent preview boundary](2026-10-16-daemon-independent-local-file-preview.md).
- **Picker.** Shows absolute path, worktree root, branch/detached HEAD, commit and
  mtime. The choice pins the canonical path and line anchor; no short-link cache. A
  newer open or session change discards a late resolution.

Effect assessment: preview and Electron callers stay Promise owners; the read-only
Git probe reuses the process layer's Legacy entry. No native migration is claimed.

## Limits

Repositories that keep a long-lived nested worktree will show the picker for most
relative links, since worktrees share files. Markdown link context-menu actions
(copy path, open, reveal) resolve the same way on invoke and reuse the picker.
External worktrees
(#472) and message-scoped cwd attribution remain out of scope.
