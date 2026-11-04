# Wait for onboarding's final action

Status: implemented
Translation: current
PR: https://github.com/LodyAI/Lody/pull/1554

[中文](2026-10-14-e2e-onboarding-final-action.zh.md)

## Abstract

Desktop smoke failed while entering onboarding because the test required a Skip
intro button that had already disappeared. The intro can finish while the real
local CLI is starting, leaving Configure Lody available. The shared Page Object
now waits for that persistent final action directly. Product behavior, assertion
coverage and timeouts stay unchanged; no retry or fixed delay is introduced.

## Evidence and decision

The complete [Actions log](https://github.com/LodyAI/Lody/actions/runs/38506904691/job/115666416152)
shows installation, suite checking and desktop build succeeding, followed by five
passing smoke journeys and one failure in WINDOW-001's initial Given step. The
failure screenshot shows the final intro screen with Configure Lody; the trace
reports a timeout locating Skip intro. The intro advances through three beats
automatically, so CLI readiness does not guarantee the transient skip control exists.

Remove the prerequisite skip click in `OnboardingPage.openAgentConfiguration`.
Playwright waits for Configure Lody whether the intro is running or already done,
then the existing heading assertion verifies entry to configuration. This follows
the [application-readiness decision](2026-10-10-e2e-initial-renderer-navigation.md):
wait for observable state, without masking a failure through retries.

## Verification

Using isolated links to installed E2E dependencies, `pnpm e2e:check` passes all
24 scenario bindings, TypeScript and harness/tooling tests. A temporary browser
check of the real Page Object reproduces the old failure on a synthetic completed
intro; the repaired method reaches the configuration heading from both completed
and explicitly advanced intro states. That focused check is not desktop E2E.

`pnpm e2e:build`, root `pnpm check` and `pnpm format` cannot complete because the
checkout lacks product dependencies. Desktop smoke cannot launch without its built
main entry. Changed-file Oxfmt and `git diff --check` pass; macOS desktop validation
remains for CI. No user profile or running Lody instance was modified.
