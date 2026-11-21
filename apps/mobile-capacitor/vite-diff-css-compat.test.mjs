import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import postcss from 'postcss';
import { build } from 'vite';
import { diffCssCompatPlugin } from './vite-diff-css-compat.ts';

const stylesheetPath = realpathSync(
  new URL('../../packages/components/node_modules/@pierre/diffs/dist/style.js', import.meta.url)
);

async function bundleStylesheet(entry, plugins = []) {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [diffCssCompatPlugin(), ...plugins],
    build: {
      write: false,
      minify: false,
      lib: { entry, formats: ['es'] },
    },
  });
  const chunk = output[0].output.find((item) => item.type === 'chunk');
  assert.ok(chunk, 'the library build must produce an importable stylesheet module');
  return import(`data:text/javascript;base64,${Buffer.from(chunk.code).toString('base64')}`);
}

function unsupportedFeatures(css) {
  const features = [];
  const sheet = postcss.parse(css);
  sheet.walkRules((rule) => {
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'rule') {
        features.push('nesting');
        break;
      }
    }
  });
  sheet.walkDecls((declaration) => {
    if (/\blight-dark\(/.test(declaration.value)) features.push('light-dark');
  });
  return features;
}

void test('the installed diff stylesheet builds without post-16.4 nesting or light-dark colors', async () => {
  const original = (await import(pathToFileURL(stylesheetPath).href)).default;
  // This fixture is the actual dependency, including its nested token colors
  // and selection rules, rather than a separately maintained CSS facsimile.
  assert.ok(unsupportedFeatures(original).includes('nesting'));
  assert.ok(unsupportedFeatures(original).includes('light-dark'));

  const { default: compiled } = await bundleStylesheet(stylesheetPath);
  assert.deepEqual(unsupportedFeatures(compiled), []);
  const stylesheet = postcss.parse(compiled);
  for (const selector of ['[data-line] span', '[data-edit-prediction-suffix] span']) {
    const tokens = [];
    stylesheet.walkRules((rule) => {
      if (rule.selectors.includes(selector)) {
        rule.walkDecls('color', (declaration) => tokens.push(declaration.value));
      }
    });
    assert.equal(tokens.length, 1, `${selector} syntax colors must remain applicable`);
    assert.ok(tokens[0].includes('--diffs-token-light'));
    assert.ok(tokens[0].includes('--diffs-token-dark'));
  }

  const { wrapThemeCSS } = await bundleStylesheet(
    new URL('./utils/cssWrappers.js', pathToFileURL(stylesheetPath)).pathname
  );
  // Forced in-app themes must still override the system appearance; merely
  // replacing light-dark() with a prefers-color-scheme query loses that choice.
  for (const theme of ['light', 'dark']) {
    const modes = [];
    postcss.parse(wrapThemeCSS('', theme)).walkRules((rule) => {
      if (rule.selector === ':host') {
        rule.walkDecls('color-scheme', (declaration) => modes.push(declaration.value));
      }
    });
    assert.deepEqual(modes, [theme]);
  }
});

void test('a changed dependency stylesheet export fails the build instead of bypassing compatibility', async () => {
  const id = '/virtual/node_modules/@pierre/diffs/dist/style.js';
  await assert.rejects(
    bundleStylesheet(id, [
      {
        name: 'changed-diff-package-fixture',
        resolveId(source) {
          return source === id ? id : null;
        },
        load(source) {
          return source === id ? 'export default makeStyles();' : null;
        },
      },
    ]),
    /Review @pierre\/diffs CSS compatibility/
  );
});
