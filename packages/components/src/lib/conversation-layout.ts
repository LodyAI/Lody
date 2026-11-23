import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

/**
 * Shared geometry for the conversation's repeated inner columns. The virtual
 * scroller and full-bleed bands stay full-width; each region centers its content
 * with these styles so avatars, prose, context and composer share one edge.
 */
export const conversationColumnStyles = stylex.create({
  base: { marginInline: 'auto', width: '100%' },
  capped: {
    maxWidth: {
      default: 'calc(48rem + 28px)',
      '@media (min-width: 640px)': 'calc(48rem + 36px)',
    },
    paddingInline: { default: '14px', '@media (min-width: 640px)': '18px' },
  },
  wide: { paddingInline: '14px' },
  wideDesktop: {
    // The outline rail's inset remains owned by the column on desktop.
    '@media (min-width: 640px)': { paddingInline: `calc(${space[8]} * 2)` },
  },
});
