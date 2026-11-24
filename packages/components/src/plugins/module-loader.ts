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
  signal: AbortSignal
): Promise<client.ClientPluginDefinition> {
  return evaluateModule(source, signal, external, moduleURL, (url) => URL.revokeObjectURL(url));
}
