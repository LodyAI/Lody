import type { ReactNode } from 'react';
import { Compass, Eye, PenLine, ShieldAlert, ShieldOff, type LucideIcon } from 'lucide-react';
import { classifyPermissionModeFace, type PermissionModeFaceKind } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import { themeFontWeight, themeSpace } from '../../style/theme-scale.stylex';
import { withClassName } from '@/lib/stylex';

const styles = stylex.create({
  label: {
    fontSize: '11px',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1,
    color: themeColors.mutedForeground,
  },
  icon: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
  },
  iconMuted: {
    color: themeColors.mutedForeground,
  },
  iconWarning: {
    color: themeColors.statusWarning,
  },
});

const MODE_FACE_ICON: Partial<Record<PermissionModeFaceKind, LucideIcon>> = {
  'read-only': Eye,
  'accept-edits': PenLine,
  plan: Compass,
  deny: ShieldOff,
  'full-access': ShieldAlert,
};

/**
 * Compact permission-mode indicator for the composer "run config" button face.
 *
 * Renders nothing for the normal/default mode or unknown third-party modes
 * (classification lives in `@lody/shared` `classifyPermissionModeFace`, keyed
 * to the built-in mode lists so it never drifts), the amber `ShieldAlert` for
 * any warning-tone mode (Codex full access, Claude skip-permissions), a neutral
 * icon for other notable modes, and the short literal "Auto" for Claude's auto
 * mode. The full, possibly long, mode name lives in the run-config sheet — never
 * here.
 */
export function PermissionModeFaceIndicator({
  modeId,
  className,
}: {
  modeId: string | null | undefined;
  className?: string;
}): ReactNode {
  const face = classifyPermissionModeFace(modeId);
  if (face.kind === 'hidden') return null;
  if (face.render === 'auto-label') {
    return <span {...withClassName(stylex.props(styles.label), className)}>Auto</span>;
  }
  // Warning modes all share the amber alert glyph so full access and
  // skip-permissions read identically here and in the run-config sheet.
  const Icon = face.tone === 'warning' ? ShieldAlert : MODE_FACE_ICON[face.kind];
  if (!Icon) return null;
  return (
    <Icon
      aria-hidden="true"
      {...withClassName(
        stylex.props(styles.icon, face.tone === 'warning' ? styles.iconWarning : styles.iconMuted),
        className
      )}
    />
  );
}
