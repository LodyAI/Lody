import { Play, RotateCcw, Square } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { corner, radius, space } from '@lody/ui/tokens/scales.stylex';
import { Spinner } from '@lody/ui/spinner';
import { useTranslation } from 'react-i18next';
import type { ElectronCliState } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { useElectronCliDaemon } from '@/hooks/use-electron-cli-daemon';
import { CompactRow } from './compact-layout';
import { settingsType as type } from './type.stylex';

const styles = stylex.create({
  anchor: { scrollMarginTop: '96px' },
  status: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1.5],
    whiteSpace: 'nowrap',
    fontSize: type.caption,
    color: colors.secondaryLabel,
  },
  dot: {
    width: '6px',
    height: '6px',
    flexShrink: 0,
    borderRadius: radius.full,
    cornerShape: corner.round,
  },
  success: { backgroundColor: colors.success },
  warning: { backgroundColor: colors.warning },
  danger: { backgroundColor: colors.destructive },
  idle: { backgroundColor: colors.tertiaryLabel },
  icon: { width: '14px', height: '14px', flexShrink: 0 },
});

const PHASE_TONE: Record<ElectronCliState['phase'], stylex.StyleXStyles> = {
  starting: styles.warning,
  running: styles.success,
  degraded: styles.warning,
  reconnecting: styles.warning,
  offline: styles.danger,
  fatal: styles.danger,
  stopping: styles.warning,
  stopped: styles.idle,
};

/**
 * "Daemon" row for Settings → General → Startup: shows the local CLI daemon
 * status and its restart/terminate controls (relocated here from the terminal
 * dock). Buttons show in-place loading while their action is in flight.
 */
export function CliDaemonSetting() {
  const { t } = useTranslation();
  const { state, phase, isRestarting, isTerminating, restart, terminate } = useElectronCliDaemon();

  const phaseLabels: Record<ElectronCliState['phase'], string> = {
    starting: t('sidebar.cli.starting', 'Starting'),
    running: t('sidebar.cli.running', 'Running'),
    degraded: t('sidebar.cli.degraded', 'Degraded'),
    reconnecting: t('sidebar.cli.reconnecting', 'Reconnecting'),
    offline: t('sidebar.cli.offline', 'Offline'),
    fatal: t('sidebar.cli.fatal', 'Fatal'),
    stopping: t('sidebar.cli.stopping', 'Stopping'),
    stopped: t('sidebar.cli.stopped', 'Stopped'),
  };

  const busy = isRestarting || isTerminating;
  const isStopped = phase === 'stopped';
  const localAgentEnabled = state?.localAgentEnabled === true;

  return (
    <div id="cli-daemon" {...stylex.props(styles.anchor)}>
      <CompactRow
        label={t('settings.general.cliDaemon.label', 'Daemon')}
        helper={t(
          'settings.general.cliDaemon.helper',
          'The background process that runs local agents and terminals.'
        )}
        alignTop
      >
        <span {...stylex.props(styles.status)}>
          <span {...stylex.props(styles.dot, PHASE_TONE[phase])} />
          {phaseLabels[phase]}
        </span>
        <Button
          type="button"
          variant="secondary"
          size="small"
          disabled={busy || !localAgentEnabled}
          onClick={() => void restart()}
        >
          {isRestarting ? (
            <Spinner size="small" />
          ) : isStopped ? (
            <Play {...stylex.props(styles.icon)} />
          ) : (
            <RotateCcw {...stylex.props(styles.icon)} />
          )}
          {isStopped ? t('sidebar.cli.start', 'Start') : t('sidebar.cli.restart', 'Restart')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="small"
          tone="destructive"
          disabled={busy || isStopped}
          onClick={() => void terminate()}
        >
          {isTerminating ? <Spinner size="small" /> : <Square {...stylex.props(styles.icon)} />}
          {t('sidebar.cli.terminate', 'Terminate')}
        </Button>
      </CompactRow>
    </div>
  );
}
