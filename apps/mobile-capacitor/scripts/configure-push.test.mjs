import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const config = {
  project_info: { project_number: '123456789', project_id: 'synthetic-lody-test' },
  client: [
    {
      client_info: {
        mobilesdk_app_id: '1:123456789:android:abcdef',
        android_client_info: { package_name: 'ai.lody.android' },
      },
      api_key: [{ current_key: 'synthetic-client-api-key' }],
    },
  ],
};

async function fixture(t, existing) {
  const root = await mkdtemp(path.join(tmpdir(), 'lody-push-config-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'android/app'), { recursive: true });
  const script = path.join(root, 'scripts/configure-push.mjs');
  const file = path.join(root, 'android/app/google-services.json');
  await copyFile(new URL('./configure-push.mjs', import.meta.url), script);
  if (existing !== undefined) await writeFile(file, JSON.stringify(existing));
  return {
    file,
    run(raw) {
      const env = { ...process.env };
      delete env.PUSH_ANDROID_GOOGLE_SERVICES_JSON;
      if (raw !== undefined) env.PUSH_ANDROID_GOOGLE_SERVICES_JSON = raw;
      return spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    },
  };
}

test('Android builds refuse to proceed without Firebase client configuration', async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /PUSH_ANDROID_GOOGLE_SERVICES_JSON/);
});

test('Android builds materialize matching client configuration from the environment', async (t) => {
  const f = await fixture(t);
  const result = f.run(JSON.stringify(config));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), config);
});

test('local Android builds accept an existing valid Firebase client file', async (t) => {
  const f = await fixture(t, config);
  assert.equal(f.run().status, 0);
});

test('Android builds reject invalid existing Firebase configuration', async (t) => {
  for (const invalid of [
    {},
    { type: 'service_account', private_key: 'synthetic-private-key' },
    { ...config, project_info: {} },
    {
      ...config,
      client: [{ client_info: { android_client_info: { package_name: 'other.app' } } }],
    },
    { ...config, client: [{ client_info: config.client[0].client_info }] },
  ]) {
    const f = await fixture(t, invalid);
    assert.notEqual(f.run().status, 0);
  }
});

test('invalid environment configuration neither overwrites a valid file nor leaks its contents', async (t) => {
  const f = await fixture(t, config);
  const result = f.run('{"private_key":"synthetic-sensitive-value"');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-sensitive-value/);
  assert.deepEqual(JSON.parse(await readFile(f.file, 'utf8')), config);
});
