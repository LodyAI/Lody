import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, test } from 'vitest';
import { UiGallery } from '../src/gallery/gallery';
import { popup } from '../src/popup/popup.tokens.stylex';
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

  test('shows the field family: both controls, every size, and each state', () => {
    expect(board).toContain('<textarea');
    expect(board).toContain('placeholder="Describe the task"');
    for (const legend of ['small · 28', 'medium · 32', 'large · 36']) {
      expect(board, `field size ${legend} is missing from the board`).toContain(legend);
    }
    // Base UI marks these on the rendered parts, so their presence is the state
    // reaching the control rather than the board describing it.
    expect(board).toContain('aria-invalid="true"');
    expect(board).toContain('data-disabled=""');
    for (const name of [
      'field.background',
      'field.value',
      'field.label',
      'field.placeholder',
      'field.hint',
      'field.error',
      'field.ring',
      'field.invalidRing',
      'field.well',
    ]) {
      expect(board, `${name} is missing from the board`).toContain(name);
    }
  });

  test('shows the choice controls: every state of each, and their own tokens', () => {
    expect(board).toContain('role="checkbox"');
    expect(board).toContain('role="radiogroup"');
    expect(board).toContain('role="switch"');
    // Base UI marks these on the rendered control, so their presence is the
    // state reaching it rather than the board describing it.
    expect(board).toContain('aria-checked="mixed"');
    expect(board).toContain('data-checked=""');
    expect(board).toContain('data-unchecked=""');
    for (const name of [
      'field.checkedFill',
      'field.checkedMark',
      'field.checkedEdge',
      'field.thumb',
      'field.thumbShadow',
    ]) {
      expect(board, `${name} is missing from the board`).toContain(name);
    }
  });

  test('shows the trigger every state and names the popup tokens', () => {
    // A trigger is a button that announces a listbox; a Combobox is an input
    // that announces one. Their presence is the board holding the real
    // controls rather than a picture of them.
    expect(board).toContain('aria-haspopup="listbox"');
    expect(board).toContain('data-placeholder=""');
    expect(board).toContain('aria-autocomplete="list"');
    for (const legend of ['small · 28', 'medium · 32', 'large · 36']) {
      expect(board, `select size ${legend} is missing from the board`).toContain(legend);
    }
    for (const name of tokenNames(popup)) {
      expect(board, `popup.${name} is missing from the board`).toContain(`popup.${name}`);
    }
    expect(board, 'field.icon is missing from the board').toContain('field.icon');
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
