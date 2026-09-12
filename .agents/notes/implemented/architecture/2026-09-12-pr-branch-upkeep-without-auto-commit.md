# PR branch upkeep without post-turn auto-commit

Status: implemented
Translation: current

[中文](2026-09-12-pr-branch-upkeep-without-auto-commit.zh.md)

## Abstract

A session with an associated PR used to have its turn finalization detect a dirty
worktree and drive the agent through extra, unrequested commit and push turns.
That machine-initiated write surprised users who had asked for something else,
and it ran on work they had not decided to keep. The enforcement moved from the
machine into the Create PR prompt, which now instructs the agent to commit and
push at the end of each turn and lets the user override that in conversation. The
`SessionMeta.workspaceDirty` + `workspaceUnpushed` probes become the visible safety
net: when a turn still ends with unpublished work, the Info Bar raises
`Commit & Push` as the HIGHEST-priority action item, ahead of conflict repair, CI
repair, and Merge. An instruction is
weaker than an enforced hook, so the remaining risk is an agent that ignores it;
the whole point of the ranking change is that this case is now visible instead of
silently corrected.

## The problem with the old behavior

`TurnPostProcessingService.autoCommitAndPushForPR` ran after every turn on a
PR-linked GitHub-capable session. It probed `git status --porcelain`, and on a
dirty tree it synthesized up to two extra agent turns ("commit all changes…",
"push your changes now"), then repeated the same loop for unpushed commits. Those
turns were real ACP prompts: they appeared in the transcript, consumed tokens, and
committed files the user had never approved. A user who ended a turn mid-experiment
found the experiment committed and pushed to their PR.

The mechanism also carried non-obvious weight. It needed an `AutoPromptRunner` to
open a turn outside the dispatch path, `onAutoPromptStart`/`onAutoPromptEnd`
callbacks threaded through `finalizeTurn`, a `TurnRuntimeState.autoPromptInFlight`
flag, an agent-cancel branch for "stop pressed during finalization", and an
`ExecutionSnapshot.hasActiveAutomation` bit that edit-and-resend consulted before
rewriting history. All of it existed only to serve this one hook.

## What replaced it

Three pieces, in the order a user meets them:

1. **The instruction.** `CREATE_PR_PROMPT` / `CREATE_DRAFT_PR_PROMPT` in
   [review-prompts.ts](../../../../packages/shared/src/review-prompts.ts) now carry
   a standing `PR_BRANCH_UPKEEP_INSTRUCTION`: keep the PR head current by committing
   and pushing at the end of every turn, treat it as the default, and skip it (out
   loud) only when the user interrupts or asks for something that overrides it.
   These prompts live in `@lody/shared` because the auto-review engine sends the
   same text, so the two paths cannot drift.
2. **The signal.** `updateSessionDiffStats` already probed the worktree and wrote
   `SessionMeta.workspaceDirty` onto the OWNER session's doc meta — the same entry
   that carries `pullRequests` and the poller's `pullRequestState`. It now also
   writes `workspaceUnpushed` (see the correction below), and is the only post-turn
   git work. Both probes stay conservative about an indeterminate result: a
   transient `git` failure contributes no key, so the durable value survives rather
   than being clobbered into a stale `false`. They are independent — one failing
   must not suppress the other.
3. **The action item.** `resolveSessionInfoBarGitHubActionIds` returns every
   applicable action in priority order instead of selecting one, with
   `commit-and-push` first whenever the tree is dirty. Rules and the full ranking:
   [sessions-info-bar.md](../../../docs/sessions-info-bar.md).

### The cancellation gap this exposed

`finalizeTurn` bails out of the remaining stages as soon as it sees the turn was
cancelled, and `updateSessionDiffStats` — the probe's only caller — sits after
those bail-outs. That was harmless while the machine auto-committed, because the
auto-commit path was skipped on cancel too. It is not harmless now: a user who
stops the agent mid-edit leaves a dirty worktree behind a `workspaceDirty` that
still reads `false` from the previous clean turn, so the bar offers nothing and
the PR looks current. Interrupting is exactly when a user is most likely to walk
away with unsaved work.

`TurnPostProcessingService.syncWorkspaceDirty` now publishes the flag on its own
(one `git status --porcelain`, no diff stats). Cancellation reaches it from TWO
independent routes, and the first attempt at this only covered one of them:

- `finalizeTurn`'s `stopIfTurnCancelled` bail-out — a Stop that raced finalization;
- `finalizeCancelledTurn` — a Stop while the ACP prompt is in flight. This is the
  ordinary Stop, and it never calls `finalizeTurn` at all, so covering only the
  first route would have left the main case broken while looking fixed.

The GitHub-capability gate lives inside `syncWorkspaceDirty` rather than at the
call sites: `finalizeCancelledTurn`'s five callers carry no `ProjectRef`, and a
second copy of the rule is exactly how two cancel routes drift apart. The helper
reads the active session's `project` and falls back to the owner's, so a Side Chat
that does not repeat the binding still reports its shared checkout. Both routes are
guarded so cancellation still settles if the probe throws, and a
`workspaceDirtyPublished` latch keeps a post-diff-stats cancellation check from
re-running the same probe. Reverting either production guard fails its test.

### Correction: a dirty tree is only half the signal

The first version of this change gated the action on `workspaceDirty` alone and
deleted `hasUnpushedCommits` along with the auto-commit loop that used it. Review
caught that this reopens the hole from the other side, and the reviewer was right.

`workspaceDirty` comes from `git status --porcelain`, so it goes false the instant
the agent commits. If the agent commits but the push fails or is skipped, the tree
is clean, the flag is `false`, the bar offers no `Commit & Push` — and because the
poller's readiness reflects the REMOTE head, it happily offers Merge. Merging there
lands a PR that is missing the local commits. That is the same "user thinks the PR
is current" failure this whole change exists to prevent, reached by a different
route, and it was made WORSE than the old behavior: the removed auto-commit loop had
a second phase that explicitly prompted the agent to push unpushed commits.

