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
});
