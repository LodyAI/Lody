import * as stylex from '@stylexjs/stylex';

const DARK = '@media (prefers-color-scheme: dark)';

export const colors = stylex.defineVars({
  background: { default: 'hsl(0 0% 100%)', [DARK]: 'hsl(0 0% 6.3%)' },
  elevatedBackground: { default: 'hsl(0 0% 100%)', [DARK]: 'hsl(0 0% 8.6%)' },
  raisedBackground: { default: 'hsl(0 0% 100%)', [DARK]: 'hsl(0 0% 13.7%)' },
  secondaryBackground: { default: 'hsl(220 23% 97.5%)', [DARK]: 'hsl(0 0% 8.6%)' },
  wellBackground: { default: 'hsl(225 10% 11% / 0.05)', [DARK]: 'hsl(0 0% 0% / 0.28)' },
  // A segmented strip: a flat tray a tint off its surface, and the one key on it.
  trayBackground: { default: 'hsl(225 10% 11% / 0.06)', [DARK]: 'hsl(0 0% 100% / 0.06)' },
  trayRaised: { default: 'hsl(0 0% 100%)', [DARK]: 'hsl(0 0% 21%)' },
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
  // The two states a message can report that `label` and `destructive` cannot.
  // They name an outcome rather than an action — a finished sync, a quota about
  // to run out — so they are never a fill a person presses, only a mark beside
  // what it is about and the tint under it.
  success: { default: 'hsl(151 55% 36%)', [DARK]: 'hsl(151 60% 52%)' },
  warning: { default: 'hsl(32 90% 48%)', [DARK]: 'hsl(43 96% 56%)' },
  overlay: { default: 'hsl(225 7% 11% / 0.5)', [DARK]: 'hsl(0 0% 0% / 0.6)' },
  gray: { default: 'hsl(220 8% 62%)', [DARK]: 'hsl(0 0% 42%)' },
  gray2: { default: 'hsl(220 9% 70%)', [DARK]: 'hsl(0 0% 34%)' },
  gray3: { default: 'hsl(220 11% 78%)', [DARK]: 'hsl(0 0% 27%)' },
  gray4: { default: 'hsl(222 13% 85%)', [DARK]: 'hsl(0 0% 22%)' },
  gray5: { default: 'hsl(223 16% 91.6%)', [DARK]: 'hsl(0 0% 18%)' },
  gray6: { default: 'hsl(220 23% 97.5%)', [DARK]: 'hsl(0 0% 13.7%)' },
});

