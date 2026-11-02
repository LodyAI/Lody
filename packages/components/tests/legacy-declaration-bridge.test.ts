import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import tailwindPostcss from '@tailwindcss/postcss';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import { optimize } from '@tailwindcss/node';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { describe, expect, it, vi } from 'vitest';
import {
  compileLegacyDeclarations,
  replaceLegacyDeclarations,
  legacyDeclarationBridge as configuredDeclarationBridge,
  type LegacyPostcssOptions,
} from '../vite-legacy-declarations';
import { legacyBindings, legacyDeclarations } from '../src/style/legacy-declaration-profile';
import * as actualBindings from '../src/style/legacy-defaults.stylex';
import { cn } from '../src/lib/utils';
import { compile } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';
import preset from '@lody/configs/tailwind-preset';

const filename = fileURLToPath(new URL('../src/style/legacy-defaults.stylex.ts', import.meta.url));
const raw = readFileSync(filename, 'utf8');
const originalSource = () => {
  // Use configured values through Tailwind's CSS theme API; @config also installs unrelated width utilities.
  const maximum = defaultTheme.maxWidth({ theme: () => ({}), colors: defaultTheme.colors }).xs;
  const radius = preset.theme.extend.borderRadius.lg;
  const mediumRadius = preset.theme.extend.borderRadius.md;
  const colors = preset.theme.extend.colors;
  const opaque = (color: string) => color.replace('<alpha-value>', '1');
  const theme = `@theme inline {
    --container-xs: ${maximum};
    --container-2xl: ${defaultTheme.maxWidth({ theme: () => ({}), colors: defaultTheme.colors })['2xl']};
    --radius-lg: ${radius};
    --radius-md: ${mediumRadius};
    --color-muted: ${opaque(colors.muted.DEFAULT)};
    --color-sidebar: ${opaque(colors.sidebar.DEFAULT)};
    --color-background: ${opaque(colors.background)};
    --color-input-field: ${opaque(colors.input.field)};
    --color-input-foreground: ${opaque(colors.input.foreground)};
    --color-muted-foreground: ${opaque(colors.muted.foreground)};
    --color-sidebar-foreground: ${opaque(colors.sidebar.foreground)};
    --color-sidebar-border: ${opaque(colors.sidebar.border)};
  }`;
  return (
    '@layer utilities { @tailwind utilities; } @theme { --spacing: .25rem; --radius-2xl: 1rem; --radius-xl: .75rem; --font-weight-medium: 500; }' +
    theme
  );
};
const originalCSS = async (candidates = legacyDeclarations.map((s) => s.alias)) =>
  (await compile(originalSource())).build(candidates);

