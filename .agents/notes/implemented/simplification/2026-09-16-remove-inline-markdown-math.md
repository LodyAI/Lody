# Remove inline Markdown math from conversations

Status: implemented
Translation: current

[中文](2026-09-16-remove-inline-markdown-math.zh.md)

## Abstract

Conversation Markdown previously converted both `$...$` and `\\(...\\)` into KaTeX
inline formulas. Agent responses now leave those inline delimiters as literal text,
while retaining block formulas written with `$$...$$` or `\\[...\\]`. This removes
the custom single-dollar AST transform and restricts TeX delimiter normalization to
display formulas; the trade-off is that inline LaTeX is readable source rather than
typeset output.

## Decision

`MarkdownRenderer` no longer installs the custom `remarkSingleDollarTextMath`
transform. `normalizeTexMathDelimiters` normalizes only completed bracket-delimited
display formulas, so parenthesis-delimited inline formulas reach Markdown unchanged.
The Streamdown math plugin remains in place for display formula rendering.

The renderer coverage asserts that dollar and parenthesis inline syntax produces no
KaTeX element, and that bracket display syntax still renders a KaTeX display block.
The delimiter utility coverage retains code-span and fence protections for the
remaining display normalization.

## Verification

The two affected Vitest files passed (42 tests), as did
`pnpm --filter @lody/components typecheck`, the changed-file Oxfmt check,
`pnpm run docs check`, and `git diff --check`. The initial CI failure came from
asserting that Markdown preserved the escape backslashes around literal
parentheses; the parser correctly removes those escapes.
