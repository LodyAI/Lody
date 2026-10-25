import * as stylex from '@stylexjs/stylex';
import { colors } from '../tokens/colors.stylex';
import { radius } from '../tokens/scales.stylex';

/** A scrollbar is a neutral position mark, on no elevation rung. */
export const scrollbar = stylex.defineVars({
  size: '8px',
  inset: '2px',
  compactSize: '4px',
  radius: radius.full,
  thumb: colors.gray3,
  thumbHover: colors.gray2,
  thumbActive: colors.gray,
});

export const scrollbarPaletteTheme = stylex.createTheme(scrollbar, {
  thumb: colors.gray3,
  thumbHover: colors.gray2,
  thumbActive: colors.gray,
});

/** Native product containers use the same tokens as the Base UI parts. */
export const scrollbarNativeTheme = stylex.create({
  variables: {
    '--lody-scrollbar-size': scrollbar.size,
    '--lody-scrollbar-inset': scrollbar.inset,
    '--lody-scrollbar-radius': scrollbar.radius,
    '--lody-scrollbar-thumb': scrollbar.thumb,
    '--lody-scrollbar-thumb-hover': scrollbar.thumbHover,
    '--lody-scrollbar-thumb-active': scrollbar.thumbActive,
  },
}).variables;
