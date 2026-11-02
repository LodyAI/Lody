import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { describe, expect, it, vi } from 'vitest';
import { compileLegacyDeclarations, replaceLegacyDeclarations } from '../vite-legacy-declarations';
import { legacyBindings, legacyDeclarations } from '../src/style/legacy-declaration-profile';
import * as actualBindings from '../src/style/legacy-defaults.stylex';
import { cn } from '../src/lib/utils';
import { compile } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';
import preset from '@lody/configs/tailwind-preset';

const filename = fileURLToPath(new URL('../src/style/legacy-defaults.stylex.ts', import.meta.url));
const raw = readFileSync(filename, 'utf8');
const originalCSS = async (candidates = legacyDeclarations.map((s) => s.alias)) => {
  // Use configured values through Tailwind's CSS theme API; @config also installs unrelated width utilities.
  const maximum = defaultTheme.maxWidth({ theme: () => ({}), colors: defaultTheme.colors }).xs;
  const radius = preset.theme.extend.borderRadius.lg;
  const mediumRadius = preset.theme.extend.borderRadius.md;
  const muted = preset.theme.extend.colors.muted.DEFAULT.replace('<alpha-value>', '1');
  const theme = `@theme inline { --container-xs: ${maximum}; --radius-lg: ${radius}; --radius-md: ${mediumRadius}; --color-muted: ${muted}; }`;
  return (
    await compile('@layer utilities { @tailwind utilities; } @theme { --spacing: .25rem; }' + theme)
  ).build(candidates);
};

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
    expect(owned).toBe(legacyDeclarations.length);
    const map = new TraceMap(result.map!.toJSON(), pathToFileURL(path.resolve('owned.css')).href);
    const generated = postcss.parse(result.css);
    for (const spec of legacyDeclarations) {
      const selector = '.' + spec.alias.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
      generated.walkRules(selector, (rule) => {
        const declaration = rule.first!;
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
    expect(owned).toBe(legacyDeclarations.length);
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
