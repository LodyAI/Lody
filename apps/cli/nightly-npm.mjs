import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateNightlyCandidate } from '../electron/nightly-candidate.mjs';
import { validateNightlyVersion } from '../electron/nightly-version.mjs';

const registry = 'https://registry.npmjs.org';
const integrity = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;

export function publicationAction(metadata, version, expectedIntegrity) {
  validateNightlyVersion(version);
  assert.equal(metadata.name, 'lody');
  assert.ok(metadata.versions && metadata['dist-tags'], 'Malformed npm metadata');
  const tagged = metadata['dist-tags'].nightly;
  if (tagged !== undefined) {
    validateNightlyVersion(tagged);
    const parts = (value) =>
      value
        .split(/[.-]/u)
        .filter((part) => part !== 'nightly')
        .map(Number);
    const a = parts(tagged);
    const b = parts(version);
    const order = a.map((part, i) => part - b[i]).find((part) => part !== 0) ?? 0;
    assert.ok(order <= 0, 'Refusing to roll back the npm nightly tag');
  }
  const existing = metadata.versions[version];
  if (existing) {
    assert.equal(existing.dist?.integrity, expectedIntegrity, 'Published npm bytes differ');
    return tagged === version ? 'skip' : 'tag';
  }
  assert.notEqual(tagged, version, 'npm tag points to a missing version');
  return 'publish';
}

export async function publishNightlyNpm({
  directory,
  candidate,
  version,
  fetchImpl = fetch,
  run = execFileSync,
}) {
  validateNightlyCandidate(candidate);
  validateNightlyVersion(version);
  const manifest = JSON.parse(await readFile(resolve(directory, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.candidate, candidate, 'npm artifact candidate mismatch');
  assert.equal(manifest.version, version, 'npm artifact version mismatch');
  const tarball = resolve(directory, `lody-${version}.tgz`);
  const expectedIntegrity = integrity(await readFile(tarball));
  assert.equal(manifest.integrity, expectedIntegrity, 'npm artifact checksum mismatch');
  const response = await fetchImpl(`${registry}/lody`, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Cannot inspect npm package: HTTP ${response.status}`);
  const action = publicationAction(await response.json(), version, expectedIntegrity);
  if (action === 'publish') {
    run(
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
        registry,
      ],
      { stdio: 'inherit' }
    );
  } else if (action === 'tag') {
    run('npm', ['dist-tag', 'add', `lody@${version}`, 'nightly', '--registry', registry], {
      stdio: 'inherit',
    });
  }
  return action;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [command, candidatePath, directory = 'nightly-npm'] = process.argv.slice(2);
  const candidate = validateNightlyCandidate(JSON.parse(await readFile(candidatePath, 'utf8')));
  const version = validateNightlyVersion(process.env.LODY_NIGHTLY_VERSION);
  if (command === 'prepare') {
    const packagePath = new URL('./package.json', import.meta.url);
    const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
    pkg.version = version;
    await writeFile(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  } else if (command === 'seal') {
    const bytes = await readFile(resolve(directory, `lody-${version}.tgz`));
    await writeFile(
      resolve(directory, 'manifest.json'),
      `${JSON.stringify({ candidate, version, integrity: integrity(bytes) }, null, 2)}\n`
    );
  } else if (command === 'publish') {
    console.log(await publishNightlyNpm({ directory, candidate, version }));
  } else {
    throw new Error('Expected prepare, seal or publish');
  }
}