describe('closed legacy declaration bridge', () => {
  it('folds real bindings without changing cn public class identity', () => {
    for (const [name, keys] of Object.entries(legacyBindings)) {
      expect(actualBindings[name as keyof typeof actualBindings]).toBe(
        keys.map((key) => legacyDeclarations.find((d) => d.key === key)!.alias).join(' ')
      );
    }
    expect(cn(actualBindings.pickerSpinnerClass, 'opacity-50')).toBe('opacity-50');
    expect(cn(actualBindings.tabStripClass, 'w-0')).toBe('flex items-center w-0');
    expect(cn(actualBindings.tabStripClass, '[width:0px]')).toBe(
      'flex w-full items-center [width:0px]'
    );
    expect(cn(actualBindings.sidebarStackLayoutClass, 'gap-4 p-0')).toBe('flex flex-col gap-4 p-0');
    expect(cn(actualBindings.windowFixedClass, 'absolute')).toBe('absolute');
    expect(cn(actualBindings.windowStripInsetsClass, 'inset-x-4 z-30')).toBe(
      'top-0 inset-x-4 z-30'
    );
    expect(cn(actualBindings.sidebarDockFrameClass, 'relative w-9')).toBe(
      'inset-y-0 z-10 hidden relative w-9'
    );
    expect(cn(actualBindings.sidebarRailGeometryClass, 'relative z-0')).toBe(
      'inset-y-0 hidden w-4 relative z-0'
    );
    expect(cn(actualBindings.mentionInputFlowClass, 'w-56')).toBe('flex w-56');
    expect(cn(actualBindings.mentionLabelBlockClass, 'py-2')).toBe('py-2');
    // This cn-only input must not add a production CSS candidate through test scanning.
    const minHeightCaller = `[${['min-height', '60px'].join(':')}]`;
    expect(cn(actualBindings.sidebarContentLayoutClass, minHeightCaller)).toBe(
      `flex min-h-0 flex-1 flex-col gap-2 ${minHeightCaller}`
    );
  });

  it('replaces actual Tailwind declarations with actual metadata in the same slots', async () => {
    const css = await originalCSS();
    const compiled = compileLegacyDeclarations(raw, filename);
    const result = replaceLegacyDeclarations(css, 'owned.css', compiled);
    let owned = 0;
    result.root.walkDecls((d) => {
      if (d.source?.input.file === filename) owned++;
    });
    expect(owned).toBe(
      legacyDeclarations.reduce((count, spec) => count + ('writer' in spec ? 2 : 1), 0)
    );
    const map = new TraceMap(result.map!.toJSON(), pathToFileURL(path.resolve('owned.css')).href);
    const generated = postcss.parse(result.css);
    for (const spec of legacyDeclarations) {
      const selector = '.' + spec.alias.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      generated.walkRules(selector, (rule) => {
        const declaration = rule.nodes.find(
          (node) => node.type === 'decl' && node.prop === spec.css
        )!;
        const actual = originalPositionFor(map, {
          line: declaration.source!.start!.line,
          column: declaration.source!.start!.column - 1,
        });
        const styleOffset = raw.indexOf(spec.key + ':');
        const objectOffset = raw.indexOf('{', styleOffset);
        const offset = raw.indexOf(spec.js + ':', objectOffset);
        const prefix = raw.slice(0, offset),
          lines = prefix.split('\n');
        expect(fileURLToPath(actual.source!)).toBe(filename);
        expect(actual.line).toBe(lines.length);
        expect(actual.column).toBe(lines.at(-1)!.length);
      });
    }
  });

  it('preserves both locked container slots and rejects a third or unequal duplicate', async () => {
    const parsed = postcss.parse(await originalCSS());
    const slots: postcss.Rule[] = [];
    parsed.walkRules('.\\@container', (rule) => {
      slots.push(rule);
    });
    expect(slots).toHaveLength(1);
    slots[0].after(slots[0].clone());
    const input = parsed.toString();
    const result = replaceLegacyDeclarations(
      input,
      'owned.css',
      compileLegacyDeclarations(raw, filename)
    );
    const projected = (css: string) => {
      const rules: unknown[] = [];
      postcss.parse(css).walkRules((rule) => {
        rules.push({
          selector: rule.selector,
          declarations:
            rule.selector === '.\\@container' ? rule.nodes.map((n) => n.toString()) : undefined,
        });
      });
      return rules;
    };
    expect(projected(result.css)).toEqual(projected(input));
    const replaced: postcss.Rule[] = [];
    result.root.walkRules('.\\@container', (rule) => {
      replaced.push(rule);
    });
    expect(replaced).toHaveLength(2);
    expect(replaced.every((r) => r.first?.source?.input.file === filename)).toBe(true);
    slots[0].after(slots[0].clone());
    expect(() =>
      replaceLegacyDeclarations(
        parsed.toString(),
        'owned.css',
        compileLegacyDeclarations(raw, filename)
      )
    ).toThrow();
    const unequal = postcss.parse(input);
    const copies: postcss.Rule[] = [];
    unequal.walkRules('.\\@container', (rule) => {
      copies.push(rule);
    });
    (copies[1].first as postcss.Declaration).value = 'normal';
    expect(() =>
      replaceLegacyDeclarations(
        unequal.toString(),
        'owned.css',
        compileLegacyDeclarations(raw, filename)
      )
    ).toThrow();
  });

  it.each([
    ['runtime value', raw.replace('opacity: 0.7', 'opacity: Math.random()')],
    [
      'conditional declaration',
      raw.replace('opacity: 0.7', "opacity: { default: 0.7, ':hover': 0.6 }"),
    ],
    ['namespace escape', raw + '\nexport const escaped = stylex;\n'],
    [
      'mixed class API',
      raw.replace(
        'stylex.props(styles.dimmed).className',
        "stylex.props(styles.dimmed).className + 'opacity-50'"
      ),
    ],
    [
      'unapproved namespace alias',
      raw
        .replace('import * as stylex from', 'import * as sx from')
        .replaceAll('stylex.create', 'sx.create')
        .replaceAll('stylex.props', 'sx.props'),
    ],
  ])('rejects %s before producing compatibility bindings', (_name, source) => {
    expect(() => compileLegacyDeclarations(source, filename)).toThrow();
  });

  it.each([
    ['missing', (rule: postcss.Rule) => rule.remove()],
    ['duplicate', (rule: postcss.Rule) => rule.after(rule.clone())],
    [
      'context',
      (rule: postcss.Rule) => {
        (rule.parent as postcss.AtRule).params = 'components';
      },
    ],
    [
      'property',
      (rule: postcss.Rule) => {
        (rule.first as postcss.Declaration).prop = 'width';
      },
    ],
    [
      'value',
      (rule: postcss.Rule) => {
        (rule.first as postcss.Declaration).value = '.6';
      },
    ],
    [
      'important',
      (rule: postcss.Rule) => {
        (rule.first as postcss.Declaration).important = true;
      },
    ],
    ['second body', (rule: postcss.Rule) => rule.append({ prop: 'opacity', value: '.7' })],
  ])(
    'rejects an unexpected %s slot without publishing a partial replacement',
    async (_name, change) => {
      const css = await originalCSS();
      const changed = postcss.parse(css);
      const slots: postcss.Rule[] = [];
      changed.walkRules('.opacity-70', (rule) => {
        slots.push(rule);
      });
      expect(slots).toHaveLength(1);
      change(slots[0]);
      const input = changed.toString();
      expect(() =>
        replaceLegacyDeclarations(input, 'owned.css', compileLegacyDeclarations(raw, filename))
      ).toThrow();
      expect(changed.toString()).toBe(input);
    }
  );

  it('rejects literal-zero substitution and recovers after unequal metadata is corrected', async () => {
    const css = await originalCSS();
    const unequal = compileLegacyDeclarations(
      raw.replace('opacity: 0.7', 'opacity: 0.6'),
      filename
    );
    expect(() => replaceLegacyDeclarations(css, 'owned.css', unequal)).toThrow();
    const literalZero = compileLegacyDeclarations(
      raw.replace("'calc(var(--spacing) * 0)'", '0'),
      filename
    );
    expect(() => replaceLegacyDeclarations(css, 'owned.css', literalZero)).toThrow();
    const literalHeightZero = compileLegacyDeclarations(
      raw.replace(
        "minimumHeight: { minHeight: 'calc(var(--spacing) * 0)' }",
        'minimumHeight: { minHeight: 0 }'
      ),
      filename
    );
    expect(() => replaceLegacyDeclarations(css, 'owned.css', literalHeightZero)).toThrow();
    const recovered = replaceLegacyDeclarations(
      css,
      'owned.css',
      compileLegacyDeclarations(raw, filename)
    );
    let owned = 0;
    recovered.root.walkDecls((d) => {
      if (d.source?.input.file === filename) owned++;
    });
    expect(owned).toBe(
      legacyDeclarations.reduce((count, spec) => count + ('writer' in spec ? 2 : 1), 0)
    );
  });

  it.each([
    ['h-10', 'height', '40px'],
    ['max-w-xs', 'max-width', 'var(--container-xs, 20rem)'],
    ['rounded-lg', 'border-radius', 'var(--radius-lg, 0px)'],
    ['bg-muted', 'background-color', 'hsl(var(--muted))'],
  ] as const)(
    'keeps the %s extension closed to its exact original slot',
    async (alias, property, unequalValue) => {
      const css = await originalCSS();
      const compiled = compileLegacyDeclarations(raw, filename);
      replaceLegacyDeclarations(css, 'owned.css', compiled);
      const selector = '.' + alias;
      for (const mutation of [
        'missing',
        'duplicate',
        'context',
        'property',
        'value',
        'important',
        'second body',
      ]) {
        const ast = postcss.parse(css);
        const slots: postcss.Rule[] = [];
        ast.walkRules(selector, (rule) => {
          slots.push(rule);
        });
        expect(slots).toHaveLength(1);
        const slot = slots[0];
        const declaration = slot.first as postcss.Declaration;
        expect(declaration.prop).toBe(property);
        if (mutation === 'missing') slot.remove();
        if (mutation === 'duplicate') slot.after(slot.clone());
        if (mutation === 'context') (slot.parent as postcss.AtRule).params = 'components';
        if (mutation === 'property') declaration.prop = 'outline-color';
        if (mutation === 'value') declaration.value = unequalValue;
        if (mutation === 'important') declaration.important = true;
        if (mutation === 'second body') slot.append({ prop: 'opacity', value: '.7' });
        const input = ast.toString();
        expect(() => replaceLegacyDeclarations(input, 'owned.css', compiled)).toThrow();
        expect(ast.toString()).toBe(input);
      }
    }
  );
  it('leaves unrelated rules, layers and declarations in their original order', async () => {
    const ordinary = '@layer stylex.priority4{.ordinary-caller{opacity:.4}}';
    const css = ordinary + (await originalCSS());
    const output = replaceLegacyDeclarations(
      css,
      'owned.css',
      compileLegacyDeclarations(raw, filename)
    );
    expect(output.root.first!.toString()).toBe(ordinary);
    expect(postcss.parse(css).nodes.map((n) => (n.type === 'atrule' ? n.params : n.type))).toEqual(
      output.root.nodes.map((n) => (n.type === 'atrule' ? n.params : n.type))
    );
  });
});

