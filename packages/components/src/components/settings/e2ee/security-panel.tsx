import type { E2eeManagementState } from '@lody/platform';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Alert } from '@lody/ui/alert';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { CompactSection, CompactRow } from '../compact-layout';
import { SettingsPageLead } from '../settings-page-header';
const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', gap: space[4] },
  notice: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[3],
    padding: space[4],
    fontSize: text.subheadlineSize,
  },
  key: {
    color: colors.secondaryLabel,
    fontFamily: 'monospace',
    fontSize: text.footnoteSize,
    overflowWrap: 'anywhere',
  },
});
export function E2eeSecurityPanel({
  state,
  busy,
  error: actionError,
  onUpdate,
  onRevoke,
  onRetry,
  onAuthorize,
}: {
  state?: E2eeManagementState;
  busy?: boolean;
  error?: string;
  onUpdate: () => void;
  onRevoke: (key: string) => void;
  onRetry: () => void;
  onAuthorize?: () => void;
}) {
  const { t } = useTranslation();
  const error =
    actionError ?? (state?.recoveryIssue ? 'e2ee_rotation_candidate_unavailable' : undefined);
  const needsUpdate = state?.rotationRequired || state?.updatePending;
  return (
    <div {...stylex.props(styles.panel)}>
      <SettingsPageLead>{t('e2ee.security.lead')}</SettingsPageLead>
      <CompactSection title={t('e2ee.security.title')}>
        <div {...stylex.props(styles.notice)}>
          <p aria-live="polite">
            {t(
              state
                ? needsUpdate
                  ? 'e2ee.security.required'
                  : 'e2ee.security.current'
                : 'e2ee.security.identityMissing',
              { epoch: state?.epoch }
            )}
          </p>
          {needsUpdate &&
            (state?.mayRotate ? (
              <Button disabled={busy} onClick={onUpdate}>
                {t(busy ? 'e2ee.security.updating' : 'e2ee.security.complete')}
              </Button>
            ) : (
              <p>{t('e2ee.security.useManager')}</p>
            ))}
          {error && (
            <Alert.Root>
              <Alert.Description>
                {t(
                  error === 'e2ee_management_operator_required'
                    ? 'e2ee.security.operatorRequired'
                    : /e2ee_(?:custody_unavailable|missing-binding|account_unavailable|not_open|account_mismatch)/.test(
                          error
                        )
                      ? 'e2ee.security.identityMissing'
                      : error === 'e2ee_rotation_candidate_unavailable'
                        ? 'e2ee.security.candidateUnavailable'
                        : error === 'e2ee_management_unauthorized'
                          ? 'e2ee.security.useManager'
                          : error === 'e2ee_management_conflict'
                            ? 'e2ee.security.conflict'
                            : 'e2ee.security.retryHint'
                )}
              </Alert.Description>
            </Alert.Root>
          )}
          <Button variant="secondary" disabled={busy} onClick={onRetry}>
            {t('e2ee.security.refresh')}
          </Button>
          {onAuthorize && (
            <Button variant="secondary" disabled={busy} onClick={onAuthorize}>
              {t('e2ee.security.authorizePersonal')}
            </Button>
          )}
        </div>
      </CompactSection>
      {state && (
        <CompactSection title={t('e2ee.security.devices')} boxed>
          {state.devices.map((device) => (
            <CompactRow
              key={device.key}
              label={device.machineId ?? t(`e2ee.values.${device.kind}`)}
              helper={
                <span {...stylex.props(styles.key)}>
                  {device.key.slice(0, 12)}
                  {device.self ? ` · ${t('e2ee.security.thisDevice')}` : ''}
                </span>
              }
            >
              {device.mayRevoke && (
                <Button variant="secondary" disabled={busy} onClick={() => onRevoke(device.key)}>
                  {t('e2ee.security.revoke')}
                </Button>
              )}
            </CompactRow>
          ))}
        </CompactSection>
      )}
    </div>
  );
}
