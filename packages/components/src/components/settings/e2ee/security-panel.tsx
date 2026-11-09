import type { E2eeManagementState } from '@lody/platform';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Alert } from '@lody/ui/alert';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { KeyRound, ShieldCheck, ShieldQuestion, UserPlus } from 'lucide-react';
import type { ReactNode } from 'react';
import { CompactSection, CompactRow } from '../compact-layout';

const styles = stylex.create({
  panel: { display: 'flex', flexDirection: 'column', gap: space[4] },
  glyph: {
    display: 'inline-grid',
    placeItems: 'center',
    flexShrink: 0,
    width: 28,
    height: 28,
    borderRadius: radius.medium,
    backgroundColor: colors.secondaryBackground,
    color: colors.secondaryLabel,
  },
  glyphSecure: { color: colors.success },
  glyphAttention: { color: colors.warning },
  error: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[3],
    paddingBlock: space[2],
  },
  key: {
    color: colors.secondaryLabel,
    fontFamily: 'monospace',
    fontSize: text.footnoteSize,
    overflowWrap: 'anywhere',
  },
});

function Glyph(props: { children: ReactNode; tone?: 'secure' | 'attention' }) {
  return (
    <span
      aria-hidden="true"
      {...stylex.props(
        styles.glyph,
        props.tone === 'secure' && styles.glyphSecure,
        props.tone === 'attention' && styles.glyphAttention
      )}
    >
      {props.children}
    </span>
  );
}

function errorMessageKey(error: string): string {
  if (error === 'e2ee_restart-required') return 'e2ee.security.restartRequired';
  if (error === 'e2ee_local-history-recovery-required' || error === 'e2ee_trusted-pin-unavailable')
    return 'e2ee.security.localRecovery';
  if (error === 'e2ee_management_operator_required') return 'e2ee.security.operatorRequired';
  if (
    /e2ee_(?:custody_unavailable|missing-binding|account_unavailable|not_open|account_mismatch)/.test(
      error
    )
  )
    return 'e2ee.security.identityMissing';
  if (error === 'e2ee_rotation_candidate_unavailable') return 'e2ee.security.candidateUnavailable';
  if (error === 'e2ee_management_unauthorized') return 'e2ee.security.useManager';
  if (error === 'e2ee_management_conflict') return 'e2ee.security.conflict';
  return 'e2ee.security.retryHint';
}

/** Settings entry for an encrypted workspace: one status line, the work that needs a
 * decision now, and the way into the encryption console. Native facts only. */
export function E2eeSecurityPanel({
  state,
  busy,
  error: actionError,
  joinRequests = false,
  onUpdate,
  onRevoke,
  onRetry,
  onOpenConsole,
}: {
  state?: E2eeManagementState;
  busy?: boolean;
  error?: string;
  /** A link join request waits for this manager's approval. */
  joinRequests?: boolean;
  onUpdate: () => void;
  onRevoke: (key: string) => void;
  onRetry: () => void;
  onOpenConsole?: () => void;
}) {
  const { t } = useTranslation();
  const error =
    actionError ?? (state?.recoveryIssue ? 'e2ee_rotation_candidate_unavailable' : undefined);
  const needsUpdate = state?.rotationRequired || state?.updatePending;
  // Another window's command is running: show it busy, not a button that would refuse.
  const updating = busy || !!state?.updateInProgress;
  const openConsole = onOpenConsole && (
    <Button disabled={busy} onClick={onOpenConsole}>
      {t('e2ee.security.openConsole')}
    </Button>
  );
  return (
    <div {...stylex.props(styles.panel)}>
      <CompactSection title={t('e2ee.security.title')}>
        <CompactRow
          leading={
            <Glyph tone={state ? 'secure' : 'attention'}>
              {state ? <ShieldCheck size={16} /> : <ShieldQuestion size={16} />}
            </Glyph>
          }
          label={t(state ? 'e2ee.security.current' : 'e2ee.security.identityMissing')}
          helper={
            state ? t('e2ee.security.deviceCount', { count: state.devices.length }) : undefined
          }
        >
          {openConsole}
        </CompactRow>
        {needsUpdate && (
          <CompactRow
            leading={
              <Glyph tone="attention">
                <KeyRound size={16} />
              </Glyph>
            }
            label={t('e2ee.security.attention')}
            helper={t(state?.mayRotate ? 'e2ee.security.required' : 'e2ee.security.useManager')}
          >
            {state?.mayRotate && (
              <Button variant="primary" disabled={updating} onClick={onUpdate}>
                {t(updating ? 'e2ee.security.updating' : 'e2ee.security.complete')}
              </Button>
            )}
          </CompactRow>
        )}
        {joinRequests && (
          <CompactRow
            leading={
              <Glyph tone="attention">
                <UserPlus size={16} />
              </Glyph>
            }
            label={t('e2ee.security.joinRequests')}
            helper={t('e2ee.security.joinRequestsHelp')}
          >
            {onOpenConsole && (
              <Button variant="primary" disabled={busy} onClick={onOpenConsole}>
                {t('e2ee.security.review')}
              </Button>
            )}
          </CompactRow>
        )}
        {error && (
          <div {...stylex.props(styles.error)}>
            <Alert.Root>
              <Alert.Description>{t(errorMessageKey(error))}</Alert.Description>
            </Alert.Root>
            <Button variant="secondary" disabled={busy} onClick={onRetry}>
              {t('e2ee.security.refresh')}
            </Button>
          </div>
        )}
      </CompactSection>
      {state && state.devices.length > 0 && (
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
                <Button
                  data-testid="e2ee-device-revoke"
                  data-device-key={device.key}
                  variant="secondary"
                  disabled={updating}
                  onClick={() => onRevoke(device.key)}
                >
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
