import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import {
  CircleDashed,
  Copy,
  Info,
  Link2Off,
  Monitor,
  RadioTower,
  TriangleAlert,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Separator } from '@lody/ui/separator';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type {
  IosSimulatorPanelStatus,
  IosSimulatorViewerState,
  IosSimulatorViewerDiagnostics,
} from '@/lib/ios-simulator/ios-simulator-types';
import { useIosSimulatorStageLabel } from './ios-simulator-copy';

export type IosSimulatorPendingAction = 'start' | 'cancel' | 'stop' | null;

export type IosSimulatorConnectionStatusProps = {
  status: IosSimulatorPanelStatus;
  /** What the viewer page last reported for a ready preview. */
  viewerState?: IosSimulatorViewerState | null;
  viewerDiagnostics?: IosSimulatorViewerDiagnostics | null;
  /** Name of the device `status` is about. */
  deviceName?: string;
  pendingAction?: IosSimulatorPendingAction;
  onRetry?: () => void;
  onRestore?: () => void;
  onCancel?: () => void;
  onStop?: () => void;
  onCopyDiagnostics: () => void;
  hasError?: boolean;
};

type StatusKind = 'idle' | 'preparing' | 'direct' | 'remote' | 'interrupted' | 'failed';

const statusKind = (
  status: IosSimulatorPanelStatus,
  viewerState: IosSimulatorViewerState | null
): StatusKind => {
  switch (status.phase) {
    case 'ready':
      if (viewerState === 'disconnected' || viewerState === 'error') return 'interrupted';
      return status.transport === 'local' ? 'direct' : 'remote';
    case 'closed':
      return 'interrupted';
    default:
      return status.phase;
  }
};

const styles = stylex.create({
  glyph: { display: 'inline-flex', width: '14px', height: '14px', flexShrink: 0 },
  /** The word beside the mark gives way first when the panel is narrow. */
  word: {
    display: { default: 'inline', '@container (max-width: 360px)': 'none' },
  },
  panel: { display: 'flex', flexDirection: 'column', gap: space[2], width: '17rem' },
  title: {
    margin: 0,
    fontSize: text.subheadlineSize,
    lineHeight: text.subheadlineLeading,
    fontWeight: 600,
    color: colors.label,
  },
  detail: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: '18px',
    color: colors.secondaryLabel,
  },
  facts: {
    margin: 0,
    padding: 0,
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: space[1],
    fontSize: text.footnoteSize,
    lineHeight: '18px',
    color: colors.secondaryLabel,
  },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: space[1.5] },
  copy: { marginInlineEnd: 'auto' },
  info: { display: 'inline-block', verticalAlign: 'text-bottom' },
});

function StatusGlyph({ kind }: { kind: StatusKind }) {
  if (kind === 'preparing') return <Spinner size="small" label={null} />;
  if (kind === 'direct') return <Monitor size="100%" aria-hidden />;
  if (kind === 'remote') return <RadioTower size="100%" aria-hidden />;
  if (kind === 'interrupted') return <Link2Off size="100%" aria-hidden />;
  if (kind === 'failed') return <TriangleAlert size="100%" aria-hidden />;
  return <CircleDashed size="100%" aria-hidden />;
}

/**
 * The toolbar's second control: how this Session's preview is connected, and
 * the only place to stop it. It never shows an address — a remote viewer rides
 * an authenticated connection — and stopping never shuts the simulator down.
 */