export const shadow = stylex.defineVars({
  // A recess, lit from the same light as everything raised: a short shadow
  // inside the top edge, one inner hairline, and the light catching the lower
  // lip. Every place that holds a value — a field, a select, a track — takes
  // it, so a column of them is one material. It is shallow and its fill sits
  // just under the surface: a deep gray well read as a hole cut into the card.
  inset: {
    default:
      'inset 0 1px 1.5px hsl(225 10% 11% / 0.08), inset 0 0 0 1px hsl(225 10% 11% / 0.06), 0 1px 0 hsl(0 0% 100% / 0.8)',
    [DARK]:
      'inset 0 1px 2px hsl(0 0% 0% / 0.4), inset 0 0 0 1px hsl(0 0% 100% / 0.06), 0 1px 0 hsl(0 0% 100% / 0.04)',
  },
  raised: {
    default:
      '0 0 0 0.5px hsl(225 10% 11% / 0.16), 0 1px 1px hsl(225 10% 11% / 0.06), 0 2px 4px -1px hsl(225 10% 11% / 0.07)',
    [DARK]:
      'inset 0 1px 0 hsl(0 0% 100% / 0.08), 0 0 0 0.5px hsl(0 0% 0% / 0.7), 0 1px 2px hsl(0 0% 0% / 0.5)',
  },
  inkEdge: {
    default: 'inset 0 1px 0 hsl(0 0% 100% / 0.18), 0 1px 1.5px hsl(225 10% 11% / 0.18)',
    [DARK]: 'inset 0 1px 0 hsl(0 0% 100% / 0.55), 0 1px 2px hsl(0 0% 0% / 0.5)',
  },
  card: {
    default:
      '0 0 0 0.5px hsl(225 10% 11% / 0.12), 0 1px 2px hsl(225 10% 11% / 0.06), 0 8px 24px -6px hsl(225 10% 11% / 0.09)',
    [DARK]:
      'inset 0 1px 0 hsl(0 0% 100% / 0.05), 0 0 0 0.5px hsl(0 0% 100% / 0.06), 0 8px 24px -6px hsl(0 0% 0% / 0.5)',
  },
  medium: {
    default: '0 1px 2px hsl(225 10% 11% / 0.14), 0 4px 12px -2px hsl(225 10% 11% / 0.18)',
    [DARK]: '0 0 0 0.5px hsl(0 0% 100% / 0.1), 0 2px 6px hsl(0 0% 0% / 0.5)',
  },
  popover: {
    default:
      '0 0 0 0.5px hsl(225 10% 11% / 0.11), 0 2px 4px -1px hsl(225 10% 11% / 0.06), 0 12px 32px -6px hsl(225 10% 11% / 0.16)',
    [DARK]:
      'inset 0 1px 0 hsl(0 0% 100% / 0.07), 0 0 0 0.5px hsl(0 0% 100% / 0.08), 0 12px 32px -4px hsl(0 0% 0% / 0.6)',
  },
  large: {
    default:
      '0 0 0 0.5px hsl(225 10% 11% / 0.08), 0 2px 6px -2px hsl(225 10% 11% / 0.08), 0 24px 56px -12px hsl(225 10% 11% / 0.28)',
    [DARK]:
      'inset 0 1px 0 hsl(0 0% 100% / 0.06), 0 0 0 0.5px hsl(0 0% 100% / 0.08), 0 24px 56px -8px hsl(0 0% 0% / 0.7)',
  },
});

/**
 * The light falls from above, so a thing raised toward it is a shade brighter at
 * its top edge than at its foot. A sheen is that fall-off laid over a fill as a
 * `background-image`, never a fill of its own: a hover that changes the fill
 * keeps it, and a press drops it, because a thing pressed flush faces the light
 * no more than the surface around it. Each one spans a few percent at most; the
 * point is that the eye reads a surface, not that it sees a gradient.
 */
export const sheen = stylex.defineVars({
  // On a raised fill — a secondary button, a thumb, a tab's pill.
  raised: {
    default: 'linear-gradient(hsl(225 10% 11% / 0), hsl(225 10% 11% / 0.03))',
    [DARK]: 'linear-gradient(hsl(0 0% 100% / 0.04), hsl(0 0% 100% / 0))',
  },
  // On an ink or tone fill — the primary and destructive buttons, a checked box.
  ink: {
    default: 'linear-gradient(hsl(0 0% 100% / 0.1), hsl(0 0% 100% / 0))',
    [DARK]: 'linear-gradient(hsl(0 0% 0% / 0), hsl(0 0% 0% / 0.08))',
  },
});

export const darkTheme = stylex.createTheme(colors, {
  background: 'hsl(0 0% 6.3%)',
  elevatedBackground: 'hsl(0 0% 8.6%)',
  raisedBackground: 'hsl(0 0% 13.7%)',
  secondaryBackground: 'hsl(0 0% 8.6%)',
  wellBackground: 'hsl(0 0% 0% / 0.28)',
  trayBackground: 'hsl(0 0% 100% / 0.06)',
  trayRaised: 'hsl(0 0% 21%)',
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
  success: 'hsl(151 60% 52%)',
  warning: 'hsl(43 96% 56%)',
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
  raisedBackground: 'hsl(0 0% 100%)',
  secondaryBackground: 'hsl(220 23% 97.5%)',
  wellBackground: 'hsl(225 10% 11% / 0.05)',
  trayBackground: 'hsl(225 10% 11% / 0.06)',
  trayRaised: 'hsl(0 0% 100%)',
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
  success: 'hsl(151 55% 36%)',
  warning: 'hsl(32 90% 48%)',
  overlay: 'hsl(225 7% 11% / 0.5)',
  gray: 'hsl(220 8% 62%)',
  gray2: 'hsl(220 9% 70%)',
  gray3: 'hsl(220 11% 78%)',
  gray4: 'hsl(222 13% 85%)',
  gray5: 'hsl(223 16% 91.6%)',
  gray6: 'hsl(220 23% 97.5%)',
});

