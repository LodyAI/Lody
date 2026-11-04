# Sidebar footer visual language

Status: implemented
Translation: current

[中文](2026-10-17-sidebar-footer-visual-language.zh.md)

## Abstract

The desktop sidebar's top and bottom edges looked like different products: the
header and navigation rows used the sidebar's own ink and fills, while the footer
was built from the generic ghost button (its own hover colour, weight and radius)
under a hairline that dead-ended at the page card's corner. The footer now uses the
navigation rows' material: no top rule, a workspace row laid out like a navigation
row, and icon buttons shared with the header. Its sides are wider (12px, was 6px)
because 6px read as cramped; its height stays the compact 36px. The cost is that the footer no longer
follows the UI primitive's ghost treatment on desktop. Nothing was inspected in a
running app.

## Decision and evidence

- The page card already parts from the window by lightness rather than by a line, so
  the desktop footer drops its `border-t`; the mobile drawer has no card and keeps it.
- `sidebarSurface.iconButton` (`sidebar-surface.ts`) is the one icon-only control:
  28px, `radius.small`, resting in the muted ink and rising to the row ink with the
  hover fill, `selected` for the current page. The footer's `IconButton` and the
  header's `SidebarHeaderIconButton` both use it. Mobile keeps the 48px ghost button.
- The workspace control is a `button` with `sidebarSurface.row` and `footerRow`: a
  fixed 28px (the icon buttons' height at any font size), its 16px avatar in a 16px
  icon column, in the row's regular weight. This replaces the 20px avatar and weight
  500 of the previous [footer Spec](../../../../specs/sidebar-footer.md), which is
  updated and stays `draft`.
- Spacing: the footer pads 12px each side (it was 6px) and keeps its 4px vertical
  padding. The workspace row's 6px inline padding puts the avatar 18px from the
  edge, matching the Settings glyph. The 28px controls, 4px gaps and 4px vertical
  padding of the [compact footer note](2026-10-04-sidebar-footer-density.md) stand.
  The avatar therefore starts 3px right of the navigation icon column. A taller
  footer was tried and rejected for the height it added.
- Alternative not taken: restyling `@lody/ui`'s ghost `Button` through `className`,
  which the components rules forbid.

## Verification limits

No tests, type-check or desktop inspection could run in the authoring environment
(no Node toolchain). Run `pnpm check`, the sidebar suites and the documentation
check, then look at the footer in both themes. The Updated list's rows are 2px
shorter than the Workspace list's and navigation rows; this note does not change that.
