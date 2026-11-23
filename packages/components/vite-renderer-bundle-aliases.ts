import type { BundlerAlias } from './vite-wasm-workarounds.ts';

export function isMermaidRuntimeDependency(id: string): boolean {
  return id.replaceAll('\\', '/').includes('/node_modules/pele/');
}

export function rendererBundleAliases(): BundlerAlias[] {
  return [
    {
      find: 'shiki/bundle/full',
      replacement: 'shiki',
    },
  ];
}
