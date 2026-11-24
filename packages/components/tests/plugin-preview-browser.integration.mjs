// Run after building the CLI: node packages/components/tests/plugin-preview-browser.integration.mjs
import { chromium, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const dir = await mkdtemp(join(tmpdir(), 'preview-browser-'));
let browser;
try {
  const cli = fileURLToPath(new URL('../../../apps/cli/dist/index.js', import.meta.url));
  const output = join(dir, 'preview.html');
  await writeFile(
    join(dir, 'lody.plugin.json'),
    JSON.stringify({
      id: 'sample',
      title: 'Sample',
      version: '1.0.0',
      sdk: '^1.0.0',
      client: 'client.ts',
      assets: ['badge.svg'],
    })
  );
  await writeFile(
    join(dir, 'badge.svg'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'
  );
  await writeFile(
    join(dir, 'client.ts'),
    `import {defineClientPlugin} from '@lody/plugin-sdk/client';import {createElement as h} from 'react';export default defineClientPlugin(l=>{l.tools.matchRender({id:'test',match:{commandPattern:'node --test'},Component:()=>h('img',{alt:'Matched test',src:l.assets.url('badge.svg')})});l.messages.renderBlock({id:'note',languages:['plugin-note'],Component:({code})=>'NOTE '+code});});`
  );
  execFileSync(process.execPath, [cli, 'plugin', 'preview', dir, '--no-open', '--output', output], {
    env: { ...process.env, LODY_AGENT_SESSION_ID: 'synthetic-preview' },
  });
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(pathToFileURL(output).href);
  const frame = page.frameLocator('iframe');
  for (const platform of ['desktop', 'web', 'mobile']) {
    await page.getByLabel('Viewport').selectOption(platform);
    await expect(frame.getByText('NOTE Synthetic message')).toBeVisible();
    await expect(frame.getByAltText('Matched test')).toBeVisible();
    await expect
      .poll(() => frame.getByAltText('Matched test').evaluate((img) => img.naturalWidth))
      .toBe(1);
    await frame.getByLabel('Command').fill('echo hi');
    await expect(frame.getByAltText('Matched test')).toHaveCount(0);
  }
  expect(await frame.locator('body').evaluate(() => globalThis.origin)).toBe('null');
  expect(
    await frame.locator('body').evaluate(() => {
      try {
        return Boolean(parent.document);
      } catch {
        return false;
      }
    })
  ).toBe(false);
} finally {
  await browser?.close();
  await rm(dir, { recursive: true, force: true });
}
