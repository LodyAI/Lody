import { getIpcServices } from '../lib/electron-ipc-client';
import { evaluateModule } from './module-runtime';
import * as React from 'react';
import * as jsx from 'react/jsx-runtime';
import * as zod from 'zod';
import * as ui from '@lody/ui';
import * as sdk from '@lody/plugin-sdk';
import * as client from '@lody/plugin-sdk/client';
import * as manifest from '@lody/plugin-sdk/manifest';

const dependencies = Object.freeze({
  react: React,
  'react/jsx-runtime': jsx,
  zod,
  '@lody/ui': ui,
  '@lody/plugin-sdk': sdk,
  '@lody/plugin-sdk/client': client,
  '@lody/plugin-sdk/manifest': manifest,
});
const urls = new Map<string, string>();
function moduleURL(source: string) {
  return URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
}
function external(name: string) {
  if (!Object.hasOwn(dependencies, name)) throw new Error(`Unsupported plugin import: ${name}`);
  const prior = urls.get(name);
  if (prior) return prior;
  const namespace = dependencies[name as keyof typeof dependencies];
  const key = Symbol.for(`lody.client.external.${name}`);
  Object.defineProperty(globalThis, key, { value: namespace });
  const bridge =
    `const mod=globalThis[Symbol.for(${JSON.stringify(key.description)})];\n` +
    Object.keys(namespace)
      .map(
        (k, i) => `const v${i}=mod[${JSON.stringify(k)}];export {v${i} as ${JSON.stringify(k)}};`
      )
      .join('\n');
  const url = moduleURL(bridge);
  urls.set(name, url);
  return url;
}
export async function evaluateClientModule(
  source: string,
  signal: AbortSignal,
  local?: {
    machineId: string;
    workspaceId: string;
    pluginId: string;
    digest: string;
    packed?: () => Uint8Array;
  }
): Promise<client.ClientPluginDefinition> {
  const ipc = getIpcServices();
  if (ipc && local) {
    const exports: Record<string, string[]> = {};
    for (const [name, ns] of Object.entries(dependencies)) {
      Object.defineProperty(globalThis, Symbol.for('lody.client.external.' + name), { value: ns });
      exports[name] = Object.keys(ns).filter((k) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k));
    }
    const url = local.packed
      ? await ipc.e2ee.openRemotePluginModule(
          local.workspaceId,
          local.machineId,
          local.pluginId,
          local.digest,
          local.packed(),
          exports
        )
      : await ipc.machineRpc.openPluginModule(
          local.machineId,
          local.workspaceId,
          local.pluginId,
          local.digest,
          exports
        );
    try {
      signal.throwIfAborted();
      const { default: plugin } = await import(/* @vite-ignore */ url);
      signal.throwIfAborted();
      if (plugin?.kind !== 'client-plugin' || typeof plugin.register !== 'function')
        throw Error('Invalid client plugin definition');
      return plugin;
    } finally {
      await ipc.machineRpc.releasePluginModule(url);
    }
  }
  return evaluateModule(source, signal, external, moduleURL, (url) => URL.revokeObjectURL(url));
}
