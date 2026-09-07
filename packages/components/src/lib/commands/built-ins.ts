import { commands } from './registry';
import { getCommandPaletteOpen, setCommandPaletteOpen } from './palette-state';
import { getCommandKeybindings, type ShortcutCommandId } from './shortcuts';
import type { CommandCategory } from './types';

let registered = false;
let disposers: Array<() => void> = [];

type BuiltInCommandDefinition = {
  id: ShortcutCommandId;
  /** i18n key — resolved at display time so titles stay correct across language changes. */
  titleKey: string;
  /** English fallback used when the i18n key is missing. */
  title: string;
  category: CommandCategory;
};

// Placeholder registrations so EVERY shortcut shows up in the command palette / keyboard
// settings even on screens where the real (mounted) command isn't active. `when: () => false`
// keeps them non-executable; a mounted real command replaces the placeholder by id. Titles
// carry a `titleKey` (not a pre-translated string) because this module registers outside
// React and can't call `t()` — display surfaces translate via the key instead.
// The Tasks commands (`tasks.quickAdd` / `tasks.open`) are deliberately absent: a
// placeholder here would list them in the palette and keyboard settings even for
// users who never enabled the Tasks beta. `app-commands.tsx` registers the real
// ones behind `tasksFeatureEnabledAtom`, and it is mounted workspace-wide, so
// nothing is lost once the beta is on.
const UNAVAILABLE_COMMANDS: BuiltInCommandDefinition[] = [
  {
    id: 'nav.back',
    titleKey: 'commands.nav.back',
    title: 'Back',
    category: 'Navigation',
  },
  {
    id: 'nav.forward',
    titleKey: 'commands.nav.forward',
    title: 'Forward',
    category: 'Navigation',
  },
  {
    id: 'workspace.openSettings',
    titleKey: 'commands.workspace.openSettings',
    title: 'Open Settings',
    category: 'Workspace',
  },
  {
    id: 'app.cycleTheme',
    titleKey: 'commands.app.cycleTheme',
    title: 'Cycle Theme',
    category: 'View',
  },
  {
    id: 'layout.toggleZenMode',
    titleKey: 'commands.layout.toggleZenMode',
    title: 'Toggle Zen Layout',
    category: 'View',
  },
  {
    id: 'session.new',
    titleKey: 'commands.session.new',
    title: 'New Chat',
    category: 'Session',
  },
  {
    id: 'session.archiveCurrent',
    titleKey: 'commands.session.archiveCurrent',
    title: 'Archive Current Chat',
    category: 'Session',
  },
  {
    id: 'sidebar.toggle',
    titleKey: 'commands.sidebar.toggle',
    title: 'Toggle Sidebar',
    category: 'View',
  },
  {
    id: 'session.toggleCurrentPinned',
    titleKey: 'commands.session.toggleCurrentPinned',
    title: 'Toggle Current Chat Pinned',
    category: 'Session',
  },
  {
    id: 'session.searchCurrent',
    titleKey: 'commands.session.searchCurrent',
    title: 'Find in Current Chat',
    category: 'Session',
  },
  {
    id: 'session.focusInput',
    titleKey: 'commands.session.focusInput',
    title: 'Focus Current Input',
    category: 'Editor',
  },
  {
    id: 'session.toggleExplorerSidebar',
    titleKey: 'commands.session.toggleExplorerSidebar',
    title: 'Toggle Files and Changes Sidebar',
    category: 'View',
  },
  {
    id: 'session.copyCurrentBranch',
    titleKey: 'commands.session.copyCurrentBranch',
    title: 'Copy Current Branch',
    category: 'Session',
  },
  {
    id: 'session.copyUrl',
    titleKey: 'commands.session.copyUrl',
    title: 'Copy Current URL',
    category: 'Session',
  },
  {
    id: 'session.renameCurrent',
    titleKey: 'commands.session.renameCurrent',
    title: 'Rename Current Chat',
    category: 'Session',
  },
  {
    id: 'session.newTabOrTerminal',
    titleKey: 'commands.session.newTabOrTerminal',
    title: 'New Tab or Terminal',
    category: 'Session',
  },
  {
    id: 'session.toggleTerminal',
    titleKey: 'commands.session.toggleTerminal',
    title: 'Toggle Terminal',
    category: 'View',
  },
  {
    id: 'session.saveCurrentFile',
    titleKey: 'commands.session.saveCurrentFile',
    title: 'Save Current File',
    category: 'Editor',
  },
  {
    id: 'session.nextTab',
    titleKey: 'commands.session.nextTab',
    title: 'Switch to Next Tab',
    category: 'Navigation',
  },
  {
    id: 'session.previousTab',
    titleKey: 'commands.session.previousTab',
    title: 'Switch to Previous Tab',
    category: 'Navigation',
  },
  {
    id: 'session.previousVisible',
    titleKey: 'commands.session.previousVisible',
    title: 'Switch to Previous Session',
    category: 'Navigation',
  },
  {
    id: 'session.nextVisible',
    titleKey: 'commands.session.nextVisible',
    title: 'Switch to Next Session',
    category: 'Navigation',
  },
  {
    id: 'session.cycleMode',
    titleKey: 'commands.session.cycleMode',
    title: 'Cycle Agent Mode',
    category: 'Session',
  },
  {
    id: 'session.cycleProvider',
    titleKey: 'commands.session.cycleProvider',
    title: 'Cycle ACP Provider',
    category: 'Session',
  },
  {
    id: 'session.cycleModel',
    titleKey: 'commands.session.cycleModel',
    title: 'Cycle Model',
    category: 'Session',
  },
  {
    id: 'session.cycleThinkEffort',
    titleKey: 'commands.session.cycleThinkEffort',
    title: 'Cycle Thinking Effort',
    category: 'Session',
  },
  {
    id: 'mention.toggleSessionProjectScope',
    titleKey: 'commands.mention.toggleSessionProjectScope',
    title: 'Toggle Session Mention Project Scope',
    category: 'Editor',
  },
];

/**
 * Register the foundational commands that ship with the app shell. Idempotent — calling
 * twice is a no-op. The companion `unregisterBuiltInCommands()` exists so React 18 strict
 * mode and HMR can re-mount the app without leaking duplicates.
 */
export function registerBuiltInCommands(): void {
  if (registered) return;
  registered = true;

  disposers.push(
    commands.register({
      id: 'palette.toggle',
      titleKey: 'commands.palette.toggle',
      title: 'Open Command Palette',
      category: 'View',
      keybindings: getCommandKeybindings('palette.toggle'),
      // Reaching the palette must never depend on where the caret is.
      allowInTextInput: true,
      run: () => {
        setCommandPaletteOpen(!getCommandPaletteOpen());
      },
    })
  );

  for (const definition of UNAVAILABLE_COMMANDS) {
    disposers.push(
      commands.register({
        id: definition.id,
        titleKey: definition.titleKey,
        title: definition.title,
        category: definition.category,
        keybindings: getCommandKeybindings(definition.id),
        when: () => false,
        run: () => {},
      })
    );
  }
}

export function unregisterBuiltInCommands(): void {
  for (const dispose of disposers) dispose();
  disposers = [];
  registered = false;
}
