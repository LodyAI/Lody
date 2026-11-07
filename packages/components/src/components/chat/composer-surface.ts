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
export function getSessionChatInputAreaShellStyles({
  protectFromEdgeBackZone = false,
  liftAboveKeyboard = false,
}: { protectFromEdgeBackZone?: boolean; liftAboveKeyboard?: boolean } = {}): stylex.StyleXStyles {
  return [
    styles.shell,
    liftAboveKeyboard && styles.shellKeyboardLift,
    protectFromEdgeBackZone && styles.shellEdgeBackLayer,
  ];
}

export function getSessionChatInputAreaShellClassName(
  options: { protectFromEdgeBackZone?: boolean; liftAboveKeyboard?: boolean } = {}
): string {
  return stylex.props(getSessionChatInputAreaShellStyles(options)).className ?? '';
}
