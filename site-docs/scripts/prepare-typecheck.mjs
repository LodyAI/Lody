#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdir, readFile, writeFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const GENERATED_FILES = [
  'public/sitemap.xml',
  'public/docs-search.json',
  'public/llms.txt',
  'public/llms-full.txt',
  'public/rss.xml',
  'public/rss-zh.xml',
  'lib/blog-reading-time.generated.ts',
  'lib/docs-faq.generated.ts',
  'src/routeTree.gen.ts',
];
const generated = new Set(GENERATED_FILES);
const inputs = [
  'content',
  'app',
  'src',
  'components',
  'lib',
  'scripts',
  'source.config.ts',
  'package.json',
  'tsconfig.json',
  'vite.config.ts',
  'tsr.config.json',
];
async function filesUnder(root, relative) {
  const info = await stat(path.join(root, relative));
  if (info.isFile()) return [relative];
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((e) => !['node_modules', '.git'].includes(e.name))
        .map((e) => filesUnder(root, path.join(relative, e.name)))
    )
  ).flat();
}
async function fingerprint(root) {
  const hash = createHash('sha256').update(process.version);
  const files = [];
  for (const input of inputs) {
    try {
      files.push(...(await filesUnder(root, input)));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  files.push('../pnpm-lock.yaml');
  for (const relative of files
    .filter((file) => !generated.has(file.replaceAll(path.sep, '/')))
    .sort()) {
    const bytes = await readFile(path.join(root, relative));
    hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
  }
  return hash.digest('hex');
}
async function artifacts(root) {
  const source = await filesUnder(root, '.source');
  if (!source.length) throw new Error('site-docs generation produced an empty .source directory');
  const result = [...GENERATED_FILES, ...source];
  for (const file of result)
    if (!(await stat(path.join(root, file))).isFile())
      throw new Error(`Missing site-docs generated file: ${file}`);
  return result;
}
function runGenerate(root, script) {
  return new Promise((resolve, reject) => {
    const child = spawn('corepack', ['pnpm', 'run', script], {
      cwd: root,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0 && signal === null
        ? resolve()
        : reject(new Error(`site-docs ${script} failed (${code}, ${signal})`))
    );
  });
}
export async function prepareTypecheck({
  root = fileURLToPath(new URL('..', import.meta.url)),
  generate = async () => {
    await runGenerate(root, 'generate');
    await runGenerate(root, 'generate:routes');
  },
} = {}) {
  const stampPath = path.join(root, '../node_modules/.cache/lody-site-docs-typecheck-stamp.json');
  try {
    const digest = await fingerprint(root);
    let old;
    try {
      old = JSON.parse(await readFile(stampPath, 'utf8'));
    } catch {}
    if (old?.fingerprint === digest && Array.isArray(old.outputs) && old.outputs.length) {
      try {
        await artifacts(root);
        for (const file of old.outputs)
          if (!(await stat(path.join(root, file))).isFile())
            throw new Error('Missing generated output');
        return false;
      } catch {}
    }
    await generate();
    const outputs = await artifacts(root);
    // Retain the pre-generation fingerprint. Edits made during generation must
    // invalidate the next run rather than bless output from an older source.
    const next = { fingerprint: digest, outputs };
    await mkdir(path.dirname(stampPath), { recursive: true });
    const temporary = `${stampPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`);
    await rename(temporary, stampPath);
    return true;
  } catch (error) {
    await rm(stampPath, { force: true });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await prepareTypecheck();
