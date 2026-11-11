# Transcript Markdown (Android)

Read before changing Markdown repair, splitting or rendering in the transcript. These rules bind every caller of the area, not only files in its directory.

- `chat/` holds the transcript pipeline, mirroring iOS `ChatMarkdownRepair` / `ChatMarkdownStore`: coalesce chunks per frame (`renderMarkdown`), repair while streaming only, split into top-level blocks with the JetBrains GFM parser, render each block as its own lazy item (`ChatTranscript`, `MarkdownBlock`). The original text stays the source of truth; repaired text is display-only.

- Repair runs the shared `../shared/markdown-repair/entry.js` (remend, pinned in `runtime/package.json` to the iOS version) as the `markdown/MarkdownRepair.js` asset in QuickJS (`QuickJsMarkdownRepair`, quickjs-kt, which serializes evaluations itself). Every failure returns the input unchanged. Do not route repair through the WebView runtime. Unit tests run the real engine via `quickjs-kt-jvm` against the built asset (`markdown.repair` system property).

- Renderer: mikepenz multiplatform-markdown-renderer. Its append-only streaming state does not fit remend output (closing markers move), so blocks re-render with `retainState = true` instead; without it a growing block flashes back to loading.

- `diagnostics/ChatStreamProbeActivity` (debug) replays `assets/chat/fixture.md` as a token stream and reports repair / split cost and long frames, with repair and coalescing toggles.
