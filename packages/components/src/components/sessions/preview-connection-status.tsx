import type { PreviewConnection } from '@lody/shared';
import {
  CloudOff,
  Link2Off,
  Monitor,
  RadioTower,
  RefreshCw,
  TimerOff,
  TriangleAlert,
} from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Spinner } from '@lody/ui/spinner';
import { Tooltip } from '@lody/ui/tooltip';
import { PreviewDisconnectButton } from './preview-disconnect-button';

const styles = stylex.create({
  triggerGroup: { display: 'flex', alignItems: 'center', gap: '2px' },
  content: { width: '100%' },
  centeredContent: {
    display: 'flex',
    maxWidth: '28rem',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
  },
  headingRow: { display: 'flex', width: '100%', alignItems: 'flex-start', gap: '10px' },
  centeredHeadingRow: { flexDirection: 'column', alignItems: 'center' },
  statusMark: {
    display: 'flex',
    width: '24px',
    height: '24px',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.full,
    backgroundColor: 'hsl(var(--muted))',
    color: colors.secondaryLabel,
  },
  statusMarkDanger: {
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 10%, transparent)`,
    color: colors.destructive,
  },
  statusIcon: { flexShrink: 0, width: '14px', height: '14px' },
  statusIconFill: { width: '100%', height: '100%', flexShrink: 0 },
  statusText: { minWidth: 0 },
  title: {
    margin: 0,
    fontSize: '0.75rem',
    lineHeight: '1rem',
    fontWeight: 500,
    color: colors.label,
  },
  detail: {
    margin: 0,
    marginTop: '2px',
    fontSize: '11px',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  diagnostic: {
    width: '100%',
    marginTop: '8px',
    overflowWrap: 'break-word',
    borderRadius: '6px',
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 8%, transparent)`,
    paddingInline: '8px',
    paddingBlock: '6px',
    textAlign: 'left',
    fontSize: '11px',
    lineHeight: 1.375,
    color: colors.destructive,
  },
  facts: {
    width: '100%',
    margin: 0,
    marginTop: '8px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    padding: 0,
    paddingTop: '8px',
    listStyle: 'none',
    textAlign: 'left',
    fontSize: '11px',
    lineHeight: 1.375,
    color: colors.secondaryLabel,
  },
  factRow: { marginBottom: space[1] },
  actions: {
    display: 'flex',
    width: '100%',
    gap: '6px',
    marginTop: '8px',
    borderTopWidth: '1px',
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
    paddingTop: '8px',
  },
  centeredActions: { justifyContent: 'center' },
  trailingActions: { justifyContent: 'flex-end' },
  placeholder: {
    display: 'flex',
    flex: '1 1 0%',
    minHeight: 0,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.background,
    paddingInline: '24px',
    paddingBlock: '32px',
  },
});

export type PreviewConnectionStatusProps = {
  local: boolean;
  connection?: PreviewConnection;
  checking?: boolean;
  /** True when a background status check timed out while the current preview page stays visible. */
  unconfirmed?: boolean;
  busy?: boolean;
  unavailableReason?: string;
  error?: string | null;
  remoteMachineName?: string;
  hasShareUrl?: boolean;
  onRestore?: () => void;
  /** Direct one-click regenerate action shown in the address bar when expired/unavailable. */
  onRegenerate?: () => void;
  onStopSharing?: () => void;
  onStopAndKillProcess?: () => void;
};

type PreviewStatusKind =
  | 'local'
  | 'active'
  | 'connecting'
  | 'checking'
  | 'unconfirmed'
  | 'expired'
  | 'closed'
  | 'failed'
  | 'unavailable'
  | 'inactive';

type PreviewStatusPresentation = {
  kind: PreviewStatusKind;
  title: string;
  detail: string;
  diagnostic: string | null;
  facts: string[];
  restoreLabel: string;
  restoreDisabled: boolean;
  showRestore: boolean;
  showInlineRegenerate: boolean;
  showStopSharing: boolean;
  hasShareUrl: boolean;
  busy: boolean;
  onRestore?: () => void;
  onRegenerate?: () => void;
  onStopSharing?: () => void;
  onStopAndKillProcess?: () => void;
};

