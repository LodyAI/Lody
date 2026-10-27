/**
 * Rewrite `@/style/…` imports to the relative path the StyleX compiler needs.
 *
 * The StyleX compiler resolves a `.stylex` import itself, and it does not read
 * the bundler's aliases: `@/style/theme-colors.stylex` fails to resolve while
 * the same file resolves fine through Vite. A relative path works for both.
 *
 *   node scripts/fix-stylex-imports.mjs
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const srcRoot = path.resolve(here, '../src');

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (/\.tsx?$/.test(entry.name)) files.push(full);
  }
  return files;
}

let changed = 0;
for (const file of await walk(srcRoot)) {
  const source = await readFile(file, 'utf8');
  if (!source.includes("'@/style/")) continue;
  const directory = path.dirname(path.relative(srcRoot, file));
  const depth = directory === '' ? 0 : directory.split(path.sep).length;
  const prefix = depth === 0 ? './' : `${'../'.repeat(depth)}`;
  const next = source.replace(/(['"])@\/style\//g, `$1${prefix}style/`);
  if (next !== source) {
    await writeFile(file, next);
    changed += 1;
    console.log(`rewrote ${path.relative(srcRoot, file)}`);
  }
}
console.log(`${changed} file(s) rewritten`);
