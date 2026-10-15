# Copy selected rendered formulas as LaTeX

Status: implemented
Translation: current

[中文](2026-10-16-math-selection-copy.zh.md)

## Abstract

Selecting rendered formulas previously copied their typeset text rather than reusable LaTeX. The shared Markdown renderer now loads KaTeX's bundled Copy-tex extension, which writes LaTeX into plain-text clipboard content while retaining the selected HTML. Inline and display formulas use `$...$` and `$$...$$`, and partial formula selections expand to the complete formula. The conversation selection guard also stops propagation when a selection is incomplete, because Copy-tex does not honor `defaultPrevented`. Synthetic DOM tests verify conversion and that incomplete selections leave clipboard data untouched; native clipboard and device acceptance remain unverified.

## Decision and ownership

The [shared renderer](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx) imports `katex/contrib/copy-tex` once through the module graph. This uses the existing KaTeX dependency and covers static and streaming Markdown surfaces without a new setting, dependency, or custom formula serializer. The extension changes native selection copying; message-copy actions continue using their existing source text.

The [native selection guard](../../../../packages/components/src/hooks/use-conversation-text-selection.ts) remains responsible for mounted and hydrated conversation ranges. Its capture listener now calls `stopImmediatePropagation()` as well as `preventDefault()` for incomplete selections, preventing the extension's document listener from writing partial clipboard data. This extends the protection described in the [selection retention decision](../bug-fix/2026-09-20-conversation-text-selection.md); range retention and hydration ownership are unchanged. Inline rendering still follows the [existing preference](2026-09-28-inline-math-preference.md).

The official extension was chosen over maintaining a custom copy handler because the installed KaTeX package already includes source extraction, formula-boundary expansion, and both clipboard formats. Importing it alone would bypass incomplete-selection cancellation, so stopping downstream handlers is part of this integration. Copy-tex serializes plain text from the selected fragment's `textContent`; this does not add Markdown serialization or preserve every visual block separator.

## Verification and limits

- [Renderer tests](../../../../packages/components/tests/markdown-streaming-reparse.test.ts) exercise real rendered DOM ranges and dispatched copy events for inline math mixed with prose, display formulas, static and streaming paths, partial formula selection, retained HTML, and ordinary prose pass-through.
- [Selection tests](../../../../packages/components/tests/conversation-text-selection.test.tsx) load the real extension and verify that a selection containing a formula writes no clipboard data while an intervening row is incomplete, then copies LaTeX once the row is ready.
- In the development checkout, all 114 tests across seven related suites passed, as did component type checking, scoped formatting, and diff whitespace checking. Scoped type-aware lint reported zero errors and 23 warnings. Documentation checking retained the six existing broken links in the proposed subagent-events note pair; there were no new documentation errors. These checks preceded transferring the focused patch onto current `main`; additional local test runs and the full repository check are left to CI at the user's request.
- The clipboard event payload is an in-memory implementation of `setData`; these tests do not claim native operating-system clipboard, Safari, or mobile-device acceptance.

PR: [#1595](https://github.com/LodyAI/Lody/pull/1595)
