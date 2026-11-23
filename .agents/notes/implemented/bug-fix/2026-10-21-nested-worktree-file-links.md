# Nested worktree file-link resolution

Status: implemented
Translation: current

[中文](2026-10-21-nested-worktree-file-links.zh.md)

## Abstract

[Issue #1788](https://github.com/LodyAI/Lody/issues/1788): relative links written
by an agent working in a nested worktree could open the checkout's same-name file.
The file-preview discovery protocol collects candidates from the session root and
contained same-repository worktrees without widening authorization. Conversation
rendering now confirms relative targets through the file index and opens them
directly; its clicks and copy menus do not invoke discovery. Current behavior is
owned by [file surfaces](../../../docs/sessions-file-surfaces.md).

## Decisions

- **Provenance gates discovery.** `resolveSessionFileOpenTarget` marks relative agent hrefs when a caller requests
  discovery; `resolveDirectMarkdownFileOpenTarget` deliberately omits that flag.
  The shared resolver re-checks discovery provenance at the trust boundary.
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
  daemons. Conversation opens bypass this negotiation, preserving the
  [daemon-independent preview boundary](2026-10-16-daemon-independent-local-file-preview.md).
- **Results.** Candidates carry absolute path, worktree root, branch/detached HEAD,
  commit and mtime. Explicit discovery callers must preserve ambiguity and pin
  the selected canonical path. Conversation opens instead use the indexed path
  and discard late opens when the session or latest open request changes.

Effect assessment: preview and Electron callers stay Promise owners; the read-only
Git probe reuses the process layer's Legacy entry. No native migration is claimed.

## Limits

Discovery can return several candidates for common files in long-lived nested
worktrees. Conversation UI avoids that ambiguity by requiring an exact indexed
relative path or an explicit absolute path; copying never resolves or rewrites
that path. External worktrees (#472) and message-scoped cwd attribution remain
out of scope for the discovery protocol.
