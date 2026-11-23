# Composer send during upload

Status: implemented
Translation: current

[中文](2026-09-21-composer-send-during-upload.zh.md)

## Abstract

Sending before attachment uploads finish now uses one submission lifetime spanning
upload waiting and downstream acceptance in the production session composer. The
composer locks the draft, waits for all selected attachments, and dispatches once
using current routing while preserving the shortcut intent. Cancellation and failure
restore the draft. Unit and browser coverage validate frontend boundaries; native
provider delivery and restart recovery are outside this verification.

## Decision

Implemented in [PR #879](https://github.com/LodyAI/Lody/pull/879), following the
[draft contract](../../../../specs/composer-send-during-upload.md).
Use the existing submission token across both phases, then call the latest committed
send handler. Awaiting inside a captured handler retains stale routing; restarting
submission on upload callbacks risks duplicates. The wait is event-driven, without
timers. A File identity check permits image-to-local-file conversion while rejecting
partial or replaced selections. Run configuration and Role resolve together at
actual dispatch; a durable outbox and keypress-time config snapshot remain outside
scope. The existing [focus decision](../bug-fix/2026-09-12-composer-click-focus.md)
continues to own focus interactions.

Configuration controls are unavailable while submission is pending, preventing
changes through this composer while preserving current routing. The parent supplies
visibility including share-selection hiding; this gates new intents, while a hidden
mounted composer continues an existing upload wait. Unmount still cancels it. The implementation
and behavioral tests now live in their ordinary source and test suites; the isolated
patch runner has been removed. The top-level new-chat landing retains upload blocking.

## Boundary findings

| Reproduced failure | Correction |
| --- | --- |
| A late acceptance erased text written through the public imperative handle while the input was disabled. This cleanup behavior was inherited from the existing composer. | Clear only draft fields still matching the accepted snapshot. Preserve replacement fields. |
| A hidden composer still accepted a synthetic Enter without pending uploads. | Guard new submission entry with visibility; hiding no longer cancels existing waits. |
| Upload readiness cleared a mutable ref without rendering, leaving an actionable Cancel during slow acceptance. | Explicit waiting/dispatching state removes Cancel send at readiness; deferred acceptance tests assert the button and config lock. |
| A previously failed ordinary file immediately cancelled an otherwise valid new image wait. | Failure checks cover this intent's selected files; already failed files stay excluded. |

Adding these boundary tests first produced three assertion failures. After the
corrections the expanded suite passed. Further tests cover preparation/verification,
partial failure before other uploads settle, machine removal, history refresh, Role
hydration, turn limits, cancel/resubmit, A → B → A, external text changes, attachment
removal, and a scope change in the ready commit. These are frontend boundary tests,
not claims that each failure is reachable through ordinary physical keyboard input.

## Ablation evidence

Before adoption, an isolated worktree experiment tested 12 targeted removals of
protections. Each collected all 82 tests and failed its named behavioral assertion;
process or compilation errors did not count as detection. This is historical evidence
from the isolated experiment, not a newly run production mutation suite.

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

The production suites pass 82 tests (62 composer, 20 route) and component type
checking. Eight browser cases pass in installed Chrome at 390px and 1280px widths:
Enter, Cmd+Shift+Enter, cancel, and upload failure. They exercise the real Storybook
composer and XMLHttpRequest transport with intercepted upload responses and a
simulated downstream callback with deferred acceptance. A unit regression first
reproduced the stale Cancel before the explicit phase correction. The browser fixtures use synthetic attachments.

The original experiment detected all 12 ablations. The normal suites retain the applicable boundary witnesses. The historical
visibility-cancellation witness is replaced with hidden-tab continuation coverage
after the product decision to preserve submitted intents across Tab switches. Passing a finite mutation set does not prove absence of other
state interleavings. Daemon delivery and physical Electron/mobile focus behavior
remain unverified. Upload waits are memory-only and have no restart recovery.
