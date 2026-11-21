---
name: lody-visualize
description: Show a chart, comparison, mockup or small interactive tool inline in your reply. Lody runs an `html render` fence as live UI inside the conversation. Read this before writing one.
---

# Lody Visualize

In Lody, a closed fence opened with ` ```html render ` is not shown as code.
It runs as a small page inside your reply, in the reader's theme, between the
paragraphs around it. Use it when seeing beats reading. A plain ` ```html `
fence stays source code; use it for HTML the user should read or copy.

## Decide first

| The reader needs                                                 | Write                                  |
| ---------------------------------------------------------------- | -------------------------------------- |
| A flow, sequence, state machine or dependency graph              | a ` ```mermaid ` fence; Lody themes it |
| A trend, distribution, or comparison across many values          | `html render` with an inline SVG chart |
| Something to tweak: sliders, toggles, a calculator, before/after | `html render` with a little script     |
| A UI mockup or layout option                                     | `html render`                          |
| A few numbers, a short list, a small table                       | plain Markdown                         |

One page per idea. If you would need a heading to explain what the page is,
it is probably two pages or should be prose.

## Write the page

- Write a fragment; it is placed inside `<body>`. Inline `<style>` and `<script>`.
- The width is the reply column and narrows on phones. Use fluid widths,
  flex or grid with wrapping, and SVG `viewBox` with `width:100%`.
- Let content set the height. Do not use `vh`, `height:100%` on html or body,
  or `position:fixed`; a page that grows with its frame is stopped.
  Give charts a fixed pixel height, about 160–280px.
- Leave html, body and your outer element without background, border, card,
  shadow, title banner or side padding. The page should read as part of the
  reply. A box that needs its own fill gets 12–16px padding and
  `var(--preview-radius)` corners.
- Do not style `button`, `input`, `select` or `textarea`. Unstyled native
  controls already match Lody; add only layout such as gaps and widths.

## Colour and type

Text, font and size already follow the conversation. Use these on `:root`
instead of fixed colours:

`--preview-text`, `--preview-accent`, `--preview-raised`, `--preview-well`,
`--preview-radius`, `--preview-font`, `--preview-font-size`,
`--preview-line-height`.

- Secondary text: `opacity:.6`. Grid lines and dividers: `currentColor` at
  10–15% opacity.
- One highlighted series: `var(--preview-accent)`; the rest stay neutral.
- When you need extra colours, `color-scheme` is set, so write
  `light-dark(<light>, <dark>)` and check both read on their background.
  Use colour to separate at most five categories; label them directly
  rather than relying on a legend.

## Sandbox

- The page runs isolated with scripts only. No localStorage, sessionStorage,
  cookies or IndexedDB; no `alert`, `confirm` or `prompt`; no form submission,
  popups or opened links. Only `#fragment` links work. Keep state in variables.
- The page cannot talk to you or to Lody. A button cannot send a message or run
  a command; if the user should act, say so in prose.
- It cannot read workspace files. Embed the data as a JSON literal in the script.
- Prefer zero-dependency SVG, Canvas and plain JS. If a library is truly needed,
  pin an exact version from a major CDN, and keep the key numbers in prose,
  because offline readers see nothing.
- Uncaught errors appear under the page. Guard against empty or missing data.

## In the reply

Do not announce or describe the page. The sentence before it says what to look
at; the sentence after says what it means. Do not repeat what the page shows.

## Check before sending

You cannot see the result, so keep pages small (under ~150 lines) and simple.
If a browser tool is available, open the fragment in it and look at it in a
dark and a light theme before sending.

## Example

```html render
<svg id="chart" viewBox="0 0 600 200" style="width:100%;height:200px"></svg>
<script>
  const data = [
    ['Mon', 12],
    ['Tue', 19],
    ['Wed', 7],
    ['Thu', 15],
    ['Fri', 22],
  ];
  const max = Math.max(...data.map(([, value]) => value));
  const step = 600 / data.length;
  document.getElementById('chart').innerHTML = data
    .map(([label, value], index) => {
      const height = (value / max) * 160;
      const x = index * step;
      return `<rect x="${x + 12}" y="${170 - height}" width="${step - 24}" height="${height}"
          rx="3" fill="var(--preview-accent)"/>
        <text x="${x + step / 2}" y="192" text-anchor="middle" font-size="12"
          fill="currentColor" opacity=".6">${label}</text>`;
    })
    .join('');
</script>
```
