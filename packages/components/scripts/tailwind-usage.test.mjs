import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const scanner = fileURLToPath(new URL('./tailwind-usage.mjs', import.meta.url));

const source = `
declare const condition: boolean;
declare const runtimeClass: string;
declare const dynamicClass: string;
declare const stylex: { props(value: unknown): { className: string } };
declare function withClassName(first: unknown, second: string): { className: string };
const LOCAL_CLASS = 'p-2';
const utilityLookingStyle = { color: 'm-8' };
const unrelatedData = ['m-9', 'p-9'].filter(Boolean).join(' ');
const classes = [
  LOCAL_CLASS,
  'mx-1',
  condition && 'flex',
  'not-a-tailwind-utility',
  runtimeClass,
  stylex.props(utilityLookingStyle).className,
].filter(Boolean).join(' ');
const plainClass = ['w-4', 'h-4'].join(' ');
export const Probe = () => <>
  <div className={classes} />
  <div className={classes} />
  <div className={plainClass} />
  <div className={['text-sm', 'text-sm'].join(' ')} />
  <div className={['border'].join('-')} />
  <div className={['rounded'].filter(Boolean, null).join(' ')} />
  <div className={['m-2'].filter(value => value).join(' ')} />
  <div className={['m-3'].join()} />
  <div className={['m-4'].join('  ')} />
  <div {...withClassName(stylex.props(utilityLookingStyle), ['shrink-0', dynamicClass].filter(Boolean).join(' '))} />
</>;
`;

test('counts only supported space-joined class arrays and keeps unresolved members', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lody-tailwind-class-arrays-'));
  try {
    const fixture = path.join(directory, 'probe.tsx');
    await writeFile(fixture, source);
    const result = spawnSync(process.execPath, [scanner, '--root', fixture, '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const expected = ['p-2', 'mx-1', 'flex', 'w-4', 'h-4', 'text-sm', 'text-sm', 'shrink-0'];
    const actual = report.files[0].entries.flatMap((entry) => entry.candidates);
    assert.deepEqual(actual, expected);
    assert.equal(report.totals.occurrences, 8);
    assert.equal(report.totals.uniqueCandidates, 7);
    assert.equal(actual.filter((candidate) => candidate === 'p-2').length, 1);
    assert.equal(actual.filter((candidate) => candidate === 'text-sm').length, 2);
    assert.deepEqual(
      report.files[0].unresolved.map((entry) => entry.expression),
      [
        'runtimeClass',
        "['border'].join('-')",
        "['rounded'].filter(Boolean, null).join(' ')",
        "['m-2'].filter(value => value).join(' ')",
        "['m-3'].join()",
        "['m-4'].join('  ')",
        'dynamicClass',
      ]
    );

    const require = createRequire(import.meta.url);
    const compiler = createRequire(require.resolve('@tailwindcss/postcss'))('@tailwindcss/node');
    const css = path.join(packageRoot, 'src/tailwind/index.css');
    const design = await compiler.__unstable__loadDesignSystem(await readFile(css, 'utf8'), {
      base: path.dirname(css),
    });
    // Negative controls must be valid utilities: exclusion cannot pass merely
    // because the compiler rejects a token unrelated to the scanner boundary.
    const excluded = ['m-8', 'm-9', 'p-9', 'border', 'rounded', 'm-2', 'm-3', 'm-4'];
    for (const candidate of [...new Set([...expected, ...excluded])]) {
      assert.notEqual(design.candidatesToCss([candidate])[0], null, candidate);
    }
    assert.equal(design.candidatesToCss(['not-a-tailwind-utility'])[0], null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('counts imperative className writes without treating comparisons or other fields as CSS', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'lody-tailwind-dom-classes-'));
  try {
    const fixture = path.join(directory, 'frame.ts');
    await writeFile(
      fixture,
      `
const spacing = 'p-2';
declare const target: HTMLElement;
declare const condition: boolean;
declare const runtimeClass: string;
declare const computedKey: string;
declare const importedStyles: { root: string };
target.className = 'block h-full';
target['className'] = cn(spacing, condition && 'opacity-50', runtimeClass);
target.className = spacing;
target.className += 'm-4';
target.className = importedStyles.root;
target.className = stylex.props().className ?? '';
target.className === 'm-7';
target.title = 'm-9';
target[computedKey] = 'm-8';
`
    );
    const result = spawnSync(process.execPath, [scanner, '--root', fixture, '--json'], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.scannerVersion, 2);
    assert.deepEqual(
      report.files[0].entries.flatMap((entry) => entry.candidates),
      ['p-2', 'block', 'h-full', 'opacity-50']
    );
    assert.equal(report.totals.occurrences, 4);
    assert.deepEqual(
      report.files[0].unresolved.map((entry) => entry.expression),
      ['runtimeClass', "target.className += 'm-4'", 'importedStyles.root']
    );
    const require = createRequire(import.meta.url);
    const compiler = createRequire(require.resolve('@tailwindcss/postcss'))('@tailwindcss/node');
    const css = path.join(packageRoot, 'src/tailwind/index.css');
    const design = await compiler.__unstable__loadDesignSystem(await readFile(css, 'utf8'), {
      base: path.dirname(css),
    });
    for (const candidate of ['m-4', 'm-7', 'm-8', 'm-9']) {
      assert.notEqual(design.candidatesToCss([candidate])[0], null, candidate);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
