import * as stylex from '@stylexjs/stylex';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, test } from 'vitest';
import { Button } from '../src/button/button';
import { Kbd, KbdGroup } from '../src/kbd/kbd';
import { kbd, kbdOnInvertedTheme, kbdPaletteTheme } from '../src/kbd/kbd.tokens.stylex';
import { forcedThemeClassNames } from '../src/theme/theme';
import { Tooltip } from '../src/tooltip/tooltip';
import { all, classesOf, mount, one, type Mounted } from './dom';

/** See `menu.test.tsx`: the same loosened call the primitives make. */
function classesFor(...styles: readonly unknown[]): string[] {
  const props = stylex.props as (...args: readonly unknown[]) => { className?: string };
  return (props(...styles).className ?? '').split(' ').filter(Boolean);
}

/** The compiled classes of a bare cap, read off the primitive rather than restated. */
function capClasses(): string[] {
  const html = renderToStaticMarkup(<Kbd>K</Kbd>);
  return (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ').filter(Boolean);
}

let mounted: Mounted | undefined;
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

describe('Kbd', () => {
  test('a cap is a picture of a key, not a control', () => {
    // It reports no role, takes no focus and answers no pointer. A surface that
    // wants a pressable key wants a Button; the deleted implementation said the
    // same thing with `pointer-events-none`, and this is where that survives
    // the move off Tailwind.
    const html = renderToStaticMarkup(<Kbd>K</Kbd>);
    expect(html).toMatch(/^<kbd/);
    expect(html).not.toContain('role=');
    expect(html).not.toContain('tabindex');
    const none = stylex.create({ probe: { pointerEvents: 'none', userSelect: 'none' } });
    for (const className of classesFor(none.probe)) {
      expect(capClasses()).toContain(className);
    }
  });

  test('a chord is a kbd around kbds, and carries no appearance of its own', () => {
    // HTML gives this exact shape a meaning, so a screen reader is told the
    // three caps are one gesture rather than three keys in a row.
    const html = renderToStaticMarkup(
      <KbdGroup>
        <Kbd>&#8984;</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
    );
    expect(html.startsWith('<kbd')).toBe(true);
    expect([...html.matchAll(/<kbd/g)]).toHaveLength(3);
    // The wrapper draws nothing: the fill and the corner belong to the caps, so
    // a chord is not a second chip with two chips inside it.
    const transparent = stylex.create({ probe: { backgroundColor: 'transparent' } });
    const groupClasses = (/class="([^"]*)"/.exec(html)?.[1] ?? '').split(' ');
    for (const className of classesFor(transparent.probe)) {
      expect(groupClasses).toContain(className);
    }
  });

  test('the cap is drawn in the UI font rather than the browser’s mono default', () => {
    // `<kbd>` defaults to a monospace face. The glyphs on these caps — ⌘, ⇧, ↵ —
    // are drawn by the UI font here, so a cap that fell back to the mono stack
    // would render a different glyph from the identical character in the label
    // beside it.
    const inherit = stylex.create({ probe: { fontFamily: 'inherit' } });
    for (const className of classesFor(inherit.probe)) {
      expect(capClasses()).toContain(className);
    }
  });

  test('a cap standing on a tooltip is told what it is standing on', async () => {
    // The tooltip is the one surface in this system that inverts, so a cap
    // carrying the page's own gray lands as a light chip on a dark one with its
    // letters gone. StyleX has no descendant selector — the shape the deleted
    // implementation used — and it does not need one: a component token group
    // re-declared on the popup reaches every cap under it, however deeply a
    // caller wrapped one.
    mounted = await mount(
      <Tooltip.Root defaultOpen>
        <Tooltip.Trigger delay={0} render={<Button aria-label="Palette" />}>
          P
        </Tooltip.Trigger>
        <Tooltip.Content>
          <span>Open the palette</span>
          <KbdGroup>
            <Kbd>&#8984;</Kbd>
            <Kbd>K</Kbd>
          </KbdGroup>
        </Tooltip.Content>
      </Tooltip.Root>
    );
    const chip = all('[data-base-ui-portal] [data-side] > *')[0];
    expect(chip).toBeDefined();
    for (const className of classesFor(kbdOnInvertedTheme)) {
      expect(classesOf(chip)).toContain(className);
    }
    // And the cap under it is the same cap: only what it is made of changed,
    // not which classes it carries.
    const cap = one('kbd kbd');
    expect(classesOf(cap)).toEqual(capClasses());
  });

  test('the inversion replaces exactly what a cap is made of', () => {
    // Two declarations and no more: the film and the letters. A theme that also
    // moved the height or the corner would be a second cap rather than the same
    // one on another surface.
    expect(Object.keys(kbd).filter((name) => !name.startsWith('__'))).toContain('background');
    const inverted = classesFor(kbdOnInvertedTheme);
    const palette = classesFor(kbdPaletteTheme);
    // `createTheme` emits one class naming the group and one carrying the
    // values, so two themes of one group share the first and differ in the
    // second.
    expect(inverted.filter((name) => palette.includes(name))).toHaveLength(1);
  });

  test('the colour tokens are re-declared under a forced palette', () => {
    for (const className of classesFor(kbdPaletteTheme)) {
      expect(forcedThemeClassNames('light')).toContain(className);
    }
  });

  test('a caller className lands after the compiled classes', () => {
    const html = renderToStaticMarkup(<Kbd className="ml-1.5">K</Kbd>);
    const cls = /class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(cls.endsWith(' ml-1.5')).toBe(true);
  });
});
