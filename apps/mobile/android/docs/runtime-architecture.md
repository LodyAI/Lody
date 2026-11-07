# WebView runtime integration

## Accepted decisions

Android uses Compose + Foundation and Material 3 where appropriate. Product UI and semantic design tokens stay separate from platform interactions. iOS and Android implement their own native components.

The initial runtime reuses the browser runtime hosted by a native-owned WebView. Commands/events keep the shared runtime's semantics; business code depends on a Kotlin interface that can later be implemented natively.

## Boundaries in this integration

```text
Compose screens → RuntimeOwner (Application, account/workspace lease)
                          ↓ CloudRuntime: StateFlow / typed events / suspend commands
                 WebViewRuntime coroutine adapter
                          ↓ internal WebViewCloudRuntime backend
                 Android bridge protocol 2 → unchanged cloud-runtime → WASM
```

- `runtime/vendor/cloud-runtime`: unchanged source snapshot; origin commit and license in `runtime/vendor/PROVENANCE.json`. There is no import or build dependency on the iOS checkout.
- `runtime/src/dispatch.mjs`: adapter around existing command names, with request/reply correlation and an explicit allowlist. Unknown names, including inherited properties and writes, are refused.
- `runtime/src/main.mjs`: production entry. Preserves the upstream `webkit.messageHandlers.dataRuntime` message shape through a thin Android shim.
- `runtime/src/debug.mjs`: debug-only compatibility checks and fault injection. Contains real Flock/Loro snapshot round trips and framed updates, not a fake success fixture.
- `CloudRuntime`: platform-independent Kotlin contract with StateFlow status/capabilities/faults, typed events and suspending commands. Callers may use any dispatcher; the WebView facade marshals work to Main. A fake implementation exercises the same contract in JVM tests.
- `RuntimeOwner`: one account/workspace lease per Application. Repeated activation retains the lease; switching or logout cancels its operations and collectors, stops the old backend and fences late events. `use(expectedScope)` rejects stale callers. GrantProvider is only a stage-2 port, with no network implementation.
- `WebViewCloudRuntime`: WebView creation/destruction, secure origin, bridge validation, generations, request limits and native watchdog.
- `LodyApplication` owns the scoped runtime and observes ProcessLifecycleOwner. Activities only collect status and submit typed commands; recreation and navigation retain the host. The debug Application activates an explicitly synthetic workspace. Production does not activate a workspace until a future authenticated account flow exists.

This phase implements the host portion of the abstraction, not the entire catalog/session API. Shared `start(workspaceId, userId)`, grants, catalog projection, session reads and writes are not wired to Android business code yet. Catalog/synced/grant events now have typed decoders and shared synthetic fixtures, but there is no real subscription or catalog cache. Adding future operations requires extending typed commands/results while retaining the existing JS wire semantics. Arbitrary JavaScript evaluation is never a business API.

## Native ownership and failure semantics

- Exact local document served through WebViewAssetLoader at `https://lody.ai/android-runtime/…`; no remote document load. This preserves the official origin for a later CORS investigation, but does not prove cloud CORS works.
- Network access denied by request interception and CSP (`connect-src 'none'`); no INTERNET permission in this offline app. Missing local resources fail closed.
- Origin-scoped `addWebMessageListener`, main-frame check, owning WebView identity and generation fencing. Unsupported WebView bridge capability fails explicitly.
- Main-thread WebView calls; a native Handler uses monotonic time. Startup deadline 20s; heartbeat deadline 8s; three automatic restarts per rolling 60s, matching Swift RuntimeHealth.
- Background suspends the watchdog, cancels pending requests and retains the WebView. Foreground resets the deadline and resumes. No background service or keepalive.
- Native deadlines are classified: control/heartbeat 5s, queries 30s, diagnostics 15s. At most 32 pending calls, with two slots reserved for control/heartbeat on both sides. Coroutine cancellation removes the native waiter and sends cooperative `$cancel`; it does not roll back side effects.
- JS serializes at most 8 MiB UTF-8 per logical message, split into ordered 16,384 UTF-16-unit chunks. Native frames are capped at 192 KiB characters, with at most two assemblies, 512 chunks each, 8 Mi UTF-16 units aggregate, final 8 MiB UTF-8, and a 5s assembly deadline. Background freezes assembly deadlines; foreground restores the remaining budget. Disposal clears assemblies. These bridge limits are separate from upstream per-replica limits.
- Protocol 2 handshake requires the core capability set before READY. Production advertises only ping, setActive and probeSchema. Unknown commands fail explicitly; malformed bridge payloads recover through the bounded native path.
- Stop/replacement cancels pending requests. Old-generation replies cannot complete new calls. Recovery never queues/replays writes.
- Renderer process loss disposes the failed view and uses the same bounded recovery path. The device suite terminates a real renderer, observes recovery and checks the old pending call fails rather than replaying.
- No credentials, account data, cloud requests or release signing configuration are imported. Before cloud integration, long-lived credentials belong in native protected storage and only short-lived workspace grants may enter JS.

## Compatibility evidence scope

The device suite exercises bundled production initialization, real WASM snapshots, Zstd, web crypto, streams, abort timeouts, concurrent Unicode messages, pending-call cancellation/timeouts, background retention, navigation blocking, missing assets and native recovery from a deliberately stalled JS loop.

These checks do **not** validate server CORS, device login, Streams HTTP transport, reconnect cursor behavior, persistence, real catalog/session data, write ordering across durable Android storage, OEM WebViews, or Android 8 minimum-device behavior. Those need separate integration stages and a wider device matrix.

## Dependency audit follow-up

`npm audit` reported GHSA-mrhx-c7xc-m3w5 against the upstream pinned `zod@3.25.76` (high severity; oversized constrained collections can exhaust memory). The published fix is a major version upgrade. This snapshot retains iOS compatibility for the network-disabled probe. Audit/migrate the shared runtime before enabling untrusted cloud payloads; do not blindly run `npm audit fix --force`.

Snapshot update and audit procedures: [runtime-snapshot.md](runtime-snapshot.md). Phase-1 acceptance scope: [phase-1-runtime.md](phase-1-runtime.md).
