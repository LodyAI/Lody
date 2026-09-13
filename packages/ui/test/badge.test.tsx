import * as stylex from '@stylexjs/stylex';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { Badge, type BadgeTone } from '../src/badge/badge';
import { badge, badgePaletteTheme } from '../src/badge/badge.tokens.stylex';
import { forcedThemeClassNames } from '../src/theme/theme';

const TONES: BadgeTone[] = ['neutral', 'running', 'success', 'warning', 'danger'];

function classesAt(html: string, index = 0): string[] {
  const matches = [...html.matchAll(/class="([^"]*)"/g)];
  return (matches[index]?.[1] ?? '').split(' ').filter(Boolean);
}

describe('Badge', () => {
  test('a badge is inline metadata, not a control', () => {
    // The old implementation's default variant filled the chip with the colour
    // the rules give a stored value, which invited a press it does not answer.
    // Nothing here takes focus, answers a pointer or reports a state.
    const html = renderToStaticMarkup(<Badge>Plus</Badge>);
    expect(html).toMatch(/^<span/);
    expect(html).not.toContain('role=');
    expect(html).not.toContain('tabindex');
    expect(html).not.toContain('<button');
  });

  test('each tone is one fill over the same chip', () => {
    const chips = TONES.map((tone) =>
      classesAt(renderToStaticMarkup(<Badge tone={tone}>{tone}</Badge>))
    );
    // Five different fills…
    expect(new Set(chips.map((names) => names.join(' '))).size).toBe(TONES.length);
    // …and one chip: everything but the fill is shared, so a tone cannot grow
    // its own height, corner or type step.
    const shared = chips.reduce<string[]>(
      (kept, names) => kept.filter((name) => names.includes(name)),
      chips[0] ?? []
    );
    for (const names of chips) expect(names.length).toBe(shared.length + 1);
  });

  test('the words stay ink in every tone', () => {
    // `warning` is 2.8:1 on a near-white surface: a colour tuned for a 16px
    // mark, where the bar is 3:1, rather than for 11px text, where it is 4.5:1.
    // A badge always carries its word, so the tint says which kind it is and
    // the label colour is one decision for all four. StyleX hashes a class per
    // property and value, so the class a bare `color: badge.label` compiles to
    // is the class every tone has to carry.
    const ink = stylex.create({ label: { color: badge.label } });
    const expected = (stylex.props(ink.label).className ?? '').split(' ').filter(Boolean);
    expect(expected.length).toBe(1);
    for (const tone of TONES) {
      const names = classesAt(renderToStaticMarkup(<Badge tone={tone}>a</Badge>));
      expect(names, `the ${tone} badge does not take the label colour`).toContain(expected[0]);
    }
  });

  test('a caller’s glyph is given a box, and a badge without one has none', () => {
    // This package's glyphs state their size as 100% of whatever holds them,
    // and StyleX has no descendant selector with which the chip could reach
    // one — the same box a menu row's leading slot is, at a badge's scale.
    const withIcon = renderToStaticMarkup(<Badge icon={<svg />}>macOS</Badge>);
    expect(withIcon).toMatch(
      /<span[^>]*><span aria-hidden="true" class="[^"]*"><svg><\/svg><\/span>macOS<\/span>/
    );
    // The box is the glyph's alone: a badge that is only words holds no empty
    // one, so an icon-less badge is not indented for nothing.
    expect(renderToStaticMarkup(<Badge>macOS</Badge>)).toMatch(/<span[^>]*>macOS<\/span>/);
  });

  test('a caller className lands after the compiled classes', () => {
    const html = renderToStaticMarkup(<Badge className="max-w-24">long</Badge>);
    const cls = /class="([^"]*)"/.exec(html)?.[1] ?? '';
    expect(cls.endsWith(' max-w-24')).toBe(true);
  });

  test('the films travel into a forced palette', () => {
    const theme = (stylex.props(badgePaletteTheme).className ?? '').split(' ').filter(Boolean);
    expect(theme.length).toBeGreaterThan(0);
    for (const name of theme) {
      expect(forcedThemeClassNames('dark'), `${name} is not applied by ThemeRoot`).toContain(name);
      expect(forcedThemeClassNames('light'), `${name} is not applied by ThemeRoot`).toContain(name);
    }
  });
});
