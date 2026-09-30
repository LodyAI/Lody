# Regular weight for menu options

Status: implemented
Translation: current

[中文版](2026-09-30-menu-regular-weight.zh.md)

## Abstract

Shared menus inherited weight 500 while the sidebar filter's popover used 400,
giving peer choices different emphasis. Menu labels now use weight 400, including
composer pickers and mention menus. Group headings and search matches retain
their emphasis, and ordinary controls keep their existing type roles. The
change reduces menu emphasis without changing selection or navigation behavior.

## Decision

The [menu primitive decision](../feature/2026-09-11-ui-menu-primitives.md) remains
the owner of shared menu behavior. This partially replaces its use of the
general control typography rule for command rows. The current intent is in the
[menu typography Spec](../../../../specs/menu-typography.md), and construction
rules remain in [token usage](../../../../packages/ui/src/tokens/RULES.md#menus).

`popupMenu` overrides weight rather than changing the base popup: Select and
Combobox fields retain their control typography, and popup prose retains its
existing role. Menubar labels follow the menu rule. The composer picker and
mention surfaces restate this weight because they render their own row lists.

Keeping all menus at 500 would preserve consistency within the old primitive
but retain the unwanted emphasis. Per-menu class overrides would scatter the
decision and miss submenus. The shared declaration keeps peer commands regular
while preserving headings and matched search characters.

## Validation

Executed in a separate clone with the same changed source files:

- `pnpm --filter @lody/ui typecheck` passed.
- The UI menu, popover and gallery suites passed (57 tests); the product menu,
  session header, permission, attachment and mention suites passed (57 tests).
- Playwright rendered the existing Storybook fixtures before and after the
  change. Session, run-config, model submenu, attachment/MCP and mention rows
  changed from computed weight 500 to 400; sidebar filter rows stayed at 400.
  Both capture passes reported no page errors. Images use synthetic fixtures.
- Changed-file Oxfmt, Oxlint and `git diff --check` passed.
- Root `pnpm format`, typecheck and lint passed. The full `pnpm check` stopped
  at `boot-shell.test.tsx`'s unavailable-storage case (1 failed, 4559 passed in
  components). The same case failed on the unmodified baseline in the same
  clone. Electron tests were not reached. The remaining i18n and import/platform/
  public-boundary checks were run separately and passed.

Removed the menu test that counted emitted CSS classes: it asserted an incidental
style count instead of user behavior. Existing keyboard, pointer, toggle and
submenu coverage remains, and Playwright checked rendered font weights.

`pnpm run docs check` reports 62 existing broken links to absent ACP submodule
files in this worktree; none belong to this change.
The Spec remains draft. Screenshot artifacts are local and excluded from Git.
