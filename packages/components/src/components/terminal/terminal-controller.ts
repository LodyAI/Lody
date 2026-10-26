import { atom } from 'jotai';

export type TerminalController = {
  /** Open the bottom dock if it's closed, close it if it's open. */
  toggleOpen: () => void;
  /** Create + focus a new terminal (opening the panel). */
  openNewTerminal: () => void;
};

/**
 * Whether the bottom terminal dock is currently expanded. Kept in sync by the
 * mounted `TerminalDock` so the session header's dock toggle button can reflect
 * open/closed state without prop-threading through the app layout. Changes only
 * on open/close, so subscribing is cheap.
 */
export const terminalDockOpenAtom = atom<boolean>(false);

/**
 * Whether a terminal can actually be created right now (the local daemon is
 * locally ready for this workspace and the session is ready). Kept in sync by the mounted
 * `TerminalDock` from its `canCreateTerminal` prop. Distinct from
 * `terminalDockAvailableAtom`: the header icon stays visible for a local session
 * but is disabled while this is false (e.g. right after launch, while the daemon
 * is still starting), so the toggle no longer silently dead-ends.
 */
export const terminalDockCanCreateAtom = atom<boolean>(false);

/**
 * Published by the mounted `TerminalDock` so app-level command handlers (the ⌃` / ⌘J
 * toggle, and ⌥N "new terminal when the terminal is focused") can drive the terminal
 * without threading callbacks through the deep terminal-dock-host → session layout
 * chain. `null` when no terminal-capable local session is mounted, which is also how
 * the toggle command's `when()` and the header icon know the terminal is unavailable.
 *
 * Consumers should read it imperatively (`useStore().get(...)`) at dispatch time rather
 * than subscribing, so the large session view doesn't re-render on terminal toggles.
 */
export const terminalControllerAtom = atom<TerminalController | null>(null);

/**
 * Whether a terminal-capable local session is currently mounted — i.e. the dock
 * has published its controller (it only does so for a local project on this
 * machine). Drives the session header's dock icon so it only shows for local
 * projects in the desktop app. Derived, so it re-renders subscribers on
 * availability flips, not on every controller identity change.
 */
export const terminalDockAvailableAtom = atom((get) => get(terminalControllerAtom) !== null);
