# Reading contrast and a dark-theme brightness ceiling

Status: implemented
Translation: current

[中文](2026-09-24-reading-contrast.zh.md)

## Abstract

Long sessions were tiring in dark themes whose foreground is pure white: in Vesper, prose,
headings, menus, buttons, settings and every sidebar title were #FFFFFF on #101010 (19.7:1),
so strokes halated, dense CJK text blurred and nothing marked the reading column. Dark themes
now hold every text foreground under one brightness ceiling, the luminance of text at 13:1
against the canvas (#DDD7CF on Vesper, still above WCAG AAA). Conversation prose sits one
step above it (15.9:1, #EFEDEB: HSL lightness 93%), shared by the selected sidebar row and
the active tab; only headings and bold go above that. Unselected sidebar text sits below
the prose. Lody ships Vesper with a warm color temperature: every neutral gray takes a warm
white point (canvas #141312), and the sidebar titles (#C7C3BD) are hand-tuned on it. High-contrast themes are unchanged, and light themes cap only
long-form text.

## Decision

- `vscode-theme-css.ts` (`applyReadingBrightness`), dark themes: every text foreground
  token (`--foreground`, card, code, input, secondary and secondary-button, hover,
  selection, bottom bar, tab, sidebar, plus `--code-added/-removed` and `--modified-file`)
  is moved toward the canvas until its luminance is at most the ceiling. Hue is kept.
  `--popover-foreground` and `--accent-foreground` are set from the ceiled foreground: the
  stylesheet defaults for them were an unthemed near-white (`210 40% 96%`), which is why
  dropdown menus stayed white.
- Above the ceiling: `--foreground-strong` (17.3:1, headings and bold). The selected sidebar
  row and the active tab are capped at the prose step, so they are brighter than the other
  sidebar text but never brighter than the conversation; their fill marks the selection.
- `--reading-foreground` for prose and user bubbles (15.9:1; Vesper pins #EFEDEB); `--sidebar-row-foreground` (10.6:1)
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
- `READING_THEME_OVERRIDES` pins Vesper's prose, selected and active text (#EFEDEB) and
  sidebar titles (#C7C3BD), hand-tuned on the warm palette.
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

## Conversation details

- GitHub references: a link whose text only names a pull request or issue (the URL
  itself, `#123`, `repo#123`, `owner/repo#123`, `PR #123`) renders as a link-blue chip,
  `[icon] owner/repo #123`: the pull-request or issue icon names the kind (also spoken to
  screen readers), and the tinted fill (no border) marks it as clickable
  (`github-reference-link.tsx`, `.markdown-reference-chip`). A link with its own wording,
  or a number that does not match its URL, stays an ordinary link. The anchor keeps the
  in-app PR interception.
- Tables: lines are foreground tints (frame and header rule 14%, row and column rules 8%)
  because the theme border melts into the canvas; no zebra stripes. No row or column is
  assumed to be a label: every cell shares one color and weight, and only the header row,
  which Markdown always has, gets a faint band. A copy button (top right, on hover or
  focus, always on touch) copies the table as HTML plus a Markdown fallback
  (`markdown-table.tsx`).
- Sidebar footer: Settings plus one More menu (Archive, then Docs, community, feedback,
  bug report). While Archive is open the More slot becomes its exit: the archive icon,
  a back arrow on hover, returning to the previous page (Home without history). Active
  footer icons use a 12% foreground fill (16% on hover); the row selection token was
  nearly invisible behind a 24px icon.
- Process rows: "Context compacted" and "Retrying…" are process status lines, not cards,
  so they share the "Ran N commands" header's box and gap (34px rhythm; was 39 / 32px).
- Info bar: the PR number is secondary text beside the colored PR icon; CI is a verdict
  icon (no tinted "CI" pill); line totals sit in a tinted chip on the right edge.
- Line totals everywhere (+/−) use `github-addition` / `github-deletion`, the PR's green
  and red. `--code-added` keeps the theme's diff color for diff highlighting.
- Sidebar: PR marks are desaturated (`saturate(0.55)`, a filter, not opacity); the
  `Mergeable` pill is the one status meant to be noticed, with a real fill and semibold
  label.
- Settings navigation: after `@lody/ui` (#913) rebuilt it on `settings/surface.ts`, its rows
  take the palette's `hoverFill` / `selectedFill` and the package's avatar, not this change's
  10% selected fill and 18px account avatar. What carried over is the focus treatment: a
  keyboard-focused row shows the hover fill instead of the accent ring, since the dialog
  focuses a row when it opens.

## Alternatives

- A 15px default (tiers 13–18px, chrome 1px under the prose): implemented, then reverted
  after review in the app, where 15px prose read as too large. The default stays 14px on
  the 12–16px scale, with chrome and prose at the same size.
- Letting wide tables and Mermaid diagrams extend past the 768px column, centered on it:
  implemented, then reverted after review in the app, where blocks jutting out of the
  reading column looked odd. Wide blocks stay in the column (tables scroll, diagrams open
  full screen).
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
  and sidebar foregrounds at or under 13:1, the strong step and active tab between 13
  and 17.3:1, sidebar rows under the prose; Vesper resolves warm (canvas #141312, warm hue on
  surfaces and text, accent unchanged) with its pinned colors; soft and high-contrast
  themes are untouched. `tests/markdown-mermaid-plugin.test.ts` checks the dark diagram
  text is under the ceiling. Components suite passes.
- Local production build with Vesper: prose renders #EFEDEB (HSL L 93%, 15.9:1); a scan of visible
  backgrounds, text, borders and strokes on the conversation, settings and archive views
  found no neutral or cool gray left.
- Only Vesper was inspected in the browser. Share images, terminals and colored-fill badges
  keep their own colors.
