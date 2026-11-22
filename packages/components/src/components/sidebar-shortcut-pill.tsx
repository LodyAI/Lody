import { useMemo } from 'react';
import * as stylex from '@stylexjs/stylex';
import { atom, useAtomValue } from 'jotai';
import { ArrowBigUp, ChevronUp, Command, Option, type LucideIcon } from 'lucide-react';
import { corner, duration, ease, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import {
  MAX_SIDEBAR_SHORTCUT_SLOTS,
  SIDEBAR_SHORTCUT_SLOTS,
  resolvedSidebarShortcutPlatformAtom,
  sidebarShortcutIndexMapAtom,
  sidebarShortcutOverlayActiveAtom,
  type SidebarSessionShortcut,
  type SidebarShortcutPlatform,
} from '@/atoms/sidebar-shortcuts';
import { formatKeyParts } from '@/lib/commands';
import { sidebar } from './sidebar.tokens.stylex';

const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce)';

const pillFadeIn = stylex.keyframes({
  from: { opacity: 0, transform: 'scale(0.96)' },
  to: { opacity: 1, transform: 'scale(1)' },
});

const styles = stylex.create({
  pill: {
    boxSizing: 'border-box',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    height: text.subheadlineLeading,
    paddingInline: space[1.5],
    borderRadius: radius.full,
    cornerShape: corner.round,
    backgroundColor: 'color-mix(in oklab, hsl(var(--sidebar-foreground)) 7%, transparent)',
    boxShadow:
      'inset 0 0 0 1px color-mix(in oklab, hsl(var(--sidebar-foreground)) 13%, transparent)',
    color: sidebar.rowText,
    fontSize: text.captionSize,
    lineHeight: 1,
    fontWeight: 500,
    fontVariantNumeric: 'tabular-nums',
    letterSpacing: text.controlTracking,
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    userSelect: 'none',
  },
  macGap: {
    gap: '3px',
  },
  windowsGap: {
    gap: space[1],
  },
  selected: {
    backgroundColor:
      'color-mix(in oklab, hsl(var(--sidebar-selection-foreground)) 12%, transparent)',
    boxShadow:
      'inset 0 0 0 1px color-mix(in oklab, hsl(var(--sidebar-selection-foreground)) 22%, transparent)',
    color: sidebar.selectedText,
  },
  animated: {
    animationName: { default: pillFadeIn, [REDUCED_MOTION]: 'none' },
    animationDuration: duration.fast,
    animationTimingFunction: ease.standard,
  },
  icon: {
    width: '11px',
    height: '11px',
    flexShrink: 0,
  },
  iconGrow: {
    transform: 'scale(1.35)',
  },
});

export type SidebarShortcutPillProps = {
  /** 1-based visible position (1–9). */
  index: number;
  platform: SidebarShortcutPlatform;
  /** Matches selected sidebar row contrast when placed on the active row. */
  selected?: boolean;
  /** Enables the mount fade-in transition when revealed by holding the modifier key. */
  animate?: boolean;
};

/**
 * Unified shortcut pill (`⌘ 1` on macOS, `Control 1` on Windows/Linux) shown on
 * the right edge of the first 9 visible sidebar session rows while the primary
 * modifier key is held.
 */
export function SidebarShortcutPill({
  index,
  platform,
  selected = false,
  animate = true,
}: SidebarShortcutPillProps) {
  return (
    <kbd
      aria-hidden="true"
      data-sidebar-shortcut-pill={String(index)}
      data-sidebar-shortcut-platform={platform}
      {...stylex.props(
        styles.pill,
        platform === 'mac' ? styles.macGap : styles.windowsGap,
        selected && styles.selected,
        animate && styles.animated
      )}
    >
      {platform === 'mac' ? (
        <Command {...stylex.props(styles.icon)} strokeWidth={2} aria-hidden="true" />
      ) : (
        <span>Control</span>
      )}
      <span>{index}</span>
    </kbd>
  );
}

/**
 * macOS modifier glyphs drawn as icons, as the ⌘ pill does: some system fonts
 * paint ⇧ and friends in colour. ArrowBigUp fills ~55% of the lucide grid where
 * Command fills 75%, so `grow` scales ⇧'s artwork to ⌘'s ink — the transform
 * leaves the 11px layout box unchanged — and a thinner stroke restores the
 * shared weight.
 */
const MODIFIER_ICONS: Record<string, { icon: LucideIcon; grow?: boolean }> = {
  '⌘': { icon: Command },
  '⇧': { icon: ArrowBigUp, grow: true },
  '⌥': { icon: Option },
  '⌃': { icon: ChevronUp },
};

/**
 * The same pill for any command binding (registry syntax), e.g. `⌘ ⇧ D` on
 * macOS, `Ctrl Shift D` elsewhere: the sidebar's navigation rows show it at
 * their end while hovered, focused, or while the modifier is held.
 */
export function SidebarBindingPill({
  binding,
  selected = false,
  animate = false,
}: {
  binding: string;
  selected?: boolean;
  animate?: boolean;
}) {
  const parts = formatKeyParts(binding);
  if (parts.length === 0) return null;
  const mac = parts.some((part) => part in MODIFIER_ICONS);
  return (
    <kbd
      aria-hidden="true"
      data-sidebar-binding-pill={binding}
      {...stylex.props(
        styles.pill,
        mac ? styles.macGap : styles.windowsGap,
        selected && styles.selected,
        animate && styles.animated
      )}
    >
      {parts.map((part, index) => {
        const modifier = MODIFIER_ICONS[part];
        if (!modifier) return <span key={index}>{part}</span>;
        const { icon: Icon, grow } = modifier;
        return (
          <Icon
            key={index}
            {...stylex.props(styles.icon, grow && styles.iconGrow)}
            strokeWidth={grow ? 1.5 : 2}
            aria-hidden="true"
          />
        );
      })}
    </kbd>
  );
}

/**
 * Leaf hook for `SidebarRowEndSlot` so holding the modifier key only re-renders
 * the end slots of the up-to-9 matching rows.
 */
export function useSidebarRowShortcut(sessionId?: string) {
  const shortcutAtom = useMemo(
    () =>
      atom<SidebarSessionShortcut | null>((get) => {
        if (!sessionId || !get(sidebarShortcutOverlayActiveAtom)) return null;
        const slotIndex = get(sidebarShortcutIndexMapAtom).get(sessionId);
        if (!slotIndex || slotIndex < 1 || slotIndex > MAX_SIDEBAR_SHORTCUT_SLOTS) return null;
        const platform = get(resolvedSidebarShortcutPlatformAtom);
        return SIDEBAR_SHORTCUT_SLOTS[platform][slotIndex - 1] ?? null;
      }),
    [sessionId]
  );
  return useAtomValue(shortcutAtom);
}
