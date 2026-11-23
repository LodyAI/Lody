# Tag releases

Status: draft
Translation: pending

## Scenario and behavior

A maintainer pushes a stable `vX.Y.Z` tag to record a source release. Automation
opens a draft PR against the default branch setting every direct app package's
version to `X.Y.Z`, then creates a GitHub Release with generated changelog notes.
If versions already match, no version PR is needed. The tag remains on its original
commit; the PR does not change the tagged source snapshot.

Release automation does not build or publish installers, updater metadata, npm
packages, or cloud deployments. GitHub's source archives remain available.
Existing releases and assets are preserved when a run is repeated.

## Operational limits

Repository settings must permit Actions to create PRs. A failure to synchronize
versions or open the PR prevents the subsequent release step. Default-token PRs
may need maintainer intervention to start CI. Independent tag pushes queued at
the same time follow GitHub concurrency semantics; maintainers should publish
tags sequentially. Merging an older version PR later can regress manifest versions;
maintainers must close superseded PRs.

## Evidence

- [Release workflow](../.github/workflows/release.yml)
