import type { CSSProperties } from 'react';

// The menu's edge color: a fixed small step from the *surface* (--background)
// toward the foreground. Derive it from --background rather than --border
// because per-theme --border is tuned for elevated cards/popovers and can clash
// hard against --background (e.g. Vesper's bright border over its near-black
// background). The hairline ring uses this mix; separators are a stronger
// ink/white wash so they stay visible on the dark popover fill.
const menuEdgeColor = 'color-mix(in oklab, hsl(var(--background)) 90%, hsl(var(--foreground)) 10%)';

export const menuSurfaceClassName =
  'min-w-[200px] rounded-lg bg-popover p-0.5 text-foreground dark:!bg-[rgb(24_24_24)] dark:![box-shadow:0_0_0_0.5px_rgb(80_80_80),0_8px_20px_0_rgb(0_0_0_/_0.7),0_0_2px_0_rgb(0_0_0_/_0.5)]';

export const menuSurfaceStyle: CSSProperties = {
  backgroundColor: 'hsl(var(--popover))',
  // The edge is a 0.5px ring in this shadow stack, not a layout-affecting
  // border: a real border would shift the 220px min-width and the padding box.
  // Dark theme overrides the fill, a brighter hairline, and a tighter/darker
  // drop (spread 0, 2px ambient diffusion) via `menuSurfaceClassName`.
  boxShadow: `0 0 0 0.5px ${menuEdgeColor}, 0 4px 12px 0 rgb(0 0 0 / 0.08), 0 1px 2px 0 rgb(0 0 0 / 0.06)`,
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
//
// A leading svg passed as a direct child (instead of via the `icon` prop) gets
// the same menu icon tone. `:where()` keeps that rule below any color class on
// the svg itself, so status/brand icons that set their own color keep it.
const menuItemBaseClassName =
  'relative flex w-full min-h-7 cursor-default select-none items-center overflow-hidden gap-2 rounded-md px-2 py-1 text-[0.9em] leading-tight outline-hidden data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:size-3.5 [:where(&)>svg]:text-[color:var(--menu-icon-color,hsl(var(--muted-foreground)))]';

// An item that owns an open surface (a submenu trigger, or a trigger wired to a
// nested menu) stays lit while that surface is open, so the pointer moving onto
// it does not make the row it came from look inactive.
/** Light overlay hover: 5% ink. Dark: 10% white — `--hover` is too close to the
 *  near-black popover fill (`rgb(24 24 24)`). */
export const overlayItemHighlightClassName =
  'bg-foreground/[0.05] text-foreground dark:bg-white/[0.10] dark:text-foreground';

const menuItemOpenStateClassName =
  'data-[state=open]:bg-foreground/[0.05] data-[state=open]:text-foreground aria-expanded:bg-foreground/[0.05] aria-expanded:text-foreground dark:data-[state=open]:bg-white/[0.10] dark:data-[state=open]:text-foreground dark:aria-expanded:bg-white/[0.10] dark:aria-expanded:text-foreground';

export const menuItemClassName = `${menuItemBaseClassName} ${menuItemOpenStateClassName} focus:bg-foreground/[0.05] focus:text-foreground dark:focus:bg-white/[0.10] dark:focus:text-foreground`;

/** Item whose leading box is a selection indicator rather than a caller icon. */
export const menuSelectionItemClassName = `${menuItemBaseClassName} ${menuItemOpenStateClassName} ps-8 focus:bg-foreground/[0.05] focus:text-foreground dark:focus:bg-white/[0.10] dark:focus:text-foreground`;

export const menuItemDestructiveClassName =
  'data-[variant=destructive]:[--menu-icon-color:hsl(var(--destructive))] data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 dark:data-[variant=destructive]:focus:bg-destructive/20 data-[variant=destructive]:focus:text-destructive';

/** Trailing metadata: a shortcut, a count, a hint. */
export const menuItemExtraClassName =
  'ms-auto ps-3 font-mono text-[0.8em] text-muted-foreground/80';

/* Sentence case, not caps: a shouted "RECENTLY USED" reads as chrome from a
   different decade. The old `tracking-[0.6px]` went with it — positive letter
   spacing is a legibility fix for caps and only loosens lowercase. */
export const menuGroupLabelClassName =
  'select-none px-2 pb-0.5 pt-1.5 text-[0.75em] font-normal leading-tight text-muted-foreground/80';

export const menuSeparatorClassName = 'my-0.5 h-px bg-foreground/[0.10] dark:bg-white/[0.18]';

export const menuSeparatorStyle: CSSProperties = {};
