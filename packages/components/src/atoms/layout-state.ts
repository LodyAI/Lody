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
  set(sidebarCollapsedAtom, false);
});

export const toggleNavigationSidebarAtom = atom(null, (get, set) => {
  const next = getZenAwarePanelToggleState({
    zenMode: get(zenLayoutModeAtom),
    panelOpen: !get(sidebarCollapsedAtom),
  });
  set(zenLayoutModeAtom, next.zenMode);
  set(sidebarCollapsedAtom, !next.panelOpen);
});
