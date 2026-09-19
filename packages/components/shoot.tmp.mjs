import { chromium } from '@playwright/test';
const [id, out, clickSel, hoverSel, locale = 'zh_CN'] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:6006/iframe.html?id=${id}&viewMode=story&globals=theme:light;locale:${locale}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
if (clickSel) { await page.click(clickSel); await page.waitForTimeout(500); }
if (hoverSel) { await page.hover(hoverSel); await page.waitForTimeout(400); }
await page.screenshot({ path: out });
await browser.close();
