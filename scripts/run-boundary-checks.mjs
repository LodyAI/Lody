#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BOUNDARY_CHECK_SCRIPTS = Object.freeze([
  'scripts/check-i18n.mjs',
  'scripts/check-code-collab-imports.mjs',
  'scripts/check-platform-boundaries.mjs',
  'scripts/check-cli-process-boundary.mjs',
  'scripts/check-effect-presence-boundary.mjs',
  'scripts/check-public-boundary.mjs',
  'scripts/check-local-loro-writer-boundary.mjs',
  'scripts/check-operation-inbox-boundary.mjs',
  'scripts/check-legacy-cloud-access.mjs',
  'scripts/check-comment-ratchet.mjs',
]);

function defaultSpawnCheck(scriptRelPath, cwd = repoRoot) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(cwd, scriptRelPath)], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on('data', (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on('error', (error) => {
      resolve({
        script: scriptRelPath,
        code: 1,
        signal: null,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: `${Buffer.concat(stderrChunks).toString('utf8')}${error.message}\n`,
      });
    });
    child.on('close', (code, signal) => {
      resolve({
        script: scriptRelPath,
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    });
  });
}

export async function runBoundaryChecks({
  scripts = BOUNDARY_CHECK_SCRIPTS,
  concurrency = Math.min(scripts.length, Math.max(2, availableParallelism())),
  spawnCheck = defaultSpawnCheck,
  cwd = repoRoot,
} = {}) {
  const results = Array.from({ length: scripts.length });
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < scripts.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await spawnCheck(scripts[current], cwd);
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, scripts.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const failed = results.filter((result) => result.code !== 0 || result.signal !== null);
  return { ok: failed.length === 0, results, failed };
}

async function main() {
  const { ok, results, failed } = await runBoundaryChecks();
  for (const result of results) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (!ok) {
    console.error(
      `Repository boundary checks failed (${failed.map((item) => item.script).join(', ')}).`
    );
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
