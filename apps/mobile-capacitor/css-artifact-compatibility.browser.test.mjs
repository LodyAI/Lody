import assert from 'node:assert/strict';
import test from 'node:test';
import { webkit } from '@playwright/test';
import { buildCssFixture } from './css-compatibility-fixture.mjs';

// Current WebKit checks that lowering preserves appearance and CSS layer order;
// the parser test separately rejects syntax unavailable on the 16.4 floor.
void test('lowered PDF, Monaco, base and StyleX styles preserve layout and both themes', async () => {
  const original = await buildCssFixture(false);
  const lowered = await buildCssFixture();
  const browser = await webkit.launch({ headless: true });
  try {
    const pdfSystemColors = [];
    for (const system of ['light', 'dark']) {
      const samples = [];
      for (const { css, js } of [original, lowered]) {
        const page = await browser.newPage({ colorScheme: system });
        try {
          await page.setContent(`
            <div class="textLayer" data-text-selectable><span id="pdf-text">PDF text</span></div>
            <button id="pdf-button" class="secondaryButton">PDF action</button>
            <div class="monaco-diff-editor"><div class="gutter"><div id="monaco" class="gutterItem showAlways">action</div></div></div>
            <div id="product">Product tokens</div>
            <div id="stylex">StyleX</div>
            <nav><span id="chrome-text">Sidebar</span></nav>
            <div data-text-selectable><b id="reading-text">Prose</b><button id="reading-button"><span id="reading-button-label">Copy</span></button></div>
            <div contenteditable="true"><span id="editor-text">Draft</span></div>`);
          await page.addStyleTag({ content: css });
          // Await module evaluation, not just insertion of a module script tag.
          await page.evaluate(
            async (url) => {
              await import(url);
            },
            `data:text/javascript;base64,${Buffer.from(js).toString('base64')}`
          );
          const themes = {};
          for (const theme of ['light', 'dark', 'system']) {
            themes[theme] = await page.evaluate(
              ({ theme: appTheme, system: systemTheme }) => {
                globalThis.applyCompatibilityTheme(appTheme, systemTheme);
                return Object.fromEntries(
                  [
                    'pdf-text',
                    'pdf-button',
                    'monaco',
                    'product',
                    'stylex',
                    'chrome-text',
                    'reading-text',
                    'reading-button-label',
                    'editor-text',
                  ].map((id) => {
                    const style = getComputedStyle(document.getElementById(id));
                    return [
                      id,
                      {
                        color: style.color,
                        background: style.backgroundColor,
                        position: style.position,
                        display: style.display,
                        padding: style.padding,
                        radius: style.borderRadius,
                        opacity: style.opacity,
                        userSelect:
                          style.getPropertyValue('user-select') ||
                          style.getPropertyValue('-webkit-user-select'),
                      },
                    ];
                  })
                );
              },
              { theme, system }
            );
          }
          samples.push(themes);
        } finally {
          await page.close();
        }
      }
      assert.deepEqual(
        samples[1],
        samples[0],
        `lowering changed computed styles under system=${system}`
      );
      const { light, dark } = samples[1];
      pdfSystemColors.push(samples[1].system['pdf-button'].color);
      assert.equal(light['pdf-text'].color, 'rgba(0, 0, 0, 0)');
      assert.equal(light['pdf-text'].position, 'absolute');
      assert.equal(light['pdf-text'].userSelect, 'text');
      assert.equal(light['chrome-text'].userSelect, 'none');
      assert.equal(light['reading-text'].userSelect, 'text');
      assert.equal(light['reading-button-label'].userSelect, 'none');
      assert.equal(light['editor-text'].userSelect, 'text');
      assert.equal(light.monaco.position, 'absolute');
      assert.equal(light.monaco.opacity, '1');
      assert.equal(light.product.display, 'flex');
      assert.equal(light.product.padding, '0px 16px');
      assert.equal(light.stylex.display, 'flex');
      assert.equal(light.stylex.padding, '12px');
      assert.equal(light.stylex.radius, '6px');
      assert.equal(
        light.stylex.color,
        light.product.color,
        'StyleX keeps the light product palette'
      );
      assert.equal(dark.stylex.color, dark.product.color, 'StyleX keeps the dark product palette');
      for (const id of ['product', 'stylex']) {
        assert.notEqual(
          light[id].color,
          dark[id].color,
          `${id} must retain distinct forced theme colors`
        );
      }
    }
    assert.notEqual(
      pdfSystemColors[0],
      pdfSystemColors[1],
      'PDF system colors must remain distinct'
    );
  } finally {
    await browser.close();
  }
});
