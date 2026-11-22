import { atom } from 'jotai';
import { isMac } from '@/lib/commands/platform';
import { sidebarNavItemsAtom, type SidebarNavItem } from './focus-layer';

export type SidebarShortcutPlatform = 'mac' | 'windows';

export type SidebarSessionShortcut = {
  readonly index: number;
  readonly platform: SidebarShortcutPlatform;
};

export const MAX_SIDEBAR_SHORTCUT_SLOTS = 9;
export const SIDEBAR_SHORTCUT_HOLD_DELAY_MS = 150;

/**
 * Whether the primary modifier key (`Command` on macOS, `Control` on
 * Windows/Linux) has been held past the reveal delay so visible sidebar rows
 * display their `1–9` shortcut pills.
 */
export const sidebarShortcutOverlayActiveAtom = atom<boolean>(false);

/**
 * Optional platform override used by Storybook previews to toggle between
 * macOS (`⌘ 1`) and Windows (`Control 1`) pills without mutating OS globals.
 */
export const sidebarShortcutPlatformOverrideAtom = atom<SidebarShortcutPlatform | null>(null);

export const resolvedSidebarShortcutPlatformAtom = atom<SidebarShortcutPlatform>((get) => {
  const override = get(sidebarShortcutPlatformOverrideAtom);
  if (override) return override;
  return isMac() ? 'mac' : 'windows';
});

/**
 * Returns up to 9 deduplicated session IDs in top-to-bottom visible order
 * across all expanded sidebar sections.
 */
export function getVisibleSidebarShortcutSessionIds(items: readonly SidebarNavItem[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind !== 'session') continue;
    if (seen.has(item.sessionId)) continue;
    seen.add(item.sessionId);
    ids.push(item.sessionId);
    if (ids.length >= MAX_SIDEBAR_SHORTCUT_SLOTS) break;
  }
  return ids;
}

export function buildSidebarShortcutIndexMap(
  items: readonly SidebarNavItem[]
): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  const ids = getVisibleSidebarShortcutSessionIds(items);
  ids.forEach((id, idx) => {
    map.set(id, idx + 1);
  });
  return map;
}

export const sidebarShortcutIndexMapAtom = atom<ReadonlyMap<string, number>>((get) =>
  buildSidebarShortcutIndexMap(get(sidebarNavItemsAtom))
);

/**
 * Preallocated frozen descriptors keyed by platform and 0-based slot index so
 * `Object.is` identity stays stable across renders.
 */
export const SIDEBAR_SHORTCUT_SLOTS: Record<
  SidebarShortcutPlatform,
  readonly SidebarSessionShortcut[]
> = {
  mac: Array.from({ length: MAX_SIDEBAR_SHORTCUT_SLOTS }, (_, idx) =>
    Object.freeze({ index: idx + 1, platform: 'mac' as const })
  ),
  windows: Array.from({ length: MAX_SIDEBAR_SHORTCUT_SLOTS }, (_, idx) =>
    Object.freeze({ index: idx + 1, platform: 'windows' as const })
  ),
};
