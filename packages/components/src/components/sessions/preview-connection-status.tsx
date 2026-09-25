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
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Popover } from '@lody/ui/popover';
import { Spinner } from '@lody/ui/spinner';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';

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

function StatusGlyph({ kind, className }: { kind: PreviewStatusKind; className?: string }) {
  const glyphClassName = cn('shrink-0', className);
  if (kind === 'connecting') {
    return <Spinner label={null} className={glyphClassName} />;
  }
  if (kind === 'checking') {
    return <RefreshCw className={glyphClassName} aria-hidden />;
  }
  if (kind === 'local') return <Monitor className={glyphClassName} aria-hidden />;
  if (kind === 'active') return <RadioTower className={glyphClassName} aria-hidden />;
  if (kind === 'expired') return <TimerOff className={glyphClassName} aria-hidden />;
  if (kind === 'closed') return <Link2Off className={glyphClassName} aria-hidden />;
  if (kind === 'failed' || kind === 'unavailable')
    return <TriangleAlert className={glyphClassName} aria-hidden />;
  return <CloudOff className={glyphClassName} aria-hidden />;
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

  return (
    <div className={cn('w-full', centered && 'flex max-w-md flex-col items-center text-center')}>
      <div className={cn('flex w-full items-start gap-2.5', centered && 'flex-col items-center')}>
        <span
          className={cn(
            'flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground',
            (kind === 'failed' || kind === 'unavailable') && 'bg-destructive/10 text-destructive'
          )}
        >
          <StatusGlyph kind={kind} className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0">
          <p className="text-xs font-medium text-foreground">{title}</p>
          <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{detail}</p>
        </div>
      </div>
      {diagnostic ? (
        <p className="mt-2 w-full break-words rounded-md bg-destructive/8 px-2 py-1.5 text-left text-[11px] leading-snug text-destructive">
          {diagnostic}
        </p>
      ) : null}
      {showFacts && facts.length > 0 ? (
        <ul className="mt-2 w-full space-y-1 border-t border-border pt-2 text-left text-[11px] leading-snug text-muted-foreground">
          {facts.map((fact) => (
            <li key={fact}>{fact}</li>
          ))}
        </ul>
      ) : null}
      {showRestore || showStopSharing ? (
        <div
          className={cn(
            'mt-2 flex w-full gap-1.5 border-t border-border pt-2',
            centered ? 'justify-center' : 'justify-end'
          )}
        >
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
                    <StatusGlyph kind={presentation.kind} className="h-full w-full" />
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
    <div
      role="status"
      aria-live="polite"
      className="flex min-h-0 flex-1 items-center justify-center bg-background px-6 py-8"
    >
      <PreviewStatusContent presentation={presentation} centered showFacts={false} />
    </div>
  );
}
