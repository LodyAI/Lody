# Keep specialist acceptance out of routine PR validation

Status: implemented
Translation: current

English | [中文](2026-11-05-pr-ci-specialist-acceptance.zh.md)

## Abstract

Routine PR validation keeps static checks and affected package tests. Additional
E2EE and conversation browser acceptance run manually; desktop PR journeys require
an explicit label or manual dispatch. These suites verify specialized browser,
runtime and packaged-app behavior, but repeating their setup for every unrelated
change is not the default validation budget. This accepts later discovery of
browser or desktop regressions when authors do not request specialist acceptance.

## Decision

[`ci.yml`](../../../../.github/workflows/ci.yml) retains `Static checks`, the five
test groups and their required `Tests` aggregate. Ordinary E2EE package tests
remain automatic. Node 22 signature vectors already run in that package suite;
the manual acceptance matrix covers the additional Node 24 and 26 runtimes.

Conversation browser acceptance moves to a manual workflow. This partially
replaces the PR execution policy in the
[scroll engine decision](../architecture/2026-09-27-conversation-scroll-engine.md);
its behavioral contracts and browser regressions remain applicable.

Desktop PR journeys run with `e2e` or `e2e-full`, or by manual dispatch. Broad
source-path triggers are removed. Concurrency belongs to the desktop execution
job so an unrelated label event cannot cancel an in-flight run. The existing
daily three-platform full suite remains automatic.

## Trade-offs

A previous successful run does not establish that future changes cannot regress.
Manual browser acceptance and opt-in desktop journeys therefore reduce automatic
pre-merge detection. Authors can run the focused suite locally or select the branch
in Actions when changing those behaviors. The daily desktop suite detects failures
after merge; it does not prove an individual PR safe before merge.

Adding new nightly suites, new required gates or fine-grained browser path filters
was declined for this simplification. Static checks and ordinary behavior tests
remain useful for newly introduced regressions; local execution alone does not
make those checks redundant. The existing
[test-group and cache decision](2026-09-26-ci-test-groups-and-pnpm-store-cache.md)
continues to own parallel execution and cache behavior.
