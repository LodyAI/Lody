import * as stylex from '@stylexjs/stylex';
import type { TokensFromVarGroup } from '@stylexjs/stylex/lib/types/StyleXTypes';
import { button } from '@lody/ui/button/button.tokens.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';

// A partial theme also declares its group's defaults on the element. Inherit
// every other token so a message action keeps its parent's control material.
export const inheritedButtonTokens = {
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

export const inheritedColors = {
  background: 'inherit',
  elevatedBackground: 'inherit',
  raisedBackground: 'inherit',
  secondaryBackground: 'inherit',
  wellBackground: 'inherit',
  trayBackground: 'inherit',
  trayRaised: 'inherit',
  label: 'inherit',
  secondaryLabel: 'inherit',
  tertiaryLabel: 'inherit',
  separator: 'inherit',
  hoverFill: 'inherit',
  selectedFill: 'inherit',
  accent: 'inherit',
  onAccent: 'inherit',
  destructive: 'inherit',
  onDestructive: 'inherit',
  success: 'inherit',
  warning: 'inherit',
  overlay: 'inherit',
  gray: 'inherit',
  gray2: 'inherit',
  gray3: 'inherit',
  gray4: 'inherit',
  gray5: 'inherit',
  gray6: 'inherit',
} satisfies Record<keyof TokensFromVarGroup<typeof colors>, 'inherit'>;

export const messageActionButtonTheme = stylex.createTheme(button, {
  ...inheritedButtonTokens,
  ghostLabel: 'hsl(var(--muted-foreground))',
  ghostHover: {
    default: 'inherit',
    '@media (hover: hover)': 'hsl(var(--hover))',
  },
});

// Only reviewed message glyphs/plain labels belong inside this theme: a child
// explicitly reading colors.label would also receive this local value.
export const messageActionInkTheme = stylex.createTheme(colors, {
  ...inheritedColors,
  label: {
    default: 'hsl(var(--muted-foreground))',
    '@media (hover: hover)': 'hsl(var(--foreground))',
  },
});

// Keep the inherited ghost hover fill for actions whose old classes only set ink.
export const messageActionLabelTheme = stylex.createTheme(button, {
  ...inheritedButtonTokens,
  ghostLabel: 'hsl(var(--muted-foreground))',
});

// A constant text utility also wins the primitive's hover ink on every device.
export const messageActionMutedInkTheme = stylex.createTheme(colors, {
  ...inheritedColors,
  label: 'hsl(var(--muted-foreground))',
});
