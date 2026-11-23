#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const ZSTD_WASM_FILE_NAME = 'zstd.wasm';
export const ZSTD_WASM_SPECIFIER = './zstd.wasm';

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function listJsFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const files = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJsFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

/**
 * Place zstd.wasm beside every emitted module that resolves `./zstd.wasm` from
 * its own URL. The production CLI inlines `@loro-dev/streams-crdt` into
 * `dist/chunks/`, so a copy next to `dist/index.js` is not the file the runtime
 * opens.
 */
export function placeBundledZstdWasm(outputDir, zstdSourcePath) {
  if (!fs.existsSync(zstdSourcePath)) {
    throw new Error(`Bundled zstd wasm is missing at ${zstdSourcePath}`);
  }
  const referencingFiles = listJsFiles(outputDir).filter((filePath) =>
    fs.readFileSync(filePath, 'utf8').includes(ZSTD_WASM_SPECIFIER)
  );
  if (referencingFiles.length === 0) {
    throw new Error(
      `No emitted CLI module references ${ZSTD_WASM_SPECIFIER}. ` +
        'Refusing to place zstd.wasm beside the CLI entry, because the runtime resolves it from the module URL.'
    );
  }
  const destinations = [
    ...new Set(
      referencingFiles.map((filePath) => path.join(path.dirname(filePath), ZSTD_WASM_FILE_NAME))
    ),
  ];
  for (const destination of destinations) {
    fs.copyFileSync(zstdSourcePath, destination);
  }
  return destinations;
}

function copyWasm() {
  const outputDir = path.resolve(__dirname, '..', 'dist');
  ensureDir(outputDir);
  const zstdEntrypoint = fileURLToPath(import.meta.resolve('@loro-dev/streams-crdt/zstd'));
  const zstdSourcePath = path.join(path.dirname(zstdEntrypoint), ZSTD_WASM_FILE_NAME);
  const placed = placeBundledZstdWasm(outputDir, zstdSourcePath);
  console.log(`Placed zstd.wasm in ${placed.length} module director${placed.length === 1 ? 'y' : 'ies'}.`);
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    copyWasm();
  } catch (err) {
    console.error('Failed to copy wasm bundle:', err);
    process.exitCode = 1;
  }
}
