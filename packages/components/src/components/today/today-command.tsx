import { useAtomValue } from 'jotai';
import { todayFeatureEnabledAtom } from '@/atoms/settings';
import { getCommandKeybindings, useCommand } from '@/lib/commands';

/**
 * Lists "Open Today" in the palette's command list and Settings > Keyboard
 * shortcuts only while the Today experiment is on (a built-in placeholder would
 * show it always). Inert (`when: () => false`): the sidebar mounts the real
 * command over it. Mounted before the app's routes, so on every toggle its
 * effect registers first and the real command stays on top of the stack.
 */
export function TodayCommandPlaceholder() {
  const enabled = useAtomValue(todayFeatureEnabledAtom);
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
  return null;
}
