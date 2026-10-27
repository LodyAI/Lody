import { Check } from 'lucide-react';
import { motion } from 'framer-motion';
import * as stylex from '@stylexjs/stylex';
import type { LodyResolvedVSCodeTheme } from '@/lib/vscode-theme';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeShadow,
  themeSpace,
} from '../../style/theme-scale.stylex';

const styles = stylex.create({
  /**
   * The tile: a swatch frame with the theme's name under it. Its focus ring
   * was a Tailwind `focus-visible:ring-*`, which this app paints as nothing
   * (the global focus rule zeroes Tailwind's ring shadow) — and which also
   * erased the app's global focus ring on the tile. The tile therefore keeps
   * no focus indicator, exactly as before.
   */
  tile: {
    position: 'relative',
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
    overflow: 'hidden',
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    padding: themeSpace[2],
    textAlign: 'left',
    boxShadow: { default: null, ':focus-visible': 'none' },
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The selected tile: the theme's accent, and a halo in the same accent. */
  tileSelected: {
    borderColor: 'hsl(var(--primary) / 0.6)',
    // The halo is the tile's own Tailwind shadow: Tailwind composed it with
    // the ring, so it survived the focused state. It stays, and the focused
    // state still shows no ring.
    boxShadow: {
      default: '0 0 0 3px hsl(var(--primary) / 0.1)',
      ':focus-visible': '0 0 0 3px hsl(var(--primary) / 0.1)',
    },
  },
  /** An unselected tile: the ordinary edge, which strengthens under the pointer. */
  tileIdle: {
    borderColor: 'hsl(var(--border) / 0.6)',
    ':hover': { borderColor: 'hsl(var(--border))' },
  },
  /** The mock editor behind the swatch. */
  preview: {
    position: 'relative',
    height: themeSpace[16],
    width: '100%',
    overflow: 'hidden',
    borderRadius: themeRadius.lg,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.3)',
  },
  /** The mock lines inside the swatch. */
  lines: {
    position: 'absolute',
    top: themeSpace[2],
    right: themeSpace[2],
    bottom: themeSpace[2],
    left: themeSpace[2],
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1.5],
  },
  line: { display: 'flex', alignItems: 'center', gap: themeSpace[1] },
  lineIndented: { paddingLeft: themeSpace[3] },
  /** One mock line: a filled bar. */
  bar: { display: 'block', height: themeSpace[1.5], borderRadius: themeRadius.full },
  bar2: { width: themeSpace[2] },
  bar3: { width: themeSpace[3] },
  bar5: { width: themeSpace[5] },
  bar8: { width: themeSpace[8] },
  bar10: { width: themeSpace[10] },
  bar12: { width: themeSpace[12] },
  /** The check badge on the selected tile. */
  badge: {
    position: 'absolute',
    right: themeSpace[1.5],
    top: themeSpace[1.5],
    display: 'flex',
    height: themeSpace[5],
    width: themeSpace[5],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.primary,
    color: themeColors.primaryForeground,
    boxShadow: themeShadow.sm,
  },
  badgeMark: { height: themeSpace[3], width: themeSpace[3] },
  /** The theme's name under the swatch. */
  label: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
});

/**
 * Mock-editor swatch preview for a single VSCode theme. Renders a
 * tile with a small mocked code-lines preview painted in the
 * theme's actual bg / fg / accent / muted colors, the theme's name
 * below, and a check badge when selected.
 *
 * Shared by the desktop onboarding theme screen and the mobile
 * general-settings code-theme picker — keeping the swatch logic
 * in one place avoids the "swatch colors look different across
 * surfaces" drift when picking which key to read from
 * `theme.colors` (the same key set is right in both places).
 */
export function ThemeTile({
  theme,
  selected,
  onSelect,
}: {
  theme: LodyResolvedVSCodeTheme;
  selected: boolean;
  onSelect: () => void;
}) {
  const colors = theme.colors as Record<string, string>;
  const bg = colors['editor.background'] ?? colors['sideBar.background'] ?? '#1e1e1e';
  const fg = colors['editor.foreground'] ?? colors['foreground'] ?? '#cccccc';
  const accent =
    colors['focusBorder'] ??
    colors['statusBar.background'] ??
    colors['button.background'] ??
    '#3794ff';
  const muted =
    colors['editorLineNumber.foreground'] ??
    colors['descriptionForeground'] ??
    'rgba(127,127,127,0.6)';

  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.98 }}
      onClick={onSelect}
      aria-pressed={selected}
      {...stylex.props(styles.tile, selected ? styles.tileSelected : styles.tileIdle)}
    >
      <div {...stylex.props(styles.preview)} style={{ background: bg }}>
        {/* Mock editor lines */}
        <div {...stylex.props(styles.lines)}>
          <div {...stylex.props(styles.line)}>
            <span {...stylex.props(styles.bar, styles.bar2)} style={{ background: muted }} />
            <span {...stylex.props(styles.bar, styles.bar10)} style={{ background: accent }} />
          </div>
          <div {...stylex.props(styles.line, styles.lineIndented)}>
            <span {...stylex.props(styles.bar, styles.bar3)} style={{ background: muted }} />
            <span
              {...stylex.props(styles.bar, styles.bar8)}
              style={{ background: fg, opacity: 0.7 }}
            />
            <span
              {...stylex.props(styles.bar, styles.bar5)}
              style={{ background: accent, opacity: 0.7 }}
            />
          </div>
          <div {...stylex.props(styles.line, styles.lineIndented)}>
            <span {...stylex.props(styles.bar, styles.bar3)} style={{ background: muted }} />
            <span
              {...stylex.props(styles.bar, styles.bar12)}
              style={{ background: fg, opacity: 0.5 }}
            />
          </div>
        </div>
        {selected ? (
          <span {...stylex.props(styles.badge)}>
            <Check {...stylex.props(styles.badgeMark)} />
          </span>
        ) : null}
      </div>
      <div {...stylex.props(styles.label)} title={theme.label}>
        {theme.label}
      </div>
    </motion.button>
  );
}