const duplicateSpecs = [
  { key: 'heightTen', alias: 'h-10', js: 'height', css: 'height' },
  { key: 'heightFull', alias: 'h-full', js: 'height', css: 'height' },
  { key: 'cornerMedium', alias: 'rounded-md', js: 'borderRadius', css: 'border-radius' },
  { key: 'cornerLarge', alias: 'rounded-lg', js: 'borderRadius', css: 'border-radius' },
];
const duplicateBindings: Record<string, string[]> = {
  shortClass: ['heightTen'],
  fullClass: ['heightFull'],
  mediumClass: ['cornerMedium'],
  largeClass: ['cornerLarge'],
  mixedClass: ['heightFull', 'cornerMedium'],
};
function duplicateSource(bindings = duplicateBindings) {
  return `import * as stylex from '@stylexjs/stylex';
function legacyClass(_classes: string | undefined): string { throw new Error('fixture'); }
const styles = stylex.create({
  heightTen: { height: 'calc(var(--spacing) * 10)' },
  heightFull: { height: '100%' },
  cornerMedium: { borderRadius: 'var(--radius-md)' },
  cornerLarge: { borderRadius: 'var(--radius-lg)' },
});
${Object.entries(bindings)
  .map(
    ([name, keys]) =>
      `export const ${name} = legacyClass(stylex.props(${keys.map((key) => 'styles.' + key).join(', ')}).className);`
  )
  .join('\n')}
`;
}
async function withKeyProfile(
  run: (api: typeof import('../vite-legacy-declarations')) => void | Promise<void>,
  specs = duplicateSpecs,
  bindings = duplicateBindings
) {
  vi.resetModules();
  vi.doMock('../src/style/legacy-declaration-profile', () => ({
    legacyDeclarations: specs,
    legacyBindings: bindings,
  }));
  try {
    await run(await import('../vite-legacy-declarations'));
  } finally {
    vi.doUnmock('../src/style/legacy-declaration-profile');
    vi.resetModules();
  }
}
describe('style keys with distinct values of the same property', () => {
  it('preserves exact aliases, slots and per-key source authors without leaking probes', async () => {
    await withKeyProfile(
      async ({ compileLegacyDeclarations: compileKeys, replaceLegacyDeclarations: replace }) => {
        const source = duplicateSource();
        const css = await originalCSS(duplicateSpecs.map((spec) => spec.alias));
        const compiled = compileKeys(source, filename);
        const result = replace(css, 'owned.css', compiled);
        expect(result.css).toBe(css);
        expect(compiled.code).toContain('"h-10"');
        expect(compiled.code).toContain('"h-full"');
        expect(compiled.code).not.toContain('__lodyLegacyKeyProbe_');
        expect(compiled.map.sourcesContent).toEqual([source]);
        const trace = new TraceMap(
          result.map!.toJSON(),
          pathToFileURL(path.resolve('owned.css')).href
        );
        const generated = postcss.parse(result.css);
        for (const spec of duplicateSpecs) {
          generated.walkRules('.' + spec.alias, (rule) => {
            const declaration = rule.first!;
            const actual = originalPositionFor(trace, {
              line: declaration.source!.start!.line,
              column: declaration.source!.start!.column - 1,
            });
            const keyOffset = source.indexOf(spec.key + ':');
            const propertyOffset = source.indexOf(spec.js + ':', keyOffset);
            const lines = source.slice(0, propertyOffset).split('\n');
            expect(actual.line).toBe(lines.length);
            expect(actual.column).toBe(lines.at(-1)!.length);
            expect(fileURLToPath(actual.source!)).toBe(filename);
          });
        }
      }
    );
  });
  it.each(['height', 'radius'])(
    'rejects swapping %s values despite an unchanged property/value set',
    async (kind) => {
      await withKeyProfile(
        async ({ compileLegacyDeclarations: compileKeys, replaceLegacyDeclarations: replace }) => {
          const source = duplicateSource();
          const css = await originalCSS(duplicateSpecs.map((spec) => spec.alias));
          const original = compileKeys(source, filename);
          replace(css, 'owned.css', original);
          const swapped =
            kind === 'height'
              ? source
                  .replace(
                    "heightTen: { height: 'calc(var(--spacing) * 10)' }",
                    "heightTen: { height: '100%' }"
                  )
                  .replace(
                    "heightFull: { height: '100%' }",
                    "heightFull: { height: 'calc(var(--spacing) * 10)' }"
                  )
              : source
                  .replace(
                    "cornerMedium: { borderRadius: 'var(--radius-md)' }",
                    "cornerMedium: { borderRadius: 'var(--radius-lg)' }"
                  )
                  .replace(
                    "cornerLarge: { borderRadius: 'var(--radius-lg)' }",
                    "cornerLarge: { borderRadius: 'var(--radius-md)' }"
                  );
          const changed = compileKeys(swapped, filename);
          const values = (value: typeof changed) =>
            value.declarations
              .map((entry) => entry.declaration.prop + ':' + entry.declaration.value)
              .sort();
          expect(values(changed)).toEqual(values(original));
          expect(() => replace(css, 'owned.css', changed)).toThrow(
            'Unequal compatibility declaration'
          );
        }
      );
    }
  );
  it('rejects overlapping properties inside a single approved binding', async () => {
    const bindings = { ...duplicateBindings, mixedClass: ['heightTen', 'heightFull'] };
    await withKeyProfile(
      ({ compileLegacyDeclarations: compileKeys }) => {
        expect(() => compileKeys(duplicateSource(bindings), filename)).toThrow(
          'Overlapping CSS properties'
        );
      },
      duplicateSpecs,
      bindings
    );
  });
  it('rejects atom deduplication between distinct source keys', async () => {
    await withKeyProfile(({ compileLegacyDeclarations: compileKeys }) => {
      const source = duplicateSource().replace(
        "heightFull: { height: '100%' }",
        "heightFull: { height: 'calc(var(--spacing) * 10)' }"
      );
      expect(() => compileKeys(source, filename)).toThrow();
    });
  });
  it('rejects metadata whose physical property disagrees with its key', async () => {
    const specs = duplicateSpecs.map((spec) =>
      spec.key === 'heightFull' ? { ...spec, css: 'width' } : spec
    );
    await withKeyProfile(({ compileLegacyDeclarations: compileKeys }) => {
      expect(() => compileKeys(duplicateSource(), filename)).toThrow('Unexpected property for key');
    }, specs);
  });
  it('rejects original exports that collide with generated key probes', async () => {
    const { shortClass: _short, ...rest } = duplicateBindings;
    const bindings = { __lodyLegacyKeyProbe_0: ['heightTen'], ...rest };
    await withKeyProfile(
      ({ compileLegacyDeclarations: compileKeys }) => {
        expect(() => compileKeys(duplicateSource(bindings), filename)).toThrow(
          'Reserved key-probe name'
        );
      },
      duplicateSpecs,
      bindings
    );
  });
});

