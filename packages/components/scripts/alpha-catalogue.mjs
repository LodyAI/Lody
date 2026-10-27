/**
 * Catalogue the alpha steps the product surfaces use.
 *
 * Most of them have no semantic home: `hsl(var(--muted) / 0.6)` is a number
 * someone typed, not a token the theme owns. They are listed here so that the
 * question "which of these deserve a name?" is asked once, with the list in
 * front of it — rather than one arbitrary step at a time.
 *
 *   node scripts/alpha-catalogue.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
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

/** `hsl(var(--token) / 0.6)` and `hsl(var(--token)/0.6)`. */
const STYLEX_ALPHA = /hsl\(\s*var\((--[a-z0-9-]+)\)\s*\/\s*([0-9.]+)\s*\)/g;
/** A Tailwind colour modifier: `bg-muted/60`, `border-border/40`. */
const TAILWIND_ALPHA =
  /\b(?:bg|text|border|ring|fill|stroke|from|to|via|shadow|outline|decoration)-([a-z0-9-]+)\/([0-9]+)\b/g;

const rows = new Map();

/** Tailwind's own palette (white, slate-200, …) is not a theme variable. */
const TAILWIND_PALETTE = new Set([
  'white',
  'black',
  'slate',
  'gray',
  'grey',
  'zinc',
  'neutral',
  'stone',
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
]);

function add(token, alpha, kind, file) {
  const key = `${token}@${alpha}`;
  if (!rows.has(key)) rows.set(key, { token, alpha, kind, files: new Set() });
  const row = rows.get(key);
  row.files.add(path.relative(srcRoot, file));
}

for (const file of await walk(srcRoot)) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(STYLEX_ALPHA)) {
    add(match[1], Number(match[2]), 'theme', file);
  }
  for (const match of source.matchAll(TAILWIND_ALPHA)) {
    const name = match[1];
    const palette = TAILWIND_PALETTE.has(name.split('-')[0]);
    add(
      palette ? `palette:${name}` : `--${name}`,
      Number(match[2]) / 100,
      palette ? 'palette' : 'theme',
      file
    );
  }
}

const sorted = [...rows.values()].sort(
  (left, right) => left.token.localeCompare(right.token) || left.alpha - right.alpha
);

const theme = sorted.filter((row) => row.kind === 'theme');
const palette = sorted.filter((row) => row.kind === 'palette');

console.log('## Theme colours\n');
console.log('| token | alpha | files |');
console.log('| --- | --- | --- |');
for (const row of theme) {
  console.log(`| \`${row.token}\` | ${row.alpha} | ${row.files.size} |`);
}
console.log(`\n## Tailwind palette\n`);
console.log('| colour | alpha | files |');
console.log('| --- | --- | --- |');
for (const row of palette) {
  console.log(`| \`${row.token}\` | ${row.alpha} | ${row.files.size} |`);
}
console.log(
  `\n${sorted.length} distinct alpha steps (${theme.length} theme, ${palette.length} palette)`
);
