#!/usr/bin/env node
import { existsSync, readdirSync, statSync, readlinkSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ADAPTERS = ['claude', 'codex', 'devin', 'grok', 'dsh'];
const ignored = new Set(['dist', 'node_modules', '.git']);

async function fingerprint(directory, hash) {
  const files = [];
  function visit(current, prefix = '') {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (ignored.has(entry.name)) continue;
      const relative = `${prefix}${entry.name}`;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full, `${relative}/`);
      else if (entry.isFile()) files.push([relative, full]);
      else if (entry.isSymbolicLink()) {
        hash.update(`symlink:${relative}\0${readlinkSync(full)}\0`);
        try {
          if (statSync(full).isFile()) files.push([relative, full]);
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
        }
      }
    }
  }
  visit(directory);
  // Bound open descriptors while allowing independent file reads to overlap.
  for (let index = 0; index < files.length; index += 64) {
    const batch = files.slice(index, index + 64);
    const contents = await Promise.all(batch.map(([, full]) => readFile(full)));
    for (let offset = 0; offset < batch.length; offset++) {
      const bytes = contents[offset];
      hash.update(`${batch[offset][0]}\0${bytes.length}\0`).update(bytes);
    }
  }
}

async function outputs(directory, prefix = 'dist') {
  const result = [];
  for (const entry of await readdir(path.join(directory, prefix), { withFileTypes: true })) {
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) result.push(...(await outputs(directory, relative)));
    else if (entry.isFile()) result.push(relative);
  }
  return result.sort();
}

export async function prepareAdapters({
  root = fileURLToPath(new URL('..', import.meta.url)),
  adapters = ADAPTERS,
  build = (name) =>
    new Promise((resolve, reject) => {
      const child = spawn(
        'corepack',
        ['pnpm', '--dir', path.join(root, 'packages', `acp-extension-${name}`), 'run', 'build'],
        {
          stdio: 'inherit',
          shell: process.platform === 'win32',
        }
      );
      child.on('error', reject);
      child.on('close', (code, signal) =>
        code === 0 && signal === null
          ? resolve()
          : reject(new Error(`ACP ${name} build failed (${code}, ${signal})`))
      );
    }),
} = {}) {
  const stampPath = path.join(root, 'node_modules/.cache/lody-acp-adapters-stamp.json');
  let stamp = {};
  try {
    const parsed = JSON.parse(await readFile(stampPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stamp = parsed;
  } catch {}
  const commonHash = createHash('sha256');
  for (const file of ['pnpm-lock.yaml', 'pnpm-workspace.yaml']) {
    commonHash.update(await readFile(path.join(root, file)));
  }
  const core = path.join(root, 'packages/acp-extension-core');
  if (existsSync(core)) await fingerprint(core, commonHash);
  const commonFingerprint = commonHash.digest('hex');
  const next = {};
  const built = [];
  const results = await Promise.allSettled(
    adapters.map(async (name) => {
      const directory = path.join(root, 'packages', `acp-extension-${name}`);
      const hash = createHash('sha256')
        .update(process.version)
        .update(process.platform)
        .update(process.arch);
      // Include the shared contract source: its local type changes must also
      // trigger adapter compilation, even when the lockfile has not changed.
      hash.update(commonFingerprint);
      await fingerprint(directory, hash);
      const digest = hash.digest('hex');
      const old = stamp[name];
      let valid =
        old?.fingerprint === digest && Array.isArray(old.outputs) && old.outputs.length > 0;
      let presentOutputs;
      if (valid) {
        try {
          presentOutputs =
            name === 'grok'
              ? statSync(path.join(directory, 'src/index.js')).isFile()
                ? ['src/index.js']
                : []
              : await outputs(directory);
          const present = new Set(presentOutputs);
          valid = old.outputs.every((file) => present.has(file));
        } catch {
          valid = false;
        }
      }
      if (!valid) {
        await build(name);
        built.push(name);
      }
      // Grok is JavaScript-only: its build validates source and emits no dist.
      const artifacts = valid
        ? presentOutputs
        : name === 'grok'
          ? ['src/index.js']
          : await outputs(directory);
      if (artifacts.length === 0) throw new Error(`ACP ${name} build produced no output`);
      next[name] = { fingerprint: digest, outputs: artifacts };
    })
  );
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) {
    // A failed rebuild may have recreated a missing file before failing. Do not
    // let an older successful stamp bless those partial outputs on the next run.
    await rm(stampPath, { force: true });
    throw failure.reason;
  }
  await mkdir(path.dirname(stampPath), { recursive: true });
  const temporary = `${stampPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(next)}\n`);
  await rename(temporary, stampPath);
  return built;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await prepareAdapters();
}
