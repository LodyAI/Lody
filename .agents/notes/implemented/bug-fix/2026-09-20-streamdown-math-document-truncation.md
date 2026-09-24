# Keep comparison operators from truncating streamed math documents

Status: implemented
Translation: current

[中文](2026-09-20-streamdown-math-document-truncation.zh.md)

## Abstract

Markdown answers containing display LaTeX such as `p<q` could lose every section
after the formula in the conversation view. Streamdown's Remend completion pass
mistook the comparison as an unfinished HTML tag and removed the remaining
streaming text. The renderer now disables only that HTML-tag completion step;
Markdown parsing, display-math rendering, and the existing sanitized HTML path stay
unchanged. A regression test covers a comparison inside one formula and a later
formula and section.

## Decision

`MarkdownRenderer` passes `remend={{ htmlTags: false }}` to Streamdown. HTML tag
completion is not needed for this surface: raw HTML is opt-in through the existing
`allowHtml` prop and then goes through `rehypeRaw` plus `rehypeSanitize`. Disabling
the completion avoids interpreting TeX comparison operators as HTML while leaving
all other streaming completions enabled.

The regression test renders synthetic Markdown with `p<q`, an aligned display
formula, and a trailing reference section. It asserts that the final text remains
present and both display formulas render.

## Verification

The focused Markdown, math-delimiter, and idle-rerender tests pass (45 tests).
The components package typecheck, Oxfmt check, and Oxlint check pass. Full repository
checks remain to be run before merging.
