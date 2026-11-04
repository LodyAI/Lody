# Code validation

[`ci.yml`](ci.yml) runs static checks and affected package tests on pull requests,
and full checks on main pushes and manual dispatch. Ordinary E2EE package tests
remain in those suites.

[`conversation-acceptance.yml`](conversation-acceptance.yml) runs the Storybook
hydration, history-header and scrolling browser regressions on manual dispatch.

[`e2e-smoke.yml`](e2e-smoke.yml) runs desktop journeys on manual dispatch or on
PRs opted in with `e2e` (smoke) or `e2e-full` (full). Subsequent commits keep
running the selected suite while its label remains. Unrelated label changes do
not start or cancel desktop runs. [`e2e-daily.yml`](e2e-daily.yml) retains the
existing daily full regression on macOS, Linux and Windows.

[`e2ee-acceptance.yml`](e2ee-acceptance.yml) runs the additional Node runtime
signature vectors and browser crypto, IndexedDB and custody acceptance checks
only on manual dispatch. Select **E2EE acceptance → Run workflow** in GitHub
Actions and choose the branch to verify. These checks no longer run automatically
on PRs or main pushes and are not dependencies of the required `Tests` check.

The [PR validation decision](../../.agents/notes/implemented/testing/2026-11-05-pr-ci-specialist-acceptance.md)
explains why specialist acceptance is opt-in while ordinary affected tests remain
automatic.
