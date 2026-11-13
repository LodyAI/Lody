import type { E2eeDeviceProfile, E2eeWorkspaceMemberProfiles } from '@lody/cloud-api';
import type { E2eeManagementState } from '@lody/platform';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Collapsible } from '@lody/ui/collapsible';
import { Button } from '@lody/ui/button';
import { Avatar } from '@lody/ui/avatar';
import { avatar } from '@lody/ui/avatar/avatar.tokens.stylex';
import { settingsType } from '../type.stylex';
import { Alert } from '@lody/ui/alert';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Info, KeyRound, ShieldCheck, ShieldQuestion, UserPlus, UserRound } from 'lucide-react';
import { Tooltip } from '@lody/ui/tooltip';
import { useState, type ReactNode } from 'react';
import { Dialog } from '@lody/ui/dialog';
import { CompactSection, CompactRow } from '../compact-layout';
import { E2eeWaitingRequestsCallout } from '@/components/pages/e2ee-instant-qr';

const styles = stylex.create({
  deviceAvatar: {
    display: 'flex',
    flexShrink: 0,
    alignSelf: 'flex-start',
    paddingBlockStart: `calc((1em * ${settingsType.leading} - ${avatar.sizeMini}) / 2)`,
  },
  deviceInfo: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[1],
    minWidth: 0,
  },
  identifiers: { maxWidth: '100%', minWidth: 0 },
  deviceActions: {
    marginInlineStart: {
      default: `calc(${avatar.sizeMini} + ${space[3]})`,
      '@media (min-width: 640px)': 0,
    },
  },
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
  detail: { display: 'block', overflowWrap: 'anywhere' },
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
  onOpenConsole?: (tab?: 'members' | 'devices') => void;
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
          {/* Adding a device is the everyday task; everything else is one step further. */}
          {onOpenConsole && state && (
            <Button
              data-testid="e2ee-security-add-device"
              disabled={busy}
              onClick={() => onOpenConsole('devices')}
            >
              {t('e2ee.security.addDevice')}
            </Button>
          )}
          {onOpenConsole && !cardOpensConsole && (
            <Button
              variant={state ? 'secondary' : 'primary'}
              disabled={busy}
              onClick={() => onOpenConsole()}
            >
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
        <E2eeWaitingRequestsCallout />
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

/** Display name and facts a machine already publishes in the workspace machine directory. */
export type E2eeDeviceMachineLabel = { name?: string; os?: string; cliVersion?: string };
const MACHINE_OS: Readonly<Record<string, string>> = {
  darwin: 'macOS',
  linux: 'Linux',
  win32: 'Windows',
};

/**
 * Display-only profile for one ledger device. This host's own row uses what it
 * collects locally; a machine row falls back to its workspace machine name. No
 * other row ever borrows local or machine data.
 */
export function resolveE2eeDeviceProfile(
  device: E2eeManagementState['devices'][number],
  reported: E2eeDeviceProfile | undefined,
  localProfile: E2eeDeviceProfile | undefined,
  machine: E2eeDeviceMachineLabel | undefined
): E2eeDeviceProfile | undefined {
  if (device.self && device.kind === 'personal' && localProfile) return localProfile;
  if (device.kind !== 'machine' || !machine) return reported;
  const name = machine.name?.trim() || reported?.name;
  const os = reported?.os ?? (machine.os ? (MACHINE_OS[machine.os] ?? machine.os) : undefined);
  const appVersion = reported?.appVersion ?? machine.cliVersion;
  return {
    ...reported,
    client: 'daemon',
    ...(name ? { name } : {}),
    ...(os ? { os } : {}),
    ...(appVersion ? { appVersion } : {}),
  };
}

/** Console Devices tab: every authorized device and machine, with revoke and the
 * key update a revoke leaves behind. Native facts only; main rechecks each action. */
export function E2eeDevicesPanel({
  state,
  directory,
  localProfile,
  machines,
  busy,
  error: actionError,
  onUpdate,
  onRevoke,
  onRetry,
}: PanelState & {
  onUpdate: () => void;
  directory?: E2eeWorkspaceMemberProfiles;
  /** This host's own collected profile, used only for the row marked as this device. */
  localProfile?: E2eeDeviceProfile;
  /** Workspace machine directory keyed by machine ID, used only for machine rows. */
  machines?: ReadonlyMap<string, E2eeDeviceMachineLabel>;
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
          {state.devices.map((device) => {
            const profile = resolveE2eeDeviceProfile(
              device,
              directory?.devices?.find((entry) => entry.signingPublicKey === device.key)?.profile,
              localProfile,
              device.machineId ? machines?.get(device.machineId) : undefined
            );
            const ownerProfile = directory?.profiles.find(
              (entry) => entry.cryptoUserId === device.cryptoUserId
            );
            const owner = ownerProfile?.name?.trim();
            const hardwareCode =
              profile?.client === 'mobile' && profile.model?.match(/^(iPhone|iPad)\d+,\d+$/);
            const model = hardwareCode
              ? `${hardwareCode[1]} · ${t('e2ee.deviceIdentity.modelUnknown')}`
              : profile?.model?.trim();
            const named = profile?.name?.trim() || model;
            const name = named || t(`e2ee.deviceIdentity.${profile?.client ?? device.kind}`);
            const title = [owner || t('e2ee.deviceIdentity.ownerUnknown'), name].join(' · ');
            // The title already names the device kind when nothing was reported; missing
            // fields are explained once, inside the expandable details.
            const info =
              profile &&
              [
                // Without a name or model the title already shows the client kind.
                named ? t(`e2ee.deviceIdentity.${profile.client}`) : '',
                [profile.os, profile.osVersion].filter(Boolean).join(' '),
                profile.appVersion ? `Lody ${profile.appVersion}` : '',
              ]
                .filter(Boolean)
                .join(' · ');
            const missing = !profile
              ? t('e2ee.deviceIdentity.detailsUnavailable')
              : !profile.osVersion
                ? t('e2ee.deviceIdentity.osVersionUnavailable')
                : undefined;
            return (
              <CompactRow
                key={device.key}
                helperBlock
                alignTop
                label={title}
                leading={
                  <span {...stylex.props(styles.deviceAvatar)}>
                    <Avatar.Root
                      size="mini"
                      aria-hidden="true"
                      data-testid="e2ee-device-owner-avatar"
                    >
                      {ownerProfile?.image && <Avatar.Image src={ownerProfile.image} alt="" />}
                      <Avatar.Fallback>
                        {owner ? owner.slice(0, 1).toUpperCase() : <UserRound size={12} />}
                      </Avatar.Fallback>
                    </Avatar.Root>
                  </span>
                }
                helper={
                  <div {...stylex.props(styles.deviceInfo)}>
                    {info && <span {...stylex.props(styles.detail)}>{info}</span>}
                    {device.self && (
                      <span {...stylex.props(styles.detail)}>{t('e2ee.security.thisDevice')}</span>
                    )}
                    <Collapsible.Root {...stylex.props(styles.identifiers)}>
                      <Collapsible.Trigger
                        render={
                          <Button
                            variant="link"
                            size="small"
                            style={{ minHeight: control.small }}
                            data-testid="e2ee-device-details"
                            data-device-key={device.key}
                          />
                        }
                      >
                        <span {...stylex.props(styles.key)}>
                          {t('e2ee.deviceIdentity.identifier')} · {device.key.slice(0, 12)}
                        </span>
                      </Collapsible.Trigger>
                      <Collapsible.Panel>
                        {missing && <span {...stylex.props(styles.detail)}>{missing}</span>}
                        {hardwareCode && (
                          <span {...stylex.props(styles.detail, styles.key)}>{profile?.model}</span>
                        )}
                        <span {...stylex.props(styles.detail, styles.key)}>{device.key}</span>
                        {device.machineId && (
                          <span {...stylex.props(styles.detail, styles.key)}>
                            {device.machineId}
                          </span>
                        )}
                      </Collapsible.Panel>
                    </Collapsible.Root>
                  </div>
                }
              >
                {device.mayRevoke && (
                  <span {...stylex.props(styles.deviceActions)}>
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
                  </span>
                )}
              </CompactRow>
            );
          })}
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
