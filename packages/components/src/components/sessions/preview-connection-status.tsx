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
import { cn } from '@/lib/utils';

const styles = stylex.create({
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
  busy?: boolean;
  unavailableReason?: string;
  error?: string | null;
  remoteMachineName?: string;
  hasShareUrl?: boolean;
  onRestore?: () => void;
  onStopSharing?: () => void;
};

type PreviewStatusKind =
  | 'local'
  | 'active'
  | 'connecting'
  | 'checking'
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
  showStopSharing: boolean;
  onRestore?: () => void;
  onStopSharing?: () => void;
};

function usePreviewStatusPresentation({
  local,
  connection,
  checking,
  busy,
  unavailableReason,
  error,
  remoteMachineName,
  hasShareUrl,
  onRestore,
  onStopSharing,
}: PreviewConnectionStatusProps): PreviewStatusPresentation {
  const { t } = useTranslation();
  const expired = connection?.status === 'closed' && connection.closedReason === 'idle_timeout';
  const failed = connection?.status === 'failed' || Boolean(error);
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
            ? t('sessions.browser.connection.checking', 'Checking preview…')
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
                'Refreshing the remote sharing status.'
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

  const showRestore =
    Boolean(onRestore) &&
    (kind === 'expired' ||
      kind === 'closed' ||
      kind === 'failed' ||
      kind === 'unavailable' ||
      kind === 'inactive');
  const showStopSharing = Boolean(onStopSharing && hasShareUrl && kind === 'active');
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
    showStopSharing,
    onRestore,
    onStopSharing,
  };
}

function StatusGlyph({ kind, fill = false }: { kind: PreviewStatusKind; fill?: boolean }) {
  const glyphStyle = stylex.props(fill ? styles.statusIconFill : styles.statusIcon);
  const spinnerClassName = cn('shrink-0', fill ? 'h-full w-full' : 'h-3.5 w-3.5');
  if (kind === 'connecting') {
    return <Spinner label={null} className={spinnerClassName} />;
  }
  if (kind === 'checking') {
    return <RefreshCw {...glyphStyle} aria-hidden />;
  }
  if (kind === 'local') return <Monitor {...glyphStyle} aria-hidden />;
  if (kind === 'active') return <RadioTower {...glyphStyle} aria-hidden />;
  if (kind === 'expired') return <TimerOff {...glyphStyle} aria-hidden />;
  if (kind === 'closed') return <Link2Off {...glyphStyle} aria-hidden />;
  if (kind === 'failed' || kind === 'unavailable')
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
    onRestore,
    onStopSharing,
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
          {showStopSharing ? (
            <Button type="button" variant="secondary" size="mini" onClick={onStopSharing}>
              {t('sessions.browser.stopSharing', 'Stop sharing')}
            </Button>
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

  return (
    <Popover.Root>
      <Tooltip.Provider delay={250}>
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
      </Tooltip.Provider>
      <Popover.Content align="end" sideOffset={6} className="w-72">
        <Popover.Title className="sr-only">{accessibleName}</Popover.Title>
        <PreviewStatusContent presentation={presentation} />
      </Popover.Content>
    </Popover.Root>
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
