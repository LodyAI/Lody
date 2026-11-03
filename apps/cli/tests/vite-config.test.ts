import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build } from 'vite';

import createViteConfig from '../vite.config';
import { nodeWasmAssets } from '../scripts/node-wasm-assets.mjs';

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
});

// (module
//   (import "./bindings.js" "increment" (func (param i32) (result i32)))
//   (func (export "run") (param i32) (result i32) local.get 0 call 0)
//   (memory (export "memory") 1)
//   (global (export "answer-value") i32 (i32.const 42)))
const wasmFixture = () => {
  const text = (value: string) => [Buffer.byteLength(value), ...Buffer.from(value)];
  const section = (id: number, contents: number[]) => [id, contents.length, ...contents];
  return Uint8Array.from([
    0,
    97,
    115,
    109,
    1,
    0,
    0,
    0,
    ...section(1, [1, 0x60, 1, 0x7f, 1, 0x7f]),
    ...section(2, [1, ...text('./bindings.js'), ...text('increment'), 0, 0]),
    ...section(3, [1, 0]),
    ...section(5, [1, 0, 1]),
    ...section(6, [1, 0x7f, 0, 0x41, 42, 0x0b]),
    ...section(7, [
      3,
      ...text('run'),
      0,
      1,
      ...text('memory'),
      2,
      0,
      ...text('answer-value'),
      3,
      0,
    ]),
    ...section(10, [1, 6, 0, 0x20, 0, 0x10, 0, 0x0b]),
  ]);
};

async function buildWasmFixture(root: string) {
  const source = path.join(root, 'source');
  await mkdir(source);
  const wasm = wasmFixture();
  await writeFile(path.join(source, 'math #运算.wasm'), wasm);
  await writeFile(path.join(source, 'bindings.js'), 'export const increment = value => value + 1;');
  await writeFile(path.join(source, 'entry.js'), 'export * from "./math #运算.wasm";');
  const outDir = path.join(root, 'dist');
  await build({
    configFile: false,
    root: source,
    logLevel: 'silent',
    plugins: [nodeWasmAssets()],
    build: {
      ssr: path.join(source, 'entry.js'),
      ssrEmitAssets: true,
      target: 'node22',
      outDir,
      minify: false,
      rollupOptions: {
        output: {
          entryFileNames: 'chunks/entry.mjs',
          assetFileNames: 'assets/[name]-[hash][extname]',
        },
      },
    },
  });
  return { source, outDir, wasm };
}

function runWasmBundle(entry: string): unknown {
  return JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `const loaded = await import(${JSON.stringify(pathToFileURL(entry).href)});
console.log(JSON.stringify({
  run: loaded.run(41),
  memoryBytes: loaded.memory.buffer.byteLength,
  global: loaded['answer-value'].value,
}));`,
      ],
      { encoding: 'utf8', stdio: 'pipe', timeout: 10_000 }
    )
  );
}

describe('CLI WASM assets', () => {
  it('preserves bytes, imports and exports after relocating the bundled application', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lody-wasm-assets-'));
    try {
      const { source, outDir, wasm } = await buildWasmFixture(root);
      const moved = path.join(root, 'installed #应用');
      await rename(outDir, moved);
      await rm(source, { recursive: true });
      const assets = await readdir(path.join(moved, 'assets'));
      expect(assets).toHaveLength(1);
      expect(await readFile(path.join(moved, 'assets', assets[0]))).toEqual(Buffer.from(wasm));
      expect(runWasmBundle(path.join(moved, 'chunks/entry.mjs'))).toEqual({
        run: 42,
        memoryBytes: 65536,
        global: 42,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports a missing packaged asset during initialization', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'lody-wasm-missing-'));
    try {
      const { outDir } = await buildWasmFixture(root);
      await rm(path.join(outDir, 'assets'), { recursive: true });
      expect(() => runWasmBundle(path.join(outDir, 'chunks/entry.mjs'))).toThrow(/ENOENT/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