export function IosSimulatorConnectionStatus({
  status,
  viewerState = null,
  viewerDiagnostics = null,
  deviceName,
  pendingAction = null,
  onRetry,
  onRestore,
  onCancel,
  onStop,
  onCopyDiagnostics,
  hasError = false,
}: IosSimulatorConnectionStatusProps) {
  const { t } = useTranslation();
  const stageLabel = useIosSimulatorStageLabel();
  const [open, setOpen] = useState(false);
  const kind = statusKind(status, viewerState);
  const canCancel = status.phase === 'preparing' && Boolean(status.operationId);
  const busy = pendingAction !== null;

  const word =
    kind === 'direct'
      ? t('sessions.iosSimulator.connection.direct', 'Direct')
      : kind === 'remote'
        ? t('sessions.iosSimulator.connection.remote', 'Remote')
        : kind === 'preparing'
          ? t('sessions.iosSimulator.connection.preparing', 'Starting…')
          : kind === 'interrupted'
            ? t('sessions.iosSimulator.connection.interrupted', 'Interrupted')
            : kind === 'failed'
              ? t('sessions.iosSimulator.connection.failed', 'Failed')
              : t('sessions.iosSimulator.connection.idle', 'Not previewing');

  const device = deviceName ?? t('sessions.iosSimulator.connection.thisDevice', 'the simulator');
  const title =
    kind === 'direct' || kind === 'remote'
      ? t('sessions.iosSimulator.connection.previewingTitle', 'Previewing {{device}}', { device })
      : kind === 'preparing' && status.phase === 'preparing'
        ? stageLabel(status.stage)
        : kind === 'interrupted'
          ? t('sessions.iosSimulator.connection.interruptedTitle', 'The preview was interrupted')
          : kind === 'failed'
            ? t('sessions.iosSimulator.connection.failedTitle', 'The preview failed')
            : t('sessions.iosSimulator.connection.idleTitle', 'No preview running');

  const detail =
    kind === 'direct'
      ? t(
          'sessions.iosSimulator.connection.directDetail',
          'Previewing on this Mac. No internet connection needed.'
        )
      : kind === 'remote'
        ? t(
            'sessions.iosSimulator.connection.remoteDetail',
            'View and control the simulator on your session’s Mac.'
          )
        : kind === 'preparing'
          ? t(
              'sessions.iosSimulator.connection.preparingDetail',
              'Cancelling leaves the simulator running.'
            )
          : kind === 'interrupted'
            ? t(
                'sessions.iosSimulator.connection.interruptedDetail',
                'The simulator is still running. Restore reconnects to it.'
              )
            : kind === 'failed'
              ? t(
                  'sessions.iosSimulator.connection.failedDetail',
                  'Try again, or copy the diagnostics for a bug report.'
                )
              : t(
                  'sessions.iosSimulator.connection.idleDetail',
                  'Choose a simulator and start a preview.'
                );

  const showDiagnostics =
    hasError ||
    kind === 'failed' ||
    (status.phase === 'ready' && (viewerState === 'error' || viewerState === 'disconnected'));
  const mode = kind === 'remote' && viewerState === 'ready' ? viewerDiagnostics?.transport : null;
  const hasActions =
    showDiagnostics ||
    (kind === 'preparing' && Boolean(onCancel)) ||
    (status.phase === 'ready' && Boolean(onStop)) ||
    (kind === 'interrupted' && Boolean(onRestore)) ||
    (kind === 'failed' && Boolean(onRetry));
  const showFacts = kind === 'direct' || kind === 'remote' || kind === 'interrupted';
  const accessibleName = t(
    'sessions.iosSimulator.connection.statusLabel',
    'Preview status: {{status}}',
    {
      status: word,
    }
  );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="small"
            tone={kind === 'failed' ? 'destructive' : 'neutral'}
            aria-label={accessibleName}
            data-testid="ios-simulator-status-trigger"
          >
            <span {...stylex.props(styles.glyph)}>
              <StatusGlyph kind={kind} />
            </span>
            <span {...stylex.props(styles.word)}>{word}</span>
          </Button>
        }
      />
      <Popover.Content align="end">
        <div {...stylex.props(styles.panel)}>
          <Popover.Title {...stylex.props(styles.title)}>{title}</Popover.Title>
          <Popover.Description {...stylex.props(styles.detail)}>{detail}</Popover.Description>
          {mode === 'webrtc' || mode === 'websocket' ? (
            <p {...stylex.props(styles.detail)}>
              <Info {...stylex.props(styles.info)} size={12} aria-hidden />{' '}
              {mode === 'webrtc'
                ? t('sessions.iosSimulator.connection.realtimeMode', 'Realtime mode')
                : t('sessions.iosSimulator.connection.compatibleMode', 'Compatibility mode')}
              {' — '}
              {mode === 'webrtc'
                ? t(
                    'sessions.iosSimulator.connection.realtimeHint',
                    'For responsive viewing and controls.'
                  )
                : t(
                    'sessions.iosSimulator.connection.compatibleHint',
                    'Keeps the preview available when realtime mode cannot connect.'
                  )}
            </p>
          ) : null}
          {showFacts ? (
            <ul {...stylex.props(styles.facts)}>
              <li>
                {t(
                  'sessions.iosSimulator.connection.controlFact',
                  'Only this session controls the simulator while it is previewed.'
                )}
              </li>
              <li>
                {t(
                  'sessions.iosSimulator.connection.stopFact',
                  'Stopping ends the preview; the simulator keeps running.'
                )}
              </li>
            </ul>
          ) : null}
          {hasActions ? <Separator /> : null}
          <div {...stylex.props(styles.actions)}>
            {showDiagnostics ? (
              <span {...stylex.props(styles.copy)}>
                <Button type="button" variant="ghost" size="mini" onClick={onCopyDiagnostics}>
                  <Copy size={12} aria-hidden />
                  {t('sessions.iosSimulator.connection.copyDiagnostics', 'Copy diagnostics')}
                </Button>
              </span>
            ) : null}
            {kind === 'preparing' && onCancel ? (
              <Button
                type="button"
                variant="secondary"
                size="mini"
                // A start still in flight is exactly what Cancel is for, once
                // the machine has named its operation.
                disabled={!canCancel || pendingAction === 'cancel'}
                onClick={onCancel}
              >
                {t('sessions.iosSimulator.action.cancel', 'Cancel')}
              </Button>
            ) : null}
            {status.phase === 'ready' && onStop ? (
              <Button
                type="button"
                variant="secondary"
                size="mini"
                disabled={busy}
                onClick={onStop}
              >
                {t('sessions.iosSimulator.action.stop', 'Stop preview')}
              </Button>
            ) : null}
            {kind === 'interrupted' && onRestore ? (
              <Button
                type="button"
                variant="primary"
                size="mini"
                disabled={busy}
                onClick={onRestore}
              >
                {t('sessions.iosSimulator.action.restore', 'Restore')}
              </Button>
            ) : null}
            {kind === 'failed' && onRetry ? (
              <Button type="button" variant="primary" size="mini" disabled={busy} onClick={onRetry}>
                {t('sessions.iosSimulator.action.retry', 'Try again')}
              </Button>
            ) : null}
          </div>
        </div>
      </Popover.Content>
    </Popover.Root>
  );
}
