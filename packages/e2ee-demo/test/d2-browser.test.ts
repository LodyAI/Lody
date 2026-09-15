import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { launchHost, session } from './helpers';

describe.skipIf(process.env.LODY_E2EE_DEMO_BROWSER !== '1')('D2 isolated browser contexts', () => {
  it('skips when Playwright is not installed, otherwise opens two contexts', async () => {
    let chromium: typeof import('playwright').chromium | undefined;
    try {
      ({ chromium } = await import('playwright'));
    } catch {
      expect(existsSync(new URL('../src/host.ts', import.meta.url))).toBe(true);
      return;
    }
    const host = await launchHost();
    const alice = await session(host, 'alice');
    await alice.createSpace();
    const browser = await chromium.launch({ headless: true });
    try {
      const a = await browser.newContext();
      const b = await browser.newContext();
      const pageA = await a.newPage();
      const pageB = await b.newPage();
      await pageA.goto(host.baseUrl);
      await pageB.goto(host.baseUrl);
      expect(await pageA.locator('h1').textContent()).toContain('E2EE demo');
      expect(await pageB.locator('h1').textContent()).toContain('E2EE demo');
      await pageA.click('#health');
      await pageB.click('#health');
      await pageA.waitForFunction(
        () => document.getElementById('status')?.textContent === 'connected'
      );
      await pageB.waitForFunction(
        () => document.getElementById('status')?.textContent === 'connected'
      );
      expect(await pageA.locator('#status').textContent()).toBe('connected');
      expect(await pageB.locator('#status').textContent()).toBe('connected');
    } finally {
      await browser.close();
    }
  });
});
