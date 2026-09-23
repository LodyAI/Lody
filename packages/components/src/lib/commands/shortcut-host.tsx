import { createMultiHotkeyHandler, type Hotkey, type HotkeyCallback } from '@tanstack/hotkeys';
import { useEffect, useMemo } from 'react';
import { canonicalizeBinding } from './key-matcher';
import { getHotkeyPlatform } from './platform';
import { commands } from './registry';
import { useCommands } from './use-commands';
import { subscribeUserBindings } from './user-bindings';

/** Owns the single application-shortcut listener for one renderer window. */
export function CommandShortcutHost() {
  const commandSnapshot = useCommands();
  const keybindings = useMemo(() => {
    const next: Partial<Record<Hotkey, HotkeyCallback>> = Object.create(null);

    for (const command of commandSnapshot) {
      for (const binding of commands.getKeybindingsFor(command.id)) {
        const normalized = canonicalizeBinding(binding);
        if (!normalized) continue;
        // Registry dispatch resolves command collisions and mounted implementation priority.
        next[normalized as Hotkey] = (event) => commands.dispatchKeybinding(normalized, event);
      }
    }

    return next;
  }, [commandSnapshot]);

  useEffect(() => {
    if (typeof window === 'undefined' || Object.keys(keybindings).length === 0) return undefined;
    const handler = createMultiHotkeyHandler(keybindings, {
      platform: getHotkeyPlatform(),
      preventDefault: false,
      stopPropagation: false,
    });
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [keybindings]);

  useEffect(() => {
    commands.reloadUserKeybindings();
    return subscribeUserBindings(() => commands.reloadUserKeybindings());
  }, []);

  return null;
}
