# Error and not-found pages share one V2 column

Status: implemented
Translation: current

[中文](2026-09-25-v2-error-pages.zh.md)

## Abstract

Lody's failure screens were built at different times in different systems. The
pre-React boot screen was an inline-styled card with a red kicker, a pink error
block and "Copy error" as its primary action. The 404 page used a 9xl "404" and
Tailwind. Session-not-found used a grey icon disc. The crash screen floated a card
over the page. They now stand in one frame, `StatusPage`, in the V2 material: no
card, a centred column on the page ground. It opens with a small drawing of a Lody
window that moves once to show what happened, then a reassuring sentence and the
way out, with the verbatim error and the details quieter below. The boot screen cannot use that component
(it has to render when React or StyleX did not), so it draws the same column in
plain DOM with the V2 token values copied into a scoped stylesheet. The cost is
that those copied values can drift from `@lody/ui`'s tokens, and no test catches it.

## Decision

- **One frame, three layouts.** `components/status-page.tsx` renders a drawing,
  a title, one sentence, then caller blocks, centred. `window` is the whole window:
  page ground, its own scroll (the shell clips `#root`) and a desktop drag strip,
  because a full-window failure otherwise leaves a hidden-titlebar window
  immovable. `pane` fills a panel that already has a ground. `region` is the
  existing section boundary: it stands in for that section on the section's own
  ground (no fill, no mark), start-aligned, with smaller type and no drawing.
- **Calm, not alarming.** The owner found the first V2 pass "让人心慌" (it made
  people anxious): a red mark, the raw error first and a red wipe button. Pages
  now open with a drawing instead of the mark. The copy leads with reassurance
  ("Your sessions and files are untouched"). The error text stays on screen,
  as the crash-recovery rule requires, but after the actions, in the secondary
  label. The wipe is a quiet footnote link whose confirmation dialog carries the
  cost.
- **The drawing carries the event.** `lib/status-illustrations.ts` holds two SVG
  strings of a Lody window. In `broken`, a content block slips from its slot and
  lands tipped below the window, with a small bump mark. In `missing`, a lens
  sweeps an empty content area. Each moves once, is still afterwards, and does
  not move at all under reduced motion. A page that keeps moving keeps asking for
  attention.
- **No card.** A page that has failed is the page. The old card sat on a halo
  shadow that read as a second layer. It also broke the ladder rule that a
  card is a block on a page, not the page.
- **The way out leads.** On the boot screen, Reload is the primary action and Copy
  is secondary. On the crash screen the four-step "If it keeps happening" list
  repeated the buttons above it. It shrank to one footnote line holding both the
  Discord link and the last-resort wipe, which keeps its confirmation dialog.
- **Surfaces state what only they know.** 404 shows the address it was asked for.
  The boot screen names the likely fix when a chunk failed to load. It shows the
  build it is running, and a separate title when the renderer died
  (`surface: 'recovery'`). It follows the stored theme (`vite-ui-theme`) and
  language (`lody-language`), since neither ThemeProvider nor i18next has run.
- **The boot screen restates tokens instead of importing them.** It is plain DOM
  plus one `<style>` element scoped to `.lody-boot-failure`, which the renderer
  CSP already allows. The drawings are plain strings coloured by `--si-*` custom
  properties, so both screens share one source: React sets the properties from
  tokens, the boot stylesheet from copied literals. Importing `@lody/ui` tokens would call `stylex.defineVars`
  at runtime, which throws exactly the error the screen was reporting.

## Alternatives considered

- **Put `StatusPage` in `@lody/ui`.** Rejected for now. It composes product
  behaviour (the Electron drag strip) and has three product callers. A package
  primitive would need its own token group, gallery entry and rules section. The
  frame reads only `@lody/ui` tokens, so it can move there later.
- **Stock illustration or a mascot.** Rejected: the owner reads decoration
  as cheap. The drawing is the product's own window in its own materials, and it
  shows what happened rather than a mood.
- **A test that parses `colors.stylex.ts` to pin the boot screen's copies.**
  Rejected: that is a source-string assertion. The drift risk is recorded
  in the file header and in `lib/AGENTS.md` instead.

## Design review round 2

A critique of the first pass found the alarm had come back on the smaller
surfaces and the crash screen still offered seven ways out.

- `section` and `inline` lost the red circle and the pink strip. Both open with a
  human sentence ("This part couldn't be shown") and one reassurance in the page's
  voice; inline keeps the raw error behind its copy button and a tooltip.
- `region` drops its fill rather than becoming a card. The 3% ink tray sat below
  its canvas in light and read as a hole, and a section fallback replaces the
  section itself, as a failed page is the page. So it keeps the host's ground.
- The crash screen is two buttons (Try again, Reload Lody), the error with an
  icon-only copy button in its corner (`StatusPageCode action`), the details
  disclosure and one footnote line: "Still stuck? Tell us on Discord or clear
  local data." The wipe still opens its confirmation dialog. The message-list
  fallback uses the same copy placement. The boot screen keeps its two buttons.
- Action buttons lost their leading icons (retry, reload, back), on the boot
  screen as well. The only icon left on an action is the icon-only copy button.
- Titles use `text-wrap: balance` and descriptions and footnotes use `pretty`,
  in `StatusPage` and in the boot stylesheet. The zh 404 line was shortened to
  one line so it no longer leaves "过期。" alone.
- Copy: the page title is "Lody couldn't show this page" (was "Lody hit a
  snag"), the message-list line uses 你, and a chunk-load boot failure is titled
  "Part of Lody didn't load" instead of claiming Lody did not start.
- The illustrations are unchanged.

## Verification

`tests/boot-failure.test.ts` renders the DOM screen. It checks that a
half-committed tree is replaced, the action order, that diagnostics stay folded
until asked, and copy confirmation on the button with a fake-timer reset. It
also checks that blocked copies open the diagnostics, that reload waits for a
click, and that the stored language and palette are followed. The crash and
message-list suites keep their behavioural coverage through the new frame.
Every surface was screenshotted in Chromium through Storybook (`Pages/BootFailure`,
`Components/ErrorBoundaryFallback`, `Pages/NotFound`,
`Components/SessionNotFound`, `Sessions/MessageListErrorFallback` and the share
page's unsupported-content story), in light and dark. A frame paused mid-fall
confirmed the drop path. The packaged desktop
recovery page and the drag strip on a real macOS window were not exercised.
`components/sessions/session-file-error-state.tsx`, a file-preview notice rather
than a page, keeps its Tailwind card.
