import { build } from 'esbuild';
import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
it('bundles all personal-device RPC logic without Node or a concrete store', async () => {
  const output = await build({
    entryPoints: [fileURLToPath(new URL('../src/e2ee-client.ts', import.meta.url))],
    bundle: true,
    platform: 'browser',
    format: 'esm',
    target: 'safari16.4',
    treeShaking: false,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  expect(Object.values(output.metafile!.outputs).flatMap((item) => item.imports)).toEqual([]);
});
