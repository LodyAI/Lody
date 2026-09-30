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

  test('a tone is a film and a word, and nothing else moves with it', () => {
    const chips = TONES.map((tone) =>
      classesAt(renderToStaticMarkup(<Badge tone={tone}>{tone}</Badge>))
    );
    // Five different chips…
    expect(new Set(chips.map((names) => names.join(' '))).size).toBe(TONES.length);
    // …made of one chip: everything a tone does not own is shared, so a tone
    // cannot grow its own height, corner or type step.
    const shared = chips.reduce<string[]>(
      (kept, names) => kept.filter((name) => names.includes(name)),
      chips[0] ?? []
    );
    // A tone owns exactly two declarations: the film, and the word. The neutral
    // one owns two as well — StyleX drops the root's `color` class from a chip
    // whose tone declares its own, so the base ink is a class only the neutral
    // chip carries and is therefore not in the shared set either.
    for (const [index, names] of chips.entries()) {
      expect(names.length, `the ${TONES[index]} badge owns the wrong number of declarations`).toBe(
        shared.length + 2
      );
    }
  });

  test('a tone’s word is that tone pulled halfway to the ink', () => {
    // The rule this replaces said the words stay ink in every tone, and the
    // measurement behind it stands: the *raw* `warning` is 2.8:1 on a near-white
    // surface, a colour tuned for a 16px mark where the bar is 3:1, used as 11px
    // text where it is 4.5:1. What it left out is that the raw tone is not the
    // only way to carry a hue — halfway to `label`, a tone keeps its hue and
    // gains the ink's contrast, and the worst of the four then measures 5.2:1 on
    // its own chip. That is the mark a person actually reads on a 20px chip,
    // and in the dark palette it is the only thing that separates `running`
    // from `warning` at all.
    // Written out one by one because StyleX compiles `create` from a literal:
    // a token read through a loop variable is not something it can evaluate.
    const ink = stylex.create({
      running: { color: badge.runningLabel },
      success: { color: badge.successLabel },
      warning: { color: badge.warningLabel },
      danger: { color: badge.dangerLabel },
      neutral: { color: badge.label },
    });
    const classFor = (style: (typeof ink)[keyof typeof ink]) => {
      const names = (stylex.props(style).className ?? '').split(' ').filter(Boolean);
      // One property, one value, one class — so what follows compares the chip
      // against the declaration itself rather than against a copy of it.
      expect(names.length).toBe(1);
      return names[0];
    };
    for (const tone of ['running', 'success', 'warning', 'danger'] as const) {
      const names = classesAt(renderToStaticMarkup(<Badge tone={tone}>a</Badge>));
      expect(names, `the ${tone} badge does not carry its own word colour`).toContain(
        classFor(ink[tone])
      );
    }
    // And the neutral one has no tone to carry, so it keeps the base ink.
    expect(classesAt(renderToStaticMarkup(<Badge>a</Badge>))).toContain(classFor(ink.neutral));
    // The four are four: a tone whose word matched another's would be the bug
    // this replaces, wearing a different colour.
    const distinct = new Set(
      (['running', 'success', 'warning', 'danger'] as const).map((tone) => classFor(ink[tone]))
    );
    expect(distinct.size).toBe(4);
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
