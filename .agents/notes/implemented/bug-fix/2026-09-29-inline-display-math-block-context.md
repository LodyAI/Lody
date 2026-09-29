# Keep display math delimiters in Markdown block context

Status: implemented
Translation: current

[中文](2026-09-29-inline-display-math-block-context.zh.md)

## Abstract

An inline-math regression came from a complete `\[...\]` pair embedded after prose: the renderer still converted it to `$$`, and parsing then consumed following content instead of rendering a later inline formula. Display delimiters now convert only when their opener starts a Markdown block, including quote and list blocks. Synthetic renderer tests cover toggling the setting after mount through static and streaming paths.

## Decision

`\[...\]` is display-math syntax and only belongs at a Markdown block start. The normalizer previously converted every complete bracket pair, even when its opener followed ordinary prose. In that position, the rewritten `$$` could be interpreted as display math across surrounding text and prevent later inline formulas from being parsed.

The normalizer now accepts leading Markdown container prefixes (blockquote and list markers) but leaves an opener after prose unchanged. The opt-in `\(...\)` inline path is unchanged. This preserves display semantics instead of coercing a misplaced display delimiter into inline math.

## Evidence

- Implementation: [math delimiter normalizer](../../../../packages/components/src/lib/markdown-single-dollar-math.ts).
- Regression coverage: [delimiter tests](../../../../packages/components/tests/markdown-math-delimiters.test.ts) and [renderer tests](../../../../packages/components/tests/markdown-streaming-reparse.test.ts).
- Contract: [Markdown math rendering Spec](../../../../specs/markdown-math-rendering.md).
- A synthetic case with display delimiters after prose no longer blocks a later inline formula from rendering.
