import * as stylex from '@stylexjs/stylex';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Dialog } from '@/ui/dialog';
import { Field as UiField } from '@lody/ui/field';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text as type } from '@lody/ui/tokens/scales.stylex';
import { E2eeLostAllRecovery, type E2eeLostAllRecoveryProps } from './e2ee-lost-all-recovery';
import type { E2eeWorkspaceRemoval } from './e2ee-workspace-removal';

/** After this long the submit button explains that the server is still answering. */
export const LOST_ACCESS_SLOW_MS = 10_000;
/** After this long a removal stops waiting: the workspace list decides, else unknown. */
export const LOST_ACCESS_BOUND_MS = 30_000;

export interface E2eeLostAccessProps {
  workspaceId: string;
  workspaceName: string | undefined;
  /** The account role from the workspace list. It only chooses which path to show;
   * the server checks ownership and billing on submit. Undefined while unknown. */
  accountRole: string | undefined;
  /** Present where this host can restore from a backup. */
  recovery?: Omit<E2eeLostAllRecoveryProps, 'workspaceId' | 'onNoBackup'>;
  /** Absent on hosts without account workspaces (local-only). */
  removal?: E2eeWorkspaceRemoval;
  /** Leave the waiting page; the pending request and this device's keys stay. */
  onBackToWorkspaces: () => void;
  /** The workspace is no longer on this account: go somewhere usable. */
  onRemoved: () => void;
  /** A removal is waiting for the server: the caller keeps the surface open. */
  onBusyChange?: (busy: boolean) => void;
}

type Step = 'restore' | 'lost' | 'confirm';
type Refusal = 'not-owner' | 'billing' | 'other';
type Phase =
  | { kind: 'idle' }
  | { kind: 'submitting'; slow: boolean }
  | { kind: 'unknown' }
  | { kind: 'refused'; reason: Refusal; detail?: string }
  | { kind: 'removed' };

/** A definite server refusal, or null when the outcome is unknown (transport failure,
 * timeout, unclassified server error). Only the server's answer refuses; a missing
 * status never does. */
export function workspaceRemovalRefusal(
  error: unknown
): { reason: Refusal; detail?: string } | null {
  if (!error || typeof error !== 'object') return null;
  const value = error as { status?: unknown; code?: unknown; message?: unknown };
  const status = typeof value.status === 'number' ? value.status : undefined;
  const code = typeof value.code === 'string' ? value.code : '';
  const message = typeof value.message === 'string' ? value.message : '';
  if (status === undefined) return null;
  if (/billing|subscription/i.test(`${code} ${message}`))
    return { reason: 'billing', ...(message ? { detail: message } : {}) };
  if (status === 403) return { reason: 'not-owner' };
  if (status >= 400 && status < 500 && status !== 408 && status !== 429)
    return { reason: 'other', ...(message ? { detail: message } : {}) };
  return null;
}

const styles = stylex.create({
  root: { display: 'flex', flexDirection: 'column', gap: space[3], textAlign: 'start' },
  heading: { margin: 0, fontSize: type.headlineSize, fontWeight: 600 },
  subheading: { margin: 0, fontSize: type.subheadlineSize, fontWeight: 600 },
  body: { margin: 0 },
  lead: { margin: 0, color: colors.secondaryLabel, fontSize: type.subheadlineSize },
  field: { display: 'flex', flexDirection: 'column', gap: space[1] },
  actions: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: space[2],
    flexWrap: 'wrap',
  },
  end: { display: 'flex', gap: space[2], flexWrap: 'wrap', marginInlineStart: 'auto' },
});

/** "Cannot approve on another device": restore from a configured backup first, then
 * say plainly that the content cannot be recovered, and only then offer the ordinary
 * owner deletion or member leave. Every removal outcome is reported as the server or
 * the workspace list confirms it; an unanswered one stays unknown. */
