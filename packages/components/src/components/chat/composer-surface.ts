import * as stylex from '@stylexjs/stylex';
import { card } from '@lody/ui/card/card.tokens.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease } from '@lody/ui/tokens/scales.stylex';
import { themeSpace } from '../../style/theme-scale.stylex';

/** Shared card material for the composer and related conversation chrome. */
export const composerSurfaceStyles = stylex.create({
  composerElevation: {
    backgroundColor: card.background,
    boxShadow: card.shadow,
    borderWidth: 0,
    borderStyle: 'none',
    borderRadius: card.radius,
    cornerShape: corner.round,
  },
  infoBarElevation: {
    backgroundColor: colors.secondaryBackground,
    borderWidth: 0,
    borderStyle: 'none',
    boxShadow: 'none',
  },
  sessionSurface: {
    containerType: 'inline-size',
    containerName: 'composer-box',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1],
    paddingInline: themeSpace[2.5],
    paddingBlock: themeSpace[2],
    transitionProperty: 'background-color, box-shadow',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
});
