# Simulator preview implementation

`service.ts` owns ephemeral operations, `control-leases.ts` excludes competing
sessions across workspaces, and `devices.ts` is the simctl boundary. Lifecycle RPC
uses the shared `iosSimulator: 1` capability and `ios-simulator/control` command
union. Browser owns a separate service and separate transport instances.

The pinned Baguette executable runs in an IPC-owned worker. The native HTTP API
stays on loopback; only the bound device's MJPEG stream and validated single-pointer
input cross `gateway.ts`. The gateway serves the fixed `viewer.ts` artifact. The
React iframe validates source/origin/operation before accepting viewer state;
frames never enter React, RPC, or synchronized documents.

## Runtime artifact

`baguette-manifest.json` pins the Lody-patched archive and executable digests. The
installer fetches only the platform runtime channel:

```
/api/runtimes/baguette/0.2.1-lody.1/darwin-arm64/baguette_v0.2.1-lody.1_macOS_arm64.tar.gz
```

The deployment composition must publish these exact bytes before shipping. The
private distribution repository provides `mirror-agent-runtimes.mjs --runtime
baguette` (use `--dry-run` to inspect the plan). There is no upstream, Homebrew or
PATH fallback. Reuse the verified versioned cache; downloads need connectivity,
while a cached same-machine preview does not require Cloud authorization.

`baguette-notices.json` contains Baguette's Apache-2.0 license and licenses/notices from
the exact dependency revisions in v0.2.1's `Package.resolved`; source URLs accompany
each notice. The installer writes them as `THIRD_PARTY_NOTICES.txt`. Version changes
must refresh both digests and notices, then rerun native compatibility checks.

Supported native artifact: Apple Silicon, macOS 15+, Xcode and an installed iOS
runtime. Intel has no pinned artifact. Local smoke evidence used Xcode 26.6 / iOS
26.5 and verified device enumeration, managed installation, real JPEG delivery and
preview cleanup. Full Electron sidebar, remote Quick Tunnel and mobile E2E remain
unverified. H.264, multitouch, keyboard and device configuration are later work.

## Maintaining the patched build

The upstream v0.2.0 and v0.2.1 Release binaries crash at the first 30-second
WebSocket ping. A symbolized source build reproduces this at `Task.sleep(for:)`;
replacing all three sleeps in `swift-websocket`'s `WebSocketHandler` also prevents the same
crash during connection shutdown. See the [decision](../../../../.agents/notes/implemented/bug-fix/2026-09-29-baguette-runtime-sleep.md).

Upstream v0.2.1 fixes the separate `baguette stream` startup crash
([PR #88](https://github.com/tddworks/baguette/pull/88)); Lody uses `baguette serve`.
Its dependency lock and license are unchanged from v0.2.0. The official v0.2.1
arm64 archive reproduced the sleep abort after 31.4 seconds, so `0.2.1-lody.1`
retains the same three-call patch. Recheck both ping and close paths before
removing it on a later upgrade. The patched build and public-channel download each
survived three real pings (~91 seconds) on Xcode 26.6/iOS 26.2; the download also
completed a normal WebSocket close before clean process shutdown. This is bounded
compatibility evidence, not a long soak or full application E2E.

`baguette-manifest.json.build` records the exact source revision, dependency
revision, patch digest, Swift version and build command. To rebuild, clone the
upstream repository at that revision, resolve the checked-in `Package.resolved`
with `swift package resolve --force-resolved-versions`, and check the
`swift-websocket` checkout revision. Apply
`patches/swift-websocket-continuous-clock.patch` in that checkout (SwiftPM marks
it read-only; grant owner write access to `Sources/WSCore/WebSocketHandler.swift`
first). Run the recorded build command. Keep the executable and adjacent
`Baguette_Baguette.bundle` together.

From this repository root, package the already verified build:

```sh
node scripts/package-baguette-runtime.mjs --build-dir <swift-release-directory> --output-dir <artifact-directory>
```

The packager verifies the pinned executable and patch, includes resources,
notices, the patch and `BUILD_PROVENANCE.json`, and compares two normalized gzip
archives. It excludes debug-symbol bundles. `--print-pins` writes the candidate
archive and prints its hash/size without changing the manifest or publishing.
A new native build requires a reviewed executable pin and a fresh `-lody.N`
version if any published bytes differ. Archive packaging is deterministic;
Swift compilation across paths/toolchains is not promised byte-reproducible.
Never overwrite an existing immutable version to accept a rebuild.

The initial publication supplies the local archive to the distribution mirror
with `--runtime baguette --baguette-artifact <archive>`. Later mirror runs can
retrieve the same pinned bytes from the manifest's public channel URL. Publish
and verify the new object before shipping the updated CLI manifest.

## Verification

Run the simulator tests plus the existing local-proxy and Quick Tunnel regressions.
`baguette-process.test.ts` checks real worker/native-child reaping with an isolated
fixture; lifecycle and gateway tests cover cancellation, cross-workspace exclusion,
stale stops, idle expiry, denied media access, input filtering and touch release.
The frontend controller/facade tests cover routing and the exact-origin handshake.