const optimizedSpecs = [
  { key: 'shrinking', alias: 'shrink', js: 'flexShrink', css: ['flex', 'shrink'].join('-') },
  { key: 'fullCorner', alias: 'rounded-full', js: 'borderRadius', css: 'border-radius' },
  { key: 'transparent', alias: 'bg-transparent', js: 'backgroundColor', css: 'background-color' },
];
const optimizedBindings = {
  shrinkClass: ['shrinking'],
  cornerClass: ['fullCorner'],
  transparentClass: ['transparent'],
};
const optimizedSource = `import * as stylex from '@stylexjs/stylex';
function legacyClass(_classes: string | undefined): string { throw new Error('fixture'); }
const styles = stylex.create({
  shrinking: { flexShrink: 1 },
  fullCorner: { borderRadius: 'calc(infinity * 1px)' },
  transparent: { backgroundColor: 'transparent' },
});
export const shrinkClass = legacyClass(stylex.props(styles.shrinking).className);
export const cornerClass = legacyClass(stylex.props(styles.fullCorner).className);
export const transparentClass = legacyClass(stylex.props(styles.transparent).className);
`;
describe('same-phase native declaration optimization', () => {
  it.each([false, { minify: false }, { minify: true }] as const)(
    'keeps the full original stylesheet and author maps with phase %j',
    async (phase) => {
      await withKeyProfile(
        async (api) => {
          const aliases = [...optimizedSpecs.map((spec) => spec.alias), optimizedSpecs[0].css];
          const rawCSS = await originalCSS(aliases);
          const css = phase ? optimize(rawCSS, phase).code : rawCSS;
          const compiled = api.compileLegacyDeclarations(optimizedSource, filename);
          const result = api.replaceLegacyDeclarations(
            css,
            'owned.css',
            compiled,
            undefined,
            phase
          );
          expect(result.css).toBe(css);
          const owned: postcss.Declaration[] = [];
          result.root.walkDecls((decl) => {
            if (decl.source?.input.file === filename) owned.push(decl);
          });
          expect(owned).toHaveLength(3);
          const map = new TraceMap(
            result.map!.toJSON(),
            pathToFileURL(path.resolve('owned.css')).href
          );
          const generated = postcss.parse(result.css);
          for (const spec of optimizedSpecs) {
            generated.walkRules((rule) => {
              if (!postcss.list.comma(rule.selector).includes('.' + spec.alias)) return;
              const decl = rule.first!;
              const location = originalPositionFor(map, {
                line: decl.source!.start!.line,
                column: decl.source!.start!.column - 1,
              });
              const offset = optimizedSource.indexOf(
                spec.js + ':',
                optimizedSource.indexOf(spec.key + ':')
              );
              const lines = optimizedSource.slice(0, offset).split('\n');
              expect(location.line).toBe(lines.length);
              expect(location.column).toBe(lines.at(-1)!.length);
              expect(fileURLToPath(location.source!)).toBe(filename);
            });
          }
          for (const [from, to] of [
            ['flexShrink: 1', 'flexShrink: 0'],
            ["'calc(infinity * 1px)'", "'111px'"],
            ["backgroundColor: 'transparent'", "backgroundColor: 'red'"],
          ]) {
            const invalid = api.compileLegacyDeclarations(
              optimizedSource.replace(from, to),
              filename
            );
            expect(() =>
              api.replaceLegacyDeclarations(css, 'owned.css', invalid, undefined, phase)
            ).toThrow('Unequal compatibility declaration');
          }
        },
        optimizedSpecs,
        optimizedBindings
      );
    }
  );
  it('rejects complex, repeated, ambiguous and multiply claimed selector slots', async () => {
    await withKeyProfile(
      async (api) => {
        const rawCSS = await originalCSS([
          ...optimizedSpecs.map((spec) => spec.alias),
          optimizedSpecs[0].css,
        ]);
        const css = optimize(rawCSS, { minify: true }).code;
        const compiled = api.compileLegacyDeclarations(optimizedSource, filename);
        for (const selector of ['.shrink, .other:hover', '.shrink,.shrink']) {
          const ast = postcss.parse(css);
          ast.walkRules((rule) => {
            if (postcss.list.comma(rule.selector).includes('.shrink')) rule.selector = selector;
          });
          expect(() =>
            api.replaceLegacyDeclarations(ast.toString(), 'owned.css', compiled, undefined, {
              minify: true,
            })
          ).toThrow();
        }
        const duplicate = postcss.parse(css);
        duplicate.walkRules((rule) => {
          if (postcss.list.comma(rule.selector).includes('.shrink')) {
            rule.after(rule.clone({ selector: '.shrink' }));
            return false;
          }
          return undefined;
        });
        expect(() =>
          api.replaceLegacyDeclarations(duplicate.toString(), 'owned.css', compiled, undefined, {
            minify: true,
          })
        ).toThrow('Missing or ambiguous compatibility slot');
        const shared = {
          ...compiled,
          declarations: [
            ...compiled.declarations,
            { ...compiled.declarations[0], alias: optimizedSpecs[0].css },
          ],
        };
        expect(() =>
          api.replaceLegacyDeclarations(css, 'owned.css', shared, undefined, { minify: true })
        ).toThrow('Ambiguous shared compatibility declaration');
      },
      optimizedSpecs,
      optimizedBindings
    );
  });
});

