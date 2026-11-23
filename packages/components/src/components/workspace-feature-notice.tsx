import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { WorkspaceRestrictedFeature } from '@lody/shared/workspace-streams-content';
import { useWorkspaceFeatureReason } from '@/hooks/use-workspace-feature';

const styles = stylex.create({
  reason: { whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0 },
  notice: { margin: 0, padding: space[3], color: colors.secondaryLabel, fontSize: '0.9em' },
});

export function WorkspaceFeatureNotice({ feature }: { feature: WorkspaceRestrictedFeature }) {
  const reason = useWorkspaceFeatureReason(feature);
  return reason ? (
    <p role="status" {...stylex.props(styles.notice)}>
      {reason}
    </p>
  ) : null;
}

/** Keep full reasons readable inside the menu's normally truncated label slot. */
export function WorkspaceFeatureReasonText({ reason }: { reason: string }) {
  return <span {...stylex.props(styles.reason)}>{reason}</span>;
}
