/** Same generated signed fixture, separate pre/post processes; no timing CI assertion. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(process.argv[2] ?? '.');
const fixturePath = process.argv[3];
if (fixturePath === undefined || fixturePath === '')
  throw new Error('Usage: effect-regression.ts PACKAGE_ROOT FIXTURE_JSON [--create]');
// The path deliberately selects an archived baseline or the working tree.
const { Ledger } = (await import(
  pathToFileURL(join(root, 'src/ledger/ledger.ts')).href
)) as typeof import('../src/ledger/ledger');
if (process.argv.includes('--create')) {
  const { buildChain } = (await import(
    pathToFileURL(join(root, 'bench/chain.ts')).href
  )) as typeof import('./chain');
  const chain = await buildChain(1000);
  await writeFile(
    fixturePath,
    JSON.stringify({
      anchor: Buffer.from(chain.created.anchor).toString('base64'),
      records: chain.records.map((r: Uint8Array) => Buffer.from(r).toString('base64')),
    }),
    { flag: 'wx', mode: 0o600 }
  );
}
const fixture: unknown = JSON.parse(await readFile(fixturePath, 'utf8'));
if (
  typeof fixture !== 'object' ||
  fixture === null ||
  !('anchor' in fixture) ||
  typeof fixture.anchor !== 'string' ||
  !('records' in fixture) ||
  !Array.isArray(fixture.records) ||
  !fixture.records.every((record: unknown) => typeof record === 'string')
) {
  throw new Error('invalid-benchmark-fixture');
}
const anchor = Uint8Array.from(Buffer.from(fixture.anchor, 'base64'));
const records = fixture.records.map((r) => Uint8Array.from(Buffer.from(r, 'base64')));
const samples: number[] = [];
for (let i = 0; i < 13; i++) {
  const start = performance.now();
  const verified = await Ledger.verify({ anchor, records });
  if (verified.length !== records.length) throw new Error('benchmark-verification-failed');
  if (i >= 3) samples.push(performance.now() - start);
}
const sorted = [...samples].sort((a, b) => a - b);
console.log(
  JSON.stringify({
    node: process.version,
    records: records.length,
    warmup: 3,
    runs: 10,
    medianMs: (sorted[4]! + sorted[5]!) / 2,
    samplesMs: samples,
  })
);