describe('explicit Tailwind pipeline options', () => {
  it.each([
    { command: 'serve', tailwindOptions: {}, cssMinify: true, phase: false },
    { command: 'build', tailwindOptions: {}, cssMinify: true, phase: { minify: true } },
    { command: 'build', tailwindOptions: {}, cssMinify: false, phase: { minify: false } },
    { command: 'build', tailwindOptions: { optimize: false }, cssMinify: true, phase: false },
    {
      command: 'build',
      tailwindOptions: { optimize: { minify: false } },
      cssMinify: true,
      phase: { minify: false },
    },
  ] as const)(
    'validates the actual CSS hook for %j',
    async ({ command, tailwindOptions, cssMinify, phase }) => {
      const { legacyDeclarationBridge } = await import('../vite-legacy-declarations');
      const plugin = legacyDeclarationBridge({ tailwindOptions })[1];
      const configHook = plugin.configResolved!;
      const configure = typeof configHook === 'function' ? configHook : configHook.handler;
      Reflect.apply(configure, {}, [{ command, build: { cssMinify } }]);
      const rawCSS = await originalCSS();
      const css = phase ? optimize(rawCSS, phase).code : rawCSS;
      const transformHook = plugin.transform!;
      const transform = typeof transformHook === 'function' ? transformHook : transformHook.handler;
      const result = Reflect.apply(
        transform,
        {
          addWatchFile() {},
          getCombinedSourcemap() {
            return undefined;
          },
        },
        [css, fileURLToPath(new URL('../src/tailwind/index.css', import.meta.url))]
      );
      const expected = postcss.parse(css);
      if (!phase)
        expected.walkRules('.opacity-70', (rule) => {
          (rule.first as postcss.Declaration).value = '.7';
        });
      expect(result.code.split('\n/*# sourceMappingURL=')[0]).toBe(expected.toString());
      expect(result.map.sourcesContent).toContain(raw);
    }
  );
});

