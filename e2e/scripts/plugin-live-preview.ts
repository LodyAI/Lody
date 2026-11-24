import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, expect } from '@playwright/test';
import { ElectronHarness, createIsolatedEnvironment } from '../src/support/electron-harness.js';
import { OnboardingPage } from '../src/support/pages/onboarding-page.js';

assert.ok(
  process.stdin.isTTY && process.env.LODY_AGENT_SESSION_ID === undefined,
  'Run the live preview from an interactive machine-owner terminal.'
);
const url = process.env.LODY_E2E_PLUGIN_WEB_URL;
assert.ok(
  url,
  'Set LODY_E2E_PLUGIN_WEB_URL to a disposable Web workspace connected to the isolated machine'
);
const settings = process.env.LODY_E2E_PLUGIN_WEB_SETTINGS_URL;
assert.ok(
  settings,
  'Set LODY_E2E_PLUGIN_WEB_SETTINGS_URL to the Plugins settings page of the same disposable workspace'
);
assert.equal(new URL(settings).origin, new URL(url).origin);
const root = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'lody-pv-'));
const desktop = new ElectronHarness({
  rootDir: root,
  scenarioDir: root,
  stableId: 'plugin-preview',
});
const cli = fileURLToPath(new URL('../../apps/cli/dist/index.js', import.meta.url));
const example = fileURLToPath(
  new URL('../../scripts/fixtures/plugin-sdk/examples/', import.meta.url)
);
const data = join(root, 'profile', 'lody-data');
const run = (args: string[], env: Record<string, string>) =>
  promisify(execFile)(process.execPath, [cli, 'plugin', ...args], {
    env,
    cwd: root,
    timeout: 30000,
  });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  for (const id of [
    'sound-effects',
    'test-report',
    'issue-context',
    'worktrees',
    'focus-sidebar',
  ]) {
    const path = join(root, id);
    await cp(join(example, id), path, { recursive: true });
    const { stdout } = await run(
      ['doctor', path],
      createIsolatedEnvironment({ LODY_DATA_DIR: data })
    );
    assert.equal(JSON.parse(stdout).ok, true, `doctor: ${id}`);
  }
  await desktop.launch({ forceOnboarding: true });
  const endpoint = await desktop.app!.evaluate(
    () =>
      Object.fromEntries(
        Object.entries(process.env).filter(
          ([k, v]) => k.startsWith('LODY_E2E_LOCAL_CLI_HOST_') && v
        )
      ) as Record<string, string>
  );
  assert.ok(Object.keys(endpoint).length, 'Desktop must own an isolated CLI endpoint');
  await new OnboardingPage(desktop.page!).skipConfigurationAndEnterProduct();
  const plugin = join(root, 'focus-sidebar');
  const ownerEnv = createIsolatedEnvironment({
    HOME: root,
    ...endpoint,
    LODY_E2E: '1',
    LODY_DATA_DIR: join(desktop.getIsolatedRoot(), 'lody-data'),
  });
  const linkArgs = ['plugin', 'link', '--dev', plugin];
  await assert.rejects(
    run(linkArgs.slice(1), { ...ownerEnv, LODY_AGENT_SESSION_ID: 'synthetic' }),
    (error: Error & { stdout?: string; stderr?: string }) =>
      /owner terminal/.test(`${error.stdout} ${error.stderr}`)
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...linkArgs], {
      cwd: root,
      env: ownerEnv,
      stdio: 'inherit',
      timeout: 65000,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Owner link failed: ${signal ?? code}`));
    });
  });
  const label = 'Swarm Hub';
  await expect(desktop.page!.getByText(label, { exact: true })).toBeVisible({ timeout: 30000 });
  browser = await chromium.launch({ channel: process.env.LODY_E2E_CHROMIUM_CHANNEL });
  const web = await browser.newPage({
    storageState: process.env.LODY_E2E_PLUGIN_WEB_STORAGE_STATE,
  });
  await web.goto(settings);
  const inspector = web
    .getByRole('region', { name: 'Plugin Inspector' })
    .filter({ has: web.getByRole('heading', { name: 'Focus Sidebar', exact: true }) });
  await inspector.getByRole('button', { name: 'Trust this dev session', exact: true }).click();
  await expect(inspector.getByText(/Trusted Dev Session/)).toBeVisible();
  await web.goto(url);
  await expect(web.getByText(label, { exact: true })).toBeVisible({ timeout: 30000 });
  const pages = [desktop.page!, web];
  for (const page of pages) {
    const tree = page.getByRole('button', { name: 'Agent Tree', exact: true });
    await tree.click();
    await expect(tree).toHaveAttribute('aria-pressed', 'true');
  }
  const entry = join(plugin, 'client.tsx');
  const source = await readFile(entry, 'utf8');
  for (let revision = 1; revision <= 20; revision++) {
    const next = `${label} ${revision}`;
    await writeFile(entry, source.replace(`label="${label}"`, `label="${next}"`));
    await Promise.all(
      pages.map(async (page) => {
        await expect(page.getByText(next, { exact: true })).toBeVisible({ timeout: 30000 });
        await expect(page.getByRole('button', { name: 'Agent Tree', exact: true })).toHaveAttribute(
          'aria-pressed',
          'true'
        );
        await expect(
          page.getByText(revision === 1 ? label : `${label} ${revision - 1}`, { exact: true })
        ).toHaveCount(0);
      })
    );
  }
} finally {
  try {
    await browser?.close();
  } finally {
    try {
      await desktop.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