`hasUnpushedCommits` is restored (`git rev-list @{u}..HEAD --count`) and published as
`SessionMeta.workspaceUnpushed`. `getSessionGitHubState` combines the two into
`hasUnpublishedWork`, and the PR-linked `Commit & Push` gates on that. The no-PR
`Commit & Push` still gates on `workspaceDirty` alone — with no PR there is no remote
branch to be behind.

A local `@{u}..HEAD` count was preferred over comparing against the PR head: it needs
no API call, cannot be stale, and the PR poller deliberately strips `headCommitSha`
from `pullRequests` entries, so that comparison has no reliable input. The no-upstream
case returns `undefined` (inconclusive, no write) rather than `false`, because
reporting "nothing to push" for a branch with no tracking ref is exactly the false
all-clear being fixed.

`COMMIT_AND_PUSH_PROMPT` was softened to match: the action can now fire on a clean
tree, so the prompt says to skip the commit when there is nothing to commit and to
report a failed push instead of stopping silently. Both locale entries were updated
alongside it — the UI sends the localized string, so changing only the constant
would be a no-op in production.

## Why Commit & Push outranks Merge

This is the load-bearing part of the change. Without the auto-commit hook, a dirty
tree — or an unpushed commit — means the PR head is not the author's latest work.
The previous ranking put
`Resolve Conflicts`, `Fix CI Errors`, and Merge ahead of `Commit & Push`, and each
of those acts on the pushed head: merging would land a PR missing the changes still
in the worktree, and "fix CI" would reason about a commit that no longer represents
the branch. Promoting `Commit & Push` puts the only action that can make the other
three meaningful at the front.

The collapse rule makes this affordable. Only the top action renders as a text
button; the rest hang off the chevron, so promoting one action hides nothing. That
required one fix: `ContextChipActions` previously filtered merge actions out of the
overflow list, which was harmless while merge could only ever be primary. Once a
dirty tree can outrank it, that filter would have made a proven-ready PR
unmergeable from the bar, so a demoted merge now renders as a plain menu item that
performs the already-selected method. Choosing a different method stays the split
button's job, which returns as soon as merge leads again.

## Alternatives considered

- **Keep the hook behind a setting.** Rejected: the default is the whole problem,
  and a per-workspace toggle would have preserved every piece of the auto-prompt
  machinery for a path few users would enable.
- **Poll worktree dirtiness like PR status.** The PR reconciler polls GitHub on a
  schedule; dirtiness is local and only changes as a result of a turn. Turn-end
  detection is exact and free, and the reconciler's own rules forbid adding a
  turn-end hook to the scheduler. Rejected as cost without new information.
- **Add dirtiness to the per-PR `pullRequestState` entry.** Rejected: dirtiness is
  a property of the session's checkout, not of a PR — a session with two associated
  PRs has one worktree — and those entries carry a documented ≤50B budget.
- **Fold "unpushed" into `workspaceDirty` as one flag.** Rejected: they go stale at
  different moments, and a single flag named for the working tree would silently
  change meaning for `hasChanges` (which gates Create PR). Two honest booleans cost
  one extra byte of meta.

## Removals and their consequence

`AutoPromptRunner` and its test, `markPromptWorkingStarted`,
the `onAutoPromptStart` / `onAutoPromptEnd` callbacks,
`TurnRuntimeState.autoPromptInFlight`, and `ExecutionSnapshot.hasActiveAutomation`
are gone; nothing set or read them after
the hook was removed. `session-edit-and-resend-service.ts` consulted
`hasActiveAutomation` in three places before rewriting durable history. Leaving an
always-false field in a safety guard reads as protection that is no longer there,
so those checks now rest on their remaining conditions: `SessionMeta.autoReview`
and an active session goal. The narrowing is real and deliberate — the only
automation that bit ever reported was the post-turn commit prompt, which no longer
exists.

Also removed: the cancel-during-finalization branch that asked the agent to abort.
Finalization no longer runs an agent prompt, so there is nothing there to cancel;
the turn interrupt still fires.

## Verification and limits

`apps/cli`: the full suite passes except `tests/gh-shim-script.test.ts`, whose five
tests fail identically at the base commit (verified in a throwaway worktree at
`2acd5117`) — the spawned shim exits 1 in this sandbox, and none of its imports are
in this change. The child-session coverage that the deleted auto-commit test carried
was rewritten against `updateSessionDiffStats`, which is the path that still routes a
child Tab's dirty flag onto its owning parent's meta — the session the user is
actually looking at.

`@lody/components`: `session-info-action-state.test.ts` covers the new ranking, and
a new `session-info-bar-actions.test.tsx` drives the rendered bar to prove the
collapse behavior, including a demoted merge reaching `onMerge` from the chevron
menu.

Unverified: whether agents in practice honor the standing prompt instruction often
enough that the `Commit & Push` action item stays rare. That is a prompt-adherence
question no test in this repo can settle, and it is the reason the UI signal ships
alongside the instruction rather than after it.

Known limits of the signal itself. The flags are refreshed only when a turn
reaches finalization or one of the two cancellation routes, and only for sessions
with a resolvable GitHub repository. It therefore does NOT refresh when a turn ends
by throwing (an agent/model error aborts before `finalizeTurn`), nor for a yielded
turn superseded by a new prompt — though the superseding turn's own finalization
covers that case. A hard turn failure that left edits behind can still show a stale
`false` until the next turn settles; the failure is visible in the transcript, which
is why this was left rather than widened into every error path.