describe('explicit configured PostCSS phase', () => {
  it.each([
    { name: 'production default', environment: 'production', command: 'build', setting: undefined },
    {
      name: 'development default',
      environment: 'development',
      command: 'serve',
      setting: undefined,
    },
    { name: 'explicit false', environment: 'production', command: 'build', setting: false },
    { name: 'object default', environment: 'production', command: 'build', setting: {} },
    {
      name: 'object false',
      environment: 'production',
      command: 'build',
      setting: { minify: false },
    },
    { name: 'object true', environment: 'production', command: 'build', setting: { minify: true } },
    {
      name: 'explicit true during serve',
      environment: 'production',
      command: 'serve',
      setting: true,
    },
  ] as const)(
    '$name uses the real producer and bridge with the same options',
    async ({ environment, command, setting }) => {
      const require = createRequire(import.meta.url);
      const configFile = fileURLToPath(new URL('../postcss.config.cjs', import.meta.url));
      const cached = require.cache[configFile];
      let producer: LegacyPostcssOptions;
      vi.stubEnv('NODE_ENV', environment);
      try {
        delete require.cache[configFile];
        const config = require(configFile) as {
          plugins: { '@tailwindcss/postcss': LegacyPostcssOptions };
        };
        producer = config.plugins['@tailwindcss/postcss'];
        expect(producer.optimize).toBe(environment === 'production');
        if (setting !== undefined) producer.optimize = setting;
      } finally {
        delete require.cache[configFile];
        if (cached) require.cache[configFile] = cached;
        vi.unstubAllEnvs();
      }
      const cssFile = fileURLToPath(new URL('../src/tailwind/index.css', import.meta.url));
      const boundedSource =
        originalSource().replace('@tailwind utilities;', '@tailwind utilities source(none);') +
        `\n@source inline(${JSON.stringify(legacyDeclarations.map((entry) => entry.alias).join(' '))});`;
      const actual = await postcss([tailwindPostcss(producer)]).process(boundedSource, {
        from: cssFile,
        map: false,
      });
      expect(actual.messages.some((message) => message.type === 'dir-dependency')).toBe(false);
      const bridge = configuredDeclarationBridge({ postcssOptions: producer })[1];
      const configHook = bridge.configResolved!;
      Reflect.apply(typeof configHook === 'function' ? configHook : configHook.handler, {}, [
        { command, build: { cssMinify: false } },
      ]);
      const transformHook = bridge.transform!;
      const result = Reflect.apply(
        typeof transformHook === 'function' ? transformHook : transformHook.handler,
        {
          addWatchFile() {},
          getCombinedSourcemap() {
            return undefined;
          },
        },
        [actual.css, cssFile]
      );
      const expected = postcss.parse(actual.css);
      if (producer.optimize === false)
        expected.walkRules('.opacity-70', (rule) => {
          (rule.first as postcss.Declaration).value = '.7';
        });
      expect(result.code.split('\n/*# sourceMappingURL=')[0]).toBe(expected.toString());
      expect(result.map.sourcesContent).toContain(raw);
    }
  );
  it('rejects an implicit PostCSS phase or two different producers', () => {
    expect(() =>
      configuredDeclarationBridge({ postcssOptions: {} as LegacyPostcssOptions })
    ).toThrow('PostCSS phase must be explicit');
    expect(() =>
      configuredDeclarationBridge({ tailwindOptions: {}, postcssOptions: { optimize: false } })
    ).toThrow('Choose one stylesheet producer');
  });
});

