# Keep display math delimiters in Markdown block context

Status: implemented
Translation: current

[中文](2026-09-29-inline-display-math-block-context.zh.md)

## Abstract

An inline-math regression came from a complete `\[...\]` pair embedded after prose: leaving it unchanged made the renderer treat the source as literal text because `remark-math` does not parse TeX bracket delimiters. Same-line pairs now become same-line `$$...$$` math. Multiline pairs are separated from surrounding prose before conversion, with quote and list prefixes preserved, so the formula renders without consuming adjacent text. Synthetic renderer tests cover static and streaming paths.

## Decision

`\[...\]` is TeX display syntax, but real assistant output also places its opener immediately after prose. The normalizer handles the two cases according to the pair's shape. A same-line pair is converted to same-line `$$...$$`, which `remark-math` parses as inline math. A multiline pair gets line breaks around the converted delimiters; the formula therefore remains a display block without allowing `$$` to span the surrounding paragraph. A pair already at a Markdown block start keeps its existing block conversion. Quote and list prefixes are copied onto inserted lines.

The opt-in `\(...\)` inline path is unchanged. Code spans, fenced and indented code, links, and incomplete pairs remain literal.

## Evidence

- Implementation: [math delimiter normalizer](../../../../packages/components/src/lib/markdown-single-dollar-math.ts).
- Regression coverage: [delimiter tests](../../../../packages/components/tests/markdown-math-delimiters.test.ts) and [renderer tests](../../../../packages/components/tests/markdown-streaming-reparse.test.ts).
- Contract: [Markdown math rendering Spec](../../../../specs/markdown-math-rendering.md).
- A synthetic case with display delimiters after prose no longer blocks a later inline formula from rendering.
