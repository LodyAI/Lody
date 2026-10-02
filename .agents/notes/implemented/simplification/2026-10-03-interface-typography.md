# One baseline for interface typography

Status: implemented
Translation: current

PR: [#1221](https://github.com/LodyAI/Lody/pull/1221)

[中文](2026-10-03-interface-typography.zh.md)

## Abstract

Appearance already changed conversation prose and the document baseline, but
fixed primitive tokens, nested `em` and rounded output formulas made other text
follow different scales. Existing `@lody/ui` roles now derive both size and leading
from that baseline; product surfaces choose roles without another token family.
The five tiers and legacy preference migration stay intact. Terminal preferences
remain independently saved and are multiplied at render time; browser and isolated
OSS desktop verification cover the changed boundaries, not every native platform.

## Decision

This extends the [five-tier interaction](2026-09-19-conversation-font-size-tiers.md)
and replaces the independent output formulas from the
[conversation scale](2026-09-14-conversation-font-size-scale.md).
Current intent is in [Interface typography](../../../../specs/interface-typography.md)
(draft, not human-approved).

`InterfaceFontController` continues publishing `--ui-font-size` on the document.
Existing StyleX `text` tokens express `Default metric × baseline / 14`, preserving
their nominal values. Portals read the same document scale. The rejected alternative
was resizing descendants with `em`: compact prose, table cells and nested code would
compound, and portals would lose the parent's ratio.

Sidebar titles and prompts take body; groups and descriptions take footnote;
Composer controls, compact tool prose, code and tool output take subheadline.
Markdown headings use the existing heading roles and paired leading. A small adapter
preserves explicitly sized standalone Markdown previews by cancelling the document
baseline before applying the requested size; it does not own a second role map.

Settings' parallel caption/title aliases are deleted, with their callers mechanically
moved to the shared tokens. Chat/tool metadata and status labels also select these
roles rather than overriding them with fixed px or Tailwind type utilities.
Unused mono/compact helpers and overridden output leading
are removed. The StyleX class-count Popover test and style-object-only font test are
replaced by computed browser metrics and terminal state checks; existing interaction
coverage remains. No new primitive, token family or generic typography framework.

Actual xterm size is `saved terminal size × interface baseline / 14`. Existing
in-place font/refit behavior retains the terminal, selected output, family and saved
base preference. The native settings preview uses the same calculation.

## Retained exceptions

Font families, brand/landing headlines, icons, spacing and control geometry are not
redesigned. Settings paragraphs retain their proportional leading. xterm keeps its
1.2 line-height ratio; one-line button labels retain their
centered button metric. Reference chips remain relative to their surrounding prose;
they do not nest compact containers. Third-party diagrams, document viewers, editor
zoom and the separate task-body editor are outside this ordinary-text migration.
Browser CSS typed division is used only by the explicit-size preview adapter; pinned
Electron 43 and tested Chromium support it. Older Safari/shared-page hosts were not
verified.

## Verification and deletion comparison

The synthetic `InterfaceTypography` story renders real SessionList, Appearance
settings, Composer/OptionSelector, Markdown, tool sheets, terminal output, xterm,
Menu/Popover/Tooltip and Field. The browser regression selects all five values through
the settings UI, checks actual font sizes and leading (including nested code and
portal content), searches options, checks keyboard focus/dismissal, reloads, and reads
legacy preferences. Matrix: light/dark at 1280px and light at 720px, mixed Chinese and
English, long titles/prose/output. All four cases passed after restoration.

Temporarily reversing the production patch to main `9ea2768` made that regression
fail. At Larger, main rendered message/prompt/menu/code at 16/14/13/14.4px; restored
code renders 16/16/14.857/14.857px. The document variable alone would not prove this.

An isolated built OSS Electron was launched with the existing E2E harness: temporary
data/profile and a random owned CLI endpoint, no user's running app. Settings →
Appearance selected all five tiers; the real prompt rendered 12/13/14/15/16px, the
terminal preview multiplied its base 13px preference, and reload retained Larger.
No provider execution or private conversation was captured.

| Command | Observed result |
| --- | --- |
| `pnpm build` | OSS CLI + desktop production build passed; existing bundle/import warnings |
| `pnpm check` (Node 26.10.0) | Type checks/lint passed; UI 298 tests passed; components 4741 passed, one boot-shell failure also reproduced with production changes reverted |
| `pnpm check` (isolated Node 22.14.0, before main integration) | Type checks/lint passed; shared stopped at a WASM loader error, also reproduced with production changes reverted |
| `NODE_ENV=test pnpm --filter @lody/components test --maxWorkers=2` (Node 22.14.0) | All 4742 tests passed after integrating main `d3e249d2f` |
| `pnpm --filter @lody/ui test` / `pnpm --filter @lody/electron test` | 298 / 199 tests passed |
| `pnpm check:quick` | Lint, i18n, import and platform/public boundaries passed |
| `NODE_ENV=test pnpm --filter @lody/components test tests/appearance-settings.test.tsx tests/interface-font-controller.test.tsx tests/terminal-settings.test.ts tests/local-terminal-panel.test.tsx` | 33 tests passed |
| `LODY_STORYBOOK_URL=http://127.0.0.1:6016 pnpm --filter @lody/components test:e2e interface-typography.spec.ts --workers=1` | Four browser cases passed; reversal comparison failed as expected |
| `pnpm format` | Passed |
| `pnpm run docs check` | Passed; pre-existing translation/size warnings, no SHA-protected topics |

Both full-check failures were reproduced against main production source, not waived.
The first integrated browser run overlapped a build-triggered preview reload and
lost focus during navigation; rerunning after the build passed all four cases
without changing assertions. Production build, Node 26 full check, Node 22 component
suite and browser verification were rerun after the conflict-free main integration.
Node 22 passes boot-shell; Node 26 passes shared's WASM suite. The broken Homebrew
Node 22 installation was left untouched; a pnpm-cached isolated Node 22 supplied
the second runtime. No checks were disabled. Windows/Linux native UI, signed packaging,
live provider streams, other system font families and older Safari are not accepted
by this run.

## Screenshots

All content is synthetic. Same 1280×1600 viewport and content for each before/after
pair; captures preserve wrapping changes. The narrow capture is 720×1600.
Before is main's production
source with the same fixture; after is restored implementation.

| State | Before | After |
| --- | --- | --- |
| Default, light | [14px](../../assets/interface-typography/before-14.png) | [14px](../../assets/interface-typography/after-14.png) |
| Larger, light, menu open | [16px](../../assets/interface-typography/before-16-menu.png) | [16px](../../assets/interface-typography/after-16-menu.png) |
| Smaller, light | — | [12px](../../assets/interface-typography/after-12.png) |
| Larger, dark | — | [16px](../../assets/interface-typography/after-16-dark.png) |
| Larger, narrow desktop (720px) | — | [16px](../../assets/interface-typography/after-16-narrow.png) |
