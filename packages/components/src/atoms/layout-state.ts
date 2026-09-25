import { atom } from 'jotai';
import { sidebarCollapsedAtom } from './sidebar-state';

/**
 * Zen is a transient visibility override for the current app window. The
 * persisted sidebar preferences remain untouched during a hide/restore cycle.
 * Toggling an already fully collapsed layout explicitly reveals its sidebars.
 */
export const zenLayoutModeAtom = atom(false);

/** The mounted desktop Session publishes its panel; null on surfaces without one. */
export const zenRightPanelAtom = atom<{
  open: boolean;
  reveal: () => void;
} | null>(null);

export const navigationSidebarHiddenAtom = atom(
  (get) => get(zenLayoutModeAtom) || get(sidebarCollapsedAtom)
);

/**
 * Whether the desktop renderer is in its compact presentation: the desktop
 * layout family at a viewport below MOBILE_LAYOUT_BREAKPOINT. Written only by
 * `syncCompactDesktopLayoutAtom` (a mounted layout bridges the viewport hook
 * into atom state); always false while the mobile renderer is active.
 */
export const compactDesktopLayoutAtom = atom(false);

/**
 * Ephemeral auto-hide marker: the nav sidebar was on screen when compact
 * started, so it was suppressed rather than left covering a narrow window.
 * An explicit sidebar action clears it, and leaving compact clears it too —
 * `sidebarCollapsedAtom`, the persisted preference, is never rewritten for
 * presentation reasons.
 */
export const compactSidebarSuppressedAtom = atom(false);

/**
 * Effective on-screen visibility of the nav sidebar: the persisted/zen state
 * minus the compact auto-suppression. Surfaces use this (not
 * `navigationSidebarHiddenAtom`) for expand affordances and chrome insets so
 * they respond to what is actually on screen.
 */
export const navigationSidebarVisibleAtom = atom(
  (get) =>
    !get(navigationSidebarHiddenAtom) &&
    !(get(compactDesktopLayoutAtom) && get(compactSidebarSuppressedAtom))
);

/**
 * Viewport → state bridge for the compact desktop presentation. Entering
 * compact auto-hides a visible sidebar instead of letting it cover the
 * window; leaving compact restores whatever the persisted sidebar state says.
 */
export const syncCompactDesktopLayoutAtom = atom(null, (get, set, compact: boolean) => {
  if (get(compactDesktopLayoutAtom) === compact) return;
  set(compactDesktopLayoutAtom, compact);
  if (compact) {
    if (!get(navigationSidebarHiddenAtom)) set(compactSidebarSuppressedAtom, true);
  } else {
    set(compactSidebarSuppressedAtom, false);
  }
});

export type ZenAwarePanelState = {
  zenMode: boolean;
  panelOpen: boolean;
};

/** A panel toggle made during Zen means "leave Zen and reveal this panel". */
export function getZenAwarePanelToggleState({
  zenMode,
  panelOpen,
}: ZenAwarePanelState): ZenAwarePanelState {
  return {
    zenMode: false,
    panelOpen: zenMode ? true : !panelOpen,
  };
}

export const toggleZenLayoutModeAtom = atom(null, (get, set) => {
  const rightPanel = get(zenRightPanelAtom);
  // A fully collapsed layout already looks like Zen. Reveal it on the first press,
  // including after navigating in Zen to a Session whose panel was closed.
  if (get(sidebarCollapsedAtom) && !rightPanel?.open) {
    set(zenLayoutModeAtom, false);
    set(sidebarCollapsedAtom, false);
    rightPanel?.reveal();
    return;
  }
  set(zenLayoutModeAtom, !get(zenLayoutModeAtom));
});

export const showNavigationSidebarAtom = atom(null, (_get, set) => {
  set(zenLayoutModeAtom, false);
  set(compactSidebarSuppressedAtom, false);
  set(sidebarCollapsedAtom, false);
});

export const toggleNavigationSidebarAtom = atom(null, (get, set) => {
  const next = getZenAwarePanelToggleState({
    zenMode: get(zenLayoutModeAtom),
    // Effective visibility: while compact auto-hide is in effect, toggling
    // reveals the sidebar overlay rather than collapsing it one level deeper.
    panelOpen: get(navigationSidebarVisibleAtom),
  });
  set(zenLayoutModeAtom, next.zenMode);
  set(compactSidebarSuppressedAtom, false);
  set(sidebarCollapsedAtom, !next.panelOpen);
});
