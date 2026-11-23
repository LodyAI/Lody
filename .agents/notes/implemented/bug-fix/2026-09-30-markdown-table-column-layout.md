# Classify Markdown table columns from the hast so short cells never wrap

Status: implemented
Translation: current

[中文](2026-09-30-markdown-table-column-layout.zh.md)

## Abstract

Markdown tables in the conversation rendered badly in two opposite ways: a
`w-full` table stretched a two-cell summary across the whole row, while a
long unbreakable cell (a file path inside the non-wrapping `AgentFileLink`
chip) dictated its column's min-content width and squeezed later columns to a
few characters. The fix classifies each column at render time from the hast:
a column whose every cell fits in roughly 24 half-width units stays on one
line at its natural width, a column holding a token longer than that may break
inside the token (`overflow-wrap: anywhere`) and is capped at `max-width:
20em` — the cap lowers the column's max-content contribution so the auto
layout's proportional distribution cannot let it starve prose columns. Every
other column wraps between words above a floor (`min-width` in em), and a
column whose widest line is intrinsically wide keeps a higher floor so it
stays readable when even the minimums already overflow the container. The
estimates also become `<col>` preferred widths: Chromium honours a specified
column width exactly when there is room and shrinks toward min-content in
proportion to the excess when there is not, so a crowded table distributes
width in proportion to need instead of pinning everyone at the floor. The
frame is `w-fit max-w-full` so small tables shrink to content and genuinely
wide tables scroll inside their bordered frame. On phone-width viewports the
one-line rule is dropped — a 480px panel still honours it, but at phone widths
nowrap columns crowd out everything else.

## Problem

Two visible symptoms, one root cause family:

- Short tables filled the row because the table was `w-full`; browsers stretch
  a full-width auto-layout table's columns, leaving most cells mostly empty.
- With a long path or URL in one cell, that cell's element (`AgentFileLink`
  uses `truncate`, i.e. `white-space: nowrap` plus ellipsis) set the column's
  min-content to the whole path. The auto layout then starved the remaining
  columns, which wrapped to one or two characters per line or overflowed the
  scroll frame.

`overflow-wrap: anywhere` on every cell was tried first and rejected: it
shrinks every column's min-content to one character, so the proportional
distribution starves short columns, and on phones it breaks ordinary words
mid-token. CJK prose also cannot be measured as one "token" — every wide
character is already a break opportunity — so the unbroken-token measure
splits on whitespace *and* on wide characters.

## Decision

- `markdownTableColumnLayout` in `markdown-table.tsx` walks the table hast
  (react-markdown passes it via `ExtraProps['node']`; GFM has no spans, so a
  cell's row position is its column). Per column it records the widest line
  (`<br>` splits lines) and the widest unbroken token in estimated ems (CJK /
  fullwidth / emoji = 1, narrow = 0.55; an `img`/`video` counts as a ~22em
  token so an image column is classified and bounded like a path column).
  `MARKDOWN_TABLE_ONE_LINE_EM = 13`, `MARKDOWN_TABLE_WIDE_EM = 16`,
  `MARKDOWN_TABLE_MAX_COL_EM = 30`.
- The `<table>` carries `data-one-line-columns`, `data-break-anywhere-columns`
  and `data-wide-columns` token lists plus a `<colgroup>` whose `<col>` widths
  are the content estimates capped at 30em. Static `:nth-child` selectors in
  `src/tailwind/index.css` (columns 1–24) turn the flags into
  `white-space: nowrap` (min-width 0), `overflow-wrap: anywhere` +
  `max-width: 20em`, and a wider `min-width` floor (9em; 15em above 640px
  viewport). All cells get a `min-width` floor — 5em, or 8em on wider
  viewports — so no column collapses to a sliver.
- The two caps matter because Chromium distributes spare width proportionally
  to each column's max-content minus min-content: an unbreakable 500px path
  would otherwise win most of the slack even though it already wraps, and when
  every column sits at its minimum a wide column needs the raised floor to
  avoid degenerating into one character per line.
- `AgentFileLink` inside a cell (`[:is(th,td)_&]` variants) becomes inline
  flow: icons are inline-block and the label inherits the cell's
  `white-space` with `line-break: anywhere`, so a wrapped path keeps its file
  icon attached instead of orphaning it on its own line.
- Alternatives considered: a CSS container query on the scroll frame would
  make a shrink-to-fit ancestor collapse (Markdown renders inside bubbles and
  other fit-content surfaces); measuring real widths post-layout would
  re-run on every streaming token and still needs a classification policy.
  The hast heuristic is deterministic, SSR-safe, and stream-stable enough —
  classification is recomputed per render, so a streaming table may re-fit
  once as cells arrive, same as any content-driven width.

## Verification

- `tests/markdown-streaming-reparse.test.ts` asserts the column classes on the
  rendered table for both the static and the streaming renderer paths (the
  CJK-token bug above was caught by this test).
- `src/stories/MarkdownTables.stories.tsx` (Conversation/Markdown tables)
  renders twelve scenarios — the reported status-report table, short
  key/value, prose cells, mixed inline elements, numeric, many columns, long
  unbreakable tokens, a very long prose cell, images in cells, a 16×40 grid,
  and a 14×24 mixed-content table — at 720/480/360px in both themes,
  screenshot reviewed with Playwright.

Not verified: real-device mobile widths below the story's viewport, and fonts
whose CJK glyphs differ much from 2:1.
