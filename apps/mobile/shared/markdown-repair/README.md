# Markdown repair (shared)

`entry.js` wraps [`remend`](https://github.com/vercel/streamdown) as a global `repairMarkdown(text)`
that temporarily closes unfinished syntax (bold, code spans, fences…) while an agent reply streams.

- iOS: `ios/apps/ios/scripts/build-decoder.mjs` bundles it to `MarkdownRepair.js`, run by
  `ChatMarkdownRepair` in JavaScriptCore.
- Android: `android/runtime/src/markdown-repair.mjs` bundles it to the `markdown/MarkdownRepair.js`
  asset, run by `QuickJsMarkdownRepair` in QuickJS.

Both pin `remend` in their `package.json`; `android/runtime/test/markdown-repair.test.mjs` fails when
the versions drift or the repair behavior changes. Edit options here only.
