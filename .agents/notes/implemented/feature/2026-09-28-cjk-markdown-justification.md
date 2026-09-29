# Align CJK Markdown prose at both edges

Status: implemented
Translation: current

[中文](2026-09-28-cjk-markdown-justification.zh.md)

## Abstract

Chinese paragraphs in conversation Markdown ended at visibly different right edges,
while applying justification to every message would stretch English and technical
content. The renderer now marks individual paragraphs that contain Han characters
and applies justification only to top-level prose blocks. Headings, lists, tables,
quotes, inline code, and fenced blocks keep their existing start alignment. The
last line remains start-aligned, so the change improves the paragraph edge without
introducing a large trailing gap.

## Decision

- `MarkdownRenderer` extracts text from each rendered paragraph and adds the
  `markdown-cjk-paragraph` class when that paragraph contains Han characters.
- `tailwind/index.css` applies `text-align: justify`, `text-justify: auto`, and
  `text-align-last: start` only to marked top-level paragraphs.
- The detection is intentionally content-based instead of tied to the interface
  locale: an English UI can receive a Chinese answer, and a Chinese UI can receive
  an English answer.

## Alternatives

- Justifying every Markdown paragraph was rejected because English, package names,
  URLs, and numbers can develop excessive word spacing.
- Applying `text-align: justify` to the whole renderer was rejected because it
  would also affect headings, list items, tables, and code surfaces.
- Restricting the rule to `lang="zh"` was rejected because message content can be
  Chinese while the application locale remains English.

## Verification and limits

- The selector is scoped to marked top-level paragraphs, so headings, lists,
  block quotes, tables, and code surfaces are unchanged.
- Detection treats any Han character in a paragraph as CJK content; a paragraph
  containing a small Chinese fragment alongside English may therefore justify.
- Package checks were not run in this checkout because `pnpm`/Corepack and the
  workspace dependencies are unavailable.
