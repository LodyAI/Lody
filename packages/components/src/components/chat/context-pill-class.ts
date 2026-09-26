import * as stylex from '@stylexjs/stylex';
import { colors, shadow, sheen } from '@lody/ui/tokens/colors.stylex';

/** The project context control uses the same raised material as its neighbors. */
export const contextPill = stylex.create({
  surface: {
    backgroundColor: colors.raisedBackground,
    backgroundImage: sheen.raised,
    boxShadow: shadow.raised,
  },
  interactive: {
    backgroundColor: { default: colors.raisedBackground, ':hover': colors.hoverFill },
  },
  open: { backgroundColor: colors.hoverFill },
});
