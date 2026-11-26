import * as stylex from '@stylexjs/stylex';
import type { TokensFromVarGroup } from '@stylexjs/stylex/lib/types/StyleXTypes';
import { button } from '@lody/ui/button/button.tokens.stylex';

// The compiler cannot serialize an imported spread. Keep the complete map
// local so only this fixed action's two ink tokens replace inherited values.
const inheritedButtonTokens = {
  heightMini: 'inherit',
  heightSmall: 'inherit',
  heightMedium: 'inherit',
  heightLarge: 'inherit',
  paddingXMini: 'inherit',
  paddingXSmall: 'inherit',
  paddingXMedium: 'inherit',
  paddingXLarge: 'inherit',
  radiusMini: 'inherit',
  radiusSmall: 'inherit',
  radiusMedium: 'inherit',
  textMini: 'inherit',
  text: 'inherit',
  gap: 'inherit',
  iconSize: 'inherit',
  primaryBackground: 'inherit',
  primaryLabel: 'inherit',
  primaryEdge: 'inherit',
  primarySheen: 'inherit',
  secondaryBackground: 'inherit',
  secondaryShadow: 'inherit',
  secondarySheen: 'inherit',
  pressedEdge: 'inherit',
  ghostLabel: 'inherit',
  ghostHover: 'inherit',
  ring: 'inherit',
  ringWidth: 'inherit',
} satisfies Record<keyof TokensFromVarGroup<typeof button>, 'inherit'>;

export const composerActionButtonTheme = stylex.createTheme(button, {
  ...inheritedButtonTokens,
  primaryBackground: 'hsl(var(--foreground) / 1)',
  primaryLabel: 'hsl(var(--background) / 1)',
});
