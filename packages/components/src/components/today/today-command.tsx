import { useAtomValue } from 'jotai';
import { useEffect } from 'react';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { currentWorkspaceSlugAtom } from '@/atoms/workspace-context';
import { getCommandKeybindings, useCommand } from '@/lib/commands';
import { isAuxiliaryWindow } from '@/lib/desktop-window';
import { isElectronRenderer } from '@/lib/electron';
import { getIpcServices } from '@/lib/electron-ipc-client';

/**
 * Lists "Open Today" in the palette's command list and Settings > Keyboard
 * shortcuts only while the Today experiment is on (a built-in placeholder would
 * show it always). Inert (`when: () => false`): the sidebar mounts the real
 * command over it. Mounted before the app's routes, so on every toggle its
 * effect registers first and the real command stays on top of the stack.
 *
 * Also syncs Today's enabled flag and active workspace to the Electron main
 * process so the OS-level toggle shortcut only registers while Today is on.
 */
export function TodayCommandPlaceholder() {
  const enabled = useAtomValue(todayFeatureEnabledAtom);
  const workspace = useAtomValue(currentWorkspaceSlugAtom);
  useCommand(
    {
      id: 'today.open',
      title: 'Open Today',
      titleKey: 'commands.today.open',
      category: 'Navigation',
      keybindings: getCommandKeybindings('today.open'),
      when: () => false,
      run: () => {},
    },
    enabled
  );
  useEffect(() => {
    if (!isElectronRenderer() || isAuxiliaryWindow()) return;
    void getIpcServices()
      ?.app.syncTodayShortcutState({ enabled, workspace })
      .catch(console.error);
  }, [enabled, workspace]);
  return null;
}
