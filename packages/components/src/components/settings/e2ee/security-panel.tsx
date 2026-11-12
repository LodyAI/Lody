import type { E2eeManagementState } from '@lody/platform';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { Alert } from '@lody/ui/alert';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Info, KeyRound, ShieldCheck, ShieldQuestion, UserPlus } from 'lucide-react';
import { Tooltip } from '@lody/ui/tooltip';
import { useState, type ReactNode } from 'react';
import { Dialog } from '@lody/ui/dialog';
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

type ErrorAction = 'retry' | 'console';
/** One card per failure: a conclusion, the reason with what is still safe, and the one
 * next step that does something. Restart and operator work have no button here. */
function errorCard(error: string): { kind: string; action?: ErrorAction } {
  if (error === 'e2ee_restart-required') return { kind: 'restart' };
  if (error === 'e2ee_local-history-recovery-required' || error === 'e2ee_trusted-pin-unavailable')
    return { kind: 'localRecovery', action: 'console' };
  if (error === 'e2ee_management_operator_required') return { kind: 'operator' };
  if (
    /e2ee_(?:custody_unavailable|missing-binding|account_unavailable|not_open|account_mismatch)/.test(
      error
    )
  )
    return { kind: 'identity', action: 'console' };
  if (error === 'e2ee_rotation_candidate_unavailable')
    return { kind: 'candidate', action: 'retry' };
  if (error === 'e2ee_management_unauthorized') return { kind: 'manager' };
  if (error === 'e2ee_management_conflict') return { kind: 'conflict', action: 'retry' };
  return { kind: 'retry', action: 'retry' };
}

interface PanelState {
  state?: E2eeManagementState;
  busy?: boolean;
  error?: string;
  /** A link join request waits for this manager's approval. */
  joinRequests?: boolean;
}

/** What needs a decision now: key update and waiting join requests. */
export function E2eeAttentionRows({
  state,
  busy,
  joinRequests = false,
  onUpdate,
  onReview,
}: PanelState & { onUpdate: () => void; onReview?: () => void }) {
  const { t } = useTranslation();
  const needsUpdate = state?.rotationRequired || state?.updatePending;
  // Another window's command is running: show it busy, not a button that would refuse.
  const updating = busy || !!state?.updateInProgress;
  return (
    <>
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
          {onReview && (
            <Button variant="primary" disabled={busy} onClick={onReview}>
              {t('e2ee.security.review')}
            </Button>
          )}
        </CompactRow>
      )}
    </>
  );
}

function ErrorRow(props: {
  error: string;
  busy?: boolean;
  onRetry: () => void;
  /** Absent inside the console itself. */
  onOpenConsole?: () => void;
}) {
  const { t } = useTranslation();
  const card = errorCard(props.error);
  // Inside the console the console step is already taken; fall back to checking again.
  const action = card.action === 'console' && !props.onOpenConsole ? 'retry' : card.action;
  return (
    <div {...stylex.props(styles.error)}>
      <Alert.Root tone="warning" data-security-error={card.kind}>
        <Alert.Title>{t(`e2ee.security.error.${card.kind}.title`)}</Alert.Title>
        <Alert.Description>{t(`e2ee.security.error.${card.kind}.body`)}</Alert.Description>
        {action && (
          <Alert.Actions>
            {action === 'console' ? (
              <Button disabled={props.busy} onClick={props.onOpenConsole}>
                {t('e2ee.security.openConsole')}
              </Button>
            ) : (
              <Button variant="secondary" disabled={props.busy} onClick={props.onRetry}>
                {t('e2ee.failure.action.refresh')}
              </Button>
            )}
          </Alert.Actions>
        )}
      </Alert.Root>
    </div>
  );
}

const effectiveError = (state: E2eeManagementState | undefined, error: string | undefined) =>
  error ?? (state?.recoveryIssue ? 'e2ee_rotation_candidate_unavailable' : undefined);

/** Settings entry for an encrypted workspace: one status line, the work that needs a
 * decision now, and the way into the encryption console. Native facts only. */
