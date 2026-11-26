# Native mobile conversation share-image card

Status: implemented
Translation: current

[中文](2026-11-26-native-mobile-chat-share-image.zh.md)

## Abstract

Native iOS and Android conversation clients lacked Web's ability to select one or more turns and export or copy them as a styled PNG card, while earlier hybrid approaches relied on DOM screenshot capture inside a rendering WebView. Both clients now read structured persisted prose turns and caption provenance through a shared `conversationShareMessages` runtime call, then handle multi-turn selection, live preview, and strip-based offscreen PNG rasterization entirely in native UIKit and Jetpack Compose. This eliminates rendering-WebView startup, font bundling, and full-document GPU texture pressure, while keeping visual parity with Web's fixed share-card template. Inline assistant image attachments inside prose remain text-only in this card template, matching the current Web prose projection, and system share-target confirmation on OEM Android choosers remains best-effort when a custom chooser omits `IntentSender` callbacks.

## Decision and alternatives

Web's [fixed share-card template](2026-09-14-chat-share-card-fixed-template.md) and [palette isolation](../../implemented/bug-fix/2026-10-06-chat-share-palette-isolation.md) capture live DOM through SnapDOM. On the standalone native clients (`apps/mobile/ios` and `apps/mobile/android`), reusing a rendering WebView for preview and capture was rejected:

- Both native clients run `cloud-runtime` inside a non-visual JS/data host with strict CSP and no bundled React/StyleX/Shiki/Inter/JetBrains Mono UI bundle. Introducing a second rendering WebView would duplicate Markdown, syntax highlighting, Mermaid, and CJK/code font stacks while hitting WebKit and Chromium texture height cliffs on long selections.
- Native transcript cells, Markdown block splitters, Pele-based Mermaid renderers, `@` mention chip decorators, and decoded `<message-quote>` renderers already exist on both platforms.

Instead, only protocol extraction is shared in `cloud-runtime`, and all UI and rasterization stay native:

```text
watched session history (cloud-runtime)
  -> conversationShareMessages (persisted user/assistant prose, decoded mentions & quotes, modelName, estimatedTokens, session meta)
  -> native transcript selection mode (set of turn IDs within loaded window, exported in history order)
  -> native preview sheet (live scaled UIKit / Compose card, Chat 360pt | Post 560pt, 6 backdrops, mat 0..96, Light | Dark)
  -> offscreen <= 2048 px strip rasterizer (@2x capped at 16,384 px, >= 1.25x floor)
  -> system clipboard or temporary cache file + system share sheet
```

## Protocol and rendering boundaries

- **Shared runtime projection (`conversationShareMessages`):** `packages/cloud-runtime/src/protocol/conversation-share-image.ts` (mirrored into `apps/mobile/android/runtime/vendor/cloud-runtime`) reads the watched session replica, retains non-queued `user` and `assistant` turns with non-empty prose, joins multi-part text items with blank lines, decodes user `@` mentions and `<message-quote>` spans into UTF-16 `references` (`mention` and `quote`), estimates turn tokens across prose and hidden reasoning/tool work (matching `Copy as Markdown`), records each assistant turn's `modelName` and `userTurnId`, and bounds wire payloads to 6 MiB from the newest turns backward.
- **Loaded-window selection and chronological order:** Selection state holds an unordered set of turn IDs intersected with the currently loaded transcript entries so `Select all` never selects unloaded pages; loading older pages expands the selectable set automatically. Multi-row folded assistant turns highlight and toggle as one unit under a single passive leading badge, and preview/export always filters `conversationShareMessages` in chronological history order. Paired `user` -> `assistant` replies (`userTurnId` matching the preceding selected user turn) use `replyGap` (`12`/`14`); non-contiguous selections open a new exchange (`exchangeGap` `24`/`28`).
- **Card isolation and static medium rules:** Following the [share-image specification](../../../../specs/chat-share-image.md) and [cross-platform mobile rules](../../../../apps/mobile/docs/rules/cross-platform.md), iOS scopes `UITraitCollection` (`userInterfaceStyle` + `.large` content size category) and Android scopes `LodyTheme(darkTheme)` + `Density(fontScale = 1f)` strictly to the card (`#111113` / `#161618` dark surfaces, never `#000000`). User prompts expand in full with unclipped quote snapshots; assistant code and diff fences soft-wrap unconditionally without horizontal scrollbars or copy buttons; wide Markdown tables scale proportionally to fit the card's inner measure.
- **Bounded strip capture and E2EE/plaintext fencing:** Preview renders the live native card view scaled to fit width rather than a pre-rasterized bitmap. Export targets `@2x` up to `16,384 px` tall, stepping scale down to `1.25x` for taller selections and rejecting taller selections before allocating full output buffers. Rendering runs in `<= 2048 px` horizontal strips (composited on CPU on iOS; streamed scanline-by-scanline into Deflater-backed RGBA `IDAT` chunks on Android so peak strip bitmap memory stays ~9 MiB). Verified plaintext workspace mode and active `(accountId, workspaceId, sessionId)` scope are checked at selection entry, before rasterization, and before clipboard or share-sheet handoff; temporary PNG directories (`tmp/lody-chat-share/<uuid>/` on iOS, `cacheDir/shared-images/chat-share/<uuid>/` on Android) are pruned on completion, cancellation, startup, and account transitions.

## Verification

- Cloud protocol unit tests in `apps/mobile/ios/apps/ios/tests/cloud/conversation-share-image.test.mjs` and `apps/mobile/android/runtime/test/contract-bridge.test.mjs` verify prose extraction, mention/quote offset rebasing, hidden-work token estimation, model attribution, and contract validation.
- iOS unit tests in `apps/mobile/ios/packages/LodyKit/Tests/LodyKitTests/ChatShareImageTests.swift` verify non-contiguous chronological ordering, exchange/reply rhythm, caption metadata, light/dark pixel isolation under opposing host traits, multi-strip PNG dimensions, scale bounds, and temporary directory cleanup.
- Android unit tests in `apps/mobile/android/app/src/test/kotlin/app/lody/android/chat/ChatShareImageTest.kt` verify JSON protocol decoding, loaded-window selection expansion, paired vs non-contiguous turn spacing, compact token and UTC date formatting, strip export planning, `StreamingPngWriter` RGBA fidelity, and `en`/`zh-Hans` string key parity.
- Real-device verification of third-party Android OEM sharesheets that ignore `Intent.createChooser` `IntentSender` callbacks remains a manual device check.
