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

Pin `@loro-dev/roost-node@0.1.1` as a CLI runtime dependency and exempt only that
version and its six exact platform dependencies from the release-age policy.
Keep `@loro-dev/roost@0.1.2` for identity,
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

## History mutation and command routing

Status corrections must not reset the active view or recreate a sealed primary.
Mutable state records are anchored to their primary and projected as the same
business turn. Permission responses use the SDK's independent response record;
readers join the outcome onto the corresponding tool without sealing an ongoing
assistant. Ordinary changes refresh affected bodies only.

For structural copy/edit/import, stage a complete history through public SDK
operations in an independent generation. Publish a signed application-owned
activation in the old stream with one native event-cursor CAS. Failed preparation
or a concurrent old-stream write retains the old branch. Never reproduce SDK
envelopes/index formats or rewrite sealed storage. Serial generation resolution
and guarded old handles prevent concurrent readers/writers using a superseded view.
Count/position reads refresh after a lost activation reply; local write barriers
republish that committed projection before RPC binds its durable control revision.
Recovery does not replay an indeterminate action.
Old generations remain archived; reclamation and arbitrary old-adapter downgrade
compatibility are not established by this repair.

ACP output and stable per-item receipts commit together, including chunked batches;
retries find receipts through prior generations. Imports bind their baseline and
source cursor to the same activation; Loro cursor failure is indeterminate and
reopening reads the committed native baseline. Conditional tail rollback retains
later appends and refuses concurrent edits. Fork uses the shared writer's sole
snapshot provenance registry and preflights all collisions before a whole prepend.

Both Cloud one-shot manager entry points inject the same owner RPC composition,
covering session commands, export and MCP history. Native execution remains with
the daemon; only local MCP reuses its manager, whose access gate refuses foreign
machines. RPC directory reads clip to the owner count, batch within the 500-row
limit and restart a moving revision. Fork/Edit & Resend keep their owner sagas;
process-local snapshot/compensation handles are not sent over RPC. New-session
preferences negotiate target capabilities before any durable write.

## Verification

### Production adapter repair (2026-10-09)

The final focused suite passes 27 cases: 23 production-history contracts using
actual SessionDocument, LoroRepo and published native SQLite, plus four RPC/backend
cases. Coverage includes seven durable queue failure stages, sealed status
correction, permission followed by sparse tool/text output, held cross-session
Fork captures, opaque stored values, failed private staging, concurrent generation
resolution, stale activation/old handles, per-item receipt retries, conditional
rollback, import cursor failure across reopen, and count/position recovery after
an activation reply is lost. The recovery barrier republishes the committed
projection without replaying the action.

Transport tests enforce the actual RPC range schema and revision restart. A real
owner SQLite composition test exercises the common Cloud factory and owner-failure
propagation. Renderer tests reject explicit unsupported Roost before creation
side effects. The complete `pnpm check` passes: CLI 3604 with four existing skips,
shared 1302, shared components 4892 and Electron 214. Formatting, documentation,
public/platform guards and the rebuilt CLI publication smoke also pass.

The synthetic production benchmark uses 100 and 1000 turns with 4 KiB bodies,
one warm-up and two measured samples. Each Roost open/older read loads one
40-turn page; ten streaming updates use no full history or branch-page reads.
It excludes RPC, renderer paint, IndexedDB, real provider execution and generation
churn. Logs: `/private/tmp/lody-roost-repair-bench.json`,
`/private/tmp/lody-roost-native-contract.log`, `/private/tmp/lody-roost-repair-check.log`
and `/private/tmp/lody-roost-repair-published-bundle.log`.
This repair uses the existing 0.1.1 runtime; no new npm publication is required.

### Published runtime and packaging checkpoint

The user published all six platform packages and the main package at 0.1.1.
The main tarball integrity matches the prepared release; its installed package
contains no binding and resolves only the host platform. Actual published-package
staging passes for all six targets through the installed-host or production public
npm download path. Fixtures cover adjacent/split layouts, exact-version mismatch
and failed-download preservation. Signed host SQLite reopen passes; foreign
binaries are selected on disk locally. The upstream six-platform release
[CI](https://github.com/loro-dev/roost/actions/runs/37877651895) supplies execution
coverage for those targets.

Before this history repair, source `8b1073e0ceef32829b0230ab64801f6a34e36c01`
passed [CI](https://github.com/LodyAI/Lody/actions/runs/37889429418) and
[Desktop E2E](https://github.com/LodyAI/Lody/actions/runs/37889429365).
The normal CLI build passed with a 2 GiB heap; the renderer build used its normal
configuration and contained no native Roost imports. Normal macOS arm64 OSS
0.104.0 directory packaging passed actual CLI boot, native binding and Worker
signed SQLite write/reopen probes. It contained native runtime 0.1.1 and exactly
one 8,021,248-byte host binding, SHA-256
`1d0e23d144491d5e566de679a6a9e2477332027a98e86af74849a4c60a983d93`,
matching the published artifact. This packaging checkpoint predates the adapter
repair; it is not a claim that a new signed application was released.
Logs: `/private/tmp/lody-roost-011-check-merged.log`,
`/private/tmp/lody-roost-011-package.log` and `/private/tmp/lody-roost-011-platforms.log`.

Private Web/mobile builds, remote deployment, browser-local offline replicas,
non-host full desktop packages, release signing/notarization and archived-generation
reclamation remain outside this validation. Test databases are synthetic and
isolated; no user history is used.
