import { GLOBAL_SHORTCUT_DEFAULTS, type GlobalShortcutId } from '@lody/shared';
import type { KeyBinding, Platform, Runtime } from './types';

export type ShortcutCommandId =
  | 'palette.toggle'
  | 'nav.back'
  | 'nav.forward'
  | 'app.cycleTheme'
  | 'layout.toggleZenMode'
  | 'workspace.openSettings'
  | 'session.new'
  | 'today.open'
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
  | 'session.toggleTerminal'
  | 'session.saveCurrentFile'
  | 'session.nextTab'
  | 'session.previousTab'
  | 'session.previousVisible'
  | 'session.nextVisible'
  | 'session.switchToVisible1'
  | 'session.switchToVisible2'
  | 'session.switchToVisible3'
  | 'session.switchToVisible4'
  | 'session.switchToVisible5'
  | 'session.switchToVisible6'
  | 'session.switchToVisible7'
  | 'session.switchToVisible8'
  | 'session.switchToVisible9'
  | 'session.cycleMode'
  | 'session.cycleProvider'
  | 'session.cycleModel'
  | 'session.cycleThinkEffort'
  | 'session.openRunConfig'
  | 'session.openAddMenu'
  | 'mention.toggleSessionProjectScope';

type CommandKeybindings = ReadonlyArray<string | KeyBinding>;

const electron = <K extends string>(key: K): KeyBinding & { key: K; runtimes: ['electron'] } => ({
  key,
  runtimes: ['electron'],
});
const web = <K extends string>(key: K): KeyBinding & { key: K; runtimes: ['web'] } => ({
  key,
  runtimes: ['web'],
});
const whileComposerFocused = <K extends string>(
  key: K
): KeyBinding & { key: K; surface: 'composer' } => ({
  key,
  surface: 'composer',
  when: (event) => {
    const target = event.target;
    return target instanceof Element && target.closest('[data-lody-composer-input]') !== null;
  },
});

/**
 * Narrow a command's default bindings to its own composer's box: besides the
 * binding's own `when`, the event target must sit inside the first ancestor of
 * `getAnchor()` that holds a `[data-lody-composer-input]` field. Two mounted
 * composer surfaces then each answer only their own field's chords — e.g. an
 * embedded landing composer in a dialog over the session composer — while
 * `commandsEnabled` still decides which visible surfaces register at all.
 *
 * The ancestor walk stops at a composer-less dialog boundary or `body`: a menu
 * mounted outside every composer answers no chord rather than falling back to
 * whichever composer happens to be focused.
 */
export function composerScopedKeybindings(
  bindings: CommandKeybindings,
  getAnchor: () => HTMLElement | null
): CommandKeybindings {
  return bindings.map((binding) => {
    if (typeof binding === 'string') return binding;
    const baseWhen = binding.when;
    return {
      ...binding,
      when: (event) => {
        if (baseWhen && !baseWhen(event)) return false;
        const anchor = getAnchor();
        if (!anchor) return false;
        let box: HTMLElement | null = anchor;
        while (box && box !== document.body) {
          if (box.querySelector('[data-lody-composer-input]')) break;
          if (box.matches('[data-lody-dialog-content]')) {
            box = null;
            break;
          }
          box = box.parentElement;
        }
        if (!box || box === document.body) return false;
        return box.contains(event.target as Node | null);
      },
    };
  });
}

