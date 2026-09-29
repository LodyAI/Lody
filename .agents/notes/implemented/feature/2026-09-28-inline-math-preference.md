# Add an opt-in inline math preference

Status: implemented
Translation: current

[中文](2026-09-28-inline-math-preference.zh.md)

## Abstract

Conversation Markdown previously left both `$...$` and `\\(...\\)` inline
formulas as source text to avoid accidental math parsing. The client now offers
an Appearance setting that opts into rendering both forms with KaTeX, while the
default remains the existing literal behavior. The setting is persisted locally
and is shared by static and streaming Markdown surfaces. The trade-off is that
users who enable it accept the old ambiguity of single-dollar prose, while code
and tool payload boundaries remain protected by the parsed Markdown tree and
their dedicated renderers.

## Decision

`inlineMathEnabledAtom` stores the local preference under
`lody-inline-math-enabled`. `MarkdownRenderer` reads it for every shared
Markdown surface. When enabled, `normalizeTexMathDelimiters` also rewrites
complete `\\(...\\)` pairs and the renderer adds the existing narrow
`remarkSingleDollarTextMath` AST pass for single-dollar formulas. The pass skips
code, links, existing math nodes, and other non-prose nodes; display math keeps
its prior normalization and rendering.

This is an opt-in follow-up to the earlier [inline math simplification](../simplification/2026-09-16-remove-inline-markdown-math.md); that record remains the rationale for the default-off behavior.

Desktop and mobile Appearance settings expose the same switch and labels. The
default-off choice preserves existing transcripts and avoids changing tool-like
prose for users who do not need inline typesetting.

## Alternatives

Always enabling inline math was rejected because shell syntax and ordinary
currency/prose can contain dollar signs. Supporting only `\\(...\\)` was
rejected because many model responses use single-dollar delimiters. A separate
renderer prop was rejected because the setting must apply consistently to the
shared chat, preview, skill, and comment surfaces.

## Verification and limits

Focused tests cover opt-in dollar and parenthesis rendering, default literal
behavior, code protection, the delimiter helper, and both desktop/mobile
settings controls. Full package checks require the workspace dependencies; the
worktree initially has no `node_modules`.
