import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const flag = process.argv.indexOf('--storybook');
const storybook = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!storybook) throw new Error('Pass --storybook with an immutable local Storybook URL');

const artifactRoot = path.join(packageRoot, 'artifacts/visual');
await mkdir(artifactRoot, { recursive: true });
const cases = [
  ['false-arrow', '() => false', false],
  ['false-boolean', 'false', false],
  ['true-arrow', '() => true', true],
  ['true-boolean', 'true', true],
  ['async-arrow', 'async () => false', false],
  ['promise-value', 'Promise.resolve(false)', false],
];
const results = [];

// Exercise the capture command: a failed gate must produce no accepted frame.
for (const [name, expression, expectedPass] of cases) {
  const phase = `readiness-check-${name}`;
  const targets = path.join(artifactRoot, `${phase}.json`);
  await writeFile(
    targets,
    JSON.stringify({
      viewports: [{ name: 'proof', width: 390, height: 844 }],
      themes: ['light'],
      ids: ['chat-mentionchips--icon-chips'],
      ready: {
        'chat-mentionchips--icon-chips': [{ action: 'waitForFunction', expression, timeout: 100 }],
      },
    })
  );
  const run = spawnSync(
    process.execPath,
    [
      'tests/visual/visual-regression.mjs',
      'capture',
      '--phase',
      phase,
      '--storybook',
      storybook,
      '--targets',
      targets,
    ],
    {
      cwd: packageRoot,
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, LODY_VISUAL_WORKERS: '1' },
    }
  );
  await writeFile(path.join(artifactRoot, `${phase}.log`), run.stdout + run.stderr);
  if (run.error) throw run.error;
  const manifest = JSON.parse(
    await readFile(path.join(artifactRoot, phase, 'manifest.json'), 'utf8')
  );
  const failures = JSON.parse(
    await readFile(path.join(artifactRoot, phase, 'failures.json'), 'utf8')
  );
  const valid = expectedPass
    ? run.status === 0 && manifest.entries.length === 1 && failures.length === 0
    : run.status === 1 && manifest.entries.length === 0 && failures.length === 1;
  if (!valid) throw new Error(`Capture readiness regression: ${name}`);
  if (!expectedPass) {
    const expectedMessage =
      name === 'async-arrow' || name === 'promise-value' ? 'must be synchronous' : 'Timeout';
    if (!failures[0].message.includes(expectedMessage))
      throw new Error(`Unexpected readiness failure: ${name}: ${failures[0].message}`);
  }
  results.push({ name, expectedPass, exitCode: run.status, captured: manifest.entries.length });
}

const harness = await readFile(path.join(packageRoot, 'tests/visual/visual-regression.mjs'));
await writeFile(
  path.join(artifactRoot, 'readiness-check.json'),
  `${JSON.stringify({ harnessSHA256: createHash('sha256').update(harness).digest('hex'), results }, null, 2)}\n`
);
console.log('Readiness: all 6 real-browser capture cases passed.');
