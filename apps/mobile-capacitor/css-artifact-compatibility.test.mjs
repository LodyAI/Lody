import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';
import { assertCompatibleCss, buildCssFixture } from './css-compatibility-fixture.mjs';

void test('the mobile CSS pipeline lowers installed PDF, Monaco, base and StyleX styles', async () => {
  const { css } = await buildCssFixture();
  assertCompatibleCss(css, 'mobile CSS fixture');
  for (const selector of ['.textLayer', '.monaco-editor', '@layer']) {
    assert.ok(css.includes(selector), `missing emitted styles: ${selector}`);
  }
});

if (process.env.LODY_MOBILE_CSS_ARTIFACT_DIR) {
  void test('every emitted mobile production stylesheet supports the 16.4 CSS floor', async () => {
    const directory = resolve(process.env.LODY_MOBILE_CSS_ARTIFACT_DIR);
    const files = (await readdir(directory, { recursive: true })).filter((name) =>
      name.endsWith('.css')
    );
    assert.ok(files.length > 0, `no CSS assets found in ${directory}; build mobile first`);
    for (const file of files) {
      assertCompatibleCss(await readFile(resolve(directory, file), 'utf8'), file);
    }
  });
}
