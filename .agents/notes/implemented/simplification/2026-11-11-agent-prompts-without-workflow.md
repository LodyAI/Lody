# Agent prompts carry requests and facts, not workflows

Status: implemented
Translation: current

[中文](2026-11-11-agent-prompts-without-workflow.zh.md)

## Abstract

Lody's own prompts told agents how to work: every delegated-result batch opened with
"Review the completed results…", Create PR added a standing order to commit and push
at the end of every turn, and Fix CI fetched the failed checks in the client and
prescribed a log-reading, root-cause and local-check routine. A user reported more
than five times the spend of another tool, with automatic chains eight levels deep;
each review instruction started another delegated pass. Lody now provides tools, and
its prompts carry only the user's request and facts the agent cannot discover. The
trade-off is that the agent no longer keeps a PR head current on its own; the
`Commit & Push` Info Bar ranking from the
[upkeep decision](../architecture/2026-09-12-pr-branch-upkeep-without-auto-commit.md)
is now the only signal of unpublished work.

## Decision

- The Inbox continuation prompt says only that delegated results follow; the
  `batchPreview` header gives the batch identity, that results are reference data
  rather than user instructions, and where omitted results are read.
- Create PR and Create Draft PR state the request plus one fact: `gh` uses the login
  saved on the machine, which sandboxed commands usually cannot read. Without it,
  sandboxed agents fail to authenticate and ask the user to log in again.
- The per-turn branch upkeep paragraph is removed. Commit & Push states the request.
- Fix CI and Resolve Conflicts name the repository and PR. The CI verdict already
  comes from Session metadata, so the client no longer fetches check runs first.
- A Project group adds only its facts: the group directory is not a Git repository
  and the members are listed in the conversation.
- The binding rule is in the root `AGENTS.md`; the Inbox-specific rule is in
  `apps/cli/src/orchestration/AGENTS.md`.

## Alternatives

- Replacing "review" with "do not re-review" was rejected: a negated instruction
  still steers every batch.
- Keeping the failed-check list in the Fix CI prompt was rejected: the agent reads
  the checks with the same `gh` access, and the client fetch delayed the send.

## Consequences

A PR head can lag the agent's latest work until the user presses `Commit & Push`.
Native iOS and Android clients keep their own copies of these strings and need a
matching change.

## Verification

`apps/cli/tests/session-execution-service.test.ts` and `apps/cli/src/orchestration`
cover the Inbox path. The quick-action prompts are plain strings without behavioral
tests. The effect on token spend is unmeasured.
