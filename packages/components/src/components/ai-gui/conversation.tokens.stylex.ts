import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';

const readingLeading = `calc(${text.bodyLeading} * 1.2)`;

/** Conversation anatomy; hosts can override this group with createTheme. */
export const conversation = stylex.defineVars({
  reading: 'hsl(var(--reading-foreground, var(--foreground)))',
  readingLeading,
  strong: 'hsl(var(--foreground-strong, var(--foreground)))',
  bubbleFill: `color-mix(in srgb, ${colors.label} 5%, transparent)`,
  bubbleRadius: radius.large,
  bubblePaddingInline: space[4],
  bubblePaddingBlock: `max(${space[3]}, calc(${text.bodyLeading} - ${space[2]}))`,
  railInset: space[1],
  messagePadding: space[2],
  responseGap: `max(${space[8]}, calc(${text.bodyLeading} * 1.8))`,
  roundGap: `max(48px, calc(${text.bodyLeading} * 2.8))`,
  activityPitch: `max(${space[6]}, calc(${text.subheadlineLeading} + ${space[1.5]}))`,
  activityPadding: `calc(${space[1]} / 2)`,
  activityHoverFill: 'hsl(var(--hover) / 0.4)',
  proseGap: space[1.5],
  surfaceGap: `max(${space[4]}, calc(${text.bodyLeading} - ${space[1]}))`,
  paragraphGap: `max(${space[3]}, calc(${text.bodyLeading} - ${space[2]}))`,
  listItemGap: `max(2px, calc(${space[6]} - ${readingLeading}))`,
  metadataGap: space[1],
  metadataPitch: `max(14px, ${text.captionLeading})`,
  codeFill: 'hsl(var(--code-background))',
  codeDarkFill: 'color-mix(in srgb, hsl(var(--input)) 90%, hsl(var(--background)))',
  codeBorder: 'hsl(var(--code-border))',
  codeText: 'hsl(var(--code-foreground))',
  codeMeta: 'hsl(var(--code-foreground) / 0.55)',
});
