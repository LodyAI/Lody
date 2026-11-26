import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer, loadConfigFromFile } from 'vite';

const configFile = fileURLToPath(new URL('./vite.config.ts', import.meta.url));
const originalPlatform = process.env.VITE_LODY_PLATFORM;

after(() => {
  if (originalPlatform === undefined) {
    delete process.env.VITE_LODY_PLATFORM;
  } else {
    process.env.VITE_LODY_PLATFORM = originalPlatform;
  }
});

async function loadMobileConfig(mode, command = 'build') {
  const loaded = await loadConfigFromFile({ command, mode }, configFile, undefined, 'silent');
  assert.ok(loaded, `expected Vite to load the mobile ${mode} config`);
  return loaded.config;
}

void test('nightly keeps production runtime settings and only aliases the icon preview', async () => {
  const previous = process.env.LODY_MOBILE_NIGHTLY_ICON;
  const platform = process.env.VITE_LODY_PLATFORM;
  delete process.env.VITE_LODY_PLATFORM;
  try {
    delete process.env.LODY_MOBILE_NIGHTLY_ICON;
    const stable = await loadMobileConfig('prod');
    process.env.LODY_MOBILE_NIGHTLY_ICON = '1';
    const nightly = await loadMobileConfig('prod');
    const stableDefines = { ...stable.define };
    const nightlyDefines = { ...nightly.define };
    delete stableDefines.__BUILD_DATE__;
    delete nightlyDefines.__BUILD_DATE__;
    assert.deepEqual(nightlyDefines, stableDefines);
    assert.equal(nightly.envDir, stable.envDir);
    assert.deepEqual(nightly.build, stable.build);
    for (const config of [stable, nightly]) {
      // Exercise Vite's resolver: comparing raw config shapes missed an array
      // accidentally spread into an object, which silently drops the WASM alias.
      const server = await createServer({
        configFile: false,
        root: fileURLToPath(new URL('./', import.meta.url)),
        resolve: config.resolve,
        server: { middlewareMode: true, watch: null },
        optimizeDeps: { noDiscovery: true },
      });
      try {
        const importer = fileURLToPath(new URL('./src/app-icon.ts', import.meta.url));
        const resolve = server.config.createResolver();
        const wasm = await resolve(
          'loro-crdt',
          fileURLToPath(
            new URL('../../packages/components/vite-wasm-workarounds.ts', import.meta.url)
          )
        );
        assert.ok(wasm?.endsWith('/loro-crdt/bundler/index.js'), wasm);
        const accountPanel = await resolve(
          '@/components/settings/account-setting',
          fileURLToPath(
            new URL(
              '../../packages/components/src/components/settings/settings-code.ts',
              import.meta.url
            )
          )
        );
        assert.equal(
          accountPanel,
          fileURLToPath(new URL('./src/recovery/recovery-account-setting.tsx', import.meta.url))
        );
        const preview = await resolve('./assets/app-icon-default.png', importer);
        const expected = config === nightly ? 'app-icon-nightly.png' : 'app-icon-default.png';
        assert.equal(preview, fileURLToPath(new URL(`./src/assets/${expected}`, import.meta.url)));
      } finally {
        await server.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env.LODY_MOBILE_NIGHTLY_ICON;
    else process.env.LODY_MOBILE_NIGHTLY_ICON = previous;
    if (platform === undefined) delete process.env.VITE_LODY_PLATFORM;
    else process.env.VITE_LODY_PLATFORM = platform;
  }
});

void test('every supported mobile build mode injects the cloud platform', async () => {
  delete process.env.VITE_LODY_PLATFORM;

  for (const mode of ['dev', 'staging', 'prod']) {
    const config = await loadMobileConfig(mode);
    assert.equal(config.define?.['import.meta.env.VITE_LODY_PLATFORM'], '"cloud"');
  }
});

void test('mobile serves and builds the bundled emoji picker dataset', async () => {
  delete process.env.VITE_LODY_PLATFORM;

  for (const command of ['serve', 'build']) {
    const config = await loadMobileConfig('dev', command);
    const pluginNames = (config.plugins ?? []).flat().map((plugin) => plugin?.name);
    assert.ok(
      pluginNames.includes('lody-emojibase-assets'),
      `expected the mobile ${command} config to register lody-emojibase-assets`
    );
  }
});

void test('the mobile cloud composition rejects an explicit local platform', async () => {
  process.env.VITE_LODY_PLATFORM = 'local';

  await assert.rejects(
    loadMobileConfig('staging'),
    /Mobile cloud runtime cannot use VITE_LODY_PLATFORM="local"/
  );
});

void test('mobile injects the configured sharing origin and rejects unsafe URLs', async () => {
  const previous = process.env.VITE_SESSION_SHARE_ORIGIN;
  const platform = process.env.VITE_LODY_PLATFORM;
  delete process.env.VITE_LODY_PLATFORM;
  try {
    process.env.VITE_SESSION_SHARE_ORIGIN = 'https://share-staging.example.test/';
    const config = await loadMobileConfig('staging');
    assert.equal(
      config.define?.['import.meta.env.VITE_SESSION_SHARE_ORIGIN'],
      JSON.stringify('https://share-staging.example.test')
    );
    process.env.VITE_SESSION_SHARE_ORIGIN = 'https://share.example.test/path';
    await assert.rejects(loadMobileConfig('staging'), /VITE_SESSION_SHARE_ORIGIN/);
    process.env.VITE_SESSION_SHARE_ORIGIN = '';
    const defaults = await loadMobileConfig('staging');
    assert.equal(
      defaults.define?.['import.meta.env.VITE_SESSION_SHARE_ORIGIN'],
      JSON.stringify('https://share.lody.ai')
    );
  } finally {
    if (previous === undefined) delete process.env.VITE_SESSION_SHARE_ORIGIN;
    else process.env.VITE_SESSION_SHARE_ORIGIN = previous;
    if (platform === undefined) delete process.env.VITE_LODY_PLATFORM;
    else process.env.VITE_LODY_PLATFORM = platform;
  }
});
