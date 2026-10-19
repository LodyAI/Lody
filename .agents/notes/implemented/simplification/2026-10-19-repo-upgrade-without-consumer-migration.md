# Keep the Repo upgrade without the workspace consumer migration

Status: implemented
Translation: current
PR: [#1713](https://github.com/LodyAI/Lody/pull/1713)

[中文](2026-10-19-repo-upgrade-without-consumer-migration.zh.md)

## Abstract

#1607 coupled a released dependency upgrade with a broad rewrite of workspace
synchronization. The owner requested withdrawing that rewrite and the extra code
built on it. Product consumers return to the published Promise Repo and transport
APIs while retaining Repo 0.23.2, CRDT 0.19.0, Client 0.12.0 and Effect 4.0.2.
The stacked Session residency kernel and wiring are removed too. This restores
the earlier ownership behavior; it does not claim to solve its existing GC race.

## Scope and decisions

The reference is `8e6521a80` (#1607) against its parent, applied selectively to
current code. CLI managers/directory readers, renderer stores, eager workers,
shortcut sync and the local v7 client return to their earlier consumer APIs.
Remove the native workspace facade, leases, recovery machinery and its dedicated
tests. Keep the original Promise client in product source and retain its real
wire, persistence and synchronization coverage.

Also withdraw #1669/#1670 (`4e285b850`, `450595e07`), which explicitly stack Session
residency on #1607, and #1680 (`9d611b0d9`), which compensates for the native
transport's changed stream-creation default. The restored Promise transport
already creates missing streams. Later notification consumers use the original
cached document access. Remove the native observer-coalescing regression fixture
from #1666; its independent auto-archive retry behavior remains.

Retain the SDK RPC append deadline compatibility adjustment and the public
`RepoStreamsErrorContext` type needed for declaration emission. Keep the later
0.23.1/0.23.2 dependency upgrades and the lockfile intact. Native presence, tokens,
local writer, Turn failure-release repair, Roost input recovery and notification
features have independent responsibilities and remain in place.

## Ownership and limits

Existing workspace startup, room joins, cache eviction, reconnect and shutdown
trigger the restored Promise workflows. The original Repo/transport and application
owners again control persistence and subscriptions. Restore their existing
cancellation, handoff and failure behavior instead of layering native retry/fencing
contracts over them. A local wait is not a server acknowledgement or durability
receipt. The removed residency no longer protects a cached Session from concurrent
GC; that pre-existing race remains separate work under the restored ownership.

The [native ownership record](../../proposed/architecture/2026-10-16-native-workspace-repo.md)
and [Session residency record](../../proposed/architecture/2026-10-17-session-residency.md)
preserve the historical implementation and its evidence. They are not current
consumer contracts. The [release-only record](../architecture/2026-10-16-streams-repo-release-adoption.md)
still explains the retained upgrade.

## Verification

Frozen installation, full workspace typecheck, formatting, type-aware lint,
Effect lint, all 58 script tests, i18n and all repository boundary guards pass.
Full renderer passes 5,615 cases and full Shared passes 1,571. RPC passes 153
with three configured skips. Shared declaration emission and documentation
checking pass; documentation retains 69 warnings.

The full CLI run has 4,385 passes, four skips and one failure in the unchanged
`github-git-transport.test.ts` recursive native SSH clone fixture, which returns
`context_unreadable`. This makes the root `pnpm check` fail, and its remaining
package test chain is not reported complete. The five targeted execution suites
also pass all 360 cases after the environment restrictions were removed.
Production services, device recovery and packaging acceptance remain unverified.
