# Render streaming Markdown with `@lobehub/streamdown`

Status: implemented
Translation: current

[中文](2026-09-26-lobehub-streamdown.zh.md)

## Abstract

Conversation Markdown was rendered by Vercel's `streamdown`, which bundled its own
code-block, Mermaid, and math UI and kept streamed text arriving in raw chunks.
It is replaced by `@lobehub/streamdown`, a headless engine that paces the
streamed text and fades in only the characters still arriving. The engine is
loaded lazily and used only while a turn streams; finished text renders through
plain react-markdown, and Lody now owns the code-block, highlighting, and Mermaid
components the old library used to supply. The main trade-off is more local UI
code in exchange for smooth streaming and a static path with no animation cost.

## Problem

- Vercel `streamdown` delivered each streamed chunk as-is, so text arrived in
  visible jumps. Its word-level `animated` mode wrapped every word of the whole
  turn in a span, which is why it was never enabled.
- Much of what it provided was already overridden: the Mermaid full-screen and
  pan/zoom canvas were disabled
  ([gesture note](../bug-fix/2026-09-09-mermaid-diagram-gestures.md)), and
  `tailwind/index.css` fought its utility classes with `!important`.

## Decision

- `markdown-renderer.tsx` renders `react-markdown` for finished text and
  `@lobehub/streamdown`'s `Streamdown` while `isStreaming`. The engine re-parses
  only the open tail block, smooths the reveal, and fades only in-flight
  characters; settled text has no animation spans, so the cost does not grow
  with the turn.
- The streaming renderer stays mounted for one second after the stream ends so
  its buffered tail finishes revealing, then hands over to the static renderer.
- The engine is a lazy chunk. Its bundle contains lookbehind regex literals,
  which are a parse error in Safari < 16.4 (the same constraint behind the
  `remend` patch and the lazy `@pierre/diffs` import); a failed load resolves to
  a static renderer instead of breaking the turn.
- Lody owns the parts the old library supplied: `markdown-code-block.tsx`
  (container, copy button, token body), `markdown-code-highlight.ts` (tokens
  from the existing highlight worker with its main-thread fallback and bounded
  cache), and `markdown-mermaid-block.tsx` (render, copy, SVG/PNG/source
  download through an armed `Menu`). The `data-streamdown="…"` attributes are
  kept as styling and test hooks.
- A streaming code block keeps its last highlighted tokens with the appended
  text plain until the worker answers, and its prefixes are no longer written to
  the highlight cache, where they evicted finished blocks.
- `@lobehub/streamdown` completes the open tail with `remend`'s defaults, whose
  HTML-tag step drops everything after a TeX comparison such as `p<q`
  ([earlier fix](../bug-fix/2026-09-20-streamdown-math-document-truncation.md)).
  `@lobehub/streamdown` 1.4.0 added a `remend` option for this
  ([lobehub/streamdown#5](https://github.com/lobehub/streamdown/pull/5)); the
  renderer passes `{ htmlTags: false }`, as the old renderer did. 1.4.0 is
  listed in `minimumReleaseAgeExclude` because it was adopted on release day.
- A remark plugin marks unclosed fences so a streaming fence reports
  `data-incomplete`; an unclosed Mermaid fence stays an ordinary code block until
  it closes instead of re-rendering the diagram on every commit.
- Math uses `remark-math` and `rehype-katex` directly with the same options that
  `@streamdown/math` passed.

## Alternatives

- Keep Vercel `streamdown` and feed it `useSmoothStreamContent` output: smaller
  change, but keeps the overridden bundled UI and gets no per-character fade.
- Use `Streamdown` for every message: it animates on mount, so a virtualized
  row scrolling back into view would replay its fade, and it would put the
  lookbehind chunk on every page.

## Verification and limits

- `tests/markdown-streaming-reparse.test.ts` covers the streaming-to-static
  handoff, fence completeness, raw-HTML escaping, autolink repair on both paths,
  and the `p<q` math tail while streaming (fails without the `remend` option); `tests/markdown-mermaid-fullscreen.test.tsx` passes unchanged against
  the new block markup.
- Checked in Storybook: code highlighting, tables, KaTeX, Mermaid actions and
  download menu, and the streaming demo (fade spans only while streaming, none
  after the handoff).
- While streaming, each top-level block parses on its own, so footnotes and
  reference-style links resolve only once the turn finishes.
- Old Safari streams without smoothing or fades; not verified on a real device.
