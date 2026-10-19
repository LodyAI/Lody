# Parse CJK Markdown emphasis at the delimiter boundary

Status: implemented
Translation: current

[中文](2026-10-10-markdown-cjk-emphasis.zh.md)

PR: [#1375](https://github.com/LodyAI/Lody/pull/1375)

## Abstract

Chinese bold sentences ending in punctuation can remain literal Markdown when the
closing marker touches the next sentence. The renderer already styles parsed bold
text; CommonMark delimiter rules prevent the strong node from being created.
The renderer and search extractor now share CJK-friendly emphasis parsing, keeping
streaming, completed text and highlight offsets consistent. Code and escaped
markers remain literal; GFM strikethrough is outside this change.

## Evidence and decision

Parsing synthetic `**检查完成。**接着执行下一步。` with remark-parse produces
only a text node. The standalone sentence, including a version surrounded by
Chinese quotation marks, already produces a strong node. The failing case has
punctuation immediately before the closing delimiter and a letter immediately
after it; see [CommonMark emphasis rules](https://spec.commonmark.org/0.31.2/#emphasis-and-strong-emphasis).

Use `remark-cjk-friendly/parseOnly` 2.3.1 after GFM in both the renderer's shared
plugin list and the search parser. Its parser extension respects Markdown code,
escapes and nesting instead of rewriting raw text. The parsing-only entry avoids
loading the serialization extension. Upstream documents the
[CJK delimiter extension](https://github.com/tats-u/markdown-cjk-friendly/tree/main/packages/remark-cjk-friendly).
This extends the [streaming renderer decision](../feature/2026-09-26-lobehub-streamdown.md)
and preserves the [search text consistency decision](2026-10-07-session-search-literal-punctuation.md).

Adding spaces around markers is a manual workaround, but changes source text and
does not handle uncontrolled generated replies. A raw-text regex replacement
would have to duplicate code, escape and nested-inline parsing rules.

## Verification

The owning renderer suite covers punctuation at both delimiter edges, bold and
italic, literal code and escaped markers, non-CJK boundaries, and streaming to
completed handoff. The search suite covers extracted prose and cross-node highlight
offsets. The [Spec](../../../../specs/markdown-cjk-emphasis.md) remains draft.

The renderer, search and outline-preview suites pass all 87 tests. Changed-source
lint, formatting, components type checking and public-boundary checks pass.
Documentation validation reports six existing links to
uninitialized isolated Kimi/Pi submodules; this topic has no validation errors.
The root check was rerun after preparing the workspace. Repository-wide type
checking and lint passed; the test stage reported a 30-second timeout in the
unchanged CLI `roost-session-backend-contract.test.ts` signed-prefix restore case.
The remaining suites were still running when the initial patch was committed.
