import assert from 'node:assert/strict';
import { _android as android } from '@playwright/test';
const [device] = await android.devices({ omitDriverInstall: true });
assert.ok(device, 'No connected Android emulator');
device.setDefaultTimeout(60000);
try {
  await device.shell('am start -W -n ai.lody.android/.MainActivity');
  const view = await device.webView({ pkg: 'ai.lody.android' }),
    page = await view.page();
  await page.waitForFunction(
    () => location.protocol === 'https:' && window.Capacitor?.getPlatform() === 'android'
  );
  const result = await page.evaluate(async () => {
    const api = await import('/__plugin_ci/fixture.js');
    const pin = api.workspacePluginEntrySchema.parse(
      await (await fetch('/__plugin_ci/pin.json')).json()
    );
    const lifetime = new AbortController();
    try {
      const store = await api.workspaceReleaseStore(
        'native-ci/workspace/genesis/key',
        lifetime.signal
      );
      if ((await store.list()).length) throw Error('Expected clean app profile');
      const row = await api.fetchWorkspaceNpmRelease(
        pin,
        lifetime.signal,
        location.origin + '/__plugin_ci'
      );
      await store.put({ ...row, npm: pin });
      return [pin.client_digest, row.digest];
    } finally {
      lifetime.abort();
    }
  });
  assert.equal(result[0], result[1]);
  await page.reload();
  const restored = await page.evaluate(async () => {
    const api = await import('/__plugin_ci/fixture.js'),
      lifetime = new AbortController();
    try {
      const store = await api.workspaceReleaseStore(
        'native-ci/workspace/genesis/key',
        lifetime.signal
      );
      const [row] = await store.list();
      const bytes = await api.receiveClientBundle(row.digest, (offset) =>
        api.workspacePage(row)(offset, lifetime.signal)
      );
      return api.unpackClientBundle(bytes)(row.manifest.client).length;
    } finally {
      lifetime.abort();
    }
  });
  assert.ok(restored > 0);
} finally {
  await device.close();
}
