# Isolate share image palettes from the app theme

Status: implemented
Translation: current
PR: [#1281](https://github.com/LodyAI/Lody/pull/1281)

[中文](2026-10-06-chat-share-palette-isolation.zh.md)

## Abstract

Choosing a light chat image inside a dark app made assistant prose nearly
invisible; Usage team cards also retained the app's default-avatar palette.
Both defects came from StyleX aliases resolved at the app root. Cards now bind
the selected product palette and their conversation or avatar themes locally;
code-block dark styling respects the card scope. Chromium reproduction and
palette switching verify the correction, including chat and Usage PNG downloads.
Native Electron export is untested.

## Evidence and decision

On repository revision `9b8cd7715`, a light card in a dark app rendered its
background as `rgb(239, 239, 241)` and assistant prose as `rgb(228, 229, 231)`.
Their contrast was 1.10:1. Bold text was `rgb(240, 241, 242)`, while the prompt
and caption used the light CSS variables correctly. This explains the different
legibility of the two speakers without attributing the defect to PNG encoding.

The [Markdown StyleX migration](../simplification/2026-10-03-conversation-rhythm-stylex.md)
introduced semantic conversation aliases. CSS custom properties resolve their
references where they are declared; overriding the referenced variables on a
descendant does not re-evaluate an inherited alias. The existing
`ensureShareThemeScopes` therefore covered legacy CSS consumers but could not
isolate the StyleX Markdown renderer. Code blocks also matched `.dark *` inside
a light card.

The [conversation token owner](../../../../packages/components/src/components/ai-gui/conversation.tokens.stylex.ts)
shares one defaults object between `defineVars` and `scopedConversationTheme`.
The [card](../../../../packages/components/src/components/share-card/chat-share-card.tsx)
applies this theme and the full selected product palette alongside the existing
light/dark CSS scope. This re-evaluates reading, emphasis, quotes, table and code
colours against the card's own variables. The code-block dark selector also
recognizes `.dark-scope` and excludes `.light-scope`.

A descendant foreground override would fix plain prose while leaving emphasis,
secondary text and code surfaces inconsistent. Local semantic themes cover those
roles without changing shared Markdown element styles or the
[fixed template](../feature/2026-09-14-chat-share-card-fixed-template.md).
The corrected light prose is `rgb(29, 29, 32)`, with 14.64:1 contrast against the
same background. The card layout, theme controls and export pipeline keep their
existing responsibilities.

### Usage and scope audit

The [Usage card](../../../../packages/components/src/components/settings/usage-share-card.tsx)
uses the scoped CSS variables directly for totals, labels and graphics. Its
team-member fallback avatars instead inherit semantic avatar aliases: a light
card in a dark app rendered initials as `rgb(215, 216, 217)` on
`rgb(46, 46, 46)`, while the same card in a light app used `rgb(26, 27, 30)` on
`rgb(230, 232, 237)`. Both combinations remain readable; this is palette leakage,
not the chat card's almost invisible prose.

Pinned Usage cards now apply the selected full product palette and the existing
`avatarPaletteTheme` on the card scope. The UI package exports that theme's token
module for this composition. An unspecified card palette still inherits the app
normally. Source inspection found that only chat and Usage share cards create
`light-scope` / `dark-scope` boundaries; other matching components only consume
these selectors. This audit establishes the two export boundaries, not the
correctness of every theme scope or visualization in the app.

## Verification and limits

The [typography browser suite](../../../../packages/components/tests/e2e/interface-typography.spec.ts)
adds four app/card combinations with opposing system appearances and two repeated
palette-switch cases. It checks actual computed colours, code wrapping, hidden
copy controls and the unchanged app theme. The light-card/dark-app case fails
against the original production files on the inherited prose colour; all six
cases pass with the correction. Twelve Usage cases cover both aspects in all
app/card combinations, the unpinned app palette, and repeated dialog switches.
The original Usage file fails specifically on the fallback-avatar colour;
all 18 chat and Usage cases pass in bundled Chromium. Fixtures are synthetic.
Usage stats/calendar/export unit suites pass 33 tests, and the UI package
typecheck passes. Regenerating the lockfile for the export-only manifest change
leaves it unchanged because dependencies did not change.

Playwright captured before/after screenshots of the real card and share dialog.
The real dialogs' Export PNG actions completed browser downloads. Chat text and
syntax colours, and Usage member avatars were inspected. Usage before/after
screenshots were also uploaded through Lody. The export, code-helper and theme-CSS
unit suites pass all 26 tests. Changed-file lint passes. The component typecheck reports the
same 27 errors with the original and changed production files: missing viewer
dependencies and incompatible reused dependency APIs. It is not a passing
typecheck. The required `pnpm check` stops during the documentation site's
pre-typecheck because `fumadocs-mdx` is unavailable; `pnpm format`, platform and
Code Collab import guards, and the i18n key check pass. The public-boundary check
cannot resolve the four other uninitialized adapter workspace packages.
An extended typography run
passed the six share cases but stalled on the existing conversation fixture and
was stopped. Docs check reports links into other uninitialized ACP submodules;
none of its errors concerns changed documentation. Native Electron save/clipboard
and Mermaid diagram palettes were not exercised by this verification.
