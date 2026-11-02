#!/usr/bin/env node
'use strict';

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function copyWasm() {
  const outputDir = path.resolve(__dirname, '..', 'dist');
  ensureDir(outputDir);

  // The build emits imported Loro/Flock WASM under assets/, while streams-crdt
  // expects zstd.wasm next to the bundled CLI entry at runtime.
  const zstdEntrypoint = fileURLToPath(import.meta.resolve('@loro-dev/streams-crdt/zstd'));
  const zstdSourcePath = path.join(path.dirname(zstdEntrypoint), 'zstd.wasm');
  const zstdDestinationPath = path.join(outputDir, 'zstd.wasm');
  fs.copyFileSync(zstdSourcePath, zstdDestinationPath);
}

try {
  copyWasm();
} catch (err) {
  console.error('Failed to copy wasm bundle:', err);
  process.exitCode = 1;
}
