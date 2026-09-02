import * as stylex from '@stylexjs/stylex';

const DARK = '@media (prefers-color-scheme: dark)';

export const colors = stylex.defineVars({
  background: { default: 'hsl(0 0% 100%)', [DARK]: 'hsl(0 0% 6.3%)' },
  elevatedBackground: { default: 'hsl(0 0% 100%)', [DARK]: 'hsl(0 0% 8.6%)' },
  raisedBackground: { default: 'hsl(216 17% 94.3%)', [DARK]: 'hsl(0 0% 13.7%)' },
  secondaryBackground: { default: 'hsl(220 23% 97.5%)', [DARK]: 'hsl(0 0% 8.6%)' },
  wellBackground: { default: 'hsl(216 12% 92%)', [DARK]: 'hsl(0 0% 11%)' },
  label: { default: 'hsl(225 7% 11%)', [DARK]: 'hsl(0 0% 100%)' },
  secondaryLabel: { default: 'hsl(220 9% 46%)', [DARK]: 'hsl(0 0% 62.7%)' },
  tertiaryLabel: { default: 'hsl(220 8% 62%)', [DARK]: 'hsl(0 0% 45%)' },
  separator: { default: 'hsl(223 16% 91.6%)', [DARK]: 'hsl(0 0% 15.7%)' },
  hoverFill: { default: 'hsl(225 15% 94.9%)', [DARK]: 'hsl(0 0% 15.7%)' },
  selectedFill: { default: 'hsl(223 18% 92.4%)', [DARK]: 'hsl(0 0% 13.7%)' },
  accent: { default: 'hsl(220 82% 65%)', [DARK]: 'hsl(27 100% 80%)' },
  onAccent: { default: 'hsl(0 0% 100%)', [DARK]: 'hsl(0 0% 0%)' },
  destructive: { default: 'hsl(356 72% 47%)', [DARK]: 'hsl(0 100% 75%)' },
  onDestructive: { default: 'hsl(0 0% 100%)', [DARK]: 'hsl(0 0% 0%)' },
  overlay: { default: 'hsl(225 7% 11% / 0.5)', [DARK]: 'hsl(0 0% 0% / 0.6)' },
  gray: { default: 'hsl(220 8% 62%)', [DARK]: 'hsl(0 0% 42%)' },
  gray2: { default: 'hsl(220 9% 70%)', [DARK]: 'hsl(0 0% 34%)' },
  gray3: { default: 'hsl(220 11% 78%)', [DARK]: 'hsl(0 0% 27%)' },
  gray4: { default: 'hsl(222 13% 85%)', [DARK]: 'hsl(0 0% 22%)' },
  gray5: { default: 'hsl(223 16% 91.6%)', [DARK]: 'hsl(0 0% 18%)' },
  gray6: { default: 'hsl(220 23% 97.5%)', [DARK]: 'hsl(0 0% 13.7%)' },
});

export const shadow = stylex.defineVars({
  inset: {
    default: 'inset 0 1px 2px hsl(225 10% 11% / 0.07)',
    [DARK]: 'inset 0 1px 2px hsl(0 0% 0% / 0.7)',
  },
  raised: {
    default: '0 1px 2px hsl(225 10% 11% / 0.12), 0 0 0 0.5px hsl(225 10% 11% / 0.05)',
    [DARK]: 'inset 0 1px 0 hsl(0 0% 100% / 0.07), 0 1px 2px hsl(0 0% 0% / 0.5)',
  },
  inkEdge: {
    default: 'inset 0 1px 0 hsl(0 0% 100% / 0.16)',
    [DARK]: 'inset 0 1px 0 hsl(0 0% 100% / 0.55)',
  },
  card: {
    default: '0 1px 2px hsl(225 10% 11% / 0.05), 0 10px 30px hsl(225 10% 11% / 0.06)',
    [DARK]: 'inset 0 1px 0 hsl(0 0% 100% / 0.04), 0 10px 30px hsl(0 0% 0% / 0.45)',
  },
  medium: {
    default: '0 2px 6px hsl(225 10% 11% / 0.2)',
    [DARK]: '0 2px 6px hsl(0 0% 0% / 0.5)',
  },
  popover: {
    default: '0 2px 6px hsl(225 10% 11% / 0.06), 0 18px 50px hsl(225 10% 11% / 0.14)',
    [DARK]: 'inset 0 1px 0 hsl(0 0% 100% / 0.06), 0 18px 50px hsl(0 0% 0% / 0.7)',
  },
  large: {
    default: '0 24px 64px hsl(225 10% 11% / 0.24)',
    [DARK]: 'inset 0 1px 0 hsl(0 0% 100% / 0.06), 0 24px 64px hsl(0 0% 0% / 0.8)',
  },
});

