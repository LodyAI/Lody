import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { loadConfigFromFile } from 'vite';

const directory = fileURLToPath(new URL('.', import.meta.url));
async function config(mode = 'cli-runtime') {
  return (
    await loadConfigFromFile(
      { command: 'build', mode },
      path.join(directory, 'vite.config.ts'),
      directory
    )
  ).config;
}
test('local ignores cloud deployment inputs and keeps release instrumentation disabled', async (t) => {
  const old = { ...process.env };
  t.after(() => {
    process.env = old;
  });
  delete process.env.LODY_PLATFORM;
  process.env.LODY_ENV = 'production';
  process.env.LODY_AUTH_URL = 'https://auth.example.test';
  const built = await config();
  assert.equal(built.define['process.env.LODY_PLATFORM'], '"local"');
  assert.equal(built.define['process.env.LODY_ENV'], '""');
  assert.equal(built.define['process.env.LODY_AUTH_URL'], undefined);
  assert.equal(built.define.__LODY_E2E_CLOCK_BUILD__, 'false');
});
test('cloud preserves flat workers, externals, WASM alias and separate adapter pass', async (t) => {
  const old = { ...process.env };
  t.after(() => {
    process.env = old;
  });
  process.env.LODY_PLATFORM = 'cloud';
  process.env.LODY_ENV = 'staging';
  process.env.LODY_AUTH_URL = 'https://auth.example.test';
  const built = await config();
  assert.equal(built.define['process.env.LODY_PLATFORM'], '"cloud"');
  assert.equal(built.define['process.env.LODY_AUTH_URL'], '"https://auth.example.test"');
  for (const id of [
    '@napi-rs/keyring',
    '@loro-dev/roost-node',
    'better-sqlite3',
    '@lydell/node-pty',
    '@sqlite.org/sqlite-wasm',
    'broadcast-channel',
    'typescript',
    'tinypool',
  ])
    assert.equal(built.build.rollupOptions.external(id), true, id);
  assert.equal(built.define.__LODY_BUNDLED_LORO_WASM__, 'true');
  const alias = built.resolve.alias.find(
    (a) => a.find instanceof RegExp && a.find.test('loro-crdt')
  );
  assert.equal(alias.replacement, 'loro-crdt/bundler');
  assert.equal(alias.find.test('loro-crdt/bundler/foo'), false);
  const output = built.build.rollupOptions.output;
  assert.equal(output.entryFileNames, '[name].js');
  assert.equal(output.chunkFileNames({ name: 'worker-owner' }), '[name]-[hash].js');
  assert.ok(built.build.rollupOptions.input['turn-diff-store-worker']);
  const adapters = await config('acp-adapters');
  assert.equal(adapters.build.emptyOutDir, false);
  assert.equal(adapters.build.rollupOptions.input.index, undefined);
  assert.ok(adapters.build.rollupOptions.input['codex-acp']);
});

test('embedded Nightly CLI carries the same frozen identity as Electron packaging', async (t) => {
  const old = { ...process.env };
  t.after(() => {
    process.env = old;
  });
  const { resolveElectronReleaseProfile } = await import('../electron/release-profile.mjs');
  const { readFile } = await import('node:fs/promises');
  const pkg = JSON.parse(
    await readFile(new URL('../electron/package.json', import.meta.url), 'utf8')
  );
  const [major, minor] = pkg.version.split('.').map(Number);
  Object.assign(process.env, {
    LODY_PLATFORM: 'cloud',
    LODY_ENV: 'production',
    LODY_CLI_INLINE_DEPLOY_ENV: '0',
    LODY_RELEASE_CHANNEL: 'nightly',
    LODY_SOURCE_SHA: 'a'.repeat(40),
    LODY_NIGHTLY_BUILD_NUMBER: '10000',
    LODY_BUILD_RUN_ID: '100',
    LODY_BUILD_TIMESTAMP: '2026-11-21T00:00:00.000Z',
    LODY_NIGHTLY_VERSION: `${major}.${minor + 1}.0-nightly.1`,
  });
  const built = await config();
  assert.deepEqual(
    JSON.parse(JSON.parse(built.define.__LODY_DESKTOP_BUILD_JSON__)),
    resolveElectronReleaseProfile({ environment: 'production', baseVersion: pkg.version })
  );
  assert.equal(built.define['process.env.LODY_AUTH_URL'], undefined);
});
