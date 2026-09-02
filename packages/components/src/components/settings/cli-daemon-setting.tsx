import { Loader2, Play, RotateCcw, Square } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { ElectronCliState } from '@lody/shared';
import { cn } from '@/lib/utils';
import { Button } from '@lody/ui/button';
import { useElectronCliDaemon } from '@/hooks/use-electron-cli-daemon';
import { CompactRow } from './compact-layout';

const PHASE_TONE: Record<ElectronCliState['phase'], string> = {
  starting: 'bg-status-warning',
  running: 'bg-status-success',
  degraded: 'bg-status-warning',
  reconnecting: 'bg-status-warning',
  offline: 'bg-status-danger',
  fatal: 'bg-status-danger',
  stopping: 'bg-status-warning',
  stopped: 'bg-muted-foreground/50',
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
    <div id="cli-daemon" className="scroll-mt-24">
      <CompactRow
        label={t('settings.general.cliDaemon.label', 'Daemon')}
        helper={t(
          'settings.general.cliDaemon.helper',
          'The background process that runs local agents and terminals.'
        )}
        alignTop
      >
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
            <span className={cn('h-1.5 w-1.5 rounded-full', PHASE_TONE[phase])} />
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
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : isStopped ? (
              <Play className="h-3.5 w-3.5" />
            ) : (
              <RotateCcw className="h-3.5 w-3.5" />
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
            {isTerminating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Square className="h-3.5 w-3.5" />
            )}
            {t('sidebar.cli.terminate', 'Terminate')}
          </Button>
        </div>
      </CompactRow>
    </div>
  );
}
