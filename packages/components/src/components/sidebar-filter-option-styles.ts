import * as stylex from '@stylexjs/stylex';
import { text } from '@lody/ui/tokens/scales.stylex';
import { themeColors } from '../style/theme-colors.stylex';
import { themeRadius, themeSpace } from '../style/theme-scale.stylex';

/* The sidebar filter's row grammar, shared by the filter menu and the owner
   list it opens so both read as one menu. */

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

export const filterOptionTypography = stylex.create({
  option: { fontSize: text.subheadlineSize, lineHeight: text.subheadlineLeading },
});

export const filterOptionStyles = stylex.create({
  /** A menu option: the row a person picks an option from. */
  option: {
    display: 'flex',
    minHeight: themeSpace[7],
    width: '100%',
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1],
    textAlign: 'left',
    backgroundColor: {
      default: 'transparent',
      ':hover': {
        default: 'hsl(var(--foreground) / 0.05)',
        [DARK_SCOPE]: {
          '@media (hover: hover)': {
            default: 'hsl(var(--foreground) / 0.1)',
          },
        },
      },
      ':focus-visible': {
        default: 'hsl(var(--foreground) / 0.05)',
        [DARK_SCOPE]: 'hsl(var(--foreground) / 0.1)',
      },
    },
    color: {
      default: themeColors.popoverForeground,
      ':hover': themeColors.foreground,
      ':focus-visible': themeColors.foreground,
    },
  },
  optionIcon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  optionSpacer: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  optionLabel: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
