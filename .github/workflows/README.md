# Code validation

[`ci.yml`](ci.yml) runs static checks and affected package tests on pull requests,
and full checks on main pushes and manual dispatch. Ordinary E2EE package tests
remain in those suites.
Tests run as one runner per group ([test groups](../../.agents/notes/implemented/testing/2026-09-26-ci-test-groups-and-pnpm-store-cache.md)),
and every Lody typecheck uses tsgo ([typecheck decision](../../.agents/notes/implemented/testing/2026-11-23-ci-typecheck-tsgo.md)).

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

## Cloud client releases

[`nightly-cloud.yml`](nightly-cloud.yml) and
[`release-clients.yml`](release-clients.yml) stage the public cloud client migration.
The five existing `publish-*.yml` workflows provide commit-pinned single-platform recovery.
Nightly iOS uses [`publish-ios-native.yml`](publish-ios-native.yml) to archive the
pinned native iOS client and upload it to TestFlight. Stable iOS recovery retains
the Capacitor publisher.
They remain disabled until `CLIENT_RELEASES_ENABLED=true`. See the
[integration and cutover guide](../client-releases.md) for A/B dependencies,
environments, npm OIDC, version reservation and rollback.