export const darkTheme = stylex.createTheme(colors, {
  background: 'hsl(0 0% 6.3%)',
  elevatedBackground: 'hsl(0 0% 8.6%)',
  raisedBackground: 'hsl(0 0% 13.7%)',
  secondaryBackground: 'hsl(0 0% 8.6%)',
  wellBackground: 'hsl(0 0% 11%)',
  label: 'hsl(0 0% 100%)',
  secondaryLabel: 'hsl(0 0% 62.7%)',
  tertiaryLabel: 'hsl(0 0% 45%)',
  separator: 'hsl(0 0% 15.7%)',
  hoverFill: 'hsl(0 0% 15.7%)',
  selectedFill: 'hsl(0 0% 13.7%)',
  accent: 'hsl(27 100% 80%)',
  onAccent: 'hsl(0 0% 0%)',
  destructive: 'hsl(0 100% 75%)',
  onDestructive: 'hsl(0 0% 0%)',
  overlay: 'hsl(0 0% 0% / 0.6)',
  gray: 'hsl(0 0% 42%)',
  gray2: 'hsl(0 0% 34%)',
  gray3: 'hsl(0 0% 27%)',
  gray4: 'hsl(0 0% 22%)',
  gray5: 'hsl(0 0% 18%)',
  gray6: 'hsl(0 0% 13.7%)',
});

export const lightTheme = stylex.createTheme(colors, {
  background: 'hsl(0 0% 100%)',
  elevatedBackground: 'hsl(0 0% 100%)',
  raisedBackground: 'hsl(216 17% 94.3%)',
  secondaryBackground: 'hsl(220 23% 97.5%)',
  wellBackground: 'hsl(216 12% 92%)',
  label: 'hsl(225 7% 11%)',
  secondaryLabel: 'hsl(220 9% 46%)',
  tertiaryLabel: 'hsl(220 8% 62%)',
  separator: 'hsl(223 16% 91.6%)',
  hoverFill: 'hsl(225 15% 94.9%)',
  selectedFill: 'hsl(223 18% 92.4%)',
  accent: 'hsl(220 82% 65%)',
  onAccent: 'hsl(0 0% 100%)',
  destructive: 'hsl(356 72% 47%)',
  onDestructive: 'hsl(0 0% 100%)',
  overlay: 'hsl(225 7% 11% / 0.5)',
  gray: 'hsl(220 8% 62%)',
  gray2: 'hsl(220 9% 70%)',
  gray3: 'hsl(220 11% 78%)',
  gray4: 'hsl(222 13% 85%)',
  gray5: 'hsl(223 16% 91.6%)',
  gray6: 'hsl(220 23% 97.5%)',
});

export const darkShadowTheme = stylex.createTheme(shadow, {
  inset: 'inset 0 1px 2px hsl(0 0% 0% / 0.7)',
  raised: 'inset 0 1px 0 hsl(0 0% 100% / 0.07), 0 1px 2px hsl(0 0% 0% / 0.5)',
  inkEdge: 'inset 0 1px 0 hsl(0 0% 100% / 0.55)',
  card: 'inset 0 1px 0 hsl(0 0% 100% / 0.04), 0 10px 30px hsl(0 0% 0% / 0.45)',
  medium: '0 2px 6px hsl(0 0% 0% / 0.5)',
  popover: 'inset 0 1px 0 hsl(0 0% 100% / 0.06), 0 18px 50px hsl(0 0% 0% / 0.7)',
  large: 'inset 0 1px 0 hsl(0 0% 100% / 0.06), 0 24px 64px hsl(0 0% 0% / 0.8)',
});

export const lightShadowTheme = stylex.createTheme(shadow, {
  inset: 'inset 0 1px 2px hsl(225 10% 11% / 0.07)',
  raised: '0 1px 2px hsl(225 10% 11% / 0.12), 0 0 0 0.5px hsl(225 10% 11% / 0.05)',
  inkEdge: 'inset 0 1px 0 hsl(0 0% 100% / 0.16)',
  card: '0 1px 2px hsl(225 10% 11% / 0.05), 0 10px 30px hsl(225 10% 11% / 0.06)',
  medium: '0 2px 6px hsl(225 10% 11% / 0.2)',
  popover: '0 2px 6px hsl(225 10% 11% / 0.06), 0 18px 50px hsl(225 10% 11% / 0.14)',
  large: '0 24px 64px hsl(225 10% 11% / 0.24)',
});
