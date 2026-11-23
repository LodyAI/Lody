# Compact permission controls with readable option names

Status: implemented
Translation: current

PR: https://github.com/LodyAI/Lody/pull/1584

[中文](2026-10-15-permission-option-wrapping.zh.md)

## Abstract

Long permission names could push refusal buttons outside the prompt and hide
future authorization scope behind menu ellipses. The prompt keeps short answers
directly clickable and moves a family with a long shown answer into a compact
menu trigger. Menus show complete provider names, left-aligned and wrapping
within the viewport. Long answers require an additional menu-opening step; six
browser scenarios and three chat-footer scenarios pass in Storybook. Native
pending-request delivery remains unverified.

## Decision and ownership

This supplements the [split-button decision](../feature/2026-09-24-permission-prompt.md#fifth-review-split-buttons)
and updates the existing draft [permission presentation contract](../../../../specs/permission-requests.md#contract).
Simply wrapping the original button labels produced large centered paragraphs
with a small detached chevron. That approach was rejected during visual review:
it fixed overflow but overwhelmed the composer-scale prompt.

[PermissionPrompt](../../../../packages/components/src/components/sessions/floating-permission-request.tsx)
owns the compact-control budget: 32 character places, counting characters above
Latin-1 twice. A main option exceeding that budget moves its entire family into
a menu, preserving provider order and original names. The trigger says Decline,
Allow, or Choose an answer according to the main option's tone; it names a group
and never submits an option. Short names retain the existing direct answer and
optional split-menu interaction. The direct answer and chevron use `ButtonGroup`
with one shared seam. No multiline Button API is introduced.

A grouped Button marks itself as a segment. Corner selectors count only those
markers, ignoring the focus guards Base UI inserts around an open menu trigger.
Otherwise the trigger ceases to be the last DOM child and loses its outer
corners. This applies to every button size and pill shape; the previous
class-only group assertion is replaced by browser checks of actual geometry.

The menu's provider labels preserve whitespace, wrap long paths, have a 32em
width ceiling, and shrink within the popup's existing viewport limit. They use
an element child to bypass the primitive's automatic ellipsis wrapper, leaving
other menus unchanged. Menus explicitly prefer the top side because the prompt
replaces the composer at the bottom of chat. Base UI retains viewport collision
avoidance and portal mounting. Even with the previous default bottom preference,
a menu in that position normally flips upward when bottom space is insufficient;
the earlier top-of-page captures did not establish chat-footer behavior.
Arrow navigation still focuses the family's control;
Enter opens a long-answer menu, and selecting its original row submits the
original option ID. Escape on the prompt retains its one-time-refusal behavior.

## Verification and limits

The [permission stories](../../../../packages/components/src/stories/PermissionPrompt.stories.tsx)
provide synthetic English and Chinese long names, a long path, and a visible
selected-ID outcome. All nine [browser cases](../../../../packages/components/tests/e2e/composer-submission-focus.spec.ts)
pass in Playwright 1.58.2 with Chrome against the full Storybook server:

- Six standalone cases at 320, 390, and 1280 pixels check compact controls,
  containment, complete menu text, and selecting the original ID only after
  opening the menu.
- Three full conversation-page integration cases at 1280×800, 390×844, and
  390×420 check the button group's shared seam, square inner corners and round
  outer corners while menus are open, upward positioning, viewport containment,
  and hit testing to detect clipping by the surrounding chat layout.

The permission component suite passes 15 tests; the UI package passes all 299
tests across 25 files and its package typecheck. Dependencies are reused from an existing complete public
checkout through ignored links, with `@lody/ui` resolving to this worktree's
modified source. The full conversation-page stories compose real page, stream,
column, and permission components with synthetic session data. They do not drive
a live daemon/provider request. The installed desktop was visually inspected for
bottom-composer placement; native pending-request delivery remains unverified.

Ignored screenshots under `.lody/permission-acceptance/screenshots/` include the
baseline, earlier iterations, and full-chat desktop/mobile/short-viewport menus.
The full-chat captures were uploaded to the task conversation.

Root `pnpm format`, `pnpm lint:i18n`, Oxfmt 0.65.0, and `git diff --check` pass.
`pnpm check` stops at the unchanged `e2ee-core` package's missing dependencies.
Components typecheck also reports missing dependencies and existing errors in
other modules, with no diagnostics in the changed prompt or stories. The public
boundary check reports missing ACP submodule workspaces; `docs check` reports 82
links to those missing submodules and no errors in changed documentation. No
protected documentation topics are registered.
