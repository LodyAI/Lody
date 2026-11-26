/**
 * Cloud Electron startup smoke test: launches the real Cloud-built Electron app
 * (with preload auth bridge active) and fails on any uncaught renderer exception
 * or React/Router error boundary (e.g. "Cannot read properties of undefined (reading 'atoms')").
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron } from '@playwright/test';

const ELECTRON_DIR = resolve(process.env.LODY_CLOUD_SMOKE_APP_DIR || 'apps/electron');
const MAIN_ENTRY = join(ELECTRON_DIR, 'out/main/index.js');
const SETTLE_MS = Number(process.env.LODY_CLOUD_SMOKE_SETTLE_MS || 6_000);

async function main() {
  const scratchDir = mkdtempSync(join(tmpdir(), 'lody-cloud-smoke-'));
  const userDataDir = join(scratchDir, 'user-data');
  const dataDir = join(scratchDir, 'data');
  const pageErrors = [];
  const consoleErrors = [];

  const app = await electron.launch({
    args: [
      MAIN_ENTRY,
      `--user-data-dir=${userDataDir}`,
      ...(process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
    ],
    env: {
      ...process.env,
      LODY_E2E: '1',
      LODY_DATA_DIR: dataDir,
      LODY_PLATFORM: 'cloud',
      VITE_LODY_PLATFORM: 'cloud',
      LODY_ELECTRON_PLAINTEXT_AUTH_STORAGE: '1',
    },
    timeout: 60_000,
  });

  try {
    const win = await app.firstWindow({ timeout: 45_000 });
    win.on('pageerror', (err) => pageErrors.push(err.stack || err.message || String(err)));
    win.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await win.waitForLoadState('domcontentloaded', { timeout: 30_000 });
    await win.waitForTimeout(SETTLE_MS);

    const bodyText = await win.evaluate(() => document.body?.innerText?.trim() ?? '');
    assert.equal(
      pageErrors.length,
      0,
      `Uncaught renderer pageerror(s) during Cloud Electron startup:\n${pageErrors.join('\n---\n')}`
    );
    assert.ok(
      !bodyText.includes('Something went wrong!'),
      `Cloud Electron rendered an ErrorBoundary on startup:\n${bodyText.slice(0, 1000)}`
    );
    assert.ok(
      bodyText.length > 0,
      `Cloud Electron rendered an empty body on startup (console errors: ${consoleErrors.slice(0, 5).join(' | ')})`
    );
    console.log(`[cloud-electron-smoke] PASS (body length=${bodyText.length}, pageErrors=0)`);
  } finally {
    await app.close().catch(() => {});
    rmSync(scratchDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`[cloud-electron-smoke] FAIL: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  process.exit(1);
});
