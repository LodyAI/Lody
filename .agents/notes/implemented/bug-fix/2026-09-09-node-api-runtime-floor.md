# Align the workspace Node constraints with SQLite's Node-API floor

Status: implemented
Translation: pending
PR: https://github.com/LodyAI/Lody/pull/72

## Abstract

The workspace accepted Node releases whose Node-API level cannot load the current
SQLite binding, allowing installation to succeed before the CLI crashed at import.
The root and both SQLite-owning packages now declare the exact Node-API 10 release
boundary, and root preinstall independently rejects a lower runtime. Future Node
majors remain allowed by the manifest because the executable guard checks the actual
Node-API capability rather than assuming it from the marketing version.

## Decision and boundaries

Use `>=22.14.0 <23 || >=23.6.0` in the root, CLI, and turn-diff-store manifests.
This excludes Node 22.0-22.13 and 23.0-23.5, where Node-API 10 is unavailable,
without rejecting later majors whose Node-API level is compatible. Keep diagnostics
and English, Chinese, machine-readable, and E2E contributor guidance aligned with
that range.

Run a dependency-free Node-API guard before the existing nested-workspace preinstall
guard. The check reads `process.versions.napi`, fails closed when it is missing or
below 10, and does not import the SQLite package. This is independent of pnpm's
`devEngines` behavior and leaves the repository's existing Corepack and strict pnpm
version controls unchanged. The Journey Foundry's explicit toolchain check reuses the
same capability decision instead of accepting every Node 22 or 23 release.

## Alternatives and trade-offs

A simple `>=22.14.0` range was rejected because it admits Node 23.0-23.5. Depending
only on `engines.node` or `devEngines.runtime` was rejected because package managers
may warn instead of stopping. Parsing `process.version` in the guard would duplicate
release-boundary knowledge and become stale; Node-API is the capability the native
loader actually requires.

The manifest range must name historical release boundaries, while the executable
guard accepts any future runtime that reports Node-API 10 or newer. These layers are
deliberately redundant: manifests guide tools and users, and preinstall prevents an
unsupported installation even when warnings are ignored.

## Evidence and limits

Focused tests compare all three manifests, inspect better-sqlite3's compiled
`NAPI_VERSION`, exercise supported and unsupported Node-API values, and launch the
preinstall guard in a child process. Package tests cover the CLI and turn-diff-store
runtime checks; Journey Foundry tests cover its toolchain gate; documentation
generation and repository boundary checks cover the published prerequisites. Node
22.13.1 with Node-API 9 has been rejected in a real run; future Node majors are
covered by capability logic but were not each executed.
