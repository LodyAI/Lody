# Patched Baguette runtime for WebSocket sleep crashes

Status: implemented
Translation: current

[中文](2026-09-29-baguette-runtime-sleep.zh.md)

## Abstract

Baguette v0.2.0 aborts when its WebSocket automatic-ping task returns from the first 30-second sleep. A symbolized Release build confirms `WebSocketHandler.runAutoPingLoop` as the failing caller, and the same sleep form also crashes in the close-handshake task. Replace the three `Task.sleep(for:)` calls in the pinned swift-websocket dependency with `ContinuousClock.sleep(until:)`, preserving cancellation and timing. Distribute the verified native build as `0.2.0-lody.1`, with its patch and provenance, rather than changing upstream-version bytes. The v0.2.1 recheck still reproduces the failure; the same patch now ships on that source base as `0.2.1-lody.1`.

## Evidence and decision

The official binary aborted after 30.15 seconds; an unmodified source build using Apple Swift 6.3.3 aborted after 31.20 seconds. Both reported `freed pointer was not the last allocation` in `swift_task_dealloc`. Source symbols identify `WebSocketHandler.swift:227` in swift-websocket 1.5.0. Changing only the ping-loop sleeps survived three pings but exposed the same failure at line 191 during shutdown. Changing all three calls survived 92.7 seconds, delivered 106 JPEG frames and three pings, and exited with code 0 after deliberate test cleanup.

This confirms the failing sleep path and workaround, not the exact compiler/ABI mechanism. [Swift issue 86204](https://github.com/swiftlang/swift/issues/86204) documents a matching specialization failure. Rebuilding with the locally available newer compiler alone was insufficient. Disabling automatic ping would remove useful connection liveness and would leave the close-handshake path unfixed.

## Upstream v0.2.1 recheck (2026-09-30)

[Upstream v0.2.1](https://github.com/tddworks/baguette/releases/tag/v0.2.1), commit `db17446e25059247879dba7941e4de641c2f31e2`, fixes a different startup crash in the standalone `baguette stream` command ([PR #88](https://github.com/tddworks/baguette/pull/88)). Lody uses `baguette serve`. The dependency lock and upstream license are unchanged, including swift-websocket revision `ca48d46c25f8fa948d37eaa480c73172182cf90f`. The official arm64 archive (SHA-256 `27196ca07dd3aa1f0f96d12100953e75ebd2059a145dfced7c88b229580e4b25`) still aborts with the same allocator message: 31.4 seconds, one JPEG frame, no ping, SIGABRT.

Upgrade the source base to v0.2.1 and retain the unchanged three-call patch as `0.2.1-lody.1`; the release note is not evidence that the WebSocket bug is fixed. Recheck both the automatic-ping and close-handshake paths before removing this workaround in a future upgrade. This extends the original decision without invalidating the v0.2.0 evidence above.

On Apple Silicon/macOS 26.6.2, Xcode 26.6 and a booted iPhone 17 Pro/iOS 26.2, the patched source build delivered three JPEG frames and three pings over 91.2 seconds, then exited with code 0 after abrupt viewer disconnect and SIGTERM. Two normalized archive builds matched. The new immutable mirror object passed R2 readback and independent public-channel archive/executable integrity checks. Running the public-channel download delivered three JPEG frames and three pings over 91.3 seconds, completed a normal WebSocket close (1000), and exited with code 0 after SIGTERM. Only three frames were observed with the mostly static screen; this is heartbeat/cleanup evidence, not a throughput or long-soak claim. Close-timeout failure branches and complete sidebar/remote/mobile E2E remain unverified. Integration PR: [LodyAI/Lody#1061](https://github.com/LodyAI/Lody/pull/1061).

## Artifact ownership

The [runtime manifest](../../../../apps/cli/src/ios-simulator/baguette-manifest.json) pins archive/executable digests and records the upstream and dependency revisions, patch digest, compiler and command. The [packager](../../../../scripts/package-baguette-runtime.mjs) retains the verified executable unchanged and emits deterministic archives with resources, notices, patch and provenance. The [runtime README](../../../../apps/cli/src/ios-simulator/README.md) owns rebuild/packaging instructions.

The separate Lody revision gives a new download key and installation cache. Existing upstream-version caches and immutable objects remain valid. Publication must verify the local archive and remote readback before shipping the updated manifest. Subsequent mirror runs reuse that exact published artifact; changing build bytes requires another runtime revision.

## Verification limits

The native test exercised MJPEG, three real ping cycles and shutdown on Apple Silicon/macOS 26.6.2. It is not a long soak or complete Electron/remote/mobile acceptance test. Packaging tests exercise layout, deterministic metadata and rejection of changed executable, patch, resources and symlinks. The runtime still requires its existing Xcode/iOS compatibility checks when any dependency or toolchain changes.
