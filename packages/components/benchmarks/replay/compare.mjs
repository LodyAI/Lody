import fs from 'node:fs';
import assert from 'node:assert/strict';
const [a, b] = process.argv.slice(2).map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
assert.deepEqual(a.runnerHashes, b.runnerHashes, 'replay workload changed');
for (const k of ['fixtureSha256', 'idleBudgetMs', 'counters', 'profile', 'node'])
  assert.equal(a[k], b[k], `incomparable ${k}`);
for (const [mode, stages] of Object.entries(a.summary)) {
  assert(b.summary[mode], `missing ${mode}`);
  console.log(mode);
  for (const [stage, { median }] of Object.entries(stages)) {
    const next = b.summary[mode][stage].median;
    console.log(
      `${stage}: ${median.toFixed(2)} -> ${next.toFixed(2)} ms (${((next / median - 1) * 100).toFixed(1)}%)`
    );
  }
}
