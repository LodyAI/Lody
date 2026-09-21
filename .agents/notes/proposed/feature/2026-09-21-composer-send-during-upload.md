# Composer send during upload POC

Status: proposed
Translation: current

[中文](2026-09-21-composer-send-during-upload.zh.md)

## Abstract

Early sending during attachment upload needs one submission lifetime spanning both
upload waiting and downstream acceptance. An isolated real-composer POC exposed
three boundary defects, now corrected only in the experimental patch. The resulting
82 positive tests and component type check pass, and 12 targeted ablations each
cause behavioral assertions to fail. Production sources remain unchanged; actual
client visibility wiring, network transfer, and daemon delivery are not established
by this experiment.

## Decision and isolation

Follow the [draft contract](../../../../specs/composer-send-during-upload.md).
Use the existing submission token across both phases, then call the latest committed
send handler. Awaiting inside a captured handler retains stale routing; restarting
submission on upload callbacks risks duplicates. The wait is event-driven, without
timers. A File identity check permits image-to-local-file conversion while rejecting
partial or replaced selections. Run configuration and Role resolve together at
actual dispatch; a durable outbox and keypress-time config snapshot remain outside
scope. The existing [focus decision](../../implemented/bug-fix/2026-09-12-composer-click-focus.md)
continues to own focus interactions.

The [runner](../../../../packages/components/poc/send-during-upload/README.md) applies
one reviewable patch in a temporary worktree at current HEAD. This exercises the
real composer, draft caches, submission token, and route resolver without shipping
the experiment or copying the composer. Upload/local-file handoff and downstream
acceptance are simulated. It reuses installed dependencies and removes temporary
worktrees after completion. Production source, ordinary tests, and manifests remain
unchanged in the authoring checkout.

## Boundary findings

| Reproduced failure | Experimental correction |
| --- | --- |
| A late acceptance erased text written through the public imperative handle while the input was disabled. This cleanup behavior was inherited from the existing composer. | Clear only draft fields still matching the accepted snapshot. Preserve replacement fields. |
| A hidden composer still accepted a synthetic Enter without pending uploads. | Guard submission entry as well as upload waiting with visibility. |
| A previously failed ordinary file immediately cancelled an otherwise valid new image wait. | Failure checks cover this intent's selected files; already failed files stay excluded. |

Adding these boundary tests first produced three assertion failures. After the
corrections the expanded suite passed. Further tests cover preparation/verification,
partial failure before other uploads settle, machine removal, history refresh, Role
hydration, turn limits, cancel/resubmit, A → B → A, external text changes, attachment
removal, and a scope change in the ready commit. These are frontend boundary tests,
not claims that each failure is reachable through ordinary physical keyboard input.

## Ablation evidence

Reproduce with `node packages/components/poc/send-during-upload/run.mjs --ablate`.
The runner requires the positive suites and type check first, restores source after
each variant, and requires the named behavioral witness to fail with an assertion.
Process errors or incomplete collection are inconclusive, not successful detection.
All variants collect 82 tests.

| Removed protection | Failing tests |
| --- | ---: |
| Latest committed send callback | 3 |
| Synchronous submission lock | 2 |
| Visibility cancellation during waiting | 1 |
| Hidden-composer entry guard | 1 |
| Immediate cancellation on selected upload failure | 1 |
| Attachment membership check | 1 |
| Draft identity check after waiting | 1 |
| Acceptance-required clearing | 16 |
| Preservation of newer text on acceptance | 1 |
| Exclusion of already failed files | 1 |
| Shortcut inversion retention | 1 |
| Current-token check after readiness | 1 |

The current-token ablation initially survived all 81 tests: ordinary unmount tests
were protected by negative wait settlement too. A deterministic parent layout-effect
scope switch during the ready commit exposed the missing ordering case. The added
test passes with the token check and sends the old payload when that check is
removed. No sleeps, timers, network, or load-dependent races are used.

## Results and limits

The final isolated run passed 82 tests (62 composer, 20 route) and component type
checking. All 12 ablations were detected by behavioral assertions; no survivor is
hidden by treating a compilation failure as a caught mutation. Root `pnpm format`, runner formatting, and diff whitespace checks pass. The
pre-commit `pnpm check` stops in `packages/ignore` because its dependencies and
Node type declarations are missing; subsequent root checks did not run. Documentation retains the same 34 pre-existing
missing-submodule link errors, with no new errors.

This supports further POC use, not production readiness. The application still
blocks early sending; new-chat landing and restart recovery are not implemented.
The parent visibility prop is present in the patch but a running application's
wiring is not exercised. Real upload transport, provider delivery, and physical
Electron/mobile focus behavior require end-to-end validation. Passing this finite
mutation set does not prove absence of other state interleavings.
