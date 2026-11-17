# Private composition builds on public runners

Status: implemented
Translation: current

English | [中文](2026-11-11-private-composition-public-runners.zh.md)

## Abstract

Lody's signed releases are built from the private composition, which owns the cloud Web entry, the cloud CLI and Electron build configs, and the root workspace that embeds this repository. Running those builds in the private repository bills every hosted-runner minute, while standard runners are free here. `build-private-composition.yml` now checks out the admitted private SHA read-only and runs the private repository's own build action, then uploads the result encrypted; the private repository signs and publishes. An earlier approach that compiled "cloud inputs" from public configuration was removed because it built a different product.

## Problem

The private Nightly and release workflows compile and package on `macos-15`, `windows-2022` and Ubuntu runners in a private repository, where minutes are billed and the budget has run out before. Signing and publication need private credentials; compilation does not.

## Decision

- The public workflow is a thin shell: validate the dispatch, check out `loro-dev/lody` at the requested SHA with a Contents-read App token, run that checkout's `public-runner-build` composite action, and upload its output with the pinned Buildgraph `upload` Action (AES-256-GCM, bound to repository, run, SHA and artifact name). A plaintext per-target index carries only the artifact ID, digest and source SHAs.
- What is built, with which commands and configuration, is decided in the private repository at that SHA. Changing the build never edits this workflow.
- The private consumer pins this repository, workflow path, branch `main` and run when it downloads, then signs, notarizes, generates update feeds and publishes. Windows and Linux installers are unsigned today, so the public stage is final there; macOS apps travel unsigned inside a tar because Buildgraph rejects symlinks.

## Alternatives

- **Compile from public configuration** (LodyAI/Lody#2474: `release.vite.config.mjs`, `release-builder.config.mjs`, `build-release-artifacts.yml`). Rejected and removed. The cloud product's Web entry, CLI and Electron configs, workspace overrides and patches live in the private composition; mirroring them publicly drifts and yields a local-only or subtly different app. Nothing consumed it.
- **A separate public build hub** (a Buildgraph fork or a dedicated repository). Rejected: this repository already holds the submodule source and free runners, and Buildgraph's Actions are usable by reference without forking.
- **Plain GitHub artifacts without encryption.** Rejected: public-repository artifacts are downloadable by anyone, and the outputs contain private bundles and source maps.

## Consequences

- Run logs, dispatch inputs and the index are public. Requests may carry only values already shipped in client bundles; build steps must not print sources or environments.
- Anyone who can dispatch here can build any private SHA. Dispatch requires write access to this repository, and the environment's branch policy keeps credentials on `main`.
- The workflow stays inert until the `private-build` environment and its App and key exist.

## Verification

The private consumer's request validation, mac signing parity checks and update-metadata merge carry its own tests. A real dispatch, cross-repository download, signed launch and update from the previous Nightly are unverified until the first Nightly runs with the credentials configured.
