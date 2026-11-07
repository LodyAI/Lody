import type { ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { themeRadius, themeFontWeight, themeSpace } from '../../style/theme-scale.stylex';
import { withClassName } from '@/lib/stylex';

/* Deterministic 0–359 hue from a string. Tiny FNV-ish hash; collisions
   are fine because we only need visual variety, not uniqueness. */
function stringToHue(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export type MobileInitialLetterAvatarSize = 'xs' | 'sm' | 'md' | 'lg';

const styles = stylex.create({
  base: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: themeFontWeight.semibold,
    color: '#ffffff',
  },
  /* Project list mark; the box reads spacing locally, while type and corner follow rem. */
  xs: {
    width: 'calc(var(--spacing) * 5)',
    height: 'calc(var(--spacing) * 5)',
    borderRadius: '0.25rem',
    fontSize: '0.68rem',
  },
  /* Header chip — paired with `text-base` titles. */
  sm: {
    width: themeSpace[6],
    height: themeSpace[6],
    borderRadius: themeRadius.md,
    fontSize: '0.72rem',
  },
  /* Default — used in the project header next to a `text-[0.98rem]` title. */
  md: {
    width: themeSpace[7],
    height: themeSpace[7],
    borderRadius: themeRadius.lg,
    fontSize: '0.82rem',
  },
  /* Home row leading tile. */
  lg: {
    width: themeSpace[10],
    height: themeSpace[10],
    borderRadius: themeRadius.xl,
    fontSize: '1.05rem',
  },
});

/**
 * Default avatar for any "named entity without its own image" surface
 * (local projects, chat-only sessions, etc). Renders the first letter
 * of `name` on a solid saturated background whose hue is derived from
 * `hashSeed` so each entity gets a stable color across renders. Solid
 * bg + white foreground reads in both light + dark themes without
 * per-theme CSS.
 *
 * Pass `hashSeed` distinctly when the same `name` should still produce
 * different hues per entity (e.g. two projects named "lody" on
 * different machines — use the unique id as the seed).
 */
export function MobileInitialLetterAvatar({
  name,
  hashSeed,
  size = 'md',
  fallbackIcon,
  className,
}: {
  name: string;
  hashSeed: string;
  size?: MobileInitialLetterAvatarSize;
  fallbackIcon?: ReactNode;
  className?: string;
}) {
  const trimmed = name.trim();
  const initial = trimmed.length > 0 ? Array.from(trimmed)[0]!.toUpperCase() : null;
  const hue = stringToHue(hashSeed || name);
  return (
    <span
      style={{ backgroundColor: `hsl(${hue} 62% 52%)` }}
      {...withClassName(stylex.props(styles.base, styles[size]), className)}
      aria-hidden="true"
    >
      {initial ?? fallbackIcon}
    </span>
  );
}
