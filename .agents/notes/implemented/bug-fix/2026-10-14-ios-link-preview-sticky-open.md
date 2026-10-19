# No iOS link preview inside selectable text

Status: implemented
Translation: current

[中文](2026-10-14-ios-link-preview-sticky-open.zh.md)

## Abstract

In the iOS app, long-pressing a link in a message showed the system link preview; after choosing "Open Link" and returning to Lody, every tap anywhere opened that link in the browser again. The native shell keeps the WKWebView link preview enabled, and conversation prose is the one place where Lody re-enables the long-press callout, so links there inherited it. Links inside selectable regions now keep the callout disabled, so a long press selects text instead of previewing and a link opens only with a tap. The native-side mechanism was not reproduced on a device; the fix removes the trigger rather than repairing WebKit state.

## Cause and scope

`body.native-mobile-shell` disables `-webkit-touch-callout` everywhere, then restores the default inside text fields and `[data-native-selection-allow]` regions so native text selection works. Markdown messages, file previews and attachments sit in such regions, and their anchors are `target="_blank"`. Restoring the callout on those anchors also restored the WKWebView link preview, whose "Open Link" action follows a different path from an ordinary tap (WebKit sends a synthetic click at the press location). The stuck state that turns every later tap into that link lives in the native WebView, outside this repository.

## Decision

`[data-native-selection-allow] a[href]` and its descendants keep `-webkit-touch-callout: none` in the native shell. Text selection still starts on a long press, and a tap still opens the link through the existing anchor handling. Lost: the system "Copy Link" / "Share" preview menu on message links.

Alternatives not taken: setting `allowsLinkPreview = false` in the native shell would fix it at the source but needs a shell release and is outside this repository; intercepting anchor taps in JavaScript would not help, because the stuck taps still arrive as clicks on the old anchor.

## Verification

CSS-only change; jsdom does not compute `-webkit-touch-callout`, so no automated test covers it. Needs a device check in the iOS app: long-press a message link shows no preview and starts selection; tapping elsewhere afterwards opens nothing.
