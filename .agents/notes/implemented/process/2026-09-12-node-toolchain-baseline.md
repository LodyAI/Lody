# Node.js 22.14 repository baseline

Status: implemented
Translation: pending
PR: pending

## Abstract

The repository previously advertised Node.js 22.0 while the published CLI and
native SQLite path already required Node.js 22.14. New build tools also exclude
early Node.js 22 releases, so a root install could satisfy the documented range
and still fail in a workspace package. The repository now declares Node.js 22.14
as its common minimum. CI continues to exercise the current Node 22 release, so
the declared floor remains a compatibility contract rather than a continuously
tested minimum. Newer Node.js releases remain supported by the open-ended range.

## Pressure

[`apps/cli/package.json`](../../../../apps/cli/package.json) and
[`packages/turn-diff-store/package.json`](../../../../packages/turn-diff-store/package.json)
already require Node.js 22.14 because `better-sqlite3` uses Node-API 10. The root
[`package.json`](../../../../package.json) and contributor setup guide still
accepted any Node.js 22 release. Vite 8 and Electron 44 also require at least
Node.js 22.12 for their development toolchains, making the old range an immediate
upgrade blocker rather than only stale documentation.

## Decision

The root `engines.node` and `devEngines.runtime.version` now match the existing
CLI floor at `>=22.14.0`. Contributor documentation names the same minimum. Code
CI and desktop E2E workflows keep their floating Node 22 selection so routine
checks continue to receive supported security and runtime updates.

The repository does not pin every developer to one Node.js patch release. Local
development may use any supported newer runtime. A dedicated minimum-version CI
lane would give stronger enforcement, but is outside this compatibility declaration.
Raising the minimum beyond 22.14 remains a separate decision.

## Verification

The change is limited to runtime declarations and contributor documentation.
Repository formatting, document checks, and the normal CI suite verify the
resulting configuration. No dependency versions, generated lockfile entries, or
workflow files change in this decision.
