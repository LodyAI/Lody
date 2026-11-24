import { init, parse } from 'es-module-lexer';
import type { ClientPluginDefinition } from '@lody/plugin-sdk/client';
/** The URL factory must issue a new identity for every evaluation, even for identical source. */
export async function evaluateModule(
  source: string,
  signal: AbortSignal,
  external: (name: string) => string,
  create: (source: string) => string,
  release: (url: string) => void
): Promise<ClientPluginDefinition> {
  await init;
  for (const entry of [...parse(source)[0]].reverse()) {
    if (entry.d === -2) continue;
    if (entry.d !== -1 || !entry.n) throw new Error('Plugins require static host imports');
    source = source.slice(0, entry.s) + external(entry.n) + source.slice(entry.e);
  }
  signal.throwIfAborted();
  const url = create(source);
  try {
    const { default: definition } = await import(/* @vite-ignore */ url);
    signal.throwIfAborted();
    if (definition?.kind !== 'client-plugin' || typeof definition.register !== 'function')
      throw new Error('Invalid client plugin definition');
    return definition;
  } finally {
    release(url);
  }
}
