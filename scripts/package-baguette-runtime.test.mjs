import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as tar from 'tar';
import { packageBaguetteRuntime } from './package-baguette-runtime.mjs';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'baguette-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const buildDir = path.join(root, 'build');
  await mkdir(path.join(buildDir, 'Baguette_Baguette.bundle'), { recursive: true });
  await writeFile(path.join(buildDir, 'Baguette'), 'synthetic executable');
  await writeFile(
    path.join(buildDir, 'Baguette_Baguette.bundle', 'index.html'),
    'synthetic resource'
  );
  const patch = Buffer.from('synthetic patch');
  return {
    root,
    buildDir,
    outputDir: path.join(root, 'output'),
    patch,
    notices: 'synthetic notices',
    printPins: true,
    manifest: {
      version: '0.2.0-lody.1',
      fileName: 'baguette.tar.gz',
      platform: 'darwin-arm64',
      executableSha256: hash('synthetic executable'),
      build: { patchSha256: hash(patch), revision: 'synthetic revision' },
    },
  };
}

test('packages the executable, resources and provenance with stable bytes and install layout', async (t) => {
  const options = await fixture(t);
  const first = await packageBaguetteRuntime(options);
  const binary = path.join(options.buildDir, 'Baguette');
  await chmod(binary, 0o600);
  await utimes(binary, new Date(123000), new Date(456000));
  const second = await packageBaguetteRuntime({
    ...options,
    printPins: false,
    manifest: { ...options.manifest, ...first },
  });
  assert.equal(first.sha256, second.sha256);
  const unpacked = path.join(options.root, 'unpacked');
  await mkdir(unpacked);
  await tar.x({ file: second.file, cwd: unpacked, strip: 1 });
  assert.equal(await readFile(path.join(unpacked, 'Baguette'), 'utf8'), 'synthetic executable');
  assert.equal(
    await readFile(path.join(unpacked, 'Baguette_Baguette.bundle/index.html'), 'utf8'),
    'synthetic resource'
  );
  assert.equal(
    await readFile(path.join(unpacked, 'THIRD_PARTY_NOTICES.txt'), 'utf8'),
    options.notices
  );
  assert.deepEqual(
    JSON.parse(await readFile(path.join(unpacked, 'BUILD_PROVENANCE.json'), 'utf8')),
    options.manifest.build
  );
});

test('rejects changed native bytes, patch bytes, resource bytes and symlinks', async (t) => {
  const options = await fixture(t);
  const pin = await packageBaguetteRuntime(options);
  await assert.rejects(
    packageBaguetteRuntime({ ...options, patch: Buffer.from('different') }),
    /patch digest/
  );
  await writeFile(path.join(options.buildDir, 'Baguette'), 'different binary');
  await assert.rejects(packageBaguetteRuntime(options), /executable digest/);
  await writeFile(path.join(options.buildDir, 'Baguette'), 'synthetic executable');
  await writeFile(
    path.join(options.buildDir, 'Baguette_Baguette.bundle/index.html'),
    'different resource'
  );
  await assert.rejects(
    packageBaguetteRuntime({
      ...options,
      printPins: false,
      manifest: { ...options.manifest, ...pin },
    }),
    /archive digest/
  );
  await symlink('/outside-artifact', path.join(options.buildDir, 'Baguette_Baguette.bundle/link'));
  await assert.rejects(packageBaguetteRuntime(options), /Unsupported artifact entry/);
});
