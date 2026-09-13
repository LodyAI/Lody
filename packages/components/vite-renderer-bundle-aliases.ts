import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import type { BundlerAlias } from './vite-wasm-workarounds.ts';

const beautifulMermaidEntry = fs.realpathSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    'node_modules/beautiful-mermaid/dist/index.js'
  )
);

export function isMermaidRuntimeDependency(id: string): boolean {
  const normalizedId = id.replaceAll('\\', '/');
  return (
    normalizedId.includes('/node_modules/beautiful-mermaid/') ||
    normalizedId.includes('/node_modules/elkjs/')
  );
}

export function rendererBundleAliases(): BundlerAlias[] {
  return [
    {
      find: 'shiki/bundle/full',
      replacement: 'shiki',
    },
  ];
}

export function resolveBeautifulMermaidChunk(id: string): string | null {
  return /beautiful-mermaid-chunk-[^/\\]+\.js$/u.test(id) ? beautifulMermaidEntry : null;
}

export function rendererBundleAliasPlugin(): Plugin {
  return {
    name: 'lody-renderer-bundle-aliases',
    enforce: 'pre',
    resolveId(id) {
      return resolveBeautifulMermaidChunk(id);
    },
  };
}
