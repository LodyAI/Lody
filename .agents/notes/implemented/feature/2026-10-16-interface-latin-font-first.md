# Interface polish: Latin font first, two radii, distinct sidebar hover

Status: implemented
Translation: pending

## Abstract

The default interface stack listed `PingFang SC` first, so Latin text — file names, branch names, repository slugs — rendered with PingFang's Latin glyphs, whose hyphens read as dashes. `--font-sans-default` now starts with the already self-hosted `Inter`; Inter has no CJK glyphs, so Chinese still falls through per glyph to PingFang SC, then Microsoft YaHei. This revises the stack chosen in [reading contrast](2026-09-24-reading-contrast.md), which kept PingFang first "for CJK and Latin alike".

## Also in this pass

- Conversation blocks (file card, edited-files list, markdown image) share the 8px radius; the user bubble is 12px (`conversation.bubbleRadius`). Two radii, as the review asked.
- The session file card drops its `bg-card/80` fill and keeps the hairline border, so a block uses one edge treatment; hover still fills.
- Default sidebar `--sidebar-hover` / `--sidebar-selection` are pulled further apart (light 91.5% / 85.5%, dark 13% / 22%, white-ground 94% / 87%) so a hovered row no longer looks selected. VS Code themes derive their own values and are unchanged.
- Sidebar type and colour: group labels were 12px **bold** at 70% muted, which reads as shouting small print; they are now medium. Unselected rows in the light theme used the same near-black as the selected row (`--sidebar-row-foreground` aliased `--sidebar-foreground`), so nothing separated them; the light default is now `225 7% 28%` and the selected row keeps `11%`. The `.dark` block restates the alias, and themed builds still derive the value in `vscode-theme-css.ts`.
- Sidebar rows (titles, nav rows, repo rows) move from the 14px body role to the 13px subheadline role (`sidebarTypography.row`), and repo rows become medium weight so a repo reads as a heading over its conversations. In sidebar rows the PR icon's GitHub hue (green/purple/red/grey) is replaced by the muted sidebar colour; only the CI verdict mark keeps a hue (the existing tests pin those). The permission-wait hand uses the primary colour instead of orange, so the row's attention marks share one accent.
- **Migration.** The sidebar's visual layer moved from Tailwind colour/radius classes to StyleX: `components/sidebar-surface.ts` over `components/sidebar.tokens.stylex.ts` (which still reads the theme's `--sidebar-*` variables, so the dark ceiling and Vesper selection keep working). Conversation rows in the session, task and Updated lists, the repo/group header rows and the navigation rows share one `row`, `hover`, `selected` and `title`. This also unified three drifting implementations: the Updated list used 14px `text-sm`, the task list `text-xs semibold` repo headers and full-ink titles, the session list the 13px role. The group label's weight moved into `sidebarTypography.groupLabel`. Still Tailwind on purpose: `group/row` hover reveals, `data-[menu-open]`, `has-[a:focus-visible]` rings, mobile branches. `session-list-opened-by.test.ts` asserted a Tailwind class name for the selected row; it now asserts `aria-current`.
- Left alone on purpose: Chinese duration has no space (`工作了7分25秒`) while counts keep one (`{{count}} 个`), both documented conventions ([duration spacing](../bug-fix/2026-09-26-compact-duration-spacing.md)); sidebar rows stay 1em and group labels are already smaller than rows; a single `ConversationColumn` already caps content width.

## Decision and ownership

`packages/components/src/tailwind/index.css` owns `--font-sans-default`. User-chosen interface fonts still prepend to it (`local-fonts.ts`), so the setting is unaffected.

## Verification limits

Not run: this environment had no Node or pnpm (the installed binaries are darwin builds), so no typecheck, lint, format, tests or visual check. Run `pnpm check` and `pnpm format` before merging; the edited `className={stylex.props(...).className}` sites may need Oxfmt line breaks. Latin metrics change slightly (Inter is wider than PingFang's Latin), so line breaks in dense sidebar rows need a visual pass.