function usePreviewStatusPresentation({
  local,
  connection,
  checking,
  unconfirmed,
  busy,
  unavailableReason,
  error,
  remoteMachineName,
  hasShareUrl,
  onRestore,
  onRegenerate,
  onStopSharing,
  onStopAndKillProcess,
}: PreviewConnectionStatusProps): PreviewStatusPresentation {
  const { t } = useTranslation();
  const expired = connection?.status === 'closed' && connection.closedReason === 'idle_timeout';
  const failed = connection?.status === 'failed' || (Boolean(error) && !unconfirmed);
  const kind: PreviewStatusKind =
    busy || connection?.status === 'creating'
      ? 'connecting'
      : checking
        ? 'checking'
        : unavailableReason
          ? 'unavailable'
          : expired
            ? 'expired'
            : failed
              ? 'failed'
              : unconfirmed
                ? 'unconfirmed'
                : connection?.status === 'closed'
                  ? 'closed'
                  : connection?.status === 'active'
                    ? 'active'
                    : local
                      ? 'local'
                      : 'inactive';

  const title =
    kind === 'local'
      ? t('sessions.browser.connection.local', 'Local direct')
      : kind === 'active'
        ? t('sessions.browser.connection.active', 'Preview connected')
        : kind === 'connecting'
          ? t('sessions.browser.connection.connecting', 'Creating preview link…')
          : kind === 'checking'
            ? t('sessions.browser.connection.checking', 'Checking preview link…')
            : kind === 'unconfirmed'
              ? t(
                  'sessions.browser.connection.unconfirmed',
                  'Unable to confirm connection right now'
                )
              : kind === 'expired'
                ? t('sessions.browser.connection.expired', 'Preview link expired')
                : kind === 'closed'
                  ? t('sessions.browser.connection.closed', 'Preview stopped')
                  : kind === 'failed'
                    ? t('sessions.browser.connection.failed', 'Preview unavailable')
                    : kind === 'unavailable'
                      ? t('sessions.browser.connection.unavailable', 'Preview unavailable')
                      : t('sessions.browser.connection.inactive', 'Not shared');

  const localUnavailableDetail = t(
    'sessions.browser.connection.localUnavailableDetail',
    'Local viewing continues; remote sharing is unavailable.'
  );
  const detail =
    kind === 'local'
      ? t('sessions.browser.connection.localDetail', 'Direct preview on this machine.')
      : kind === 'active'
        ? local
          ? t(
              'sessions.browser.connection.localSharingDetail',
              'Direct locally; remote sharing is on.'
            )
          : t('sessions.browser.connection.activeDetail', 'Connected through a remote share link.')
        : kind === 'connecting'
          ? t(
              'sessions.browser.connection.creatingDetail',
              'Opening a remote share link for this localhost target.'
            )
          : kind === 'checking'
            ? t(
                'sessions.browser.connection.checkingDetail',
                'Verifying the preview link in the background.'
              )
            : kind === 'unconfirmed'
              ? t(
                  'sessions.browser.connection.unconfirmedDetail',
                  'Connection check timed out. Keeping the current page open.'
                )
              : kind === 'expired'
                ? local
                  ? localUnavailableDetail
                  : t(
                      'sessions.browser.connection.expiredDetail',
                      'Closed after 1 hour idle. The address is preserved.'
                    )
                : kind === 'closed'
                  ? local
                    ? localUnavailableDetail
                    : t('sessions.browser.connection.closedDetail', 'Remote sharing was stopped.')
                  : kind === 'failed' || kind === 'unavailable'
                    ? local
                      ? localUnavailableDetail
                      : t(
                          'sessions.browser.connection.failedDetail',
                          'Remote sharing is unavailable.'
                        )
                    : local
                      ? t(
                          'sessions.browser.connection.localDetail',
                          'Direct preview on this machine.'
                        )
                      : t(
                          'sessions.browser.connection.inactiveDetail',
                          'Remote sharing is not open.'
                        );

  // A reason (archive, ownership, machine offline) is more actionable than a
  // transport error, so it stays the visible diagnostic when both are present.
  const diagnostic = unavailableReason ?? error ?? connection?.error?.message ?? null;
  const facts: string[] = [];
  if (remoteMachineName) {
    facts.push(
      t('sessions.browser.connection.machineRelation', 'Remote machine: {{machine}}', {
        machine: remoteMachineName,
      })
    );
    facts.push(
      t(
        'sessions.browser.connection.enterConsent',
        'Enter authorizes this localhost target. Anyone with the link can access it.'
      )
    );
  } else if (hasShareUrl) {
    facts.push(
      t('sessions.browser.connection.linkAccess', 'Anyone with the link can access this preview.')
    );
  }
  if (remoteMachineName || hasShareUrl) {
    facts.push(t('sessions.browser.connection.idlePolicy', 'Closes after 1 hour idle.'));
  }

  const needsRebuild =
    kind === 'expired' || kind === 'closed' || kind === 'failed' || kind === 'inactive';
  const showRestore =
    Boolean(onRestore) && (needsRebuild || kind === 'unavailable' || kind === 'unconfirmed');
  const showInlineRegenerate = !local && Boolean(onRegenerate) && needsRebuild;
  const showStopSharing = Boolean(
    onStopSharing && ((hasShareUrl && kind === 'active') || (local && kind === 'local'))
  );
  const restoreLabel =
    connection?.closedReason === 'revoked'
      ? t('sessions.browser.connection.reopen', 'Reopen preview')
      : t('sessions.browser.connection.restore', 'Restore preview');

  return {
    kind,
    title,
    detail,
    diagnostic,
    facts,
    restoreLabel,
    restoreDisabled: Boolean(busy || checking || unavailableReason),
    showRestore,
    showInlineRegenerate,
    showStopSharing,
    hasShareUrl: Boolean(hasShareUrl),
    busy: Boolean(busy),
    onRestore,
    onRegenerate,
    onStopSharing,
    onStopAndKillProcess,
  };
}

