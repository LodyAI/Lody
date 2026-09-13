# Verify terminal PR status before the reconciler becomes idle

Status: implemented
Translation: current

[中文](2026-09-13-terminal-pr-status-verification.zh.md)

Pull request: [#670](https://github.com/LodyAI/Lody/pull/670)

## Abstract

The session sidebar could retain a red `closed` icon after GitHub had merged the same pull request,
while the active conversation showed `merged` from a fresh details request. The local reconciler
previously treated an already-discovered branch plus any terminal metadata as permanently idle.
Terminal discovery generations now include the current PR URL, forcing one final authoritative
query before becoming idle again; this costs one request per terminal transition and avoids
continuous terminal polling.

## Problem

The compact sidebar reads `SessionMeta.pullRequests`, while the active conversation fetches GitHub
details and derives lifecycle state from that response. PR #649 exposed a split view: the stored
metadata was `closed`, but GitHub's authoritative state was `MERGED`. The reconciler could not repair
the stored value because status targets intentionally include only open/draft PRs, and the existing
branch discovery fingerprint suppressed discovery as soon as the stored current PR became terminal.

## Decision

Keep terminal PRs out of recurring status polling. Instead, define a terminal discovery generation
as `(repository, branch, current PR URL)`, distinct from the ordinary `(repository, branch)`
generation used while a PR is open or absent. The transition therefore creates a never-refreshed
target that is due immediately. A successful discovery can correct `closed` to `merged` through the
existing fresh-meta write-back path, then records the terminal fingerprint so subsequent passes stop.

Including lifecycle state itself in the fingerprint was rejected because correcting `closed` to
`merged` would create a second generation and an unnecessary second request. Polling all terminal
PRs on a fixed cadence was also rejected because terminal lifecycle is stable after this final
verification.

## Evidence and verification

- `gh pr view 649 --repo LodyAI/Lody` reported `MERGED` while the captured sidebar rendered the
  stored `closed` icon.
- The target regression reproduces the suppression caused by an existing branch fingerprint.
- The scheduler regression moves an associated PR from open to stored `closed`, returns `merged`
  from branch discovery, verifies the metadata correction, and advances 45 minutes to prove that no
  recurring terminal poll remains.

The test uses deterministic fake timers and a synthetic PR observation. It does not exercise the
hosted webhook or make a live write to session metadata.
