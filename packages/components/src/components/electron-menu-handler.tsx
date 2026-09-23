import { useEffect } from 'react';
import { useRouter } from '@tanstack/react-router';
import { useAtomValue } from 'jotai';
import { toast } from 'sonner';
import { useTranslation } from 'react-i18next';
import { currentWorkspaceSlugAtom } from '@/atoms';
import { activeWorkspaceRuntimeAtom } from '@/atoms/runtime';
import { commands, getCommandKeybindings, useCommand } from '@/lib/commands';
import { selectAndWriteLocalProject } from '@/lib/local-project-import';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { closeCurrentTabOrWindow } from '@/lib/desktop-tab-or-window-close';
import { getIpcServices, onIpcEvent } from '@/lib/electron-ipc-client';

/**
 * Map menu-action IPC names to registry command ids. Electron menu accelerators are
 * intercepted at OS level (so they never reach the renderer's keydown listener); we
 * route them into the registry here so menu and palette converge on the same handlers.
 *
 * Window chords such as Close are not commands: they stay on the menu accelerator and
 * are handled before this map.
 *
 * Add new menu actions to this map when they should be invokable from the palette,
 * or just keep them as legacy menu-only actions if they're truly menu-specific.
 */
const MENU_ACTION_TO_COMMAND_ID: Record<string, string> = {
  about: 'workspace.openAboutSettings',
  settings: 'workspace.openSettings',
  'check-updates': 'workspace.openAboutSettings',
  'new-session': 'session.new',
  'import-project': 'project.importLocal',
};

export function ElectronMenuHandler() {
  const { t } = useTranslation();
  const router = useRouter();
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const { openSettings } = useOpenSettings();

  // `workspace.openSettings` (the native menu's Settings item / ⌘, target) is defined in
  // `AppCommands` so it can carry a web ⌘, binding + show in the palette; the menu-action
  // bridge below still routes the desktop menu click to it via commands.execute().
  useCommand({
    id: 'workspace.openAboutSettings',
    title: t('commands.workspace.openAboutSettings', 'About Lody'),
    category: 'Help',
    // Menu/IPC-only: still invokable from the native menu's "About" item via
    // commands.execute(), but hidden from the command palette and the keyboard
    // shortcuts settings list (it has no shortcut and isn't worth surfacing there).
    hidden: true,
    when: () => Boolean(workspaceSlug),
    run: () => {
      if (!workspaceSlug) return;
      openSettings('about');
    },
  });

  useCommand({
    id: 'session.new',
    title: t('commands.session.new', 'New Chat'),
    category: 'Session',
    keybindings: getCommandKeybindings('session.new'),
    when: () => Boolean(workspaceSlug),
    run: () => {
      if (!workspaceSlug) return;
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
      });
    },
  });

  // Menu/IPC-only: invokable from the native menu's Import item, but hidden from the
  // command palette + keyboard shortcuts list (no in-app shortcut).
  useCommand({
    id: 'project.importLocal',
    title: t('commands.project.importLocal', 'Import Local Project'),
    category: 'Workspace',
    hidden: true,
    when: () => Boolean(getIpcServices()) && Boolean(runtime),
    run: () => {
      const services = getIpcServices();
      const importFn = services
        ? services.localProjects.selectDirectory.bind(services.localProjects)
        : undefined;
      if (!importFn || !runtime) return;
      void selectAndWriteLocalProject({
        runtime,
        selectDirectory: importFn,
        timeoutMessage: t('localProjects.add.timeout', 'The machine did not respond in time.'),
      }).catch((error: unknown) => {
        console.error('Failed to import local project', error);
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.__LODY_ELECTRON__) {
      return undefined;
    }
    return onIpcEvent('app.menuAction', (action) => {
      if (action === 'close-current-tab-or-window') {
        closeCurrentTabOrWindow();
        return;
      }
      const commandId = MENU_ACTION_TO_COMMAND_ID[action];
      if (!commandId) {
        console.warn(`[electron-menu] unhandled action "${action}"`);
        return;
      }
      commands.execute(commandId);
    });
  }, []);

  return null;
}
