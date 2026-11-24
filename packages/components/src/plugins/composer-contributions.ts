import { commands } from '../lib/commands/registry';
import type { ClientPluginRegistry } from '@lody/plugin-sdk/client';

type Command = Parameters<ClientPluginRegistry['commands']['register']>[0];
type Slash = Parameters<ClientPluginRegistry['composer']['slashCommands']['add']>[0];
type Handler = Parameters<ClientPluginRegistry['composer']['beforeSend']>[0];
type Owned<T> = { workspace: string; signal: AbortSignal; value: T };
const slash = new Set<Owned<Slash>>();
const hooks = new Set<Owned<Handler>>();

export function composerContributions(workspace: string, pluginId: string, signal: AbortSignal) {
  function add<T>(set: Set<Owned<T>>, value: T) {
    signal.throwIfAborted();
    const entry = { workspace, signal, value };
    set.add(entry);
    signal.addEventListener('abort', () => set.delete(entry), { once: true });
  }
  return {
    commands: { register(command: Command) {
      signal.throwIfAborted();
      const id = `plugin:${JSON.stringify([workspace, pluginId, command.id])}`;
      const shortcut = command.shortcut;
      const off = commands.register({id, title: command.title, category: 'Workspace',
        keybindings: shortcut && !commands.findCommandBoundTo(shortcut) ? [shortcut] : [],
        when: () => !signal.aborted && (command.when?.() ?? true), run: () => command.run() });
      signal.addEventListener('abort', off, {once:true});
    } },
    slashCommands: { add: (command: Slash) => add(slash, command) },
    beforeSend: (handler: Handler) => add(hooks, handler),
  };
}
export function slashContributions(workspace: string) {
  return [...slash].filter(e => e.workspace === workspace).map(e => e.value);
}
export function hasComposerTransforms(workspace: string) {
  return [...hooks].some(e => e.workspace === workspace);
}
export function confirmComposerTransform(original: string, result: string, confirm: (text: string) => boolean): string | undefined {
  // Session input normalization trims text before computing execution evidence.
  const submitted = result.trim();
  return submitted === original || confirm(submitted) ? submitted : undefined;
}
export async function transformComposerText(workspace: string, text: string, cancelled: AbortSignal) {
  const deadline = AbortSignal.timeout(3000);
  cancelled.throwIfAborted();
  for (const owner of [...hooks]) {
    if (owner.workspace !== workspace) continue;
    const signal = AbortSignal.any([cancelled, owner.signal, deadline]);
    signal.throwIfAborted();
    let rejectAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = () => reject(signal.reason); });
    signal.addEventListener('abort', rejectAbort, { once: true });
    try {
      const result = await Promise.race([owner.value({ text, signal }), aborted]);
      signal.throwIfAborted();
      if (result !== undefined) {
        if (typeof result !== 'string') throw Error('Invalid plugin draft transformation');
        text = result;
      }
    } finally { signal.removeEventListener('abort', rejectAbort); }
  }
  return text;
}
