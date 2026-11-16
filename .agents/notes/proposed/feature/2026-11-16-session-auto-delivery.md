# Session auto delivery: Lody drives the PR routine on request

Date: 2026-11-16
Status: proposed
Translation: current

[中文](2026-11-16-session-auto-delivery.zh.md)

## Abstract

Users repeatedly typed the same follow-ups after a fix was agreed: open a PR, skip
or run tests, fix CI, resolve conflicts, merge. Auto delivery lets them hand that
routine to Lody mid-conversation, from the Info Bar, the Session automation menu or
by asking the agent. The local Host watches the PR poller and sends the existing
quick-action requests one at a time; the agent still does every GitHub change. It
is opt-in per Session and pull request, bounded, and stops with a visible reason
instead of retrying.

## Decision

- **Lody drives each step from events, not one long instruction.** A single
  up-front prompt describing the whole routine would be the workflow text the
  [2026-11-11 prompt decision](../../implemented/simplification/2026-11-11-agent-prompts-without-workflow.md)
  removed, and agents tend to forget it or poll CI themselves. Each step instead
  sends the request the matching button already sends, with an origin line. The
  merge request adds one fact the agent cannot tie to the message on its own: the
  head commit whose checks passed.
- **Enabled mid-conversation, not at Session creation.** The user decides once the
  fix is agreed; a creation-time policy was considered and rejected by the user.
  The agent may turn it on when the user asks in conversation, without a second
  confirmation, through the existing `lody_automation configure` command.
- **Merge is a request to the agent, not a daemon mutation.** The CLI's PR access
  is read-only observation and the local summary path enables no mutations. Moving
  merge into the daemon would change that boundary; the agent's `gh` merge also
  follows repository rules. Cost: one short turn per merge.
- **Bounded and honest.** Three requests per repair kind per enablement and one
  merge per head. A request that pushed no new commit, a review requirement, a
  behind branch, a closed or draft PR, or a merge that did not land stop delivery
  and put the conversation in the sidebar's attention group. This prevents the
  unattended chains that motivated the 2026-11-11 decision.
- **Same automation machinery.** Auto delivery is a fourth Session policy beside
  archive-after-merge. A pass reads PR checkpoints (now including CI and merge
  state), publishes one deterministic `session.delivery.step` event, and the
  policy maps it to an `agent.invoke` with a `session.group.settled` condition and
  a current-head guard. Progress lives in a ledger checkpoint; the renderer reads
  `SessionMeta.autoDelivery`, written only on transitions.
- **Not a return to post-turn auto commit.** The
  [2026-09-12 upkeep decision](../../implemented/architecture/2026-09-12-pr-branch-upkeep-without-auto-commit.md)
  rejected finalization-driven commit turns the user had not chosen. Auto delivery
  sends nothing unless the user turned it on, and waits while the workspace has
  unpushed work rather than pushing it.

## Alternatives

- A creation-time delivery strategy with project defaults and a local test level:
  rejected by the user in favour of deciding mid-conversation; the test level is
  said in conversation.
- Detecting `until … sleep` loops and taking over: not part of this change; the
  CI wait is now Lody's, which removes the main reason to poll.
- Daemon-side merge through the poller's credential: rejected above.

## Limits

- Encrypted workspaces reject the setting because their PR poller is not
  registered; the menu explains why.
- Sessions with PRs in several repositories stop with `multiple_prs`.
- The folded sidebar group summary does not count stalled delivery; the row and
  the attention group do.
- Validation is synthetic: ledger tests drive the request sequence, limits, guard
  and request text. No real repository, GitHub account or desktop run was made.
