# Changelog-only tag releases

Status: implemented
Translation: pending

## Abstract

Tag pushes previously built three desktop platforms and published installers and
update feeds, with macOS signing credentials gating all publication. The replacement
opens a draft app-version synchronization PR and creates a changelog-only source
release. Tags remain immutable, so manifest synchronization lands separately on the
default branch. Existing binary releases remain intact, but new releases provide
no installer or auto-update assets.

## Decision and limits

The [workflow](../../../../.github/workflows/release.yml) accepts stable version tags,
enumerates direct app manifests, and uses one version-specific PR branch. It requires
only repository contents and pull-request write permissions; no dependencies,
submodules, signing credentials, packaging runners, or release environment are needed.
It preserves existing release notes and assets on reruns. It intentionally does not
move tags or directly commit version changes to the protected default branch.

The lockfile stores app dependencies rather than app manifest versions, so this
version-only operation does not change pnpm-lock.yaml. Superseded version PRs require
maintainer closure, and the repository must allow Actions to create pull requests.
Validation covers the version-edit operation and workflow structure locally; live
tag publication is not exercised. Full repository checks are limited by this nested
checkout's missing dependencies and uninitialized submodules.

Intent: [tag releases](../../../../specs/tag-releases.md).
