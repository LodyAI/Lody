# PR branch upkeep without post-turn auto-commit

Status: implemented
Translation: current

[中文](2026-09-12-pr-branch-upkeep-without-auto-commit.zh.md)

## Abstract

Turn finalization used to detect a dirty worktree on a PR-linked session and drive
the agent through extra commit and push turns — real ACP prompts that entered the
transcript, spent tokens, and committed work the user had not chosen to keep. The
obligation moved into the Create PR prompt, overridable in conversation, and two
probed flags became the fallback: a turn ending with unpublished work raises
`Commit & Push` as the top Info Bar action. An instruction is weaker than a hook,
so the risk is an agent ignoring it — the ranking makes that visible rather than
silently corrected.

## Decisions

- **Commit & Push outranks conflict repair, CI repair and Merge**: all three act on
  the pushed head, which unpublished work makes stale. A demoted Merge therefore had
  to stop being filtered out of the overflow menu.
- **Two flags, not one**: `workspaceDirty` goes false the instant the agent commits,
  while a failed push leaves the PR head behind. The first version shipped with only
  that flag and was worse than the old behaviour — the removed loop had a second
  phase for this. `workspaceUnpushed` uses local `git rev-list @{u}..HEAD`; the
  poller strips `headCommitSha`, so a PR-head comparison has no input.
- **Both cancellation routes refresh the flags**: a Stop during the prompt never
  reaches `finalizeTurn`, so covering one route left the common case broken.

## Limits

An inconclusive probe writes no key, so no stale `false` appears. Nothing refreshes
when a turn throws, or without a resolvable GitHub repo. How well agents honour the
instruction is unverified.
