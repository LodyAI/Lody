import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'upload-android-release.sh'
);

const fakeAws = String.raw`#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const store = process.env.MOCK_R2_STORE;
const valueAfter = (flag) => args[args.indexOf(flag) + 1];
const objectPath = (key) => path.join(store, key);
const s3Key = (value) => value.replace(/^s3:\/\/[^/]+\//, '');

if (args[0] === 's3api' && args[1] === 'head-object') {
  const target = objectPath(valueAfter('--key'));
  if (fs.existsSync(target)) process.exit(0);
  console.error('An error occurred (404) when calling the HeadObject operation: Not Found');
  process.exit(255);
}

if (args[0] === 's3' && args[1] === 'cp') {
  const source = args[2];
  const destination = args[3];
  if (destination.startsWith('s3://')) {
    const key = s3Key(destination);
    if (process.env.MOCK_FAIL_METADATA === '1' && key.endsWith('/version.json')) {
      console.error('simulated metadata upload failure');
      process.exit(42);
    }
    const target = objectPath(key);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  } else {
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(objectPath(s3Key(source)), destination);
  }
  process.exit(0);
}

if (args[0] === 's3' && args[1] === 'rm') {
  fs.rmSync(objectPath(s3Key(args[2])), { force: true });
  process.exit(0);
}

console.error('unsupported fake aws invocation', args.join(' '));
process.exit(64);
`;

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'lody-android-upload-'));
  const bin = path.join(root, 'bin');
  const store = path.join(root, 'store');
  const runnerTemp = path.join(root, 'runner-temp');
  await mkdir(path.join(root, 'mobile-android-release'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(store, { recursive: true });
  await mkdir(runnerTemp, { recursive: true });
  const awsPath = path.join(bin, 'aws');
  await writeFile(awsPath, fakeAws);
  await chmod(awsPath, 0o755);
  return { root, bin, store, runnerTemp };
}

function runUpload(fixture, overrides = {}) {
  return spawnSync('bash', [scriptPath], {
    cwd: fixture.root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${fixture.bin}:${process.env.PATH}`,
      MOCK_R2_STORE: fixture.store,
      RUNNER_TEMP: fixture.runnerTemp,
      R2_ACCOUNT_ID: 'account',
      R2_BUCKET: 'bucket',
      R2_MOBILE_ANDROID_PREFIX: 'mobile/production',
      MOBILE_ANDROID_DOWNLOAD_BASE_URL: 'https://updates.example/mobile/production',
      MOBILE_VERSION_NAME: '0.77.2',
      MOBILE_VERSION_CODE: '3243',
      ...overrides,
    },
  });
}

function stored(fixture, name) {
  return path.join(fixture.store, 'mobile', 'production', name);
}

void test('publishes a new immutable APK and matching mutable pointers', async () => {
  const fixture = await createFixture();
  await writeFile(path.join(fixture.root, 'mobile-android-release', 'app.apk'), 'apk-v1');

  const result = runUpload(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(stored(fixture, 'lody-android-v0.77.2+3243.apk'), 'utf8'), 'apk-v1');
  assert.equal(await readFile(stored(fixture, 'lody-android-latest.apk'), 'utf8'), 'apk-v1');
  const metadata = JSON.parse(await readFile(stored(fixture, 'version.json'), 'utf8'));
  assert.equal(metadata.version, '0.77.2');
  assert.equal(metadata.buildNumber, '3243');
  assert.match(metadata.versionDownloadUrl, /lody-android-v0\.77\.2\+3243\.apk$/u);
});

void test('refuses to replace an immutable URL with different bytes', async () => {
  const fixture = await createFixture();
  const immutable = stored(fixture, 'lody-android-v0.77.2+3243.apk');
  await mkdir(path.dirname(immutable), { recursive: true });
  await writeFile(immutable, 'published-apk');
  await writeFile(
    path.join(fixture.root, 'mobile-android-release', 'app.apk'),
    'different-rebuild'
  );

  const result = runUpload(fixture);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout, /Refusing to replace immutable/u);
  assert.equal(await readFile(immutable, 'utf8'), 'published-apk');
});

void test('restores the previous alias when metadata publication fails', async () => {
  const fixture = await createFixture();
  const alias = stored(fixture, 'lody-android-latest.apk');
  const metadata = stored(fixture, 'version.json');
  await mkdir(path.dirname(alias), { recursive: true });
  await writeFile(alias, 'old-apk');
  await writeFile(metadata, '{"version":"0.74.0"}\n');
  await writeFile(path.join(fixture.root, 'mobile-android-release', 'app.apk'), 'new-apk');

  const result = runUpload(fixture, { MOCK_FAIL_METADATA: '1' });
  assert.notEqual(result.status, 0);
  assert.equal(await readFile(alias, 'utf8'), 'old-apk');
  assert.equal(await readFile(metadata, 'utf8'), '{"version":"0.74.0"}\n');
});
