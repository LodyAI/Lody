import { transform } from 'lightningcss';
import postcss from 'postcss';
import type { Plugin } from 'vite';

const safariTarget = { safari: (16 << 16) | (4 << 8) };

function compatibleColorScheme(theme: 'light' | 'dark'): string {
  // Include a color consumer so Lightning CSS emits the same switching
  // variables used by the separately compiled core stylesheet.
  const sheet = postcss.parse(
    transform({
      filename: 'diff-theme.css',
      code: Buffer.from(`:host { color-scheme: ${theme}; color: light-dark(black, white); }`),
      targets: safariTarget,
    }).code.toString()
  );
  const declarations: string[] = [];
  sheet.walkDecls((declaration) => {
    if (declaration.prop !== 'color') declarations.push(`${declaration.toString()};`);
  });
  return declarations.join('\n');
}

function normalizeThemeVariables(css: string): string {
  const sheet = postcss.parse(css);
  sheet.walkDecls('background-color', (declaration) => {
    if (declaration.value.includes('--diffs-token-light-bg')) {
      // `inherit` is not a valid color inside light-dark(), so the original
      // rule falls back to transparent when tokens have no background. After
      // lowering, a standalone `inherit` would instead paint the parent fill.
      declaration.value =
        'light-dark(var(--diffs-token-light-bg, transparent), var(--diffs-token-dark-bg, transparent))';
    }
  });
  return sheet.toString();
}

/** Pierre injects this CSS from a JS string, outside Vite's CSS pipeline. */
export function diffCssCompatPlugin(): Plugin {
  return {
    name: 'lody-mobile-diff-css-compat',
    enforce: 'pre',
    config() {
      // Prebundling would hide style.js from the transform during development.
      // Its nested CommonJS dependency still needs Vite's ESM interop wrapper.
      // Follow the actual pnpm dependency chain: mobile does not own Pierre.
      return {
        optimizeDeps: {
          exclude: ['@pierre/diffs'],
          include: ['@lody/components > @pierre/diffs > lru_map'],
        },
      };
    },
    transform(code, id) {
      // Vite adds a version query to unbundled dependencies during development.
      const path = id.split('?', 1)[0].replaceAll('\\', '/');
      if (path.endsWith('/@pierre/diffs/dist/utils/cssWrappers.js')) {
        const ast = this.parse(code);
        const wrapper = ast.body.find(
          (node) => node.type === 'FunctionDeclaration' && node.id?.name === 'wrapThemeCSS'
        );
        const declarations =
          wrapper?.type === 'FunctionDeclaration'
            ? wrapper.body.body.flatMap((node) =>
                node.type === 'VariableDeclaration' ? node.declarations : []
              )
            : [];
        const rule = declarations.find(
          (node) => node.id.type === 'Identifier' && node.id.name === 'colorSchemeRule'
        )?.init;
        if (rule?.type !== 'ConditionalExpression' || rule.alternate.type !== 'TemplateLiteral') {
          this.error('Review @pierre/diffs CSS compatibility: its theme wrapper changed.');
        }
        const { start, end } = rule.alternate as typeof rule.alternate & {
          start: number;
          end: number;
        };
        const replacement = `(themeType === 'light' ? ${JSON.stringify(compatibleColorScheme('light'))} : ${JSON.stringify(compatibleColorScheme('dark'))})`;
        return {
          code: code.slice(0, start) + replacement + code.slice(end),
          map: null,
        };
      }
      if (!path.endsWith('/@pierre/diffs/dist/style.js')) return null;

      // Read the pinned package's string literal without evaluating its module.
      // A changed export shape needs review, rather than silently shipping CSS
      // that requires a newer WebKit than the native deployment target.
      const ast = this.parse(code);
      const exported = ast.body.flatMap((node) =>
        node.type === 'ExportNamedDeclaration' ? node.specifiers : []
      );
      const defaultExport = exported.find(
        (node) => node.exported.type === 'Identifier' && node.exported.name === 'default'
      );
      const defaultName =
        defaultExport?.local.type === 'Identifier' ? defaultExport.local.name : undefined;
      const declarations = ast.body.flatMap((node) =>
        node.type === 'VariableDeclaration' ? node.declarations : []
      );
      const value = declarations.find(
        (node) => node.id.type === 'Identifier' && node.id.name === defaultName
      )?.init;
      if (value?.type !== 'Literal' || typeof value.value !== 'string') {
        this.error('Review @pierre/diffs CSS compatibility: its stylesheet export changed.');
      }

      const result = transform({
        filename: id,
        code: Buffer.from(normalizeThemeVariables(value.value)),
        targets: safariTarget,
      });
      return { code: `export default ${JSON.stringify(result.code.toString())};`, map: null };
    },
  };
}
