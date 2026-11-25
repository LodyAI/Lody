import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import type { E2eeActionableFailure, E2eeRecoveryAction } from '@/lib/e2ee-actionable-failure';

const styles = stylex.create({
  code: {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: text.captionSize,
    color: colors.tertiaryLabel,
    userSelect: 'all',
  },
  actions: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: space[2],
  },
});

const ACTION_LABEL_KEYS: Record<E2eeRecoveryAction, string> = {
  retry_saved: 'e2ee.team.retry',
  resume_existing_request: 'e2ee.actionable.action.resumeExisting',
  cancel_previous_request: 'e2ee.actionable.action.cancelAndUseNew',
  open_workspace: 'e2ee.team.openWorkspace',
  repair_device: 'e2ee.devices.pairAgain',
  verify_email: 'e2ee.team.verify',
  unlock_custody: 'e2ee.actionable.action.retryAfterUnlock',
  upgrade_client: 'e2ee.actionable.action.checkUpdates',
  refresh_state: 'e2ee.actionable.action.refresh',
  restart_pairing: 'e2ee.auto.restart',
  reset_identity: 'e2ee.actionable.action.resetIdentity',
  back_home: 'e2ee.team.home',
};

export function E2eeActionableError({
  failure,
  busy,
  onAction,
}: {
  failure: E2eeActionableFailure;
  busy?: boolean;
  onAction?: Partial<Record<E2eeRecoveryAction, () => void>>;
}) {
  const { t } = useTranslation();
  const primaryHandler = onAction?.[failure.primaryAction];
  const secondaryHandler = failure.secondaryAction
    ? onAction?.[failure.secondaryAction]
    : undefined;
  const showCode = failure.disposition !== 'retryable';
  return (
    <Alert.Root
      tone={failure.disposition === 'hard_conflict' ? 'danger' : 'warning'}
      data-testid="e2ee-actionable-error"
      data-disposition={failure.disposition}
      data-code={failure.code}
    >
      <Alert.Description>{t(failure.messageKey)}</Alert.Description>
      {showCode && (
        <Alert.Description>
          <span {...stylex.props(styles.code)}>{failure.code}</span>
        </Alert.Description>
      )}
      {(primaryHandler || secondaryHandler) && (
        <Alert.Actions>
          <div {...stylex.props(styles.actions)}>
            {primaryHandler && (
              <Button size="small" disabled={busy} onClick={primaryHandler}>
                {t(ACTION_LABEL_KEYS[failure.primaryAction])}
              </Button>
            )}
            {secondaryHandler && failure.secondaryAction && (
              <Button size="small" variant="secondary" disabled={busy} onClick={secondaryHandler}>
                {t(ACTION_LABEL_KEYS[failure.secondaryAction])}
              </Button>
            )}
          </div>
        </Alert.Actions>
      )}
    </Alert.Root>
  );
}
