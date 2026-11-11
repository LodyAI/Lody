# Cloud runtime (Android)

Read before changing the WebView runtime, its owner and lifecycle, the `CloudRuntime` contract or the vendored runtime snapshot. These rules bind every caller of the area, not only files in its directory.

- Host the browser cloud runtime in a native-owned WebView. Business code depends on a platform-neutral Kotlin interface; WebView, JSON bridging and watchdog internals remain inside the implementation. Preserve command/event semantics across Swift and Kotlin so a future native runtime can replace the WebView implementation.

- Keep watchdog deadlines outside JavaScript, fence callbacks by runtime generation, bound automatic restarts, suspend deadlines in background, and never replay writes after recovery. Long-lived credentials stay native; only short-lived grants may enter the runtime. A machine ACK is delivery, not completion.

- The vendored cloud-runtime source is an unchanged, provenance-tracked snapshot of `../ios/packages/cloud-runtime` (`docs/runtime-snapshot.md`). Bridge code lives in `runtime/src`; when Android needs a protocol field, add it to the iOS runtime and re-snapshot instead of patching the snapshot at bundle time. Retain dependency licenses and reproducible asset generation.

- `LodyApplication` owns `RuntimeOwner`; pages never create or destroy a runtime. Tie foreground/background to ProcessLifecycleOwner, not Activity callbacks. Every operation supplies its expected account/workspace scope; switching/logout cancels the old lease and observers.

- Features depend on the suspend/StateFlow `CloudRuntime` contract. Keep JSON, WebView and callback transport inside the adapter. Debug-only commands and fixture scopes stay under `src/debug`.

- Negotiate protocol/capabilities before READY. Keep native control/query/diagnostic deadlines and bounded chunk assembly; coroutine cancellation removes native waiters and cooperatively aborts JS. Cancellation is not rollback. No replay across recovery or process restart.

- Initialize bundled WASM asynchronously.

- Run JS, JVM owner/protocol tests and Android WebView tests for runtime changes. Snapshot drift checks are part of asset generation; update hashes and provenance only after reviewing an intentional source update. See `docs/runtime-snapshot.md`.

- Native iOS page ownership/reveal fixes do not replace Android's Compose lifecycle or transcript implementation; retain the existing Android session owner boundaries.
