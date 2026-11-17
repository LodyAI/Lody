# Agent prompts carry requests and facts, not workflows

Status: implemented
Translation: current

[中文](2026-11-11-agent-prompts-without-workflow.zh.md)

## Abstract

Lody's own prompts told agents how to work: every delegated-result batch opened with
"Review the completed results…", and Fix CI fetched the failed checks in the client
and prescribed a log-reading, root-cause and local-check routine. A user reported more
than five times the spend of another tool, with automatic chains eight levels deep;
each review instruction started another delegated pass. Lody now provides tools, and
its prompts carry only the user's request and facts the agent cannot discover. The
one standing instruction kept is the Create PR branch upkeep, because turn
finalization does not commit and the user asked for a PR that tracks the work
([upkeep decision](../architecture/2026-09-12-pr-branch-upkeep-without-auto-commit.md)).

## Decision

- The Inbox continuation prompt says only that delegated results follow; the
  `batchPreview` header gives the batch identity, that results are reference data
  rather than user instructions, and where omitted results are read.
- Create PR and Create Draft PR state the request plus one fact: `gh` uses the login
  saved on the machine, which sandboxed commands usually cannot read. Without it,
  sandboxed agents fail to authenticate and ask the user to log in again.
- The per-turn branch upkeep stays, shortened to one sentence. Commit & Push states
  the request.
- Fix CI and Resolve Conflicts name the repository and PR. The CI verdict already
  comes from Session metadata, so the client no longer fetches check runs first.
- An `@Role` mention becomes a reference, `[Agent Role: Name (agentRoleId: …)]`, not
  "use lody mcp to create a session…": the user's own words say what to do with the
  Role. The Lody MCP server instructions describe this format and say that
  `lody_session_create` accepts the ids, as they already do for Session mentions. Messages persist display spans, so native clients still render the chip;
  their legacy text grammar applies only to span-less messages.
- The iOS cloud runtime sends the same Session and Role references as Web. The
  Android runtime is a pinned snapshot of it and picks this up at its next re-snapshot.
- A capacity-recovery automation states that capacity is back and that the recorded
  tool results show what was completed, without a reconciliation procedure. An
  external-event delivery no longer adds "continue within the existing task".
- A Session created from a feedback post receives the postId only, not a named skill.
- A Project group adds only its facts: the group directory is not a Git repository
  and the members are listed in the conversation.
- The binding rule is in the root `AGENTS.md`; the Inbox-specific rule is in
  `apps/cli/src/orchestration/AGENTS.md`.

## Alternatives

- Removing the per-turn upkeep was rejected: without it a PR head lags the work
  until the user presses `Commit & Push`.
- Replacing "review" with "do not re-review" was rejected: a negated instruction
  still steers every batch.
- Keeping the failed-check list in the Fix CI prompt was rejected: the agent reads
  the checks with the same `gh` access, and the client fetch delayed the send.

## Consequences

`lody_session_create` guidance states facts about delegated prompts (history is not
copied) instead of prescribing their content. Native iOS and Android clients keep
their own longer copies of the quick-action strings; they are out of scope here.

## Verification

`apps/cli/tests/session-execution-service.test.ts` and `apps/cli/src/orchestration`
cover the Inbox path. The quick-action prompts are plain strings without behavioral
tests. The effect on token spend is unmeasured.
