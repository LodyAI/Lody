import * as stylex from '@stylexjs/stylex';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock, KeyRound, ShieldAlert, ShieldOff, WifiOff } from 'lucide-react';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { Spinner } from '@lody/ui/spinner';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';

export type E2eeAccessState =
  | 'pendingApproval'
  | 'waitingKey'
  | 'incomplete'
  | 'offline'
  | 'revoked'
  | 'verificationFailed';

/** The caller supplies the affected scope; this view never derives failure policy. */
export type E2eeAffectedScope = { kind: 'document' | 'workspace'; name: string };

export type E2eeRecoveryState = 'notSet' | 'importing' | 'partial' | 'failed';
export type E2eeRecoveryWorkspace = {
  id: string;
  name: string;
} & (
  | { state: 'notSet' | 'saved' | 'waitingKey' | 'failed' }
  | { state: 'verified'; verifiedKeyUpdate: number }
);

type Action = { onAction?: () => void; pending?: boolean };

const styles = stylex.create({
  card: {
    padding: '20px',
  },
  cardWarning: {
    backgroundColor: `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.warning} 3.5%)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.warning} 22%, transparent), ${shadow.card}`,
  },
  cardDanger: {
    backgroundColor: `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.destructive} 3%)`,
    boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${colors.destructive} 20%, transparent), ${shadow.card}`,
  },
  content: { display: 'grid', gap: space[4], minWidth: 0, overflowWrap: 'anywhere' },
  context: {
    margin: 0,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontWeight: 500,
  },
  statusMeta: {
    margin: 0,
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
  },
  message: { display: 'grid', gap: space[2] },
  titleRow: { display: 'flex', alignItems: 'center', gap: space[3] },
  glyph: {
    display: 'inline-grid',
    placeItems: 'center',
    flexShrink: 0,
    width: 32,
    height: 32,
    borderRadius: radius.small,
    backgroundColor: colors.secondaryBackground,
    color: colors.secondaryLabel,
  },
  glyphWarning: {
    backgroundColor: `color-mix(in oklab, ${colors.warning} 12%, transparent)`,
    color: colors.warning,
  },
  glyphDanger: {
    backgroundColor: `color-mix(in oklab, ${colors.destructive} 10%, transparent)`,
    color: colors.destructive,
  },
  warning: { color: colors.label },
  error: { color: colors.destructive },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[2], paddingBlockStart: space[1] },
  list: { margin: 0, padding: 0, listStyle: 'none' },
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'space-between',
    columnGap: space[3],
    rowGap: space[1],
    paddingBlock: space[3],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  rowName: { margin: 0, fontWeight: 500, fontSize: text.subheadlineSize },
  announcement: {
    position: 'absolute',
    width: 1,
    height: 1,
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
  },
});

function RecoveryChanges({ workspaces }: { workspaces: readonly E2eeRecoveryWorkspace[] }) {
  const { t } = useTranslation();
  const previous = useRef<Map<string, string> | null>(null);
  const [announcement, setAnnouncement] = useState({ sequence: 0, text: '' });

  useEffect(() => {
    const next = new Map<string, string>();
    const changes: string[] = [];
    for (const workspace of workspaces) {
      const result =
        workspace.state === 'verified'
          ? `verified:${workspace.verifiedKeyUpdate}`
          : workspace.state;
      next.set(workspace.id, result);
      // New IDs seed the baseline. Names, ordering and object identity are not results.
      if (previous.current?.has(workspace.id) && previous.current.get(workspace.id) !== result) {
        changes.push(
          t('e2ee.recovery.changed', {
            name: workspace.name,
            result:
              workspace.state === 'verified'
                ? t('e2ee.recovery.verifiedChange', { update: workspace.verifiedKeyUpdate })
                : t(`e2ee.recovery.workspace.${workspace.state}`),
          })
        );
      }
    }
    previous.current = next;
    if (changes.length > 0) {
      setAnnouncement((current) => ({ sequence: current.sequence + 1, text: changes.join(' ') }));
    }
  }, [workspaces, t]);

  return (
    <div role="status" aria-live="polite" aria-atomic="true" {...stylex.props(styles.announcement)}>
      {/* Replace the child for distinct changes with identical wording (e.g. same-name IDs). */}
      <span key={announcement.sequence}>{announcement.text}</span>
    </div>
  );
}

function StatusCard({
  title,
  description,
  context,
  tone = 'neutral',
  icon,
  actionLabel,
  pending,
  onAction,
  children,
}: {
  title: string;
  description: string;
  context: string;
  tone?: 'neutral' | 'warning' | 'danger';
  icon?: ReactNode;
  actionLabel: string;
  children?: ReactNode;
} & Action) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <Card.Root
      role="region"
      aria-labelledby={`${id}-title`}
      data-status-tone={tone}
      xstyle={[
        styles.card,
        tone === 'warning' && styles.cardWarning,
        tone === 'danger' && styles.cardDanger,
      ]}
    >
      <div {...stylex.props(styles.content)}>
        <p {...stylex.props(styles.context)}>{context}</p>
        <div role="status" aria-atomic="true" {...stylex.props(styles.message)}>
          <div {...stylex.props(styles.titleRow)}>
            {icon && (
              <span
                aria-hidden="true"
                {...stylex.props(
                  styles.glyph,
                  tone === 'warning' && styles.glyphWarning,
                  tone === 'danger' && styles.glyphDanger
                )}
              >
                {icon}
              </span>
            )}
            <Card.Title as="h2" id={`${id}-title`}>
              <span
                {...stylex.props(
                  tone === 'danger' && styles.error,
                  tone === 'warning' && styles.warning
                )}
              >
                {title}
              </span>
            </Card.Title>
          </div>
          <Card.Description id={`${id}-description`}>{description}</Card.Description>
          {pending ? <p {...stylex.props(styles.context)}>{t('e2ee.action.pending')}</p> : null}
        </div>
        {children}
        {onAction ? (
          <div {...stylex.props(styles.actions)}>
            <Button
              type="button"
              variant="secondary"
              size="large"
              aria-describedby={`${id}-description`}
              disabled={pending}
              focusableWhenDisabled
              onClick={onAction}
            >
              {actionLabel}
            </Button>
          </div>
        ) : null}
      </div>
    </Card.Root>
  );
}

const ACCESS_VISUAL: Record<
  E2eeAccessState,
  { tone: 'neutral' | 'warning' | 'danger'; icon: ReactNode }
> = {
  pendingApproval: { tone: 'neutral', icon: <Clock size={16} /> },
  waitingKey: { tone: 'neutral', icon: <KeyRound size={16} /> },
  incomplete: { tone: 'warning', icon: <AlertTriangle size={16} /> },
  offline: { tone: 'warning', icon: <WifiOff size={16} /> },
  revoked: { tone: 'danger', icon: <ShieldOff size={16} /> },
  verificationFailed: { tone: 'danger', icon: <ShieldAlert size={16} /> },
};

const RECOVERY_VISUAL: Record<
  E2eeRecoveryState,
  { tone: 'neutral' | 'warning' | 'danger'; icon: ReactNode }
> = {
  notSet: { tone: 'warning', icon: <AlertTriangle size={16} /> },
  importing: { tone: 'neutral', icon: <Spinner size="small" /> },
  partial: { tone: 'warning', icon: <AlertTriangle size={16} /> },
  failed: { tone: 'danger', icon: <ShieldAlert size={16} /> },
};

/** Presentational only: a click reports intent, never approval or key possession. */
export function E2eeAccessStatus({
  state,
  scope,
  ...action
}: {
  state: E2eeAccessState;
  scope: E2eeAffectedScope;
} & Action) {
  const { t } = useTranslation();
  const visual = ACCESS_VISUAL[state];
  return (
    <StatusCard
      title={t(`e2ee.access.${state}.title`)}
      description={t(`e2ee.access.${state}.description`)}
      context={t(`e2ee.scope.${scope.kind}`, { name: scope.name })}
      tone={visual.tone}
      icon={visual.icon}
      actionLabel={t(state === 'verificationFailed' ? 'e2ee.action.retry' : 'e2ee.action.check')}
      {...action}
    />
  );
}

/** Coverage and verification evidence are supplied per workspace, not inferred from a file. */
export function E2eeRecoveryStatus({
  state,
  workspaces,
  ...action
}: {
  state: E2eeRecoveryState;
  workspaces: readonly E2eeRecoveryWorkspace[];
} & Action) {
  const { t } = useTranslation();
  const visual = RECOVERY_VISUAL[state];
  return (
    <StatusCard
      title={t(`e2ee.recovery.${state}.title`)}
      description={t(`e2ee.recovery.${state}.description`)}
      context={t('e2ee.recovery.label')}
      tone={visual.tone}
      icon={visual.icon}
      actionLabel={t(state === 'notSet' ? 'e2ee.action.setup' : 'e2ee.action.retry')}
      {...action}
      pending={state === 'importing' || action.pending}
    >
      <p {...stylex.props(styles.context)}>{t('e2ee.recovery.explanation')}</p>
      <RecoveryChanges workspaces={workspaces} />
      {workspaces.length > 0 ? (
        <ul aria-label={t('e2ee.recovery.workspaces')} {...stylex.props(styles.list)}>
          {workspaces.map((workspace) => (
            <li key={workspace.id} {...stylex.props(styles.row)}>
              <p {...stylex.props(styles.rowName)}>{workspace.name}</p>
              <p {...stylex.props(styles.statusMeta, workspace.state === 'failed' && styles.error)}>
                {workspace.state === 'verified'
                  ? t('e2ee.recovery.workspace.verified', { update: workspace.verifiedKeyUpdate })
                  : t(`e2ee.recovery.workspace.${workspace.state}`)}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
    </StatusCard>
  );
}
