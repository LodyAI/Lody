import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postcss from 'postcss';
import { TraceMap, originalPositionFor } from '@jridgewell/trace-mapping';
import { describe, expect, it } from 'vitest';
import { compileLegacyDeclarations, replaceLegacyDeclarations } from '../vite-legacy-declarations';
import { legacyBindings, legacyDeclarations } from '../src/style/legacy-declaration-profile';
import * as actualBindings from '../src/style/legacy-defaults.stylex';
import { cn } from '../src/lib/utils';
import { compile } from 'tailwindcss';

const filename = fileURLToPath(new URL('../src/style/legacy-defaults.stylex.ts', import.meta.url));
const raw = readFileSync(filename, 'utf8');
const originalCSS = async () =>
  (await compile('@layer utilities { @tailwind utilities; } @theme { --spacing: .25rem; }')).build(
    legacyDeclarations.map((s) => s.alias)
  );

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
  });

  it('replaces actual Tailwind declarations with actual metadata in the same slots', async () => {
    const css = await originalCSS();
    const compiled = compileLegacyDeclarations(raw, filename);
    const result = replaceLegacyDeclarations(css, 'owned.css', compiled);
    let owned = 0;
    result.root.walkDecls((d) => {
      if (d.source?.input.file === filename) owned++;
    });
    expect(owned).toBe(8);
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
        const offset = raw.indexOf(spec.js + ':');
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
    const recovered = replaceLegacyDeclarations(
      css,
      'owned.css',
      compileLegacyDeclarations(raw, filename)
    );
    let owned = 0;
    recovered.root.walkDecls((d) => {
      if (d.source?.input.file === filename) owned++;
    });
    expect(owned).toBe(8);
  });

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
