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
  and mark the conversation's sidebar row. This prevents the
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
  sends nothing unless the user turned it on, and stops with a visible reason while
  the workspace has uncommitted or unpushed work rather than pushing it; a silent
  wait read as "waiting for CI" forever.
- **No reported check is not a pass.** A new head reports no check until its suites
  register, so treating `null` as green merged before CI ran. A head counts as having
  no CI only after a five-minute grace measured between polls.
- **Earlier pull requests are not adopted.** Only a current pull request that both
  `SessionMeta` and its ledger observation show open or draft binds a new enablement;
  binding a merged one ended delivery immediately. The poller records the observation
  before it rewrites the metadata, so the property test found a pass that read a
  closed observation under stale open metadata.
- **Which stops are final.** A failed or cancelled request ends the enablement; a stop
  derived from the pull request's state is recomputed from each new observation, so a
  push or an approval resumes it within the same limits.
- **Turning off withdraws unsent work.** The engine leaves a disabled rule's receipt
  `blocked`, which still counted as Session automation work and kept the group from
  settling, so archive-after-merge never ran. Turning delivery off cancels the request
  if it has not reached the Session queue; queued input is already revoked by admission.
- **One writer for the status line.** A delivery pass and a setting change both write
  `SessionMeta.autoDelivery`. They share one Effect `Semaphore` separate from the
  engine gate, so a pass cannot republish a status the user just cleared, and turning
  the setting off never waits behind condition checks.

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
- Only the row's own mark shows stalled delivery. The sidebar's Focus / Later /
  Settled grouping ([sidebar status view](../../../../specs/sidebar-status-view.md))
  deliberately does not re-sort by live state, so a stalled conversation is not
  moved, and a snoozed or settled one shows the mark only where the row is visible.
- Validation is synthetic: ledger tests drive the request sequence, limits, guard
  and request text. No real repository, GitHub account or desktop run was made.
