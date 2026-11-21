import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { publicationAction, publishNightlyNpm } from './nightly-npm.mjs';
import { resolvePnpmRunner } from './pnpm-runner.mjs';

const version = '0.104.0-nightly.7';
const checksum = 'sha512-test';
const metadata = (tag, existing) => ({
  name: 'lody',
  'dist-tags': { latest: '0.103.2', next: '0.104.0-beta.0', ...(tag ? { nightly: tag } : {}) },
  versions: existing ? { [version]: { dist: { integrity: existing } } } : {},
});

void test('first publication, exact retry and interrupted tag update', () => {
  assert.equal(publicationAction(metadata(), version, checksum), 'publish');
  assert.equal(publicationAction(metadata(version, checksum), version, checksum), 'skip');
  assert.equal(publicationAction(metadata(undefined, checksum), version, checksum), 'tag');
  assert.equal(
    publicationAction(metadata('0.104.0-nightly.6', checksum), version, checksum),
    'tag'
  );
});

void test('rejects rollback, collisions, malformed registry state and non-nightly versions', () => {
  for (const newer of ['0.104.0-nightly.8', '0.104.0-nightly.10', '0.105.0-nightly.0']) {
    assert.throws(() => publicationAction(metadata(newer), version, checksum), /roll back/u);
  }
  assert.throws(
    () => publicationAction(metadata(version, 'different'), version, checksum),
    /bytes differ/u
  );
  assert.throws(() => publicationAction(metadata(version), version, checksum), /missing version/u);
  assert.throws(() => publicationAction({}, version, checksum));
  assert.throws(() => publicationAction(metadata('latest'), version, checksum));
  assert.throws(() => publicationAction(metadata(), '0.104.0', checksum));
});

const candidate = {
  schema: 1,
  sourceSha: 'a'.repeat(40),
  runId: '123',
  buildNumber: '52',
  builtAt: '2026-09-23T00:00:00.000Z',
  trigger: { repository: 'LodyAI/Lody', sha: 'a'.repeat(40) },
};

void test('publisher verifies immutable artifact and fails closed before npm writes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'lody-nightly-npm-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.from('frozen tarball fixture');
  const digest = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const tarball = join(directory, `lody-${version}.tgz`);
  await writeFile(tarball, bytes);
  await writeFile(
    join(directory, 'manifest.json'),
    JSON.stringify({ candidate, version, integrity: digest })
  );
  const calls = [];
  const run = (...args) => calls.push(args);
  const options = { directory, candidate, version, run };
  const response = (data) => async () => ({ ok: true, json: async () => data });
  assert.equal(await publishNightlyNpm({ ...options, fetchImpl: response(metadata()) }), 'publish');
  assert.deepEqual(calls[0].slice(0, 2), [
    'pnpm',
    [
      'publish',
      tarball,
      '--access',
      'public',
      '--no-git-checks',
      '--tag',
      'nightly',
      '--registry',
      'https://registry.npmjs.org',
    ],
  ]);
  calls.length = 0;
  assert.equal(
    await publishNightlyNpm({ ...options, fetchImpl: response(metadata(version, digest)) }),
    'skip'
  );
  assert.equal(calls.length, 0);
  assert.equal(
    await publishNightlyNpm({ ...options, fetchImpl: response(metadata(undefined, digest)) }),
    'tag'
  );
  assert.deepEqual(calls[0].slice(0, 2), [
    'npm',
    ['dist-tag', 'add', `lody@${version}`, 'nightly', '--registry', 'https://registry.npmjs.org'],
  ]);
  calls.length = 0;
  await assert.rejects(
    publishNightlyNpm({ ...options, fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /HTTP 503/u
  );
  await assert.rejects(
    publishNightlyNpm({
      ...options,
      candidate: { ...candidate, sourceSha: 'c'.repeat(40) },
      fetchImpl: response(metadata()),
    }),
    /candidate mismatch|source differs/u
  );
  await writeFile(tarball, 'changed');
  await assert.rejects(
    publishNightlyNpm({ ...options, fetchImpl: response(metadata()) }),
    /checksum mismatch/u
  );
  assert.equal(calls.length, 0);
});

void test('staging and pnpm packing keep the nightly version and resolve catalog dependencies', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const { mkdir, copyFile, readFile } = await import('node:fs/promises');
  const directory = await mkdtemp(join(tmpdir(), 'lody-nightly-pack-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cloud = join(directory, 'apps/cli');
  const cli = join(directory, 'apps/cli');
  const viewer = join(directory, 'packages/code-review-viewer');
  await Promise.all([
    mkdir(cloud, { recursive: true }),
    mkdir(join(cli, 'dist'), { recursive: true }),
    mkdir(join(viewer, 'dist'), { recursive: true }),
  ]);
  await copyFile(
    new URL('./prepare-publish.js', import.meta.url),
    join(cloud, 'prepare-publish.js')
  );
  await writeFile(
    join(directory, 'package.json'),
    JSON.stringify({ private: true, packageManager: 'pnpm@10.20.0' })
  );
  await writeFile(
    join(directory, 'pnpm-workspace.yaml'),
    'packages:\n  - apps/*\ncatalog:\n  example-runtime: 1.2.3\n'
  );
  await writeFile(
    join(cloud, 'package.json'),
    JSON.stringify({ name: '@lody/cli-cloud', type: 'module', version })
  );
  await writeFile(
    join(cli, 'package.json'),
    JSON.stringify({
      name: 'lody',
      version,
      type: 'module',
      bin: { lody: 'dist/index.js' },
      files: ['dist'],
      dependencies: { 'example-runtime': 'catalog:', '@lody/shared': 'workspace:*' },
    })
  );
  await writeFile(join(cli, 'README.md'), 'Fixture');
  await writeFile(join(cli, 'dist/index.js'), '#!/usr/bin/env node\nconsole.log("fixture");\n');
  await writeFile(
    join(viewer, 'package.json'),
    JSON.stringify({ name: 'lody-code-review-viewer', version: '0.1.0' })
  );
  await writeFile(join(viewer, 'standalone.html'), '<html></html>');
  await writeFile(
    join(viewer, 'dist/manifest.generated.ts'),
    `export const reviewViewerVersion = ${JSON.stringify(version)};`
  );
  execFileSync(process.execPath, [join(cloud, 'prepare-publish.js')], {
    cwd: directory,
    stdio: 'pipe',
  });
  const tarball = join(directory, `lody-${version}.tgz`);
  const runner = resolvePnpmRunner();
  execFileSync(runner.command, [...runner.args, 'pack', '--out', tarball], {
    cwd: join(cloud, '.publish/lody'),
    shell: runner.shell,
    stdio: 'pipe',
  });
  const packed = JSON.parse(
    execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' })
  );
  assert.equal(packed.name, 'lody');
  assert.equal(packed.version, version);
  assert.equal(packed.bin.lody, 'dist/index.js');
  assert.deepEqual(packed.dependencies, { 'example-runtime': '1.2.3' });
  assert.equal(JSON.parse(await readFile(join(cli, 'package.json'), 'utf8')).version, version);
});
