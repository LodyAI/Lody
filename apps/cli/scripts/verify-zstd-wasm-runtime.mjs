#!/usr/bin/env node
/**
 * Run the published streams-crdt zstd entry from a directory that mimics the
 * production CLI chunk layout. The entry's `import.meta.url` is the staged
 * file, so `./zstd.wasm` resolves beside that file and nowhere else.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

export async function verifyRelocatedZstdRuntime(sourceEntry) {
  if (typeof global.gc !== 'function') {
    const result = spawnSync(process.execPath, ['--expose-gc', scriptPath, sourceEntry], {
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      throw new Error(
        result.stderr || result.stdout || `zstd runtime check exited ${result.status}`
      );
    }
    return;
  }
  await runChecks(sourceEntry);
}

async function stageRuntime(sourceEntry) {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-zstd-runtime-'));
  const chunks = path.join(root, 'chunks');
  await mkdir(chunks);
  const queue = [sourceEntry];
  const seen = new Set();
  while (queue.length > 0) {
    const filePath = queue.pop();
    if (filePath == null || seen.has(filePath)) continue;
    seen.add(filePath);
    const source = await readFile(filePath, 'utf8');
    await copyFile(filePath, path.join(chunks, path.basename(filePath)));
    for (const match of source.matchAll(/from\s+["'](\.\/[^"']+\.js)["']/g)) {
      const specifier = match[1];
      if (specifier == null) continue;
      queue.push(path.join(path.dirname(filePath), specifier));
    }
  }
  return {
    root,
    entryPath: path.join(chunks, path.basename(sourceEntry)),
    wasmPath: path.join(chunks, 'zstd.wasm'),
  };
}

async function importStaged(entryPath, token) {
  return import(`${pathToFileURL(entryPath).href}?case=${token}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function expectRejection(task, label) {
  let rejected = false;
  try {
    await task;
  } catch {
    rejected = true;
  }
  assert(rejected, `${label} resolved instead of rejecting`);
}

async function runChecks(sourceEntry) {
  const unhandled = [];
  const onUnhandled = (error) => {
    unhandled.push(String(error));
  };
  process.on('unhandledRejection', onUnhandled);
  const sourceWasm = path.join(path.dirname(sourceEntry), 'zstd.wasm');
  const payload = new TextEncoder().encode('local diagnostic test');

  const missing = await stageRuntime(sourceEntry);
  try {
    const runtime = await importStaged(missing.entryPath, 'missing');
    let document = { payload };
    const retained = new WeakRef(document);
    const pending = runtime.compress(document.payload);
    const release = (async (held) => {
      await pending;
      return held;
    })(document);
    document = null;
    await expectRejection(release, 'compression without zstd.wasm');
    global.gc();
    assert(retained.deref() === undefined, 'rejected compression kept the caller document');

    await copyFile(sourceWasm, missing.wasmPath);
    const compressed = await runtime.compress(payload);
    const restored = await runtime.decompress(compressed);
    assert(
      Buffer.from(restored).equals(Buffer.from(payload)),
      'compression after the wasm file appeared did not round-trip'
    );
  } finally {
    await rm(missing.root, { recursive: true, force: true });
  }

  const corrupt = await stageRuntime(sourceEntry);
  try {
    await writeFile(corrupt.wasmPath, Buffer.from('not wasm'));
    const runtime = await importStaged(corrupt.entryPath, 'corrupt');
    await expectRejection(runtime.compress(payload), 'corrupt zstd.wasm');
    await expectRejection(runtime.compress(payload), 'retry after corrupt zstd.wasm');
  } finally {
    await rm(corrupt.root, { recursive: true, force: true });
  }

  process.off('unhandledRejection', onUnhandled);
  assert(unhandled.length === 0, `unhandled zstd rejections: ${unhandled.join(' | ')}`);
}

const invokedDirectly =
  process.argv[1] != null && path.resolve(process.argv[1]) === scriptPath;
if (invokedDirectly) {
  const entry = process.argv[2];
  if (entry == null || entry.length === 0) {
    console.error('usage: verify-zstd-wasm-runtime.mjs <zstd-entry>');
    process.exitCode = 1;
  } else {
    verifyRelocatedZstdRuntime(entry).catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  }
}
