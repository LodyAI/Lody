import type { CSSProperties } from 'react';

// The menu's edge color: a fixed small step from the *surface* (--background)
// toward the foreground. Derive it from --background rather than --border
// because per-theme --border is tuned for elevated cards/popovers and can clash
// hard against --background (e.g. Vesper's bright border over its near-black
// background). Shared by the surface's hairline ring and the inner separators
// so they read as the same line in every theme.
const menuEdgeColor = 'color-mix(in oklab, hsl(var(--background)) 90%, hsl(var(--foreground)) 10%)';

export const menuSurfaceClassName = 'min-w-[220px] rounded-xl bg-background p-1 text-foreground';

export const menuSurfaceStyle: CSSProperties = {
  // Match the app's main background so the menu reads as the same surface.
  backgroundColor: 'hsl(var(--background))',
  // The edge is the ring in this shadow stack, not a layout-affecting border:
  // a real border would shift the 220px min-width and the padding box.
  boxShadow: `0 0 0 1px ${menuEdgeColor}, 0 4px 12px 0 rgb(0 0 0 / 0.08), 0 1px 3px 0 rgb(0 0 0 / 0.06)`,
};

/**
 * Fixed box for an item's leading glyph. The icon is sized by this wrapper —
 * `[&>svg]:size-full` — never by guessing whether the caller already set a size
 * on the svg. Icon libraries name their own classes (lucide emits
 * `lucide-trash-2`), so any `[class*='h-']`-style guess misfires.
 */
export const menuItemIconClassName =
  'flex size-3.5 shrink-0 items-center justify-center text-[color:var(--menu-icon-color,hsl(var(--muted-foreground)))] [&>svg]:size-full';

// The svg rule is UNCONDITIONAL on purpose. It used to skip svgs whose class
// looked like a caller-supplied size, but that test is a substring match and
// icon libraries name their own classes (lucide emits `lucide-trash-2`, which
// contains `h-`), so the rule silently skipped them and they rendered at the
// library's 24px default. A caller that genuinely needs another size says so
// with `!`.
const menuItemBaseClassName =
  'relative flex w-full min-h-8 cursor-default select-none items-center overflow-hidden gap-3 rounded-lg px-3 py-1.5 text-sm leading-5 outline-hidden data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5';

// An item that owns an open surface (a submenu trigger, or a trigger wired to a
// nested menu) stays lit while that surface is open, so the pointer moving onto
// it does not make the row it came from look inactive.
const menuItemOpenStateClassName =
  'data-[state=open]:bg-hover data-[state=open]:text-hover-foreground aria-expanded:bg-hover aria-expanded:text-hover-foreground';

export const menuItemClassName = `${menuItemBaseClassName} ${menuItemOpenStateClassName} focus:bg-hover focus:text-hover-foreground`;

/** Item whose leading box is a selection indicator rather than a caller icon. */
export const menuSelectionItemClassName = `${menuItemBaseClassName} ${menuItemOpenStateClassName} ps-8 focus:bg-hover focus:text-hover-foreground`;

export const menuItemDestructiveClassName =
  'data-[variant=destructive]:[--menu-icon-color:hsl(var(--destructive))] data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive';

/** Trailing metadata: a shortcut, a count, a hint. */
export const menuItemExtraClassName = 'ms-auto ps-4 font-mono text-xs text-muted-foreground/80';

export const menuGroupLabelClassName =
  'select-none px-3 pb-1 pt-2 text-[10px] font-semibold uppercase leading-[14px] tracking-[0.6px] text-muted-foreground/80';

export const menuSeparatorClassName = 'my-1 h-px';

export const menuSeparatorStyle: CSSProperties = {
  backgroundColor: menuEdgeColor,
};
