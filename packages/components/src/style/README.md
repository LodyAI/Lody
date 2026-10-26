# Product style layer

The Tailwind → StyleX migration's shared vocabulary. A migrated surface reads
its colours from `theme-colors.stylex.ts` and its sizes from
`theme-scale.stylex.ts`. Values preserve the existing theme contract; browser
comparisons verify their computed behavior. The migration is incomplete.

| Part                                                       | Responsibility                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------- |
| [Theme colors](theme-colors.stylex.ts)                     | App semantic colors, including portals and VS Code themes.            |
| [Theme scale](theme-scale.stylex.ts)                       | Existing spacing, radius, type, motion, shadow and stacking scales.   |
| [Migration guide](MIGRATION.md)                            | Style ownership, cascade, compatibility and real visual verification. |
| [Alpha catalogue](ALPHAS.md)                               | Existing ad-hoc color opacity expressions.                            |
| [Visual harness](../../tests/visual/visual-regression.mjs) | Real screenshots, interaction states and self-contained HTML reports. |

## Why the theme's own variables

Tailwind's preset maps every colour to `hsl(var(--token))`, and the app writes
those variables on the document root — from the bundled palette, from `.dark`,
and at runtime from the active VS Code theme
(`lib/vscode-theme/vscode-theme-css.ts`). A token here is that same expression,
so a migrated surface keeps its colour in every theme, in every theme variant,
and inside a portal (a portal renders outside the subtree carrying the
`@lody/ui` palette, so `@lody/ui`'s `colors` are not a safe reference for a
product surface).

`@lody/ui`'s primitives keep reading `colors`: that is the design system's
palette, and a primitive is not a product surface.

## Colour map

| Tailwind                                     | StyleX                                                      |
| -------------------------------------------- | ----------------------------------------------------------- |
| `bg-background`                              | `backgroundColor: themeColors.background`                   |
| `text-foreground`                            | `color: themeColors.foreground`                             |
| `bg-card` / `text-card-foreground`           | `themeColors.card` / `themeColors.cardForeground`           |
| `bg-popover` / `text-popover-foreground`     | `themeColors.popover` / `themeColors.popoverForeground`     |
| `bg-primary` / `text-primary-foreground`     | `themeColors.primary` / `themeColors.primaryForeground`     |
| `bg-secondary` / `text-secondary-foreground` | `themeColors.secondary` / `themeColors.secondaryForeground` |
| `bg-muted` / `text-muted-foreground`         | `themeColors.muted` / `themeColors.mutedForeground`         |
| `bg-hover` / `text-hover-foreground`         | `themeColors.hover` / `themeColors.hoverForeground`         |
| `bg-selection`                               | `themeColors.selection`                                     |
| `text-destructive` / `bg-destructive`        | `themeColors.destructive`                                   |
| `border-border`                              | `borderColor: themeColors.border`                           |
| `border-input` / `bg-input`                  | `themeColors.input`                                         |
| `ring-ring`                                  | `boxShadow: \`0 0 0 2px ${themeColors.ring}\``              |
| `bg-sidebar` / `text-sidebar-foreground`     | `themeColors.sidebar` / `themeColors.sidebarForeground`     |
| `text-status-success`                        | `themeColors.statusSuccess`                                 |
| `text-github-merged`                         | `themeColors.githubMerged`                                  |
| `bg-code` / `text-code-foreground`           | `themeColors.code` / `themeColors.codeForeground`           |

The sidebar's own tokens (`sidebar.tokens.stylex.ts`) stay where they are.

### Alpha

Preserve the exact original declaration. The locked Tailwind 4.3 compiler uses
`color-mix` in `oklab` for these opacity modifiers:

```ts
// bg-muted/60
backgroundColor: 'color-mix(in oklab, hsl(var(--muted) / 1) 60%, transparent)';
// border-border/60
borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)';
// text-foreground/90
color: 'color-mix(in oklab, hsl(var(--foreground) / 1) 90%, transparent)';
```

An existing direct `hsl(var(--token) / alpha)` declaration stays direct HSL.
Do not interchange it with a mix based on the same percentage: the Diff Viewer
path comparison exposed different computed colors and glyph-edge pixels. Inspect
the installed compiler's output for each utility rather than inferring its
expression from the preset or a previous migration.

Do **not** mint a token per alpha step (`muted60`, `border60`, …). There is no
semantic behind most of those numbers, and a token would freeze a value the
theme may want to move. The catalogue of the alphas in use, and the ones with no
semantic home, is recorded in [ALPHAS.md](./ALPHAS.md) — that list is the
input to the question "which of these deserve a name?", asked once rather than
one arbitrary step at a time.

Where an alpha has a semantic home in the theme, use that token instead:
`hsl(var(--hover) / 0.4)`, `hsl(var(--selection) / 0.5)`.

## Size map

| Tailwind                        | StyleX                                                                |
| ------------------------------- | --------------------------------------------------------------------- |
| `p-2` / `gap-4` / `mt-1.5`      | `themeSpace[2]` / `themeSpace[4]` / `themeSpace[1.5]`                 |
| `rounded-lg`                    | `borderRadius: themeRadius.lg`                                        |
| `rounded-full`                  | `borderRadius: 'calc(infinity * 1px)'`                                |
| `text-sm`                       | `fontSize: themeFontSize.sm` **and** `lineHeight: themeLineHeight.sm` |
| `font-semibold`                 | `fontWeight: themeFontWeight.semibold`                                |
| `duration-200` / `ease-pro`     | `themeDuration[200]` / `themeEasing.pro`                              |
| `shadow-panel`                  | `boxShadow: themeShadow.panel`                                        |
| `z-50` (arbitrary `--z-dialog`) | `zIndex: themeZ.dialog`                                               |

`text-*` sets a size **and** a line height in Tailwind v4. A surface that keeps
only the size re-wraps its copy; keep the pair.

These mappings require the [compiled variable contract](MIGRATION.md#preserve-the-computed-contract).
Some radius and weight tokens retain literal legacy defaults; they cannot
replace a runtime variable merely because the default screenshot matches.

Spacing reads `--spacing`, the theme's one spacing unit, so a migrated surface
and a Tailwind one stay coupled. Type sizes stay on Tailwind's rem scale: the
interface-font-size tiers (`--ui-font-size`) resized the body copy only, and a
migrated surface must not start following them.

## Cascade

The stylesheet declares `@layer theme, base, stylex, components, utilities`, so
a Tailwind utility beats a StyleX style on the same property. While both are
present, remove the Tailwind class you replaced — leaving it makes the Tailwind
class the winner and the migration invisible.

`className` stays available on a migrated component for layout and interaction
constraints from a caller. It is not a place to re-state the component's own
visual design.

## What a migration produces

- A `stylex.create` block in the component, or a shared `surface.ts` beside it
  when an area's rows share a look (`components/settings/surface.ts` is the
  model).
- Tokens from this directory.
- No new abstraction between the component and its styles: a component's
  styles live with the component.
