import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildUi, launchHost } from './helpers';

describe.skipIf(process.env.LODY_E2EE_DEMO_BROWSER !== '1')('D2 isolated browser contexts', () => {
  it('creates and joins from two isolated contexts and compares ledger digests', async () => {
    let chromium: typeof import('playwright').chromium | undefined;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      expect(existsSync(new URL('../src/host.ts', import.meta.url))).toBe(true);
      return;
    }
    buildUi();
    const host = await launchHost();
    const browser = await chromium.launch({ headless: true });
    try {
      const contextA = await browser.newContext();
      const contextB = await browser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      await pageA.goto(host.baseUrl);
      await pageB.goto(host.baseUrl);
      expect(await pageA.locator('h1').textContent()).toContain('E2EE demo');
      await pageA.selectOption('#account', 'alice');
      await pageA.click('#connect');
      await pageA.waitForFunction(
        () => document.getElementById('status')?.textContent === 'connected'
      );
      await pageA.click('#create');
      await pageA.waitForFunction(
        () => (document.getElementById('genesis') as HTMLInputElement)?.value.length === 64
      );
      const genesis = await pageA.locator('#genesis').inputValue();
      expect(genesis).toMatch(/^[0-9a-f]{64}$/);

      await pageB.selectOption('#account', 'bob');
      await pageB.click('#connect');
      await pageB.waitForFunction(
        () => document.getElementById('status')?.textContent === 'connected'
      );
      await pageB.fill('#genesis', genesis);
      await pageB.click('#join');
      await pageB.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('join requested')
      );

      await pageA.click('#approve');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('join approved')
      );
      await pageA.click('#note');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('note published')
      );
      await pageB.click('#note');
      await pageB.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('note published')
      );
      await pageA.click('#compare');
      await pageB.click('#compare');
      await pageA.waitForFunction(
        () => (document.getElementById('compare-kind')?.textContent ?? '').length > 0
      );
      await pageB.waitForFunction(
        () => (document.getElementById('compare-kind')?.textContent ?? '').length > 0
      );
      const kindA = await pageA.locator('#compare-kind').textContent();
      const kindB = await pageB.locator('#compare-kind').textContent();
      const labelA = await pageA.locator('#compare-label').textContent();
      const labelB = await pageB.locator('#compare-label').textContent();
      expect(kindA).toBe('agree');
      expect(kindB).toBe('agree');
      expect(labelA).toBe('checked');
      expect(labelB).toBe('checked');
    } finally {
      await browser.close();
    }
  });

  it('exercises key delivery, Loro/Flock, snapshot, revoke, rotate, and file restore', async () => {
    let chromium: typeof import('playwright').chromium | undefined;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      expect(existsSync(new URL('../src/ui/App.tsx', import.meta.url))).toBe(true);
      return;
    }
    buildUi();
    const host = await launchHost();
    const browser = await chromium.launch({ headless: true });
    try {
      const contextA = await browser.newContext({ acceptDownloads: true });
      const contextB = await browser.newContext();
      const contextC = await browser.newContext();
      const pageA = await contextA.newPage();
      const pageB = await contextB.newPage();
      const pageC = await contextC.newPage();
      await pageA.goto(host.baseUrl);
      await pageB.goto(host.baseUrl);
      await pageC.goto(host.baseUrl);

      await pageA.selectOption('#account', 'alice');
      await pageA.click('#connect');
      await pageA.waitForFunction(
        () => document.getElementById('status')?.textContent === 'connected'
      );
      await pageA.click('#create');
      await pageA.waitForFunction(
        () => (document.getElementById('genesis') as HTMLInputElement)?.value.length === 64
      );
      const genesis = await pageA.locator('#genesis').inputValue();

      await pageB.selectOption('#account', 'bob');
      await pageB.click('#connect');
      await pageB.waitForFunction(
        () => document.getElementById('status')?.textContent === 'connected'
      );
      await pageB.fill('#genesis', genesis);
      await pageB.click('#join');
      await pageB.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('join requested')
      );
      await pageA.click('#approve');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('join approved')
      );

      await pageA.click('#deliver-key');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('delivered')
      );
      await pageB.click('#receive-key');
      await pageB.waitForFunction(
        () => Number(document.getElementById('keys-received')?.textContent ?? '0') > 0
      );

      await pageA.fill('#loro-input', 'hello-ui');
      await pageA.click('#loro-write');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('loro written')
      );
      await pageB.click('#loro-read');
      await pageB.waitForFunction(() =>
        (document.getElementById('loro-value')?.textContent ?? '').includes('hello-ui')
      );

      await pageA.fill('#flock-input', 'flock-ui');
      await pageA.click('#flock-write');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('flock written')
      );
      await pageB.click('#flock-read');
      await pageB.waitForFunction(() =>
        (document.getElementById('flock-value')?.textContent ?? '').includes('flock-ui')
      );

      await pageA.click('#snapshot-upload');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('snapshot uploaded')
      );

      const [download] = await Promise.all([
        pageA.waitForEvent('download'),
        pageA.click('#export-backup'),
      ]);
      const backupPath = await download.path();
      expect(backupPath).toBeTruthy();

      await pageC.selectOption('#account', 'carol');
      await pageC.click('#connect');
      await pageC.waitForFunction(
        () => document.getElementById('status')?.textContent === 'connected'
      );
      await pageC.setInputFiles('#import-backup', backupPath!);
      await pageC.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('backup restored')
      );
      await pageC.click('#loro-read');
      await pageC.waitForFunction(() =>
        (document.getElementById('loro-value')?.textContent ?? '').includes('hello-ui')
      );

      await pageA.click('#revoke');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('member revoked')
      );
      await pageA.click('#rotate');
      await pageA.waitForFunction(() =>
        (document.getElementById('log')?.textContent ?? '').includes('rotated')
      );
      await pageB.fill('#loro-input', 'after-revoke');
      await pageB.click('#loro-write');
      await pageB.waitForFunction(
        () => document.getElementById('status')?.textContent === 'failed'
      );
    } finally {
      await browser.close();
    }
  }, 120_000);
});