export function E2eeLostAccess(props: E2eeLostAccessProps) {
  const { t } = useTranslation();
  const [step, setStep] = useState<Step>(props.recovery ? 'restore' : 'lost');
  const [kind, setKind] = useState<'delete' | 'leave'>('delete');
  const name = props.workspaceName ?? '';
  const owner =
    props.accountRole === undefined
      ? undefined
      : props.accountRole.split(',').some((role) => role.trim() === 'owner');

  if (step === 'restore')
    return (
      <div data-testid="e2ee-lost-access-restore" {...stylex.props(styles.root)}>
        {props.recovery ? (
          <E2eeLostAllRecovery
            workspaceId={props.workspaceId}
            {...props.recovery}
            onNoBackup={() => setStep('lost')}
          />
        ) : null}
      </div>
    );

  if (step === 'confirm' && props.removal)
    return (
      <RemovalConfirm
        kind={kind}
        workspaceId={props.workspaceId}
        workspaceName={name}
        removal={props.removal}
        onCancel={() => setStep('lost')}
        onLeaveInstead={() => setKind('leave')}
        onRemoved={props.onRemoved}
        {...(props.onBusyChange ? { onBusyChange: props.onBusyChange } : {})}
      />
    );

  return (
    <div data-testid="e2ee-lost-access-lost" {...stylex.props(styles.root)}>
      <h3 {...stylex.props(styles.heading)}>
        {t('e2ee.lostAccess.lost.title', { workspace: name })}
      </h3>
      <p {...stylex.props(styles.body)}>{t('e2ee.lostAccess.lost.body')}</p>
      <Alert.Root>
        <Alert.Description>{t('e2ee.lostAccess.lost.otherDevice')}</Alert.Description>
      </Alert.Root>
      {!props.recovery && <p {...stylex.props(styles.lead)}>{t('e2ee.lostAccess.noRestore')}</p>}
      {owner === undefined ? (
        <p {...stylex.props(styles.lead)}>{t('e2ee.lostAccess.roleUnknown')}</p>
      ) : (
        <>
          <h4
            {...stylex.props(styles.subheading)}
            data-lost-access-role={owner ? 'owner' : 'member'}
          >
            {t(owner ? 'e2ee.lostAccess.owner.title' : 'e2ee.lostAccess.member.title')}
          </h4>
          <p {...stylex.props(styles.lead)}>
            {t(owner ? 'e2ee.lostAccess.owner.help' : 'e2ee.lostAccess.member.help')}
          </p>
        </>
      )}
      <div {...stylex.props(styles.actions)}>
        {props.recovery && (
          <Button variant="link" onClick={() => setStep('restore')}>
            {t('e2ee.lostAccess.tryRestore')}
          </Button>
        )}
        <div {...stylex.props(styles.end)}>
          <Button variant="secondary" onClick={props.onBackToWorkspaces}>
            {t('e2ee.lostAccess.back')}
          </Button>
          {owner !== undefined && props.removal && (
            <Button
              variant="secondary"
              tone="destructive"
              data-testid={owner ? 'e2ee-lost-access-delete' : 'e2ee-lost-access-leave'}
              onClick={() => {
                setKind(owner ? 'delete' : 'leave');
                setStep('confirm');
              }}
            >
              {t(owner ? 'e2ee.lostAccess.delete' : 'e2ee.lostAccess.leave')}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function RemovalConfirm({
  kind,
  workspaceId,
  workspaceName,
  removal,
  onCancel,
  onLeaveInstead,
  onRemoved,
  onBusyChange,
}: {
  kind: 'delete' | 'leave';
  workspaceId: string;
  workspaceName: string;
  removal: E2eeWorkspaceRemoval;
  onCancel: () => void;
  onLeaveInstead: () => void;
  onRemoved: () => void;
  onBusyChange?: (busy: boolean) => void;
}) {
  const { t } = useTranslation();
  const [typed, setTyped] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const busyRef = useRef(onBusyChange);
  busyRef.current = onBusyChange;
  const submitting = phase.kind === 'submitting';
  useEffect(() => {
    busyRef.current?.(submitting);
  }, [submitting]);
  useEffect(() => () => busyRef.current?.(false), []);
  const live = useRef(true);
  const attempt = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const clearTimers = () => {
    for (const timer of timers.current) clearTimeout(timer);
    timers.current = [];
  };
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
      clearTimers();
    };
  }, []);
  const removed = () => {
    clearTimers();
    setPhase({ kind: 'removed' });
    // A confirmed removal stands even if refreshing the list fails afterwards.
    try {
      removal.refresh();
    } catch (error) {
      console.warn('Workspace list refresh failed', error);
    }
  };
  /** The workspace list settles an unanswered or failed request. */
  const reconcile = async (own: number, refusal: ReturnType<typeof workspaceRemovalRefusal>) => {
    const listed = await removal.listed(workspaceId);
    if (!live.current || attempt.current !== own) return;
    if (listed === false) return removed();
    clearTimers();
    setPhase(refusal ? { kind: 'refused', ...refusal } : { kind: 'unknown' });
  };
  const submit = () => {
    const own = ++attempt.current;
    clearTimers();
    setPhase({ kind: 'submitting', slow: false });
    timers.current.push(
      setTimeout(() => {
        if (live.current && attempt.current === own) setPhase({ kind: 'submitting', slow: true });
      }, LOST_ACCESS_SLOW_MS),
      setTimeout(() => {
        if (live.current && attempt.current === own) void reconcile(own, null);
      }, LOST_ACCESS_BOUND_MS)
    );
    void removal.submit(kind, workspaceId).then(
      () => {
        // A late success is still the truth, even after the page reported unknown.
        if (live.current) removed();
      },
      (error: unknown) => {
        if (!live.current || attempt.current !== own) return;
        void reconcile(own, workspaceRemovalRefusal(error));
      }
    );
  };

  if (phase.kind === 'removed')
    return (
      <div data-testid="e2ee-lost-access-removed" {...stylex.props(styles.root)}>
        <h3 {...stylex.props(styles.heading)}>
          {t(kind === 'delete' ? 'e2ee.lostAccess.deleted' : 'e2ee.lostAccess.left', {
            workspace: workspaceName,
          })}
        </h3>
        <Alert.Root tone="success">
          <Alert.Description>{t('e2ee.lostAccess.removedFromList')}</Alert.Description>
        </Alert.Root>
        {kind === 'delete' && (
          <p {...stylex.props(styles.lead)}>{t('e2ee.lostAccess.cleanupPending')}</p>
        )}
        <div {...stylex.props(styles.actions)}>
          <div {...stylex.props(styles.end)}>
            <Button onClick={onRemoved}>{t('e2ee.lostAccess.continue')}</Button>
          </div>
        </div>
      </div>
    );

  const nameMatches = kind === 'leave' || typed === workspaceName;
  return (
    <div
      data-testid="e2ee-lost-access-confirm"
      data-lost-access-phase={phase.kind}
      {...stylex.props(styles.root)}
    >
      <h3 {...stylex.props(styles.heading)}>
        {t(kind === 'delete' ? 'e2ee.lostAccess.confirmDelete' : 'e2ee.lostAccess.confirmLeave', {
          workspace: workspaceName,
        })}
      </h3>
      {kind === 'delete' ? (
        <>
          <Alert.Root tone="danger">
            <Alert.Description>
              {t('workspace.danger.deleteWorkspace.encryptedLoss')}
            </Alert.Description>
            <Alert.Description>
              {t('workspace.danger.deleteWorkspace.encryptedDownloaded')}
            </Alert.Description>
          </Alert.Root>
          <p {...stylex.props(styles.lead)}>{t('e2ee.lostAccess.cleanupNotice')}</p>
          <div {...stylex.props(styles.field)}>
            <UiField.Label htmlFor="e2ee-lost-access-name">
              {t('workspace.danger.deleteWorkspace.typeToConfirm', { workspace: workspaceName })}
            </UiField.Label>
            <Input
              id="e2ee-lost-access-name"
              value={typed}
              disabled={submitting}
              onChange={(event) => setTyped(event.target.value)}
              placeholder={t('workspace.danger.deleteWorkspace.inputPlaceholder')}
            />
          </div>
        </>
      ) : (
        <p {...stylex.props(styles.lead)}>
          {t('workspace.danger.leaveWorkspace.encryptedDescription')}
        </p>
      )}
      {phase.kind === 'unknown' && (
        <Alert.Root tone="warning" data-testid="e2ee-lost-access-unknown">
          <Alert.Description>
            {t('e2ee.lostAccess.unknown', { workspace: workspaceName })}
          </Alert.Description>
        </Alert.Root>
      )}
      {phase.kind === 'refused' && (
        <Alert.Root tone="danger" data-testid="e2ee-lost-access-refused">
          <Alert.Description>
            {t(
              phase.reason === 'not-owner'
                ? kind === 'delete'
                  ? 'e2ee.lostAccess.refused.notOwner'
                  : 'e2ee.lostAccess.refused.leave'
                : phase.reason === 'billing'
                  ? 'e2ee.lostAccess.refused.billing'
                  : 'e2ee.lostAccess.refused.other'
            )}
          </Alert.Description>
          {phase.detail && <Alert.Description>{phase.detail}</Alert.Description>}
        </Alert.Root>
      )}
      {submitting && phase.slow && (
        <p role="status" {...stylex.props(styles.lead)}>
          {t('e2ee.lostAccess.slow')}
        </p>
      )}
      <div {...stylex.props(styles.actions)}>
        {phase.kind === 'refused' && phase.reason === 'not-owner' && kind === 'delete' && (
          <Button
            variant="link"
            onClick={() => {
              setPhase({ kind: 'idle' });
              onLeaveInstead();
            }}
          >
            {t('e2ee.lostAccess.leave')}
          </Button>
        )}
        <div {...stylex.props(styles.end)}>
          <Button variant="secondary" disabled={submitting} onClick={onCancel}>
            {t('common.cancel')}
          </Button>
          <Button
            variant="destructive"
            data-testid="e2ee-lost-access-submit"
            disabled={submitting || !nameMatches}
            onClick={submit}
          >
            {submitting ? (
              <>
                <Spinner size="small" />
                {t('common.processing')}
              </>
            ) : phase.kind === 'unknown' || phase.kind === 'refused' ? (
              t('e2ee.lostAccess.retry')
            ) : (
              t(
                kind === 'delete'
                  ? 'workspace.danger.deleteWorkspace.confirmButton'
                  : 'workspace.danger.leaveWorkspace.confirmButton'
              )
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** The waiting pages' single way out when no other device can approve: a button that
 * opens the steps above. Closing it changes nothing: the pending request, this
 * device's keys and any recovery material stay as they were. */
export function E2eeLostAccessEntry({
  disabled,
  onOpenChange,
  ...props
}: Omit<E2eeLostAccessProps, 'onBusyChange'> & {
  disabled?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const busy = useRef(false);
  const change = (next: boolean) => {
    // An unanswered removal keeps the dialog: its result must reach the person.
    if (!next && busy.current) return;
    setOpen(next);
    onOpenChange?.(next);
  };
  return (
    <>
      <Button
        variant="secondary"
        data-testid="e2ee-lost-access-entry"
        disabled={disabled}
        onClick={() => change(true)}
      >
        {t('e2ee.lostAccess.entry')}
      </Button>
      <Dialog.Root open={open} onOpenChange={change}>
        <Dialog.Content
          width={520}
          className="max-h-[90dvh] overflow-y-auto"
          data-e2ee-pairing-surface=""
        >
          <Dialog.Title>{t('e2ee.lostAccess.title')}</Dialog.Title>
          <E2eeLostAccess
            {...props}
            {...(props.recovery
              ? {
                  recovery: {
                    ...props.recovery,
                    onRecovered: () => {
                      change(false);
                      props.recovery!.onRecovered();
                    },
                  },
                }
              : {})}
            onBusyChange={(value) => {
              busy.current = value;
            }}
          />
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
