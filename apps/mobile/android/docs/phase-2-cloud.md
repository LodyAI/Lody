# Phase 2 — native login and read-only cloud probe

Approved by user: continue phase 2 of android-roadmap; architecture and simplicity first.

Keep the existing app module and runtime owner. Add a small native Auth API, a cancellable account controller, an Android Keystore encrypted credential store, and a scoped GrantProvider. UI sees account/workspace/connection state only. Long-lived credentials never enter WebView, intents, logs or saved UI state. Use official Device Flow with registered lody-cli client. Auth operations use an injectable native HTTP boundary; Streams remain in the unchanged shared JS runtime.

The networked runtime is a separate local asset from offline diagnostics. Only native-validated HTTPS grant endpoints and scoped read requests may leave the runtime. Deny redirects, external documents/scripts, writes and Machine RPC. Restore only credentials on process start; full cached catalogs and product navigation remain phase 3. Stop/switch/logout cancel runtime and native tasks, fence old callbacks, and clear sensitive state. Runtime restarts may restart reads but never writes.

Before cloud input, upgrade pinned Zod to patched v4 and run representative shared-schema compatibility tests, asset/device tests and audit. No blanket dependency upgrade or extra DI/database framework.

Acceptance: deterministic tests for pending/slow_down/expiry/cancel/401, restoration and logout races, encrypted storage round trips/tamper handling, URL/path/method/redirect boundaries, grant renewal and generation isolation. Real app login, workspace selection and Streams bootstrap/ongoing read must be verified with the user's independent device authorization; never borrow another client's token. Keep offline tests and real-cloud results separately labelled. Ask for authorization only when a concrete device code is ready; continue independent work while waiting.
