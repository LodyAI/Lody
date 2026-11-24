import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postcss from 'postcss';
import { build, loadConfigFromFile } from 'vite';

const mobileRoot = fileURLToPath(new URL('./', import.meta.url));
const componentsRoot = fileURLToPath(new URL('../../packages/components/', import.meta.url));
const uiRoot = fileURLToPath(new URL('../../packages/ui/', import.meta.url));
const requireFromComponents = createRequire(join(componentsRoot, 'package.json'));
const requireFromUi = createRequire(join(uiRoot, 'package.json'));

export function unsupportedCssFeatures(css, from) {
  const features = [];
  const sheet = postcss.parse(css, { from });
  sheet.walkRules((rule) => {
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'rule') {
        features.push(`nesting: ${rule.selector}`);
        break;
      }
    }
  });
  sheet.walkDecls((decl) => {
    if (/\blight-dark\(/.test(decl.value)) features.push(`light-dark: ${decl.prop}`);
  });
  return features;
}

export function assertCompatibleCss(css, from) {
  const features = unsupportedCssFeatures(css, from);
  assert.equal(
    features.length,
    0,
    `${from}: ${features.length} unsupported declarations/rules:\n${features.slice(0, 10).join('\n')}`
  );
}

// Build the installed PDF/Monaco sheets, the real app base sheet, and real
// UI token imports through the mobile pipeline. The small JS entry avoids an
// entire app/Worker build in unit tests; the optional artifact test scans dist too.
export async function buildCssFixture(cssMinify) {
  const root = await mkdtemp(join(tmpdir(), 'lody-mobile-css-'));
  try {
    const { config } = await loadConfigFromFile(
      { command: 'build', mode: 'prod' },
      join(mobileRoot, 'vite.config.ts'),
      mobileRoot,
      'silent'
    );
    const source = `
      import ${JSON.stringify(requireFromComponents.resolve('pdfjs-dist/legacy/web/pdf_viewer.css'))};
      import ${JSON.stringify(requireFromComponents.resolve('monaco-editor/esm/vs/editor/browser/widget/diffEditor/style.css'))};
      import ${JSON.stringify(join(componentsRoot, 'src/tailwind/index.css'))};
      import * as stylex from '@stylexjs/stylex';
      import { colors } from ${JSON.stringify(join(uiRoot, 'src/tokens/colors.stylex'))};
      import { productDarkPalette, productLightPalette } from ${JSON.stringify(join(componentsRoot, 'src/lib/vscode-theme/lody-ui-palette.stylex'))};
      const styles = stylex.create({ product: {
        color: colors.label, backgroundColor: colors.background,
        paddingInline: 16, display: 'flex',
      }, sample: {
        color: colors.label, backgroundColor: colors.background,
        padding: 12, borderRadius: 6, display: 'flex',
      }});
      document.querySelector('#stylex').className = stylex.props(styles.sample).className;
      const product = document.querySelector('#product');
      if (product) product.className = stylex.props(styles.product).className;
      // Match theme-provider.tsx: class + product palette on html, with the
      // committed mode in its inline color-scheme (body keeps the app CSS).
      globalThis.applyCompatibilityTheme = (theme, system) => {
        const resolved = theme === 'system' ? system : theme;
        const palette = stylex.props(resolved === 'dark' ? productDarkPalette : productLightPalette);
        document.documentElement.className = resolved + ' ' + palette.className;
        document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : resolved;
      };
    `;
    await writeFile(join(root, 'index.js'), source);

    const result = await build({
      ...config,
      configFile: false,
      root,
      logLevel: 'silent',
      resolve: {
        ...config.resolve,
        alias: [
          ...config.resolve.alias,
          { find: '@stylexjs/stylex', replacement: requireFromUi.resolve('@stylexjs/stylex') },
        ],
      },
      build: {
        ...config.build,
        ...(cssMinify === undefined ? {} : { cssMinify }),
        write: false,
        rollupOptions: { input: join(root, 'index.js') },
      },
    });
    const css = result.output
      .filter((asset) => asset.type === 'asset' && asset.fileName.endsWith('.css'))
      .map((asset) => String(asset.source))
      .join('\n');
    const js = result.output.find((asset) => asset.type === 'chunk' && asset.isEntry)?.code;
    assert.ok(css && js, 'the actual CSS plugins must emit stylesheet and StyleX entry');
    return { css, js };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
