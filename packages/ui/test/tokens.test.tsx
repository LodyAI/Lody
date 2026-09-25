import * as stylex from '@stylexjs/stylex';
import { describe, expect, test } from 'vitest';
import { colors, shadow } from '../src/tokens/colors.stylex';
import { corner, radius } from '../src/tokens/scales.stylex';
import { ThemeRoot } from '../src/theme/theme';

const styles = stylex.create({
  well: {
    backgroundColor: colors.wellBackground,
    boxShadow: shadow.inset,
    borderRadius: radius.medium,
    cornerShape: corner.shape,
  },
});

describe('tokens', () => {
  test('semantic tokens compile to CSS custom property references', () => {
    expect(colors.label).toMatch(/^var\(--/);
    expect(shadow.card).toMatch(/^var\(--/);
    expect(radius.large).toMatch(/^var\(--/);
  });

  test('consts inline their value', () => {
    expect(corner.shape).toBe('squircle');
  });

  test('a style built from tokens yields a class list', () => {
    const { className } = stylex.props(styles.well);
    expect(className).toBeTruthy();
    expect(className?.split(' ').length).toBeGreaterThanOrEqual(4);
  });

  test('theme root is a component', () => {
    expect(typeof ThemeRoot).toBe('function');
  });
});
