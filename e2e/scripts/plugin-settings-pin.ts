import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from '@playwright/test';
import { ElectronHarness } from '../src/support/electron-harness.js';
import { OnboardingPage } from '../src/support/pages/onboarding-page.js';
const root = await mkdtemp(join(tmpdir(), 'plugin-pin-'));
const desktop = new ElectronHarness({ rootDir: root, scenarioDir: root, stableId: 'settings-pin' });
try {
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      join(repo, 'apps/cli/dist/index.js'),
      'plugin',
      'pack',
      join(repo, 'scripts/fixtures/plugin-sdk/examples/focus-sidebar'),
      '-o',
      join(root, 'release.tgz'),
    ],
    {
      cwd: root,
      env: { HOME: root, PATH: process.env.PATH, LODY_DATA_DIR: join(root, 'pack-data') },
    }
  );
  const { workspaceEntry } = JSON.parse(stdout);
  assert.equal(workspaceEntry.plugin_id, 'focus-sidebar');
  await desktop.launch({ forceOnboarding: true });
  const page = desktop.page!;
  await new OnboardingPage(page).skipConfigurationAndEnterProduct();
  const settings = new URL(page.url());
  settings.hash = '/local/settings/plugins';
  await page.goto(settings.href);
  await page.getByLabel(/Import npm workspace pin|导入 npm 工作区固定版本/).setInputFiles({
    name: 'release.json',
    mimeType: 'application/json',
    buffer: Buffer.from(stdout),
  });
  const inspector = page.getByRole('region', { name: /Plugin Inspector|插件检查器/i });
  await expect(
    inspector.getByRole('heading', { name: workspaceEntry.manifest_summary.title })
  ).toBeVisible();
  settings.hash += '/focus-sidebar';
  await page.reload();
  await expect(page.locator('#chat-prompt')).toBeVisible();
  await page.goto(settings.href);
  await expect(page).toHaveURL(/#\/local\/chat(?:\?.*)?$/);
  await expect(inspector.getByText(workspaceEntry.client_digest, { exact: false })).toBeVisible();
  await expect(
    inspector.getByRole('button', { name: /Approve this release|批准此版本/ })
  ).toBeVisible();
} finally {
  try {
    await desktop.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
