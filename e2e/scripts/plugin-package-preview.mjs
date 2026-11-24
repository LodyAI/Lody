import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { chromium, webkit, expect } from '@playwright/test';

const cli = fileURLToPath(new URL('../../apps/cli/dist/index.js', import.meta.url));
const fixture = fileURLToPath(
  new URL('../../scripts/fixtures/plugin-sdk/examples/focus-sidebar', import.meta.url)
);
const root = await mkdtemp(join(tmpdir(), 'lody-plugin-package-'));
const run = (...args) =>
  promisify(execFile)(process.execPath, [cli, 'plugin', ...args], {
    cwd: root,
    timeout: 60000,
    env: { PATH: process.env.PATH, HOME: root, LODY_DATA_DIR: join(root, 'data') },
  });
try {
  const archive = join(root, 'release.lodypkg');
  const { stdout } = await run('pack', fixture, '--output', archive);
  assert.equal(
    JSON.parse(stdout).sha256,
    createHash('sha256')
      .update(await readFile(archive))
      .digest('hex')
  );
  const html = join(root, 'preview.html');
  await run('preview', archive, '--output', html, '--no-open');
  for (const [engine, platform] of [
    [chromium, 'web'],
    [webkit, 'mobile'],
  ]) {
    const browser = await engine.launch();
    try {
      const page = await browser.newPage({
        viewport: platform === 'web' ? { width: 1280, height: 900 } : { width: 390, height: 844 },
      });
      await page.goto(pathToFileURL(html).href);
      await page.getByLabel('Viewport').selectOption(platform);
      const frame = page.frameLocator('iframe');
      await expect(frame.getByRole('heading', { name: 'Session', exact: true })).toBeVisible();
      const surface = frame.getByRole('heading', { name: 'Swarm Hub', exact: true });
      if (platform === 'web') await expect(surface).toBeVisible();
      else await expect(surface).toHaveCount(0);
    } finally {
      await browser.close();
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