export const COMMAND_SHORTCUTS = {
  'palette.toggle': ['Mod+k', 'Mod+Shift+p'],
  // Browser-style history nav. Desktop only — on web ⌘[ / ⌘] are the browser's own
  // back/forward and can't be intercepted.
  'nav.back': [electron('Mod+[')],
  'nav.forward': [electron('Mod+]')],
  'app.cycleTheme': [],
  'layout.toggleZenMode': ['Mod+.'],
  // Settings: ⌘, follows OS convention, on web + desktop. On desktop the native app menu
  // still SHOWS ⌘, next to "Settings" but does NOT register the accelerator
  // (`registerAccelerator: false` in apps/electron menu.ts), so the key reaches this
  // registry binding — a single source that also shows + is rebindable on the
  // keyboard-shortcuts settings page (instead of an invisible native-menu accelerator).
  'workspace.openSettings': ['Mod+,'],
  'session.new': [electron('Mod+n'), web('Mod+Alt+n')],
  // Open Today (experimental; specs/today-outline.md). D for Daily, as Roam and Tana
  // bind their daily page. Free in browsers (only "Bookmark all tabs", which yields to
  // preventDefault), unlike ⌘D (bookmark; duplicate-line in editors) or ⌘⌥D (macOS
  // Dock toggle; AltGr+D on Windows layouts).
  'today.open': ['Mod+Shift+d'],
  'session.archiveCurrent': ['Mod+Alt+a'],
  'sidebar.toggle': ['Mod+b'],
  'session.toggleCurrentPinned': ['Mod+Alt+p'],
  'session.searchCurrent': [electron('Mod+f'), web('Mod+Alt+f')],
  // Desktop ⌘L focuses the composer. On web the browser owns ⌘L (Open Location),
  // so leave it unbound — the hint chip follows the resolved binding.
  'session.focusInput': [electron('Mod+l')],
  'session.toggleExplorerSidebar': ['Mod+Alt+b'],
  'session.copyCurrentBranch': ['Alt+Shift+b'],
  'session.copyUrl': ['Alt+Shift+c'],
  'session.renameCurrent': ['F2'],
  // ⌥N creates a new tab, or a new terminal when the terminal is focused (desktop).
  // Desktop also gets the browser-convention ⌘T; on web the browser claims it,
  // so it stays electron-only. ⌥N remains the primary binding shown in settings.
  'session.newTabOrTerminal': ['Alt+n', electron('Mod+t')],
  // Open/close the terminal panel (desktop, local sessions only).
  'session.toggleTerminal': [electron('Ctrl+`'), electron('Mod+j')],
  'session.saveCurrentFile': ['Mod+s'],
  // Tab + conversation switching use the Mac-browser convention: ⌘⇧[ / ⌘⇧] step
  // between conversations and ⌘⇧, / ⌘⇧. (i.e. ⌘⇧< / ⌘⇧>) between tabs. The bracket
  // / comma / period keys use the engine's event.code fallback so the shifted glyph
  // ({ } < >) reported by the OS does not change the shortcut.
  'session.nextTab': [electron('Mod+Shift+.')],
  'session.previousTab': [electron('Mod+Shift+,')],
  'session.previousVisible': [electron('Mod+Shift+[')],
  'session.nextVisible': [electron('Mod+Shift+]')],
  // Direct sidebar jumps: ⌘1–⌘9 (Ctrl+1–Ctrl+9 on Windows/Linux) select the first
  // 9 visible sessions across expanded sidebar sections. Desktop only — on web the
  // browser claims ⌘<digit> for its own tab strip.
  'session.switchToVisible1': [electron('Mod+1')],
  'session.switchToVisible2': [electron('Mod+2')],
  'session.switchToVisible3': [electron('Mod+3')],
  'session.switchToVisible4': [electron('Mod+4')],
  'session.switchToVisible5': [electron('Mod+5')],
  'session.switchToVisible6': [electron('Mod+6')],
  'session.switchToVisible7': [electron('Mod+7')],
  'session.switchToVisible8': [electron('Mod+8')],
  'session.switchToVisible9': [electron('Mod+9')],
  'session.cycleMode': [whileComposerFocused('Shift+Tab')],
  'session.cycleProvider': [],
  'session.cycleModel': [],
  'session.cycleThinkEffort': [whileComposerFocused("Mod+'")],
  'session.openRunConfig': [whileComposerFocused('Mod+/')],
  'session.openAddMenu': [whileComposerFocused('Mod+;')],
  'mention.toggleSessionProjectScope': [],
} as const satisfies Record<ShortcutCommandId, CommandKeybindings>;

/**
 * The defaults table is authored once, so overlap is a compile error, not a
 * console warning: each binding projects to [key, runtimes, platforms, surfaces]
 * where absent attributes mean "all", and two rows conflict when every position
 * intersects. Only literal spelling compares — `Shift+Mod+d` vs `Mod+Shift+d`
 * need the vitest canonicalization pass to catch.
 */
type BindingTuple<B> = [
  B extends string ? B : B extends { key: infer K } ? K : never,
  B extends { runtimes: readonly (infer R)[] } ? R : Runtime,
  B extends { platforms: readonly (infer P)[] } ? P : Platform,
  B extends { surface: infer S } ? S : 'composer' | 'other',
];
type TuplesIn<List> = List extends readonly (infer B)[] ? BindingTuple<B> : never;
type TuplesOf<C extends ShortcutCommandId> = TuplesIn<(typeof COMMAND_SHORTCUTS)[C]>;
type LiveTuple<T> = T extends [infer K, infer R, infer P, infer S]
  ? [K] extends [never]
    ? never
    : [R] extends [never]
      ? never
      : [P] extends [never]
        ? never
        : [S] extends [never]
          ? never
          : T
  : never;
type ConflictingDefaults = {
  [C in ShortcutCommandId]: LiveTuple<TuplesOf<C> & TuplesOf<Exclude<ShortcutCommandId, C>>>;
}[ShortcutCommandId];
const _conflictingDefaultsCheck: [ConflictingDefaults] extends [never]
  ? true
  : { readonly 'conflicting default keybindings': ConflictingDefaults } = true;
void _conflictingDefaultsCheck;

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
  'mod+n',
  'mod+shift+n',
  'mod+t',
  'mod+shift+t',
  'mod+w',
  'mod+shift+w',
  'mod+q',
  'mod+shift+q',
]);
