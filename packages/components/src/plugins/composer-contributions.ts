import { commands } from '../lib/commands/registry';
import type { ClientPluginRegistry } from '@lody/plugin-sdk/client';

type Command = Parameters<ClientPluginRegistry['commands']['register']>[0];
type Slash = Parameters<ClientPluginRegistry['composer']['slashCommands']['add']>[0];
import { registerComposerTransform } from './composer-before-send';
type Owned<T> = { workspace: string; signal: AbortSignal; value: T };
const slash = new Set<Owned<Slash>>();

export function composerContributions(workspace: string, pluginId: string, signal: AbortSignal) {
  function add<T>(set: Set<Owned<T>>, value: T) {
    signal.throwIfAborted();
    const entry = { workspace, signal, value };
    set.add(entry);
    signal.addEventListener('abort', () => set.delete(entry), { once: true });
  }
  return {
    commands: {
      register(command: Command) {
        signal.throwIfAborted();
        const id = `plugin:${JSON.stringify([workspace, pluginId, command.id])}`;
        const shortcut = command.shortcut;
        const off = commands.register({
          id,
          title: command.title,
          category: 'Workspace',
          keybindings: shortcut && !commands.findCommandBoundTo(shortcut) ? [shortcut] : [],
          when: () => !signal.aborted && (command.when?.() ?? true),
          run: () => command.run(),
        });
        signal.addEventListener('abort', off, { once: true });
      },
    },
    slashCommands: { add: (command: Slash) => add(slash, command) },
    beforeSend: (handler: Parameters<ClientPluginRegistry['composer']['beforeSend']>[0]) =>
      registerComposerTransform(workspace, signal, handler),
  };
}
export function slashContributions(workspace: string) {
  return [...slash].filter((e) => e.workspace === workspace).map((e) => e.value);
}
