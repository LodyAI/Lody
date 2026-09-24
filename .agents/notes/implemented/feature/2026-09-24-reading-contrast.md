# Reading contrast and a dark-theme brightness ceiling

Status: implemented
Translation: current

[中文](2026-09-24-reading-contrast.zh.md)

## Abstract

Long sessions were tiring in dark themes whose foreground is pure white: in Vesper, prose,
headings, menus, buttons, settings and every sidebar title were #FFFFFF on #101010 (19.7:1),
so strokes halated, dense CJK text blurred and nothing marked the reading column. Dark themes
now hold every text foreground under one brightness ceiling, the luminance of text at 11.6:1
against the canvas (#D2CDC5 on Vesper, still above WCAG AAA). Only headings and bold, the
selected sidebar row and the active tab go above it. Unselected sidebar text sits below the
prose. Lody ships Vesper with a warm color temperature: every neutral gray takes a warm
white point (canvas #141312), and the sidebar (#BAB6AE) and selected/active text (#F0EAE1)
are hand-tuned on it. High-contrast themes are unchanged, and light themes cap only
long-form text.

## Decision

- `vscode-theme-css.ts` (`applyReadingBrightness`), dark themes: every text foreground
  token (`--foreground`, card, code, input, secondary and secondary-button, hover,
  selection, bottom bar, tab, sidebar, plus `--code-added/-removed` and `--modified-file`)
  is moved toward the canvas until its luminance is at most the ceiling. Hue is kept.
  `--popover-foreground` and `--accent-foreground` are set from the ceiled foreground: the
  stylesheet defaults for them were an unthemed near-white (`210 40% 96%`), which is why
  dropdown menus stayed white.
- Above the ceiling: `--foreground-strong` (15:1, headings and bold), and the selected
  sidebar row and active tab foregrounds (capped at the same 15:1 step).
- `--reading-foreground` for prose and user bubbles; `--sidebar-row-foreground` (9.2:1)
  for unselected session titles, group and project labels, section headers and New chat /
  Search, so the sidebar never outshines the prose. Hover changes a row's fill only.
- Foregrounds on colored fills (`--primary-foreground`, `--destructive-foreground`,
  highlight foregrounds) keep the theme value: they need contrast against the fill.
- Warm Vesper (`bundled/vesper-warm-palette.ts`), applied once when the bundled theme
  resolves so app tokens, terminal, code highlighting and `--vscode-*` agree: every
  neutral workbench color and syntax foreground takes the white point (1, 0.976, 0.938),
  and opaque surfaces darker than #303030 lift 4 steps (canvas #101010 → #141312, sidebar
  #161616 → #1A1918). Channels are floored so the canvas/sidebar step stays visible.
  Accents and pure black keep their values. The dark `--github-draft` and the Electron
  window/title-bar colors use the same warm grays.
- `READING_THEME_OVERRIDES` pins Vesper's sidebar (#BAB6AE) and selected/active text
  (#F0EAE1), hand-tuned on the warm palette.
- Literal colors outside the tokens: the dark Mermaid palette now stays under the ceiling,
  and the green merge button uses `dark:text-background` like the PR tab's.
- Inline code: 7% fill, reading color. List items 0.5rem apart. The outline rail rests at /32.

## Column and font

- The conversation column caps its CONTENT at 768px (was 700px inside a 736px column):
  `CONVERSATION_CONTENT_WIDTH_CLASS` adds the per-breakpoint gutter to the max width, and
  the outline rail's container threshold moves from 860px to 928px to keep its margin.
- The default sans stack is `"PingFang SC", -apple-system, BlinkMacSystemFont,
"Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Arial` plus emoji fonts. PingFang
  SC is Apple's proprietary system font: it cannot be bundled, so macOS and iOS use it and
  Windows falls back to Microsoft YaHei. Inter stays self-hosted for the interface-font
  setting and diagrams. Bundling an open font (Noto Sans SC / Source Han Sans, SIL OFL)
  for uniform CJK on every platform was not done: it needs unicode-range subsets of a
  multi-megabyte family.

## Alternatives

- Styling each surface (menus, settings, buttons, panels) one by one: a static scan found
  no hard-coded white there; the white came from the tokens, so the ceiling belongs in the
  theme layer where every surface inherits it.
- Editing the bundled theme files: they are vendored and other surfaces read their raw
  values; the derived tokens change only text.
- Dimming row icons and avatars with opacity, and brightening titles on hover: tried and
  rejected; faded icons and avatars read as disabled, and a color change under the pointer
  looks unstable.
- A 40em CJK column: not done here.

## Verification and limits

- `tests/vscode-theme-css.test.ts`: a pure-white dark theme holds `--foreground`, popover
  and sidebar foregrounds at or under 11.6:1, the strong step and active tab between 11.6
  and 15:1, sidebar rows under the prose; Vesper resolves warm (canvas #141312, warm hue on
  surfaces and text, accent unchanged) with its pinned colors; soft and high-contrast
  themes are untouched. `tests/markdown-mermaid-plugin.test.ts` checks the dark diagram
  text is under the ceiling. Components suite passes.
- Local production build with Vesper: prose renders #D1CBC4 (11.5:1); a scan of visible
  backgrounds, text, borders and strokes on the conversation, settings and archive views
  found no neutral or cool gray left.
- Only Vesper was inspected in the browser. Share images, terminals and colored-fill badges
  keep their own colors.
