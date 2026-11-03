import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';

/**
 * The composer's box. Exported so surfaces that cannot mount the real
 * `ChatComposer` — the anonymous share reader, which must stay free of mention,
 * attachment and agent-control machinery — still render the same object the
 * product's composer is, instead of a look-alike that drifts from it.
 *
 * Focus, mention-chip surface colour and every interactive concern stay in
 * `chat-composer.tsx`; this is only the resting surface.
 */
export const COMPOSER_ELEVATION_CLASS =
  'shadow-[0_10px_28px_-14px_lch(0%_0_0/0.16),0_1px_2px_lch(0%_0_0/0.05)] dark:shadow-none';

export const INFO_BAR_ELEVATION_CLASS =
  'shadow-[0_0.5px_1px_1px_rgba(0,0,0,0.04)] dark:shadow-none';

export const COMPOSER_SESSION_SURFACE_CLASS = `@container/composer-box flex flex-col gap-1 rounded-2xl border px-2.5 py-2 transition-colors duration-150 border-foreground/[0.10] bg-[hsl(var(--composer))] ${COMPOSER_ELEVATION_CLASS} dark:border-input-border/70 dark:bg-input/90`;

const styles = stylex.create({
  shell: {
    position: 'relative',
    flexShrink: 0,
    paddingTop: 0,
    paddingBottom:
      'calc(0.5rem + max(0px, var(--safe-area-bottom, env(safe-area-inset-bottom, 0px)) - var(--native-keyboard-height, 0px)))',
    backgroundColor: colors.background,
    transitionProperty: 'margin-bottom, padding-bottom',
    transitionDuration: '250ms',
    transitionTimingFunction: 'var(--ease-out, cubic-bezier(0, 0, 0.2, 1))',
  },
  shellKeyboardLift: { marginBottom: 'var(--native-keyboard-height, 0px)' },
  shellEdgeBackLayer: { zIndex: 40 },
});

/** Both new-chat and in-session composers own exactly one keyboard/safe-area inset. */
export function getSessionChatInputAreaShellClassName({
  protectFromEdgeBackZone = false,
  liftAboveKeyboard = false,
}: { protectFromEdgeBackZone?: boolean; liftAboveKeyboard?: boolean } = {}): string {
  return (
    stylex.props(
      styles.shell,
      liftAboveKeyboard && styles.shellKeyboardLift,
      protectFromEdgeBackZone && styles.shellEdgeBackLayer
    ).className ?? ''
  );
}
