import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../../..');
const require = createRequire(path.join(root, 'apps/cli/package.json'));
const loader = require.resolve('tsx');
const arg = (key, fallback) => {
  const i = process.argv.indexOf('--' + key);
  return i < 0 ? fallback : process.argv[i + 1];
};
const out = path.resolve(arg('out', '/tmp/conversation-replay'));
fs.mkdirSync(out, { recursive: true });
const fixture = path.resolve(arg('fixture', path.join(out, 'synthetic.snapshot')));
const runs = Number(arg('runs', '3')),
  rounds = Number(arg('rounds', '1000'));
const idleBudgetMs = Number(arg('idle-budget-ms', '50'));
for (const n of [runs, rounds, idleBudgetMs])
  if (!Number.isFinite(n) || n <= 0) throw Error('positive numeric options required');
const profile = process.argv.includes('--profile');
const counters = process.argv.includes('--counters');
function child(config) {
  const r = spawnSync(
    process.execPath,
    [
      '--expose-gc',
      '--max-old-space-size=8192',
      '--import',
      loader,
      path.join(here, 'worker.ts'),
      JSON.stringify(config),
    ],
    { cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 32 * 1024 * 1024 }
  );
  if (r.error || r.status !== 0) throw Error(`${r.error ?? r.status}\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
if (!process.argv.includes('--fixture')) child({ generate: true, rounds, fixture });
const results = [];
const modes = arg('mode', 'both') === 'both' ? ['committed', 'pending'] : [arg('mode', 'both')];
if (modes.some((m) => !['committed', 'pending'].includes(m)))
  throw Error('mode must be committed, pending or both');
for (let i = 0; i < runs; i++)
  for (const mode of i % 2 ? [...modes].reverse() : modes) {
    const config = {
      fixture,
      mode,
      idleBudgetMs,
      windows: 20,
      tokens: 30,
      counters,
      profile: profile ? path.join(out, `${mode}-${i}.cpuprofile`) : undefined,
    };
    const stdout = child(config);
    const result = JSON.parse(stdout.trim().split('\n').at(-1));
    results.push(result);
    fs.writeFileSync(path.join(out, `${mode}-${i}.json`), JSON.stringify(result, null, 2));
    console.log(mode, i, result.timings);
  }
const sorted = (values) => values.toSorted((a, b) => a - b);
const p = (a, q) => sorted(a)[Math.ceil(a.length * q) - 1];
const summary = Object.fromEntries(
  modes.map((mode) => {
    const rows = results.filter((r) => r.mode === mode);
    return [
      mode,
      Object.fromEntries(
        Object.keys(rows[0].timings).map((k) => [
          k,
          {
            min: Math.min(...rows.map((r) => r.timings[k])),
            median: p(
              rows.map((r) => r.timings[k]),
              0.5
            ),
            max: Math.max(...rows.map((r) => r.timings[k])),
          },
        ])
      ),
    ];
  })
);
const git = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' });
const diff = spawnSync(
  'git',
  ['diff', 'HEAD', '--', 'packages/shared/src', 'packages/components/src'],
  { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }
);
const sourceFiles = [
  'packages/shared/src/session-data/loro.ts',
  'packages/shared/src/history-writer.ts',
  'packages/components/src/lib/conversation-view/create-conversation-session.ts',
  'packages/components/src/lib/conversation-view/create-conversation-view-from-reader.ts',
  'packages/components/src/lib/conversation-view/turn-summary.ts',
  'pnpm-lock.yaml',
];
const sourceHashes = Object.fromEntries(
  sourceFiles.map((file) => [
    file,
    createHash('sha256')
      .update(fs.readFileSync(path.join(root, file)))
      .digest('hex'),
  ])
);
const sourceDiffHash = createHash('sha256').update(diff.stdout).digest('hex');
const runnerHashes = Object.fromEntries(
  ['worker.ts', 'run.mjs'].map((file) => [
    file,
    createHash('sha256')
      .update(fs.readFileSync(path.join(here, file)))
      .digest('hex'),
  ])
);
fs.writeFileSync(
  path.join(out, 'baseline.json'),
  JSON.stringify(
    {
      sha: git.stdout.trim(),
      sourceDirty: diff.stdout.length > 0,
      sourceDiffHash,
      sourceHashes,
      runnerHashes,
      fixtureSha256: createHash('sha256').update(fs.readFileSync(fixture)).digest('hex'),
      fixtureBytes: fs.statSync(fixture).size,
      runs,
      idleBudgetMs,
      counters,
      profile,
      node: process.version,
      summary,
      results,
    },
    null,
    2
  )
);
console.log('Saved', path.join(out, 'baseline.json'));