export const darkShadowTheme = stylex.createTheme(shadow, {
  inset:
    'inset 0 1px 2px hsl(0 0% 0% / 0.4), inset 0 0 0 1px hsl(0 0% 100% / 0.06), 0 1px 0 hsl(0 0% 100% / 0.04)',
  raised:
    'inset 0 1px 0 hsl(0 0% 100% / 0.08), 0 0 0 0.5px hsl(0 0% 0% / 0.7), 0 1px 2px hsl(0 0% 0% / 0.5)',
  inkEdge: 'inset 0 1px 0 hsl(0 0% 100% / 0.55), 0 1px 2px hsl(0 0% 0% / 0.5)',
  card: 'inset 0 1px 0 hsl(0 0% 100% / 0.05), 0 0 0 0.5px hsl(0 0% 100% / 0.06), 0 8px 24px -6px hsl(0 0% 0% / 0.5)',
  medium: '0 0 0 0.5px hsl(0 0% 100% / 0.1), 0 2px 6px hsl(0 0% 0% / 0.5)',
  popover:
    'inset 0 1px 0 hsl(0 0% 100% / 0.07), 0 0 0 0.5px hsl(0 0% 100% / 0.08), 0 12px 32px -4px hsl(0 0% 0% / 0.6)',
  large:
    'inset 0 1px 0 hsl(0 0% 100% / 0.06), 0 0 0 0.5px hsl(0 0% 100% / 0.08), 0 24px 56px -8px hsl(0 0% 0% / 0.7)',
});

export const lightShadowTheme = stylex.createTheme(shadow, {
  inset:
    'inset 0 1px 1.5px hsl(225 10% 11% / 0.08), inset 0 0 0 1px hsl(225 10% 11% / 0.06), 0 1px 0 hsl(0 0% 100% / 0.8)',
  raised:
    '0 0 0 0.5px hsl(225 10% 11% / 0.16), 0 1px 1px hsl(225 10% 11% / 0.06), 0 2px 4px -1px hsl(225 10% 11% / 0.07)',
  inkEdge: 'inset 0 1px 0 hsl(0 0% 100% / 0.18), 0 1px 1.5px hsl(225 10% 11% / 0.18)',
  card: '0 0 0 0.5px hsl(225 10% 11% / 0.12), 0 1px 2px hsl(225 10% 11% / 0.06), 0 8px 24px -6px hsl(225 10% 11% / 0.09)',
  medium: '0 1px 2px hsl(225 10% 11% / 0.14), 0 4px 12px -2px hsl(225 10% 11% / 0.18)',
  popover:
    '0 0 0 0.5px hsl(225 10% 11% / 0.11), 0 2px 4px -1px hsl(225 10% 11% / 0.06), 0 12px 32px -6px hsl(225 10% 11% / 0.16)',
  large:
    '0 0 0 0.5px hsl(225 10% 11% / 0.08), 0 2px 6px -2px hsl(225 10% 11% / 0.08), 0 24px 56px -12px hsl(225 10% 11% / 0.28)',
});

export const darkSheenTheme = stylex.createTheme(sheen, {
  raised: 'linear-gradient(hsl(0 0% 100% / 0.04), hsl(0 0% 100% / 0))',
  ink: 'linear-gradient(hsl(0 0% 0% / 0), hsl(0 0% 0% / 0.08))',
});

export const lightSheenTheme = stylex.createTheme(sheen, {
  raised: 'linear-gradient(hsl(225 10% 11% / 0), hsl(225 10% 11% / 0.03))',
  ink: 'linear-gradient(hsl(0 0% 100% / 0.1), hsl(0 0% 100% / 0))',
});
