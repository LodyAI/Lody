# Copy selected rendered formulas as LaTeX

Status: implemented
Translation: current

[中文](2026-10-16-math-selection-copy.zh.md)

## Abstract

Selecting rendered formulas previously copied their typeset text rather than reusable LaTeX. The shared Markdown renderer now loads KaTeX's bundled Copy-tex extension, which writes LaTeX into plain-text clipboard content while retaining the selected HTML. Inline and display formulas use `$...$` and `$$...$$`, and partial formula selections expand to the complete formula. The conversation selection guard also stops propagation when a selection is incomplete, because Copy-tex does not honor `defaultPrevented`. Synthetic DOM tests verify conversion and that incomplete selections leave clipboard data untouched; native clipboard and device acceptance remain unverified.

## Decision and ownership

The [shared renderer](../../../../packages/components/src/components/ai-gui/markdown-renderer.tsx) loads the browser-only [Copy-tex entry](../../../../packages/components/src/components/ai-gui/markdown-math-copy.ts) in a mount effect. Copy-tex registers a document listener during module evaluation, so importing it eagerly breaks Node consumers with `document is not defined`; CI exposed this in five existing suites. Delaying the import until mount preserves DOM-free imports, while module caching registers the extension once for the page lifetime. This uses the existing KaTeX dependency and covers static and streaming Markdown surfaces without a new setting, dependency, or custom formula serializer. The extension changes native selection copying; message-copy actions continue using their existing source text.

The [native selection guard](../../../../packages/components/src/hooks/use-conversation-text-selection.ts) remains responsible for mounted and hydrated conversation ranges. Its capture listener now calls `stopImmediatePropagation()` as well as `preventDefault()` for incomplete selections, preventing the extension's document listener from writing partial clipboard data. This extends the protection described in the [selection retention decision](../bug-fix/2026-09-20-conversation-text-selection.md); range retention and hydration ownership are unchanged. Inline rendering still follows the [existing preference](2026-09-28-inline-math-preference.md).

The official extension was chosen over maintaining a custom copy handler because the installed KaTeX package already includes source extraction, formula-boundary expansion, and both clipboard formats. Importing it alone would bypass incomplete-selection cancellation, so stopping downstream handlers is part of this integration. Copy-tex serializes plain text from the selected fragment's `textContent`; this does not add Markdown serialization or preserve every visual block separator.

## Verification and limits

- [Renderer tests](../../../../packages/components/tests/markdown-streaming-reparse.test.ts) exercise real rendered DOM ranges and dispatched copy events for inline math mixed with prose, display formulas, static and streaming paths, partial formula selection, retained HTML, and ordinary prose pass-through.
- [Selection tests](../../../../packages/components/tests/conversation-text-selection.test.tsx) load the real extension and verify that a selection containing a formula writes no clipboard data while an intervening row is incomplete, then copies LaTeX once the row is ready.
- All 99 tests across seven focused suites passed, including the five Node suites that failed in CI and the renderer/selection suites. Copy tests wait for the mount-triggered dynamic import to settle before dispatching native copy events. Scoped formatting and diff whitespace checks passed; type-aware lint reported zero errors and 20 warnings. Full repository testing remains with CI at the user's request. Local worktree type checking is limited by reused dependencies resolving an older sibling checkout, and documentation checking by uninitialized ACP submodules; neither is reported as passing.
- The clipboard event payload is an in-memory implementation of `setData`; these tests do not claim native operating-system clipboard, Safari, or mobile-device acceptance.

PR: [#1595](https://github.com/LodyAI/Lody/pull/1595)
