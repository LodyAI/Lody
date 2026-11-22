import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { inlinePackageManifestPlugin } from '../scripts/inline-package-manifest.mjs';
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
  it('requires an explicit E2E build flag and refuses release compositions', async () => {
    for (const [enabled, environment, channel, expected] of [
      ['', '', '', false],
      ['1', '', '', true],
      ['1', 'production', '', false],
      ['1', '', 'nightly', false],
    ] as const) {
      vi.resetModules();
      vi.stubEnv('LODY_PLATFORM', 'local');
      vi.stubEnv('LODY_E2E_DAEMON_LOSS_BUILD', enabled);
      vi.stubEnv('LODY_ENV', environment);
      vi.stubEnv('LODY_RELEASE_CHANNEL', channel);
      try {
        const { default: create } = await import('../vite.config');
        expect(create({ command: 'build', mode: 'test' }).define?.__LODY_E2E_DAEMON_LOSS__).toBe(
          JSON.stringify(expected)
        );
      } finally {
        vi.unstubAllEnvs();
      }
    }
  });

  it('inlines ../package.json reads from bundled vendor modules so dist/chunks never fails with ENOENT', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'lody-cli-manifest-'));
    try {
      const pkgDir = path.join(tmpRoot, 'node_modules', '@sorbetai', 'control');
      const distDir = path.join(pkgDir, 'dist');
      fs.mkdirSync(distDir, { recursive: true });
      fs.writeFileSync(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ name: '@sorbetai/control', version: '0.1.0-alpha.20', private: false })
      );
      const plugin = inlinePackageManifestPlugin();
      const source =
        'const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));';
      const transformed = plugin.transform.call(
        {
          error: (msg: string) => {
            throw new Error(msg);
          },
        },
        source,
        path.join(distDir, 'control.js')
      );
      expect(transformed?.code).toBe(
        'const manifest = JSON.parse("{\\"name\\":\\"@sorbetai/control\\",\\"version\\":\\"0.1.0-alpha.20\\"}");'
      );
      expect(() =>
        plugin.renderChunk.call(
          {
            error: (msg: string) => {
              throw new Error(msg);
            },
          },
          source,
          { fileName: 'chunks/vendor-@sorbetai-control-abc.js' }
        )
      ).toThrow(/unresolved readFileSync/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
