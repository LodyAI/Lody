import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

const require = createRequire(import.meta.url);

test('terminal disposal releases window and DPR listeners', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Resource counters require Chromium CDP');
  await page.goto('about:blank');
  await page.addScriptTag({ path: require.resolve('@xterm/xterm') });
  const cdp = await page.context().newCDPSession(page);
  const counters = async () => {
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    await cdp.send('HeapProfiler.collectGarbage');
    return cdp.send('Memory.getDOMCounters');
  };
  const cycle = () =>
    page.evaluate(() => {
      const host = document.createElement('div');
      document.body.append(host);
      const { Terminal } = window as unknown as {
        Terminal: new () => { open(host: HTMLElement): void; dispose(): void };
      };
      const terminal = new Terminal();
      try {
        terminal.open(host);
      } finally {
        terminal.dispose();
        host.remove();
      }
    });

  for (let i = 0; i < 3; i++) await cycle();
  const baseline = await counters();
  for (let i = 0; i < 30; i++) await cycle();
  const final = await counters();
  expect(final.jsEventListeners).toBe(baseline.jsEventListeners);
});
