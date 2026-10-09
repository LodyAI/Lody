# Roost native runtime and shared clients

Status: proposed
Type: architecture
Translation: current
PR: [#1329](https://github.com/LodyAI/Lody/pull/1329)

[中文](2026-10-09-roost-native-runtime.zh.md)

## Abstract

The npm history adapter previously required a separately built Roost executable,
so a public Lody checkout could not build or package the experimental backend.
The CLI now consumes the published Node-API package with its SQLite implementation
running in a Worker. Electron stages that package with one target prebuild; shared
Web and mobile clients retain the existing history RPC interfaces. This change
does not establish browser-local IndexedDB replicas or offline Streams sync.

## Decision and boundaries

Pin `@loro-dev/roost-node@0.1.0` as a CLI runtime dependency and exempt only that
version from the release-age policy. Keep `@loro-dev/roost@0.1.2` for identity,
application JSON, and `NodeLodyHistory`. Neither Rust source nor a sibling Roost
checkout is needed to install, build, or package Lody.

Use `RoostNativeClient` directly. Preserve the database path, credential-store
seed, admitted owner, bounded queue, shared stream leases, and awaited final close.
Worker initialization failures close the failed client before releasing its lease.
Retire subprocess binary and client-path discovery. Historical owner architecture
is described by the [transition proposal](2026-09-30-roost-transition-delivery-lifecycle.md).

Externalize the native npm package intact so its client, Worker, and binding
keep their relative paths. Electron stages it in `resources/cli/node_modules`
and copies it into `app.asar.unpacked` before signing. Select exactly one of the
six published macOS, Windows MSVC, or Linux GNU arm64/x64 binaries per artifact.
Unsupported targets fail during packaging. Linux musl is not supported; the
published Linux builds require glibc 2.35 or newer.

Web and iOS reusing shared components never import this Node package. The existing
remote history bridge reads and writes through the owning machine's advertised
`sessionHistory: 2` RPC contract. The machine must be available. Browser Roost
storage is available from the browser package, but this repository does not
compose an IndexedDB replica or authorize a new sync scheduler. Public Web/mobile
application sources are outside this repository's boundary.

The [feature gate](../feature/2026-10-08-roost-history-feature-gate.md) still controls
new-session selection. Loro remains the default; existing backend discriminators,
history, Loro control metadata, and transport authorization remain unchanged.

## Verification

### Platform package compatibility (2026-10-09)

Roost is preparing 0.1.1 as a small main package with six optional platform
packages. Extend Electron staging to accept both an adjacent 0.1.0 prebuild and
a matching installed platform package. A foreign target may download only the
exact platform version declared by the main package, using the existing public
npm packaging path. Copy the selected binary adjacent to the staged loader so
the unpacked application still contains one binary and preserves Worker paths.

Staging validation passes for all six targets, real host SQLite reopen, version
mismatch and failed-fetch preservation. The existing suite adds two behavioral
cases using real published binaries in both installed and downloaded split layouts;
all 214 Electron tests pass. Keep the CLI dependency pinned to the
published 0.1.0 until the user publishes the complete 0.1.1 release; this prepares
compatibility without making public CI depend on an unpublished version.

Formatting, documentation, type checks, lint and public/platform guards pass.
A new macOS arm64 directory package through the normal wrapper passes CLI boot,
native Worker and SQLite reopen probes, retaining exactly one 8,021,248-byte Roost
binary. This package still uses the pinned 0.1.0. The final upstream 0.1.1 bundle
also passes all six real platform-package selections and signed SQLite reopen
on Node 24.14 and the actual packaged Lody Electron executable, using temporary
unpacked runtime directories and synthetic databases. The dependency upgrade
remains deferred until the user publishes the complete release.

The full local `pnpm check` reaches an unrelated CLI failure: the simulator
guest-buttons descendant shutdown test raises `kill EPERM` on macOS (3529 CLI
tests passed, four existing skips). An isolated archive of unchanged HEAD
`6f5332f` reproduces that exact failure, with four other cases passing. No simulator
source was changed. Logs: `/private/tmp/lody-roost-split-check.log` and
`/private/tmp/lody-roost-split-baseline-test.log`.

All [CI checks](https://github.com/LodyAI/Lody/actions/runs/37878236234) and
[Desktop E2E smoke](https://github.com/LodyAI/Lody/actions/runs/37878236205) pass
on source commit `8e6cf25de374b50dbaa6b3582710d0a17b265f0c`. The upstream six-platform
build and complete 0.1.1 release preparation also
[pass](https://github.com/loro-dev/roost/actions/runs/37877651895). No npm upload
or dependency upgrade was performed. The previous evidence below refers to the
original integration commit.

The actual published tarball integrity matches the prepared release. A clean
consumer passes signed history batches, SQLite reopen, and encrypted Streams
loopback tests on Node 24.14 and Electron 43.7.6. These verify the published native
package, not Lody's remote deployment or a mobile application.

The three existing native history adapter suites run without a sibling checkout
or a skip gate. The production-backend benchmark fixture opens a real
`SessionDocument`, reads 80 turns through the shared view, pages backward, and
updates assistant output. A synthetic sealed history database is readable after
switching from the legacy executable to the native addon and back; the legacy
comparison used the macOS arm64 debug build, not the Linux artifacts stored in
another checkout.

`pnpm install --frozen-lockfile`, `pnpm check`, `pnpm format`, documentation checks,
and the public/platform boundary guards pass. The CLI has 3530 passing tests and
4 existing skips; shared components have 4885 passing tests; Electron has 212
passing tests. The former four CLI failures were stale fixtures: runtime-config
writes need awaiting and machine capabilities include `sessionHistory: 2`.

`pnpm --dir apps/electron build` passes with the CLI's 2 GiB build heap. Its renderer
output has no native Roost imports. A macOS arm64 directory package, produced by
`package-electron.mjs` with publishing disabled, passes the actual packaged CLI
startup, native Worker, SQLite write/reopen, and existing native dependency probes.
This is a local packaging probe, not a signed/notarized release.

Packaging tests select all six published prebuilds and run the host's staged
Worker against SQLite; rejected targets leave the working runtime usable. Other
OS/architecture binaries are selected and checked on disk locally, not executed.
The upstream native package's six-runner CI provides those execution results;
Lody's remote deployment, private Web/mobile app builds, offline browser replicas,
and non-host full desktop packages remain outside this validation.
