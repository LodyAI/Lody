# Product style layer

Product controls and standard surfaces use `@lody/ui` family tokens and its
[material rules](../../../ui/src/tokens/RULES.md). This directory retains app/domain
colours and layout scales; a legacy theme alias is not proof of design-system
conformance. [Design-system convergence](../../../../.agents/notes/implemented/architecture/2026-11-07-design-system-convergence.md)
owns the deliberate replacement of preserved legacy overrides.

| Part                                              | Responsibility                                                        |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| [Theme colors](theme-colors.stylex.ts)            | App semantic colors, including portals and VS Code themes.            |
| [Theme scale](theme-scale.stylex.ts)              | Existing spacing, radius, type, motion, shadow and stacking scales.   |
| [Migration guide](MIGRATION.md)                   | Style ownership, cascade, compatibility and real visual verification. |
| [Visual acceptance](../../tests/visual/README.md) | Deterministic browser verification and self-contained HTML reports.   |

The declaration bridge, its Tailwind-dependent profile and the Electron Tailwind
plugin have been removed. Browser normalization and ordinary theme defaults live
in `../tailwind/{reset,theme-defaults}.css`; the product stylesheet has no utility
compiler input. Storybook also uses local StyleX without a utility compiler.
Components use local StyleX directly; primitive overrides compose through typed
`xstyle` props. The [migration guide](MIGRATION.md) describes the remaining
transition and verification rules.

## Palette and roles

The product's `theme-provider.tsx` publishes the resolved semantic palette, shadows
and sheens on the document root; ordinary portals inherit them. Forced palettes
must use the existing theme owners that redeclare dependent family tokens. Raw
subtree `--input` or `--composer` overrides are not the design system's theme API.

Use `field` for value/placeholder/well, `popup` for floating lists and metadata,
`card` for a card surface, and component variants for controls. Disabled state
reads `control.disabledOpacity` once. Icons and supporting text take their named
ink roles instead of an arbitrary `opacity` multiplier. Media overlays use the
paired `media.scrim` / `media.label` contrast roles; ordinary controls do not.

`themeColors` remains for legacy and domain-specific readers, including code and
GitHub state. Its aliases resolve where their group is declared. A retained local
CSS palette must use its explicit scoped owner; an inherited alias does not
re-evaluate descendant overrides. `scopedThemeColors` and `scopedThemeSpace`
retain those migration contracts, not a replacement vocabulary for UI families.

## Legacy colour map

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

For an explicitly preserved migration comparison, preserve the exact original
declaration. For design-system convergence, select the existing semantic role
and record the intentional visual change. The retired Tailwind 4.3 compiler used
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
the retained compiler-output evidence for each legacy utility rather than
inferring its expression from the preset or another migration.

Do **not** mint a token per alpha step (`muted60`, `border60`, …). There is no
semantic behind most of those numbers, and a token would freeze a value the
theme may want to move. Choose an existing semantic role for the component or
material before introducing a new token.

Use the current read-only inventory with `node scripts/design-system-audit.mjs`.
It records opacity, mixes, shadows and literal colours with owner/state context;
its findings require semantic review and are not a violation count. Visibility,
artwork and motion are distinct from disabled controls or hint text. Add a named
role only when an actual semantic gap exists; do not create `muted60`-style steps.

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

Spacing tokens read `--spacing`, the theme's one spacing unit, at their definition
scope. Root theme changes keep them coupled to the spacing scale; descendant overrides
need the [local variable contract](MIGRATION.md#preserve-the-computed-contract)
because an inherited StyleX alias has already resolved its dependencies. Type sizes retain the original rem scale: the
interface-font-size tiers (`--ui-font-size`) resized the body copy only, and a
migrated surface must not start following them.

## Cascade

The stylesheet retains `@layer theme, base, stylex, components, utilities` for
ordinary native CSS and StyleX extraction. There is no utility compiler input.
Remove retired selectors when their last real consumer has migrated; preserve
active integration hooks, browser resets and theme variables.

Primitive overrides compose through typed `xstyle` props inside the owner's
`stylex.props` call. `className` remains available for ordinary integration hooks;
combining opaque atomic class strings does not establish caller precedence.

[`message-action-button.stylex.ts`](message-action-button.stylex.ts) owns the
local palette for the reviewed message action Buttons. Its complete typed
`inherit` maps preserve parent layout, material and focus tokens while changing
only the existing color roles. These themes assume the fixed `currentColor`
glyph/label subtrees audited by their callers; they are not a general Button skin.
The [migration guide](MIGRATION.md#ownership-and-cascade) records the same-element
inline token and portal limits.

## What a migration produces

- A `stylex.create` block in the component, or a shared `surface.ts` beside it
  when an area's rows share a look (`components/settings/surface.ts` is the
  model).
- Tokens from this directory.
- No new abstraction between the component and its styles: a component's
  styles live with the component.
