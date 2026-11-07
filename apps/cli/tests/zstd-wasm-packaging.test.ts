import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ZSTD_WASM_SPECIFIER,
  placeBundledZstdWasm,
} from '../scripts/copy-loro-wasm.js';
import { verifyRelocatedZstdRuntime } from '../scripts/verify-zstd-wasm-runtime.mjs';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

async function makeTempDir(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), 'lody-zstd-packaging-'));
  temporaryDirectories.push(directory);
  return directory;
}

describe('CLI zstd wasm packaging', () => {
  it('places zstd.wasm beside the emitted chunk that resolves it', async () => {
    const root = await makeTempDir();
    const wasmSource = path.join(root, 'source.wasm');
    await writeFile(wasmSource, Buffer.from('wasm-bytes'));
    const chunk = path.join(root, 'dist', 'chunks', 'vendor-streams.js');
    const entry = path.join(root, 'dist', 'index.js');
    await mkdir(path.dirname(chunk), { recursive: true });
    await writeFile(chunk, `const url = new URL(${JSON.stringify(ZSTD_WASM_SPECIFIER)}, import.meta.url);\n`);
    await writeFile(entry, 'export const entry = true;\n');

    const placed = placeBundledZstdWasm(path.join(root, 'dist'), wasmSource);

    expect(placed).toEqual([path.join(root, 'dist', 'chunks', 'zstd.wasm')]);
    await expect(readFile(path.join(root, 'dist', 'chunks', 'zstd.wasm'))).resolves.toEqual(
      Buffer.from('wasm-bytes')
    );
    await expect(readFile(path.join(root, 'dist', 'zstd.wasm'))).rejects.toThrow();
  });

  it('refuses to invent a CLI-root wasm when no emitted module references it', async () => {
    const root = await makeTempDir();
    const wasmSource = path.join(root, 'source.wasm');
    await writeFile(wasmSource, Buffer.from('wasm-bytes'));
    await mkdir(path.join(root, 'dist'), { recursive: true });
    await writeFile(path.join(root, 'dist', 'index.js'), 'export const entry = true;\n');

    expect(() => placeBundledZstdWasm(path.join(root, 'dist'), wasmSource)).toThrow(
      /Refusing to place zstd\.wasm/
    );
  });

  it('rejects a missing or timed-out wasm without retaining the caller document, then round-trips once the runtime can run', async () => {
    const entry = fileURLToPath(import.meta.resolve('@loro-dev/streams-crdt/zstd'));
    await verifyRelocatedZstdRuntime(entry);
  });
});
