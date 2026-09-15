import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Explicit artifact inputs only: never resolve a sibling checkout or publish a package.
const [corePath, coreHash, streamsPath, streamsHash, lockPath, lockHash, ...extra] =
  process.argv.slice(2);
if (
  !corePath ||
  !streamsPath ||
  !coreHash ||
  !streamsHash ||
  extra.length ||
  Boolean(lockPath) !== Boolean(lockHash)
) {
  throw new Error(
    'Usage: node check-packed-consumer.mjs CORE.tgz SHA256 STREAMS.tgz SHA256 [LOCK.yaml SHA256]'
  );
}
function artifact(path, expected) {
  if (!/^[a-f0-9]{64}$/.test(expected)) throw new Error('Expected lowercase SHA-256');
  const bytes = readFileSync(resolve(path));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error(`Artifact checksum mismatch: ${path}`);
  return bytes;
}
// Read and validate before creating the consumer or executing package tools.
const coreBytes = artifact(corePath, coreHash);
const streamsBytes = artifact(streamsPath, streamsHash);
const lockBytes = lockPath ? artifact(lockPath, lockHash) : undefined;
const directory = mkdtempSync(join(tmpdir(), 'e2ee-packed-consumer-'));
process.stdout.write(`Consumer evidence: ${directory}\n`);
writeFileSync(join(directory, 'core.tgz'), coreBytes);
writeFileSync(join(directory, 'streams.tgz'), streamsBytes);
if (lockBytes) writeFileSync(join(directory, 'pnpm-lock.yaml'), lockBytes);
const env = { ...process.env, CI: 'true' };
delete env.LORO_STREAMS_CRDT;
delete env.LODY_E2EE_LEAN;
let sequence = 0;
function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: directory,
    env,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  writeFileSync(join(directory, `${++sequence}.log`), output);
  process.stdout.write(output);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`);
  return result.stdout;
}
const manifest = JSON.parse(run('tar', ['-xOf', 'core.tgz', 'package/package.json']));
if (manifest.name !== '@lody/e2ee-core') throw new Error('Unexpected core package');
const streamsManifest = JSON.parse(run('tar', ['-xOf', 'streams.tgz', 'package/package.json']));
if (streamsManifest.name !== '@loro-dev/streams-crdt')
  throw new Error('Unexpected Streams package');
const dependencies = { ...manifest.dependencies };
for (const [name, version] of Object.entries(dependencies)) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error(`Unpinned packed dependency: ${name} ${version}`);
  }
}
const fixture = {
  name: 'e2ee-packed-consumer',
  private: true,
  type: 'module',
  packageManager: 'pnpm@10.20.0',
  dependencies: {
    ...dependencies,
    '@lody/e2ee-core': 'file:./core.tgz',
    '@loro-dev/streams-crdt': 'file:./streams.tgz',
    vitest: '3.2.4',
    tsx: '4.23.13',
    'loro-crdt': '1.15.1',
    '@loro-dev/flock-wasm': '0.4.3',
  },
  pnpm: { overrides: { '@loro-dev/streams-crdt': 'file:./streams.tgz' } },
};
writeFileSync(join(directory, 'package.json'), `${JSON.stringify(fixture, null, 2)}\n`);
writeFileSync(
  join(directory, 'vitest.config.mjs'),
  `export default {
  test: {
    include: ['node_modules/@lody/e2ee-core/test/**/*.test.ts'],
    exclude: [],
    passWithNoTests: false,
  },
};\n`
);
const receipt = {
  node: process.version,
  coreSha256: coreHash,
  streamsSha256: streamsHash,
  coreVersion: manifest.version,
  streamsVersion: streamsManifest.version,
  lockSha256: lockHash ?? null,
  passed: false,
};
try {
  receipt.pnpm = run('corepack', ['pnpm', '--version']).trim();
  if (receipt.pnpm !== '10.20.0') throw new Error('Wrong pnpm version');
  run('corepack', [
    'pnpm',
    'install',
    '--ignore-scripts',
    lockBytes ? '--frozen-lockfile' : '--no-frozen-lockfile',
  ]);
  if (lockBytes && !readFileSync(join(directory, 'pnpm-lock.yaml')).equals(lockBytes)) {
    throw new Error('Frozen lockfile changed during installation');
  }
  run('corepack', [
    'pnpm',
    'exec',
    'vitest',
    'run',
    '--reporter=default',
    '--reporter=json',
    '--outputFile=vitest-result.json',
  ]);
  const report = JSON.parse(readFileSync(join(directory, 'vitest-result.json'), 'utf8'));
  if (
    report.success !== true ||
    !Number.isSafeInteger(report.numTotalTests) ||
    report.numTotalTests <= 0 ||
    report.numPassedTests !== report.numTotalTests ||
    report.numPendingTests !== 0 ||
    report.numTodoTests !== 0
  ) {
    throw new Error('Incomplete packed test run (failed, skipped, todo or empty)');
  }
  receipt.passedTests = report.numPassedTests;
  // Exercise the documented public import surface outside the package directory, too.
  copyFileSync(
    join(directory, 'node_modules/@lody/e2ee-core/bench/readme-consumer.ts'),
    join(directory, 'readme-consumer.ts')
  );
  run('corepack', ['pnpm', 'exec', 'tsx', 'readme-consumer.ts']);
  receipt.passed = true;
} finally {
  writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
}
