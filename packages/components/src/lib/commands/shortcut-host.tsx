import { useEffect, useMemo } from 'react';
import { tinykeys, type KeybindingsMap } from 'tinykeys';
import { bindingToTinykeys } from './key-matcher';
import { commands } from './registry';
import { useCommands } from './use-commands';
import { subscribeUserBindings } from './user-bindings';

/** Owns the single application-shortcut listener for one renderer window. */
export function CommandShortcutHost() {
  const commandSnapshot = useCommands();
  const keybindings = useMemo<KeybindingsMap>(() => {
    const next = Object.create(null) as KeybindingsMap;

    for (const command of commandSnapshot) {
      for (const binding of commands.getKeybindingsFor(command.id)) {
        const tinykeysBinding = bindingToTinykeys(binding);
        if (!tinykeysBinding) continue;
        // Registry dispatch resolves command collisions and mounted implementation priority.
        next[tinykeysBinding] = (event) => commands.dispatchKeybinding(binding, event);
      }
    }

    return next;
  }, [commandSnapshot]);

  useEffect(() => {
    if (typeof window === 'undefined' || Object.keys(keybindings).length === 0) return undefined;
    return tinykeys(window, keybindings, {
      capture: true,
      // Scopes and allowInTextInput own focus semantics. The engine must see these events
      // so registry dispatch can explicitly yield or run the command.
      ignore: () => false,
    });
  }, [keybindings]);

  useEffect(() => {
    commands.reloadUserKeybindings();
    return subscribeUserBindings(() => commands.reloadUserKeybindings());
  }, []);

  return null;
}
