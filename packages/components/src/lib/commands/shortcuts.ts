import { GLOBAL_SHORTCUT_DEFAULTS, type GlobalShortcutId } from '@lody/shared';
import type { KeyBinding, Platform, Runtime } from './types';

export type ShortcutCommandId =
  | 'palette.toggle'
  | 'nav.back'
  | 'nav.forward'
  | 'app.cycleTheme'
  | 'workspace.openSettings'
  | 'session.new'
  | 'session.archiveCurrent'
  | 'sidebar.toggle'
  | 'session.toggleCurrentPinned'
  | 'session.searchCurrent'
  | 'session.focusInput'
  | 'session.toggleExplorerSidebar'
  | 'session.copyCurrentBranch'
  | 'session.copyUrl'
  | 'session.renameCurrent'
  | 'session.newTabOrTerminal'
  | 'session.closeFocusedTab'
  | 'session.toggleTerminal'
  | 'session.saveCurrentFile'
  | 'session.nextTab'
  | 'session.previousTab'
  | 'session.previousVisible'
  | 'session.nextVisible'
  | 'session.cycleMode'
  | 'session.cycleProvider'
  | 'session.cycleModel'
  | 'session.cycleThinkEffort'
  | 'tasks.quickAdd'
  | 'tasks.open';

type CommandKeybindings = Array<string | KeyBinding>;

const electron = (key: string): KeyBinding => ({ key, runtimes: ['electron'] });
const web = (key: string): KeyBinding => ({ key, runtimes: ['web'] });
const whileComposerFocused = (key: string): KeyBinding => ({
  key,
  when: (event) => {
    const target = event.target;
    return target instanceof Element && target.closest('[data-lody-composer-input]') !== null;
  },
});

export const COMMAND_SHORTCUTS: Record<ShortcutCommandId, CommandKeybindings> = {
  'palette.toggle': ['$mod+k', '$mod+Shift+p'],
  // Browser-style history nav. Desktop only — on web ⌘[ / ⌘] are the browser's own
  // back/forward and can't be intercepted.
  'nav.back': [electron('$mod+[')],
  'nav.forward': [electron('$mod+]')],
  'app.cycleTheme': [],
  // Settings: ⌘, follows OS convention, on web + desktop. On desktop the native app menu
  // still SHOWS ⌘, next to "Settings" but does NOT register the accelerator
  // (`registerAccelerator: false` in apps/electron menu.ts), so the key reaches this
  // registry binding — a single source that also shows + is rebindable on the
  // keyboard-shortcuts settings page (instead of an invisible native-menu accelerator).
  'workspace.openSettings': ['$mod+,'],
  'session.new': [electron('$mod+n'), web('$mod+Alt+n')],
  'session.archiveCurrent': ['$mod+Alt+a'],
  'sidebar.toggle': ['$mod+b'],
  'session.toggleCurrentPinned': ['$mod+Alt+p'],
  'session.searchCurrent': [electron('$mod+f'), web('$mod+Alt+f')],
  // Desktop ⌘L focuses the composer. On web the browser owns ⌘L (Open Location),
  // so leave it unbound — the hint chip follows the resolved binding.
  'session.focusInput': [electron('$mod+l')],
  'session.toggleExplorerSidebar': ['$mod+Alt+b'],
  'session.copyCurrentBranch': ['Alt+Shift+b'],
  'session.copyUrl': ['Alt+Shift+c'],
  'session.renameCurrent': ['F2'],
  // ⌥N creates a new tab, or a new terminal when the terminal is focused (desktop).
  // ⌘T is intentionally avoided — the browser claims it on web.
  'session.newTabOrTerminal': ['Alt+n'],
  // Electron's native menu only displays this accelerator; the renderer owns it so the
  // focused in-app tab closes instead of the BrowserWindow.
  'session.closeFocusedTab': [electron('$mod+w')],
  // Open/close the terminal panel (desktop, local sessions only).
  'session.toggleTerminal': [electron('Ctrl+`'), electron('$mod+j')],
  'session.saveCurrentFile': ['$mod+s'],
  // Tab + conversation switching use the Mac-browser convention: ⌘⇧[ / ⌘⇧] step
  // between conversations and ⌘⇧, / ⌘⇧. (i.e. ⌘⇧< / ⌘⇧>) between tabs. The bracket
  // / comma / period keys are matched by physical position (event.code) so the
  // shifted glyph ({ } < >) the OS reports doesn't matter — see physicalKeyFromEvent.
  'session.nextTab': [electron('$mod+Shift+.')],
  'session.previousTab': [electron('$mod+Shift+,')],
  'session.previousVisible': [electron('$mod+Shift+[')],
  'session.nextVisible': [electron('$mod+Shift+]')],
  // ⇧Tab cycles the agent mode while the composer is focused. The other cyclers ship
  // WITHOUT a default binding — they're rebindable from the keyboard settings page.
  'session.cycleMode': [whileComposerFocused('Shift+Tab')],
  'session.cycleProvider': [],
  'session.cycleModel': [],
  'session.cycleThinkEffort': [],
  'tasks.quickAdd': ['$mod+Alt+t'],
  'tasks.open': [],
};

export function getCommandKeybindings(id: ShortcutCommandId): CommandKeybindings {
  return COMMAND_SHORTCUTS[id].map(cloneKeybinding);
}

/**
 * OS-level global shortcuts registered in the Electron main process via
 * `globalShortcut.register` — NOT through this in-renderer command registry. They fire
 * app-wide even when Lody isn't focused, so they can't be a normal registry command
 * (which only sees keydown while the window is focused).
 *
 * This is the renderer's DISPLAY mirror (title only). The id + default binding (or
 * intentionally unbound `null`) live in `@lody/shared`'s `GLOBAL_SHORTCUT_DEFAULTS`; the
 * user's live binding is read/written over IPC via `useGlobalShortcuts`. To add another
 * global shortcut, see the checklist on `GlobalShortcutId` in `@lody/shared/electron-ipc`.
 */
export type GlobalShortcut = {
  id: GlobalShortcutId;
  titleKey: string;
  defaultTitle: string;
  /** Default binding (registry display syntax). The live value comes from the main process. */
  binding: string | null;
};

export const GLOBAL_SHORTCUTS: GlobalShortcut[] = [
  {
    id: 'app.focus',
    titleKey: 'commands.app.focus',
    defaultTitle: 'Bring Lody to Front',
    binding: GLOBAL_SHORTCUT_DEFAULTS['app.focus'],
  },
];

export function keybindingAppliesToEnvironment(
  binding: KeyBinding,
  platform: Platform,
  runtime: Runtime
): boolean {
  if (binding.platforms && !binding.platforms.includes(platform)) return false;
  if (binding.runtimes && !binding.runtimes.includes(runtime)) return false;
  return true;
}

function cloneKeybinding(binding: string | KeyBinding): string | KeyBinding {
  if (typeof binding === 'string') return binding;
  const clone: KeyBinding = { ...binding };
  if (binding.platforms) clone.platforms = [...binding.platforms];
  if (binding.runtimes) clone.runtimes = [...binding.runtimes];
  return clone;
}

/**
 * Browser shortcuts that web pages CANNOT intercept (the browser claims them at OS level
 * before any keydown reaches JS). Registering bindings for these on the web runtime is
 * useless, so the registry warns in dev.
 */
export const UNINTERCEPTABLE_WEB_KEYS = new Set<string>([
  '$mod+n',
  '$mod+shift+n',
  '$mod+t',
  '$mod+shift+t',
  '$mod+w',
  '$mod+shift+w',
  '$mod+q',
  '$mod+shift+q',
]);
