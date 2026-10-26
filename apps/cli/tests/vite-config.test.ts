import { describe, expect, it } from 'vitest';

import createViteConfig from '../vite.config';

const viteConfig = createViteConfig({ command: 'build', mode: 'test' });

describe('CLI vite config', () => {
  it('bundles runtime dependencies needed by the Electron CLI copy', () => {
    expect(viteConfig.ssr?.external).toEqual(
      expect.arrayContaining(['bufferutil', 'utf-8-validate', 'typescript'])
    );

    const external = viteConfig.build?.rollupOptions?.external;
    expect(typeof external).toBe('function');

    if (typeof external !== 'function') {
      throw new Error('rollup external config should be a function');
    }

    expect(external('ws', undefined, false)).toBe(false);
    expect(external('ws/lib/sender', undefined, false)).toBe(false);
    expect(external('convex/browser', undefined, false)).toBe(false);
    expect(external('convex/server', undefined, false)).toBe(false);
    expect(external('better-sqlite3', undefined, false)).toBe(true);
    expect(external('@lydell/node-pty', undefined, false)).toBe(true);
    expect(external('typescript', undefined, false)).toBe(true);
  });

  it('disables ws optional native dependencies in bundled output', () => {
    expect(viteConfig.define).toMatchObject({
      'process.env.WS_NO_BUFFER_UTIL': JSON.stringify('true'),
      'process.env.WS_NO_UTF_8_VALIDATE': JSON.stringify('true'),
    });
  });
});