export function E2eeSecurityPanel({
  state,
  busy,
  error: actionError,
  joinRequests = false,
  onUpdate,
  onRetry,
  onOpenConsole,
}: PanelState & {
  onUpdate: () => void;
  onRetry: () => void;
  /** Opens the console, on a tab when the item names one. */
  onOpenConsole?: (tab?: 'members') => void;
}) {
  const { t } = useTranslation();
  const error = effectiveError(state, actionError);
  // When the failure card's one step is the console, the status row neither repeats
  // the explanation nor offers a second console button.
  const cardOpensConsole = !!error && errorCard(error).action === 'console' && !!onOpenConsole;
  return (
    <div {...stylex.props(styles.panel)}>
      <CompactSection title={t('e2ee.security.title')}>
        <CompactRow
          leading={
            <Glyph tone={state ? 'secure' : 'attention'}>
              {state ? <ShieldCheck size={16} /> : <ShieldQuestion size={16} />}
            </Glyph>
          }
          label={t(
            state || cardOpensConsole ? 'e2ee.security.current' : 'e2ee.security.identityMissing'
          )}
        >
          {/* The primary step leads, so a wrapped row on a phone never strands the
              help icon in the glyph column. */}
          {onOpenConsole && !cardOpensConsole && (
            <Button disabled={busy} onClick={() => onOpenConsole()}>
              {t('e2ee.security.openConsole')}
            </Button>
          )}
          {state && (
            <Tooltip.Root>
              <Tooltip.Trigger
                render={
                  <Button variant="ghost" size="small" icon aria-label={t('e2ee.security.about')}>
                    <Info size={15} aria-hidden="true" />
                  </Button>
                }
              />
              <Tooltip.Content side="left">{t('e2ee.security.aboutHelp')}</Tooltip.Content>
            </Tooltip.Root>
          )}
        </CompactRow>
        <E2eeAttentionRows
          state={state}
          busy={busy}
          joinRequests={joinRequests}
          onUpdate={onUpdate}
          onReview={onOpenConsole && (() => onOpenConsole('members'))}
        />
        {error && (
          <ErrorRow
            error={error}
            busy={busy}
            onRetry={onRetry}
            {...(onOpenConsole ? { onOpenConsole: () => onOpenConsole() } : {})}
          />
        )}
      </CompactSection>
    </div>
  );
}

/** Console Devices tab: every authorized device and machine, with revoke and the
 * key update a revoke leaves behind. Native facts only; main rechecks each action. */
export function E2eeDevicesPanel({
  state,
  busy,
  error: actionError,
  onUpdate,
  onRevoke,
  onRetry,
}: PanelState & {
  onUpdate: () => void;
  onRevoke: (key: string, confirmation?: { confirmedRecoveryOnly: true }) => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [confirmKey, setConfirmKey] = useState<string | null>(null);
  const error = effectiveError(state, actionError);
  const updating = busy || !!state?.updateInProgress;
  return (
    <div {...stylex.props(styles.panel)}>
      {(state?.rotationRequired || state?.updatePending || error) && (
        <CompactSection>
          <E2eeAttentionRows state={state} busy={busy} onUpdate={onUpdate} />
          {error && <ErrorRow error={error} busy={busy} onRetry={onRetry} />}
        </CompactSection>
      )}
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
                  onClick={() =>
                    device.requiresRecoveryConfirmation
                      ? setConfirmKey(device.key)
                      : onRevoke(device.key)
                  }
                >
                  {t('e2ee.security.revoke')}
                </Button>
              )}
            </CompactRow>
          ))}
        </CompactSection>
      )}
      <Dialog.Root
        open={confirmKey !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmKey(null);
        }}
      >
        <Dialog.Content data-testid="e2ee-last-personal-confirm" width={440}>
          <Dialog.Header>
            <Dialog.Title>{t('e2ee.security.lastPersonalTitle')}</Dialog.Title>
            <Dialog.Description>
              {t(
                state?.devices.find((device) => device.key === confirmKey)
                  ?.recoveryDeviceAvailable === false
                  ? 'e2ee.security.lastPersonalNoRecovery'
                  : 'e2ee.security.lastPersonalWarning'
              )}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button variant="ghost" disabled={updating} onClick={() => setConfirmKey(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              tone="destructive"
              disabled={updating}
              data-testid="e2ee-last-personal-revoke"
              onClick={() => {
                if (confirmKey) onRevoke(confirmKey, { confirmedRecoveryOnly: true });
                setConfirmKey(null);
              }}
            >
              {t('e2ee.security.revoke')}
            </Button>
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
    </div>
  );
}
