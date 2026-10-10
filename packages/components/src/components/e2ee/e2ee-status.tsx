import * as stylex from '@stylexjs/stylex';
import { useId, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Card } from '@lody/ui/card';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';

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
  content: { display: 'grid', gap: space[4], minWidth: 0, overflowWrap: 'anywhere' },
  context: { margin: 0, color: colors.secondaryLabel, fontSize: '0.9em' },
  message: { display: 'grid', gap: space[2] },
  error: { color: colors.destructive },
  actions: { display: 'flex', flexWrap: 'wrap', gap: space[3] },
  list: { margin: 0, padding: 0, listStyle: 'none' },
  row: {
    display: 'grid',
    gap: space[1],
    paddingBlock: space[3],
    borderTopWidth: 1,
    borderTopStyle: 'solid',
    borderTopColor: colors.separator,
  },
  rowName: { margin: 0, fontWeight: 500 },
});

function StatusCard({
  title,
  description,
  context,
  error,
  actionLabel,
  pending,
  onAction,
  children,
}: {
  title: string;
  description: string;
  context: string;
  error?: boolean;
  actionLabel: string;
  children?: ReactNode;
} & Action) {
  const { t } = useTranslation();
  const id = useId();
  return (
    <Card.Root role="region" aria-labelledby={`${id}-title`}>
      <div {...stylex.props(styles.content)}>
        <p {...stylex.props(styles.context)}>{context}</p>
        <div role="status" aria-atomic="true" {...stylex.props(styles.message)}>
          <Card.Title as="h2" id={`${id}-title`}>
            <span {...stylex.props(error && styles.error)}>{title}</span>
          </Card.Title>
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
  return (
    <StatusCard
      title={t(`e2ee.access.${state}.title`)}
      description={t(`e2ee.access.${state}.description`)}
      context={t(`e2ee.scope.${scope.kind}`, { name: scope.name })}
      error={state === 'verificationFailed' || state === 'revoked'}
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
  return (
    <StatusCard
      title={t(`e2ee.recovery.${state}.title`)}
      description={t(`e2ee.recovery.${state}.description`)}
      context={t('e2ee.recovery.label')}
      error={state === 'failed'}
      actionLabel={t(state === 'notSet' ? 'e2ee.action.setup' : 'e2ee.action.retry')}
      {...action}
      pending={state === 'importing' || action.pending}
    >
      <p {...stylex.props(styles.context)}>{t('e2ee.recovery.explanation')}</p>
      {workspaces.length > 0 ? (
        <ul aria-label={t('e2ee.recovery.workspaces')} {...stylex.props(styles.list)}>
          {workspaces.map((workspace) => (
            <li key={workspace.id} {...stylex.props(styles.row)}>
              <p {...stylex.props(styles.rowName)}>{workspace.name}</p>
              <p {...stylex.props(styles.context, workspace.state === 'failed' && styles.error)}>
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
