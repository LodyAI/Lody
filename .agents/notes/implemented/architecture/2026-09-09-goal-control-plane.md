# Give goal actions their own control plane instead of the `/goal` prompt bridge

Status: implemented
Translation: pending

## Abstract

Pausing or resuming a Codex goal was delivered as a chat message (`/goal pause`,
`/goal resume`), so it needed the session's ACP prompt slot — the same slot the
running goal holds open across the agent's own continuations. The dispatch
watcher silently deferred those turns with `guard-noop-active-session`, and the
goal banner disabled every button while it waited, so the visible symptom was a
paused goal whose Resume button did nothing until the user pressed Stop. Goal
actions now split by what they do: `pause` and `clear` travel out of band on the
`_lody/session/goal` extension request and take effect mid-prompt, while `set`
and `resume` ride a Lody-owned prompt as `_meta.lody.goalControl` metadata and
queue behind a draining turn instead of being dropped. The split is a protocol
change across `acp-extension-core` and the Codex adapter; it was verified with
adapter, CLI, and component tests, not against a live Codex goal.

## Problem

`GoalPromptLifecycle` (Codex adapter, September 2026) made one ACP v1 prompt span
every native continuation of an active goal. That is the right lifecycle — it is
how the goal's turns stay attributable to one conversation entry — but it means
an active goal permanently occupies the session's only prompt slot.

Lody's goal controls were prompt text. Each press wrote a pending user turn and
asked the CLI to dispatch it. `resolveSessionDispatchAction` returns
`noop('active-session')` whenever a turn is active, so the turn sat pending until
the goal's prompt closed. Meanwhile the banner's `pendingGoalCommand` only cleared
when the goal status actually changed, with no timeout, and it disabled all goal
buttons. Cancelling the turn was the only user-reachable way out, which is exactly
the workaround users found.

Pause had already accumulated compensations for the same root cause: the Stop
button sent its own `/goal pause`, and the adapter paused the goal itself in the
cancelled-prompt path. Both exist because the bridge could not deliver a command
during a prompt.

## Decision

Split goal actions by whether they start work.

Status-only actions (`pause`, `clear`) go out of band. `acp-extension-core`
already defined `_lody/session/goal`; the capability now names which actions are
safe there (`controlActions`) and Lody finally calls it. No turn, no prompt slot,
no queue.

Work-starting actions (`set`, `resume`) need somewhere to put the resulting
turns, and ACP v1 gives a client exactly one such place: its own prompt. Core
gained `LodyGoalPromptControl`, carried on `prompt._meta.lody.goalControl`, and
the adapter routes it into the same code as the slash command. The conversation
never carries command text, and the adapter still adopts a turn Codex started
natively rather than submitting a duplicate.

The CLI owns the ordering. `SessionExecutionService.controlSessionGoal` sends the
request when the transport allows it; otherwise it opens a goal turn
(`dispatchSource: 'goal'`, no user message, no run configuration) or queues one
behind the running turn using the existing `waitForTurnRelease`. One queued action
per session, newest wins, bounded to three turn waits.

The UI now reads `goalActions` from the ACP capability cache instead of testing
`agentType === 'codex'`, and its pending state expires after a minute so a slow
action cannot leave the banner dead.

## Alternatives

**Let the adapter start the resumed goal's turn itself.** The adapter already has
`startGoalContinuationIfCurrent` for clients that cannot send prompt metadata.
Rejected for Lody: the CLI would receive session updates for a turn it never
prompted, and `SessionTransientStore`'s late-update routing would append them to
the previously finalized assistant entry — no turn boundary, no running status, no
Stop button.

**Keep the prompt bridge and only fix the queueing.** This would have removed the
dead Resume button without a protocol change, but pause would still be undeliverable
during the prompt it needs to stop, and Stop's `/goal pause` compensation would
have to stay.

**Allow only `set`/`resume` as prompt metadata.** Cleaner conceptually, but it
leaves no way to clear a goal whose session is not running: the request path needs
a live agent. Status-only actions are therefore accepted on both transports, with
the request preferred.

## Consequences and limits

`ACP_CAPABILITY_CACHE_VERSION` moves to 8 so machines re-probe and publish
`goalActions`. Until a session's machine refreshes, goal buttons are hidden rather
than wrongly shown — the conservative direction.

`acp-extension-core` is now 0.1.2 and the Codex adapter depends on that version.
Inside this workspace the pnpm override resolves it to the local source; a
published adapter build needs the new core release first.

A paused goal can still be draining its last native turn, and that is now visible
rather than hidden: the queued resume waits and then runs. It no longer requires
Stop, but it is not instant either.

Both submodules need their own PRs before the pointer bump here lands.
The [goal control Spec](../../../../specs/session-goal-control.md) is draft.

## Verification

Adapter: prompt metadata resumes a goal without command text and without a second
`turnStart`; the parser accepts every advertised action and rejects a blank
objective, an unknown action, and a future version. The existing goal-lifecycle,
transport, and thread-event suites still pass (37 tests).

CLI: transport selection prefers the request for status-only actions, keeps
work-starting actions on a prompt even when the agent lists them as control
actions, falls back to the slash bridge for runtimes advertising neither list, and
refuses unadvertised actions. Execution-service tests cover out-of-band pause
without a turn, a refused action, a goal turn carrying no run configuration, a
resume queued behind a draining turn and released deterministically by clearing
the current turn (no timers, no sleeps), and newest-wins supersession. The CLI
suite passes except `tests/gh-shim-script.test.ts`, which fails in this sandbox on
files this change does not touch.

Components: goal commands derive from advertised actions, including a partial
advertisement. Typecheck passes for shared, RPC, CLI, and components.

Not verified: a live Codex session pausing and resuming a real goal, and the
managed-runtime build path that consumes a published `acp-extension-core`.

Follow-up correction (2026-09-10): the [independent review and ablation](../simplification/2026-09-10-goal-control-ablation.zh.md)
found gaps in startup acknowledgement, cross-transport supersession, and cold-session
status control. Those implementation defects remain unresolved; the intended
guarantees above are not evidence that these scenarios currently work.

Merge integration (2026-09-10): retain both `SessionGoalAction` and Core's
`createPlanModeConfigOption` imports when merging main. Core's goal branch now
also includes main's worktree-project contract (`2812417`), while Codex stays on
merged PR #39 (`33d897b`). Choosing either old Core pointer alone would drop a
required contract. Core build/typecheck and Codex typecheck pass with the combined
contract; CLI ownership/goal tests (122), Codex goal/fork/worktree tests (52), shared
capability/config tests (26), and goal UI helper tests (5) pass. This resolves the
dependency mismatch, not the previously recorded host-side P1 findings. The Core
goal branch still needs its own merge/release before registry-only consumption.
Full workspace typecheck and lint also pass; `pnpm check` reaches tests but is
terminated at the five-minute limit, so the full suite is not a passing signal.
Formatting, docs check, and the public-boundary check pass; unrelated formatter
churn is excluded from the merge.

Release integration (2026-09-10): Core PR #7 is merged and 0.1.4 (`4c8ffe9`)
contains both contracts; the earlier 0.1.3 package did not include goal prompt
controls. Codex now pins 0.1.4 in its manifest and npm lock, including the registry
integrity. In a separate clone without the workspace override,
`npm ci --include=dev --ignore-scripts` installs the published package and both
Codex typechecks plus 52 goal/fork/worktree tests pass. Workspace frozen-lockfile
installation, Core build, and Codex typecheck also pass. The existing root pnpm
lock needs no change because Core remains a workspace link. This closes the
registry dependency gap above; it does not resolve the host-side P1 findings.