const fontPairSpecs = [
  {
    key: 'mediumWeight',
    alias: 'font-medium',
    js: 'fontWeight',
    css: 'font-weight',
    writer: '--tw-font-weight',
  },
];
const fontPairBindings = { mediumClass: ['mediumWeight'] };
const fontPairSource = `import * as stylex from '@stylexjs/stylex';
function legacyClass(_classes: string | undefined): string { throw new Error('fixture'); }
const styles = stylex.create({ mediumWeight: {
  '--tw-font-weight': 'var(--font-weight-medium)',
  fontWeight: 'var(--font-weight-medium)',
} });
export const mediumClass = legacyClass(stylex.props(styles.mediumWeight).className);
`;
describe('closed font-medium writer pair', () => {
  it.each([false, { minify: false }, { minify: true }] as const)(
    'preserves the actual font rule, registration and both author maps in phase %j',
    async (phase) => {
      await withKeyProfile(
        async (api) => {
          const rawCSS = await originalCSS(['font-medium']);
          const css = phase ? optimize(rawCSS, phase).code : rawCSS;
          const compiled = api.compileLegacyDeclarations(fontPairSource, filename);
          expect(
            compiled.declarations.map(({ declaration }) => [declaration.prop, declaration.value])
          ).toEqual([
            ['--tw-font-weight', 'var(--font-weight-medium)'],
            ['font-weight', 'var(--font-weight-medium)'],
          ]);
          expect(compiled.code).toBe('export const mediumClass = "font-medium";');
          const result = api.replaceLegacyDeclarations(
            css,
            'owned.css',
            compiled,
            undefined,
            phase
          );
          expect(result.css).toBe(css);
          const trace = new TraceMap(
            result.map!.toJSON(),
            pathToFileURL(path.resolve('owned.css')).href
          );
          const generated = postcss.parse(result.css);
          generated.walkRules('.font-medium', (rule) => {
            for (const [i, node] of rule.nodes.entries()) {
              const position = originalPositionFor(trace, {
                line: node.source!.start!.line,
                column: node.source!.start!.column - 1,
              });
              const authored = i === 0 ? "'--tw-font-weight':" : 'fontWeight:';
              const lines = fontPairSource.slice(0, fontPairSource.indexOf(authored)).split('\n');
              expect(fileURLToPath(position.source!)).toBe(filename);
              expect([position.line, position.column]).toEqual([
                lines.length,
                lines.at(-1)!.length,
              ]);
            }
          });
        },
        fontPairSpecs,
        fontPairBindings
      );
    }
  );
  it.each([
    ['writer omitted', "  '--tw-font-weight': 'var(--font-weight-medium)',\n", ''],
    [
      'different reader',
      "fontWeight: 'var(--font-weight-medium)'",
      "fontWeight: 'var(--tw-font-weight)'",
    ],
    [
      'different writer',
      "'--tw-font-weight': 'var(--font-weight-medium)'",
      "'--tw-font-weight': '700'",
    ],
    [
      'extra property',
      "fontWeight: 'var(--font-weight-medium)'",
      "fontWeight: 'var(--font-weight-medium)', color: 'red'",
    ],
  ])('rejects authored pair with %s', async (_name, before, after) => {
    await withKeyProfile(
      (api) => {
        expect(() =>
          api.compileLegacyDeclarations(fontPairSource.replace(before, after), filename)
        ).toThrow();
      },
      fontPairSpecs,
      fontPairBindings
    );
  });
  it.each(['missing writer', 'reversed pair', 'duplicate writer', 'important writer'])(
    'rejects unequal original %s without changing the input',
    async (change) => {
      await withKeyProfile(
        async (api) => {
          const css = postcss.parse(await originalCSS(['font-medium']));
          css.walkRules('.font-medium', (rule) => {
            if (change === 'missing writer') rule.first!.remove();
            if (change === 'reversed pair') rule.prepend(rule.last!);
            if (change === 'duplicate writer') rule.append(rule.first!.clone());
            if (change === 'important writer') (rule.first as postcss.Declaration).important = true;
          });
          const input = css.toString();
          expect(() =>
            api.replaceLegacyDeclarations(
              input,
              'owned.css',
              api.compileLegacyDeclarations(fontPairSource, filename)
            )
          ).toThrow();
          expect(css.toString()).toBe(input);
        },
        fontPairSpecs,
        fontPairBindings
      );
    }
  );
});
