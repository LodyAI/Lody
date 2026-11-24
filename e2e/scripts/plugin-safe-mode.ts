import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ElectronHarness } from '../src/support/electron-harness.js';
import { OnboardingPage } from '../src/support/pages/onboarding-page.js';

const root = await mkdtemp(join(tmpdir(), 'plugin-safe-'));
const desktop = new ElectronHarness({ rootDir: root, scenarioDir: root, stableId: 'safe-mode' });
try {
  await desktop.launch({ safeMode: true, forceOnboarding: true });
  const page = desktop.page!;
  assert.equal(new URL(page.url()).searchParams.get('safeMode'), '1');
  await new OnboardingPage(page).skipConfigurationAndEnterProduct();
  await assert.rejects(
    page.evaluate(() =>
      window.ipc!.invoke(
        'machineRpc.openPluginModule',
        'machine',
        'workspace',
        'example',
        '0'.repeat(64),
        {}
      )
    ),
    /Plugins disabled in safe mode/
  );
} finally {
  try {
    await desktop.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
