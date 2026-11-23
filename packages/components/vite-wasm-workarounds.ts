import type { PluginOption } from 'vite';

export interface BundlerAlias {
  find: string | RegExp;
  replacement: string;
}

export const VITEST_INLINE_WASM_DEPS = [
  'loro-repo',
  '@loro-dev/flock-wasm',
  'loro-crdt',
  '@loro-dev/streams-crdt',
];

export function loroCrdtBundlerAlias(): BundlerAlias[] {
  return [{ find: /^loro-crdt$/, replacement: 'loro-crdt/bundler' }];
}

export function loroCrdtWasmUrlWorkaround(): PluginOption {
  return {
    name: 'loro-wasm-url-workaround',
    enforce: 'pre',
    transform(code: string, id: string) {
      if (id.includes('/loro-crdt/browser/loro_wasm.js')) {
        throw new Error(
          'loro-crdt browser build sync-loads WASM and crashes some Android WebViews. ' +
            'Use loroCrdtBundlerAlias() so Vite resolves loro-crdt to the bundler entry.'
        );
      }

      if (id.includes('/loro-crdt/bundler/loro_wasm.js')) {
        if (!code.includes('loro_wasm_bg.wasm')) return undefined;

        return {
          code: code.replaceAll('./loro_wasm_bg.wasm', './loro_wasm_bg.wasm?url'),
          map: null,
        };
      }

      if (id.includes('/@loro-dev/streams-crdt/dist/zstd-core-')) {
        if (!code.includes('zstd.wasm')) return undefined;

        return {
          code: code.replaceAll('./zstd.wasm', './zstd.wasm?url'),
          map: null,
        };
      }
      return undefined;
    },
  };
}