function StatusGlyph({ kind, fill = false }: { kind: PreviewStatusKind; fill?: boolean }) {
  const glyphStyle = stylex.props(fill ? styles.statusIconFill : styles.statusIcon);
  if (kind === 'connecting' || kind === 'checking') {
    return <Spinner label={null} diameter={fill ? '100%' : 'calc(var(--spacing) * 3.5)'} />;
  }
  if (kind === 'local') return <Monitor {...glyphStyle} aria-hidden />;
  if (kind === 'active') return <RadioTower {...glyphStyle} aria-hidden />;
  if (kind === 'expired') return <TimerOff {...glyphStyle} aria-hidden />;
  if (kind === 'closed') return <Link2Off {...glyphStyle} aria-hidden />;
  if (kind === 'failed' || kind === 'unavailable' || kind === 'unconfirmed')
    return <TriangleAlert {...glyphStyle} aria-hidden />;
  return <CloudOff {...glyphStyle} aria-hidden />;
}

function PreviewStatusContent({
  presentation,
  centered = false,
  showFacts = true,
}: {
  presentation: PreviewStatusPresentation;
  centered?: boolean;
  showFacts?: boolean;
}) {
  const { t } = useTranslation();
  const {
    kind,
    title,
    detail,
    diagnostic,
    facts,
    restoreLabel,
    restoreDisabled,
    showRestore,
    showStopSharing,
    hasShareUrl,
    busy,
    onRestore,
    onStopSharing,
    onStopAndKillProcess,
  } = presentation;

  const contentStyle = stylex.props(styles.content, centered && styles.centeredContent);
  const headingStyle = stylex.props(styles.headingRow, centered && styles.centeredHeadingRow);
  const actionsStyle = stylex.props(
    styles.actions,
    centered ? styles.centeredActions : styles.trailingActions
  );
  return (
    <div {...contentStyle}>
      <div {...headingStyle}>
        <span
          {...stylex.props(
            styles.statusMark,
            (kind === 'failed' || kind === 'unavailable') && styles.statusMarkDanger
          )}
        >
          <StatusGlyph kind={kind} />
        </span>
        <div {...stylex.props(styles.statusText)}>
          <p {...stylex.props(styles.title)}>{title}</p>
          <p {...stylex.props(styles.detail)}>{detail}</p>
        </div>
      </div>
      {diagnostic ? <p {...stylex.props(styles.diagnostic)}>{diagnostic}</p> : null}
      {showFacts && facts.length > 0 ? (
        <ul {...stylex.props(styles.facts)}>
          {facts.map((fact, index) => (
            <li key={fact} {...stylex.props(index < facts.length - 1 && styles.factRow)}>
              {fact}
            </li>
          ))}
        </ul>
      ) : null}
      {showRestore || showStopSharing ? (
        <div {...actionsStyle}>
          {showStopSharing && onStopSharing ? (
            <PreviewDisconnectButton
              size="mini"
              primaryLabel={
                hasShareUrl
                  ? t('sessions.browser.stopSharing', 'Stop sharing')
                  : t('sessions.browser.stopPreview', 'Close preview')
              }
              menuAriaLabel={t('sessions.browser.disconnectOptions', 'Preview disconnect options')}
              disconnectOnlyLabel={
                hasShareUrl
                  ? t('sessions.browser.disconnectRemoteOnly', 'Stop remote preview only')
                  : t('sessions.browser.disconnectPreviewOnly', 'Close preview only')
              }
              disconnectAndTerminateLabel={t(
                'sessions.browser.disconnectAndStopProcess',
                'Close preview and stop server'
              )}
              disabled={busy}
              onDisconnectOnly={onStopSharing}
              onDisconnectAndTerminate={onStopAndKillProcess}
            />
          ) : null}
          {showRestore ? (
            <Button
              type="button"
              variant="secondary"
              size="mini"
              disabled={restoreDisabled}
              onClick={onRestore}
            >
              {restoreLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** One address-bar status control: distinct icon, accessible name, hover label and compact details popover. */
export function PreviewConnectionStatus(props: PreviewConnectionStatusProps) {
  const { t } = useTranslation();
  const presentation = usePreviewStatusPresentation(props);
  const accessibleName = t(
    'sessions.browser.connection.statusLabel',
    'Preview status: {{status}}',
    { status: presentation.title }
  );
  const regenerateLabel = t(
    'sessions.browser.connection.regenerateLink',
    'Regenerate preview link'
  );

  return (
    <Tooltip.Provider delay={250}>
      <div {...stylex.props(styles.triggerGroup)}>
        {presentation.showInlineRegenerate ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="mini"
                  icon
                  disabled={Boolean(props.busy || props.unavailableReason)}
                  data-testid="preview-regenerate-button"
                  aria-label={regenerateLabel}
                  onClick={presentation.onRegenerate}
                >
                  <RefreshCw {...stylex.props(styles.statusIconFill)} aria-hidden />
                </Button>
              }
            />
            <Tooltip.Content side="bottom">{regenerateLabel}</Tooltip.Content>
          </Tooltip.Root>
        ) : null}
        <Popover.Root>
          <Tooltip.Root>
            <Tooltip.Trigger
              render={
                <Popover.Trigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="mini"
                      icon
                      tone={
                        presentation.kind === 'failed' || presentation.kind === 'unavailable'
                          ? 'destructive'
                          : 'neutral'
                      }
                      data-testid="preview-status-trigger"
                      aria-label={accessibleName}
                    >
                      <StatusGlyph kind={presentation.kind} fill />
                    </Button>
                  }
                />
              }
            />
            <Tooltip.Content side="bottom">{presentation.title}</Tooltip.Content>
          </Tooltip.Root>
          <Popover.Content align="end" sideOffset={6} width="calc(var(--spacing) * 72)">
            <Popover.Title visuallyHidden>{accessibleName}</Popover.Title>
            <PreviewStatusContent presentation={presentation} />
          </Popover.Content>
        </Popover.Root>
      </div>
    </Tooltip.Provider>
  );
}

/** Full-size reason/recovery surface for when remote content is not mounted. */
export function PreviewConnectionPlaceholder(props: PreviewConnectionStatusProps) {
  const presentation = usePreviewStatusPresentation(props);
  return (
    <div role="status" aria-live="polite" {...stylex.props(styles.placeholder)}>
      <PreviewStatusContent presentation={presentation} centered showFacts={false} />
    </div>
  );
}
