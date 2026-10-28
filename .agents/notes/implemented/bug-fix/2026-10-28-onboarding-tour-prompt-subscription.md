# Keep onboarding tour prompt subscriptions isolated

Status: implemented
Translation: current

[中文](2026-10-28-onboarding-tour-prompt-subscription.zh.md)

## Abstract

Desktop onboarding crashed when its product preview mounted the composer, preventing
all six smoke journeys from reaching Agent configuration. The composer now reads
prompt suggestions, but the tour's isolated runtime lacked that subscription method.
The fixture now reports no suggestion and returns an inert cleanup function. The
preview remains isolated from real workspace subscriptions and persistence.

## Evidence and decision

- [PR #1998](https://github.com/LodyAI/Lody/pull/1998)'s
  [failed job](https://github.com/LodyAI/Lody/actions/runs/40626372854/job/122612190080)
  built successfully, then all six scenarios failed waiting for the Agent configuration
  heading. Its screenshots and traces show `subscribePromptSuggestion is not a function`.
  The affected fixture and hook are unchanged between base `574cfb00a` and PR head
  `91d320cfa`; the chat-directory cleanup change did not introduce this missing method.
- [TourApp](../../../../packages/components/src/components/onboarding/tour/tour-app.tsx)
  mounts the real composer against [its own runtime](../../../../packages/components/src/components/onboarding/tour/tour-fixtures.ts).
  The [prompt-suggestion composer integration](../feature/2026-10-27-prompt-suggestion-composer-ui.md)
  calls the required subscription through the normal hook. Supply its empty read contract
  in the fixture; do not weaken the production hook or the E2E heading assertion.
- The [existing isolation test](../../../../packages/components/tests/tour-app-cloud-isolation.test.tsx)
  now exercises the real prompt-suggestion hook at the reused composer boundary, asserting
  a rendered empty hint alongside the synthetic machine/project visibility data.

## Verification and limits

Before the fixture fix, the expanded test and a freshly built Electron onboarding
journey reproduced the same missing-method failure. The four focused fixture/hook
suites pass six tests after the fix. Rebuilt OSS desktop smoke passes all six scenarios
and 42 steps with the original E2E assertions. The subscription intentionally produces no live
suggestions; this repair does not establish external Agent suggestion delivery.
