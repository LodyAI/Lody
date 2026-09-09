import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { UiGallery } from '../src/gallery/gallery';
import { forcedThemeClassNames } from '../src/theme/theme';
import { colors, shadow } from '../src/tokens/colors.stylex';
import { control, duration, radius, space, text, z } from '../src/tokens/scales.stylex';

/** StyleX adds bookkeeping keys to the runtime token objects. */
function tokenNames(tokens: object): string[] {
  return Object.keys(tokens).filter((key) => !key.startsWith('__'));
}

const board = renderToStaticMarkup(<UiGallery />);

describe('UiGallery', () => {
  test('names every colour and shadow token', () => {
    for (const name of tokenNames(colors)) {
      expect(board, `colour token ${name} is missing from the board`).toContain(`>${name}<`);
    }
    for (const name of tokenNames(shadow)) {
      expect(board, `shadow token ${name} is missing from the board`).toContain(`>shadow.${name}<`);
    }
  });

  test('names every scale token', () => {
    const scales: [string, object][] = [
      ['radius', radius],
      ['control', control],
      ['space', space],
      ['duration', duration],
      ['z', z],
    ];
    for (const [group, tokens] of scales) {
      for (const name of tokenNames(tokens)) {
        expect(board, `${group}.${name} is missing from the board`).toContain(`${group}.${name}`);
      }
    }
    const typeSteps = new Set(tokenNames(text).map((name) => name.replace(/(Size|Leading)$/, '')));
    for (const step of typeSteps) {
      expect(board, `type step ${step} is missing from the board`).toContain(step);
    }
  });

  test('renders each sample under both forced palettes', () => {
    for (const className of [...forcedThemeClassNames('light'), ...forcedThemeClassNames('dark')]) {
      expect(board).toContain(className);
    }
    expect(board).toContain('Lody Light');
    expect(board).toContain('Vesper');
  });

  test('shows every Button variant and size', () => {
    for (const variant of ['primary', 'secondary', 'ghost', 'destructive', 'link']) {
      expect(board).toContain(`data-variant="${variant}"`);
    }
    for (const size of ['mini', 'small', 'medium', 'large']) {
      expect(board).toContain(`data-size="${size}"`);
    }
    expect(board).toContain('disabled=""');
  });

  test('renders one palette when asked for one', () => {
    const light = renderToStaticMarkup(<UiGallery palettes="light" />);
    expect(light).toContain('Lody Light');
    expect(light).not.toContain('Vesper');
    // createTheme also emits a marker class shared by both themes of a variable
    // group; only the palette-specific classes tell the two renders apart.
    const darkOnly = forcedThemeClassNames('dark').filter(
      (className) => !forcedThemeClassNames('light').includes(className)
    );
    expect(darkOnly.length).toBeGreaterThan(0);
    for (const className of darkOnly) {
      expect(light).not.toContain(className);
    }
  });
});
