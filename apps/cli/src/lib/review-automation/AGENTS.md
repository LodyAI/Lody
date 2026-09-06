# review-automation — Auto review and merge

Machine-side engine for "Auto review and merge": a review agent reads a branch,
blocking findings go back to the authoring session, and once nothing blocks and
CI is green the pull request is merged. File responsibilities, why this is not MCP
orchestration, and the bug history behind these rules: [README.md](README.md).

## Invariants

- **This loop steps around `LODY_MAX_CHAIN_DEPTH`, so its own budgets are the
  replacement safety mechanism.** Do not raise or bypass them without replacing the
  protection.
- **`review_only` and `review_and_merge` are the SAME state machine.** Keep it that
  way; do not fork a separate one-shot path.
- **A run whose session has no `SessionMeta.autoReview` is inert**: `step()` returns
  early. That is what makes unchecking the box stop a run wherever it is.
- **`SessionMeta.autoReview` is human-written only.** The reviewer and the author
  both have MCP access to the session; an agent able to grant itself merge
  authority makes the whole gate decorative. Same rule as a Task's `agent`.
- **Auto-merge must NOT reuse `deriveSessionPullRequestReadiness`.** That helper
  treats an ABSENT CI rollup as ready, which is right for enabling a manual merge
  button and wrong here: right after a push no check suite has registered and `s`
  is undefined, so reusing it merges before CI ever runs. `evaluateAutoMerge`
  requires `s === 's'` explicitly. There is a regression test for this.
- **The no-CI exemption is time-earned, never immediate.** `evaluateAutoMerge`
  accepts `ciAbsentConfirmed`, but only the engine may set it, via `trackCiAbsence`:
  one unchanged head must show no rollup for `NO_CI_GRACE_MS` (5 min, far past the
  check-suite registration race). The stamp map is engine-local, so a restart waits
  a fresh window — the safe direction. A pass waiting out the window gets no
  document events, so the engine arms `reevaluateLater` for the expiry. The planner
  forwards the exemption only while `s` is still undefined.
- **`awaiting_confirmation` alongside transient blockers waits, not blocks.** The
  confirmation is requested only when it is the SOLE remaining blocker; mixed with
  `ci_not_green`/`merge_state_not_clean`/`no_pr` the planner returns `wait`.
- **Restart resumes.** Unlike `task-automation/`, the first pass after a restart
  DOES act, because every run exists because a person ticked a box on that session
  and was told the branch is being watched. Do not copy that scheduler's baseline
  pattern over.
- **`REVIEW.md` is read from the BASE branch**, via `git show <baseRef>:REVIEW.md`
  in the prompt, and is in the default protected paths. Both halves matter: the
  file is ordinary repository content, so a branch that could rewrite the rules it
  is judged by — and then be merged automatically — would be approving itself.
- **A later round may not raise new suggestions.** Enforced in
  `applyReviewSubmission`, not only in the prompt. Without it the reviewer always
  spends the whole budget.
- **A dispute ends the loop** and escalates to a human. Two agents arguing is the
  expensive failure mode.
- **The reviewer runs read-only** (`ACP_PLAN_PERMISSION_MODE_ID`) and never posts to
  GitHub itself — the engine posts, and it writes an issue COMMENT, never a review,
  so Lody can never contribute to `reviewDecision`. `LODY_REVIEW_COMMENT_MARKER` is
  for humans reading the thread, not for that gate.
- **The human-review gate reads `reviewDecision`**, not a comment count. Plain
  comments are conversation; `CHANGES_REQUESTED` is where a person said no.
- **`approvedSha` stamping is a DISJUNCTION**: a fresh approval (`isFreshApproval`)
  re-stamps, OR an approval with no sha recorded yet stamps the first head that
  becomes known. Each of the three simpler rules has shipped as a bug; keep
  `resolveApprovedShaPatch` exported and unit-tested.
- **The fix prompt must say PUSH when a pull request exists.** The reviewer
  re-checks the local working copy while the merge gate reads the PR head from
  GitHub; a committed-but-unpushed fix therefore passes review and then merges a
  head without it. (Residual gap: nothing yet asserts local HEAD == PR head.)
- **Every gated state needs a reachable exit.**
  - `awaiting_merge_confirmation` is satisfied by the per-run `mergeConfirmed`
    flag the banner writes, NOT by the policy's `mergeConfirmedOnce` (whose only
    writer is the merge it gates). The grant relaxes only the confirmation
    blocker; every other merge gate still applies.
  - `paused` is left only by the banner's Resume, which restores `pausedFrom`
    AND re-seeds `lastEngineTurnId`. Without the re-seed it re-pauses on the very
    next pass, because the pause condition is that marker not matching.
- **Human input pauses the run**, and it outranks everything including a run one
  step from merging. A pause notifies: the user wrote a message, not "stop the
  automation", so it has to say that it stopped.
- **A failing step is counted, not just logged.** A throw leaves durable state
  untouched, so the same action would retry on every document change — for
  `start_review` that is a hot loop attempting session creation. Three
  consecutive failures block the run.
- **Merge method comes from the repository**, via `gh repo view`. A hardcoded
  `--merge` fails outright on squash-only or rebase-only repositories.
- **Finding ids are sequential over the run**, never `r{round}-{n}`.
- **Every terminal state produces a plain-language handoff and flags
  `awaitingUserSince`.** A run that stops silently reads as a run still working.

## Reviewer configuration

Review standards and budgets remain one workspace policy; reviewer execution is
configured separately per machine under `['reviewer', machineId]`, using the exact
`agentConfigId` plus ACP mode/model/config-option values. Authorize a new run only
when the reviewed session's machine has a usable row and that exact agent config
still belongs to it. Authorization freezes the machine reviewer into
`run.policy.reviewer`, so later setting edits do not mutate an in-flight review.
`agentType` stays in the frozen ref for old-daemon/run compatibility, but new
execution resolves by `agentConfigId`; never fall back to another same-type config
when the selected id disappears.
