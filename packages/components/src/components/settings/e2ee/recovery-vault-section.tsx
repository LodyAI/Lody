import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Badge, type BadgeTone } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { AlertDialog } from '@/ui/dialog';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@/atoms/settings';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';

/** When this device last opened the account's recovery file successfully. Display only:
 * it proves nothing about other devices and is cleared when the file is replaced. */
const checkedKey = (accountId: string) => `lody:e2ee:recovery-checked:${accountId}`;
function readChecked(accountId: string | null | undefined): number | null {
  if (!accountId) return null;
  try {
    const value = Number(localStorage.getItem(checkedKey(accountId)));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}
function writeChecked(accountId: string | null | undefined, at: number | null) {
  if (!accountId) return;
  try {
    if (at === null) localStorage.removeItem(checkedKey(accountId));
    else localStorage.setItem(checkedKey(accountId), String(at));
  } catch {
    // Storage can be unavailable; the date is only a convenience.
  }
}
import { CompactRow, CompactSection } from '../compact-layout';
import {
  useRecoveryPort,
  type RecoveryPasskey,
  type RecoveryPlan,
  type RecoveryReplacementPort,
  type RecoverySecurityEvent,
  type RecoveryWorkspaceStatus,
} from './recovery-port';

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[3],
    padding: space[4],
    fontSize: text.subheadlineSize,
  },
  actions: { display: 'flex', gap: space[2], flexWrap: 'wrap', alignItems: 'center' },
  rowActions: { display: 'flex', gap: space[2], flexWrap: 'wrap', justifyContent: 'flex-end' },
  stack: { display: 'flex', flexDirection: 'column', gap: space[4] },
  line: { display: 'block' },
  // Name and status share one column so the buttons wrap below them at the same left edge.
  workspace: {
    alignSelf: 'stretch',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    columnGap: space[3],
    rowGap: space[2],
  },
  workspaceLabel: {
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '16em',
    minWidth: 0,
  },
});

type Result =
  | {
      kind: 'notice';
      key:
        | 'e2ee.recovery.replaceBegun'
        | 'e2ee.recovery.replaceAbandoned'
        | 'e2ee.recovery.replaceFinished'
        | 'e2ee.recovery.replacePending'
        | 'e2ee.recovery.setupDone'
        | 'e2ee.recovery.passkeyAdded'
        | 'e2ee.recovery.passkeyRemoved'
        | 'e2ee.recovery.passkeyRemoveIncomplete';
    }
  | {
      kind: 'restored';
      results: readonly { name: string; outcome: string; partialEpochKey?: boolean }[];
    }
  | { kind: 'setupAll'; done: number; failed: readonly string[] }
  | { kind: 'created'; vaultId: string }
  | { kind: 'opened'; vaultId: string; count: number }
  | { kind: 'error'; code: string };

/** This workspace's recovery readiness for the console's getting-started list: true only
 * when recovery is verified, false when it is not yet, undefined when off or unknown. */
export function useWorkspaceRecoveryReady(
  workspaceId: string | null | undefined,
  accountId?: string | null
) {
  const enabled = useAtomValue(e2eeRecoveryVaultFeatureEnabledAtom);
  const port = useRecoveryPort();
  const [ready, setReady] = useState<{ scope: string; value: boolean | undefined }>();
  const scope = `${accountId ?? ''}:${workspaceId ?? ''}`;
  useEffect(() => {
    if (!enabled || !port || !workspaceId) return;
    let live = true;
    void port.plan().then(
      (plan) => {
        if (!live) return;
        const status = plan.covered.find((workspace) => workspace.id === workspaceId)?.status;
        setReady({
          scope,
          value: !plan.hasVault
            ? false
            : status === undefined || status.kind === 'unknown'
              ? undefined
              : status.kind === 'verified',
        });
      },
      () => {
        if (live) setReady({ scope, value: undefined });
      }
    );
    return () => {
      live = false;
    };
  }, [enabled, port, workspaceId, scope]);
  return enabled && ready?.scope === scope ? ready.value : undefined;
}

const statusBadge: Record<RecoveryWorkspaceStatus['kind'], { key: string; tone: BadgeTone }> = {
  verified: { key: 'e2ee.recovery.workspace.verified', tone: 'success' },
  saved: { key: 'e2ee.recovery.workspace.saved', tone: 'neutral' },
  notSet: { key: 'e2ee.recovery.workspace.notSet', tone: 'warning' },
  unknown: { key: 'e2ee.recovery.workspace.unknown', tone: 'neutral' },
};

/**
 * Post-MVP recovery file controls, hidden unless Developer mode and the beta
 * switch are on; the desktop main process additionally refuses unless started with
 * the env gate. The host's recovery port owns the unlock, file and bytes; this view
 * receives only outcomes, and offers only the actions the port supports.
 */
export function RecoveryVaultSection({ accountId }: { accountId?: string | null } = {}) {
  const { t, i18n } = useTranslation();
  const [checkedAt, setCheckedAt] = useState(() => readChecked(accountId));
  const markChecked = (at: number | null) => {
    writeChecked(accountId, at);
    setCheckedAt(at);
  };
  const enabled = useAtomValue(e2eeRecoveryVaultFeatureEnabledAtom);
  const port = useRecoveryPort();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();
  const [plan, setPlan] = useState<RecoveryPlan>();
  const [planFailed, setPlanFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<'begin' | 'continue'>();
  const [passkey, setPasskey] = useState(false);
  const [events, setEvents] = useState<readonly RecoverySecurityEvent[]>([]);
  const [naming, setNaming] = useState<string>();
  const [passkeys, setPasskeys] = useState<readonly RecoveryPasskey[]>();
  const [pending, setPending] = useState<readonly RecoveryPasskey[]>([]);
  const [removing, setRemoving] = useState<RecoveryPasskey>();
  useEffect(() => {
    if (!enabled || !port) return;
    let live = true;
    void port.plan().then(
      (next) => {
        if (!live) return;
        setPlan(next);
        setPlanFailed(false);
      },
      () => {
        if (!live) return;
        setPlan(undefined);
        setPlanFailed(true);
      }
    );
    void port.securityEvents().then(
      (next) => {
        if (live) setEvents(next);
      },
      () => undefined
    );
    void port.passkeyAvailable().then(
      (next) => {
        if (live) setPasskey(next);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [enabled, port, result, reload]);
  if (!enabled || !port) return null;
  // Actions the host cannot perform are not offered at all.
  const { create, checkFile, replacement } = port;
  // One state decides which actions exist, so only one primary action shows at a time.
  // When the state cannot be read, retry leads and the actions that change nothing stay;
  // creating stays too because main and the service refuse a second vault.
  const mode = !plan
    ? planFailed
      ? 'failed'
      : 'unknown'
    : plan.replacing
      ? 'replacing'
      : plan.hasVault
        ? 'ready'
        : 'none';
  // An older file still restores during a replacement, and main does not refuse it.
  const canRestore =
    mode === 'failed' || ((mode === 'ready' || mode === 'replacing') && !!plan?.uncovered.length);
  const run = async (work: () => Promise<Result | undefined>) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await work();
      if (next) setResult(next);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      // Dismissing the system prompt is a choice, not a failure.
      if (!code.includes('e2ee_recovery_cancelled')) setResult({ kind: 'error', code });
    } finally {
      setBusy(false);
    }
  };
  const finishReplacement = async (
    replace: RecoveryReplacementPort,
    compromised: boolean
  ): Promise<Result | undefined> => {
    const finished = await replace.finish({ compromised });
    if (finished.outcome === 'Committed') {
      // The old file stopped working; its check says nothing about the new one.
      markChecked(null);
      return { kind: 'notice', key: 'e2ee.recovery.replaceFinished' };
    }
    return finished.outcome === 'Pending'
      ? { kind: 'notice', key: 'e2ee.recovery.replacePending' }
      : undefined;
  };
  const short = (vaultId: string) => vaultId.slice(0, 12);
  // Saved but not yet verified still needs its setup finished: a held receipt or an
  // undelivered envelope continues from the journal's original submission.
  const unfinished =
    mode === 'ready'
      ? (plan?.covered.filter(
          (row) => row.status.kind === 'notSet' || row.status.kind === 'saved'
        ) ?? [])
      : [];
  const setupAll = (method: 'file' | 'passkey') =>
    void run(async () => {
      const settled = await port.setupWorkspaces(
        unfinished.map((row) => row.id),
        method
      );
      if (settled.outcome === 'cancelled') return undefined;
      // Reconcile against what was asked: only a committed, verified setup is done.
      // Pending, conflicting, unverified or missing results are listed as not finished.
      const finished = new Set(
        settled.results
          .filter((row) => row.outcome === 'Committed' && row.recoverable)
          .map((row) => row.workspaceId)
      );
      return {
        kind: 'setupAll',
        done: unfinished.filter((row) => finished.has(row.id)).length,
        failed: unfinished.filter((row) => !finished.has(row.id)).map((row) => row.name),
      };
    });
  const removePasskey = async (entryId: string): Promise<Result | undefined> => {
    const removed = await port.removePasskey(entryId);
    if (removed.outcome === 'cancelled') return undefined;
    if (removed.passkeys) {
      setPasskeys(removed.passkeys);
      setPending(removed.pending);
    } else {
      // The removal settled but the list could not be read again: keep its outcome and
      // drop the stale list rather than showing the removed passkey; Manage reads it anew.
      setPasskeys(undefined);
      setPending([]);
    }
    return {
      kind: 'notice',
      key:
        removed.outcome === 'removed'
          ? 'e2ee.recovery.passkeyRemoved'
          : 'e2ee.recovery.passkeyRemoveIncomplete',
    };
  };
  // Restoring leads when it is this host's only next step: a replacement it cannot
  // continue, or nothing to set up and no file check. Desktop always has a step that
  // leads instead (continue, set up all, check), so its restore stays secondary.
  const restoreLeads =
    canRestore &&
    ((mode === 'replacing' && !replacement) ||
      (mode === 'ready' && unfinished.length === 0 && !checkFile));
  const restoreButton = (method: 'file' | 'passkey') => (
    <Button
      size="small"
      variant={restoreLeads && method === 'file' ? 'primary' : 'secondary'}
      disabled={busy}
      onClick={() =>
        void run(async () => {
          const restored = await port.restore(method);
          return restored.outcome === 'restored'
            ? { kind: 'restored', results: restored.results }
            : undefined;
        })
      }
    >
      {t(method === 'file' ? 'e2ee.recovery.restore' : 'e2ee.recovery.restorePasskey')}
    </Button>
  );
  return (
    <div {...stylex.props(styles.stack)} data-testid="e2ee-recovery">
      {mode === 'failed' && (
        <Alert.Root tone="danger">
          <Alert.Description>{t('e2ee.recovery.planFailed')}</Alert.Description>
          <Alert.Actions>
            <Button
              disabled={busy}
              onClick={() => {
                setPlanFailed(false);
                setReload((n) => n + 1);
              }}
            >
              {t('common.retry')}
            </Button>
          </Alert.Actions>
        </Alert.Root>
      )}
      {mode === 'none' && (
        <Alert.Root tone="warning" data-testid="e2ee-recovery-none">
          <Alert.Title>{t('e2ee.recovery.noneTitle')}</Alert.Title>
          <Alert.Description>{t('e2ee.recovery.noneBody')}</Alert.Description>
        </Alert.Root>
      )}
      {unfinished.length > 0 && (
        <Alert.Root tone="warning" data-testid="e2ee-recovery-uncovered">
          <Alert.Title>
            {t('e2ee.recovery.uncoveredTitle', { count: unfinished.length })}
          </Alert.Title>
          <Alert.Description>{t('e2ee.recovery.uncoveredBody')}</Alert.Description>
          <Alert.Actions>
            <Button disabled={busy} onClick={() => setupAll('file')}>
              {t('e2ee.recovery.setupAll')}
            </Button>
            {passkey && (
              <Button variant="secondary" disabled={busy} onClick={() => setupAll('passkey')}>
                {t('e2ee.recovery.setupAllPasskey')}
              </Button>
            )}
          </Alert.Actions>
        </Alert.Root>
      )}
      <CompactSection title={t('e2ee.recovery.methods')} boxed>
        <CompactRow
          label={t('e2ee.recovery.file')}
          helper={
            mode === 'ready' || mode === 'replacing'
              ? mode === 'replacing'
                ? t('e2ee.recovery.fileReplacing')
                : checkedAt
                  ? t('e2ee.recovery.fileSavedChecked', {
                      date: new Intl.DateTimeFormat(toIntlLocaleOrEn(i18n?.language), {
                        month: 'short',
                        day: 'numeric',
                      }).format(new Date(checkedAt)),
                    })
                  : t('e2ee.recovery.fileSaved')
              : mode === 'none'
                ? t(create ? 'e2ee.recovery.fileNone' : 'e2ee.recovery.createElsewhere')
                : t('e2ee.recovery.offlineHint')
          }
          alignTop
        >
          <div {...stylex.props(styles.rowActions)}>
            {create && (mode === 'none' || mode === 'failed') && (
              <Button
                size="small"
                variant={mode === 'none' ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const created = await create();
                    if (created.outcome !== 'created') return undefined;
                    // Creation saves and reads the file back, so it counts as a check.
                    markChecked(Date.now());
                    return { kind: 'created', vaultId: created.vaultId };
                  })
                }
              >
                {t('e2ee.recovery.create')}
              </Button>
            )}
            {checkFile && (mode === 'ready' || mode === 'failed') && (
              <Button
                size="small"
                // One primary action at a time: setting up uncovered workspaces leads when
                // there are any; otherwise checking the saved file does.
                variant={mode === 'ready' && unfinished.length === 0 ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const opened = await checkFile();
                    if (opened.outcome !== 'opened') return undefined;
                    markChecked(Date.now());
                    return { kind: 'opened', vaultId: opened.vaultId, count: opened.workspaces };
                  })
                }
              >
                {t('e2ee.recovery.check')}
              </Button>
            )}
            {replacement && mode === 'ready' && (
              <Button
                size="small"
                variant="secondary"
                disabled={busy}
                onClick={() => setDialog('begin')}
              >
                {t('e2ee.recovery.replace')}
              </Button>
            )}
            {canRestore && restoreButton('file')}
          </div>
        </CompactRow>
        {passkey && (mode === 'ready' || mode === 'replacing' || canRestore) && (
          <CompactRow
            label={t('e2ee.recovery.passkey')}
            helper={t('e2ee.recovery.passkeyHelp')}
            alignTop
          >
            <div {...stylex.props(styles.rowActions)}>
              {mode === 'ready' && (
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void port.passkeyDefaultLabel().then(
                      (label) => setNaming(label),
                      () => setNaming('')
                    )
                  }
                >
                  {t('e2ee.recovery.passkeyAdd')}
                </Button>
              )}
              {mode === 'ready' && (
                <Button
                  size="small"
                  variant="ghost"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const listed = await port.listPasskeys();
                      if (listed.outcome === 'listed') {
                        setPasskeys(listed.passkeys);
                        setPending(listed.pending);
                      }
                      return undefined;
                    })
                  }
                >
                  {t('e2ee.recovery.passkeyManage')}
                </Button>
              )}
              {canRestore && restoreButton('passkey')}
            </div>
          </CompactRow>
        )}
      </CompactSection>
      {pending.length > 0 && (
        <Alert.Root tone="warning">
          <Alert.Description>
            {pending.map((row) => (
              <span key={row.entryId} {...stylex.props(styles.actions)}>
                {t('e2ee.recovery.passkeyRemoveUnfinished', { name: row.label })}
                <Button
                  size="small"
                  variant="secondary"
                  disabled={busy}
                  onClick={() => void run(() => removePasskey(row.entryId))}
                >
                  {t('e2ee.recovery.passkeyRemoveRetry')}
                </Button>
              </span>
            ))}
          </Alert.Description>
        </Alert.Root>
      )}
      {passkeys !== undefined && (
        <CompactSection title={t('e2ee.recovery.passkeys')} boxed>
          {passkeys.length === 0 ? (
            <CompactRow label={t('e2ee.recovery.passkeyNone')} />
          ) : (
            passkeys.map((row) => (
              <CompactRow key={row.entryId} label={row.label}>
                <Button
                  size="small"
                  variant="secondary"
                  tone="destructive"
                  disabled={busy}
                  onClick={() => setRemoving(row)}
                >
                  {t('e2ee.recovery.passkeyRemove')}
                </Button>
              </CompactRow>
            ))
          )}
        </CompactSection>
      )}
      {mode === 'ready' && !!plan?.covered.length && (
        <CompactSection title={t('e2ee.recovery.workspaces')} boxed>
          {plan.covered.map((workspace) => {
            const badge = statusBadge[workspace.status.kind];
            return (
              <CompactRow key={workspace.id} label={workspace.name}>
                <div data-recovery-workspace={workspace.id} {...stylex.props(styles.rowActions)}>
                  <Badge tone={badge.tone} data-recovery-status={workspace.status.kind}>
                    {t(badge.key)}
                  </Badge>
                  {(workspace.status.kind === 'notSet' || workspace.status.kind === 'saved') && (
                    <Button
                      size="small"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const done = await port.setupWorkspace(workspace.id);
                          if (done.outcome === 'cancelled') return undefined;
                          return {
                            kind: 'notice',
                            key:
                              done.outcome === 'Committed' && done.recoverable
                                ? 'e2ee.recovery.setupDone'
                                : 'e2ee.recovery.replacePending',
                          };
                        })
                      }
                    >
                      {t(
                        workspace.status.kind === 'saved'
                          ? 'e2ee.recovery.setupContinue'
                          : 'e2ee.recovery.setup'
                      )}
                    </Button>
                  )}
                </div>
              </CompactRow>
            );
          })}
        </CompactSection>
      )}
      {result?.kind === 'restored' &&
        (result.results.length === 0 ? (
          <p aria-live="polite">{t('e2ee.recovery.restoreNone')}</p>
        ) : (
          <ul aria-live="polite">
            {result.results.map((row) => (
              <li key={row.name}>
                {t(
                  row.outcome === 'Committed'
                    ? row.partialEpochKey
                      ? 'e2ee.recovery.restorePartial'
                      : 'e2ee.recovery.restoreDone'
                    : row.outcome === 'Pending' || row.outcome === 'Unconfirmed'
                      ? 'e2ee.recovery.restoreWaiting'
                      : row.outcome === 'not-backed-up'
                        ? 'e2ee.recovery.restoreNotBackedUp'
                        : 'e2ee.recovery.restoreFailed',
                  { name: row.name }
                )}
              </li>
            ))}
          </ul>
        ))}
      {result?.kind === 'setupAll' && (
        <Alert.Root tone={result.failed.length ? 'warning' : 'success'} aria-live="polite">
          <Alert.Description>
            {result.failed.length
              ? t('e2ee.recovery.setupAllPartial', {
                  done: result.done,
                  names: result.failed.join(t('e2ee.recovery.nameSeparator')),
                })
              : t('e2ee.recovery.setupAllDone')}
          </Alert.Description>
        </Alert.Root>
      )}
      {plan?.replacing &&
        !replacement && (
          // This host cannot continue it; the device that started it finishes or abandons it.
          <Alert.Root tone="warning">
            <Alert.Description aria-live="polite">
              {t('e2ee.recovery.replacingOtherDevice')}
            </Alert.Description>
          </Alert.Root>
        )}
      {plan?.replacing && replacement && (
        <Alert.Root tone="warning">
          <Alert.Description aria-live="polite">{t('e2ee.recovery.replacing')}</Alert.Description>
          <Alert.Actions>
            <Button disabled={busy} onClick={() => setDialog('continue')}>
              {t('e2ee.recovery.replaceContinue')}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const abandoned = await replacement.abandon();
                  return {
                    kind: 'notice',
                    key:
                      abandoned.outcome === 'Pending'
                        ? 'e2ee.recovery.replacePending'
                        : 'e2ee.recovery.replaceAbandoned',
                  };
                })
              }
            >
              {t('e2ee.recovery.replaceAbandon')}
            </Button>
          </Alert.Actions>
        </Alert.Root>
      )}
      {events.length > 0 && (
        <CompactSection title={t('e2ee.recovery.securityEvents')} boxed>
          {events.slice(0, 5).map((event) => (
            <CompactRow
              key={event.id}
              label={t(
                event.kind === 'personal_device_recovered'
                  ? 'e2ee.recovery.eventRecovered'
                  : event.kind === 'vault_replacement_finished'
                    ? 'e2ee.recovery.eventReplaced'
                    : 'e2ee.recovery.eventReplacing',
                { time: new Date(event.occurredAt).toLocaleString() }
              )}
            />
          ))}
          {replacement && mode === 'ready' && (
            <CompactRow label={t('e2ee.recovery.eventNotMeHelp')}>
              <Button
                size="small"
                variant="secondary"
                tone="destructive"
                disabled={busy}
                onClick={() => setDialog('begin')}
              >
                {t('e2ee.recovery.eventNotMe')}
              </Button>
            </CompactRow>
          )}
        </CompactSection>
      )}
      {result?.kind === 'notice' && <p aria-live="polite">{t(result.key)}</p>}
      {result?.kind === 'created' && (
        <p aria-live="polite">{t('e2ee.recovery.created', { vaultId: short(result.vaultId) })}</p>
      )}
      {result?.kind === 'opened' && (
        <p aria-live="polite">
          {t('e2ee.recovery.opened', { vaultId: short(result.vaultId), count: result.count })}
        </p>
      )}
      {result?.kind === 'error' && (
        <Alert.Root tone="danger">
          <Alert.Description>
            {t(
              result.code.includes('e2ee_recovery_disabled')
                ? 'e2ee.recovery.disabled'
                : result.code.includes('e2ee_recovery_prf-unavailable')
                  ? 'e2ee.recovery.passkeyUnsupported'
                  : result.code.includes('e2ee_recovery_replacing')
                    ? 'e2ee.recovery.replacingElsewhere'
                    : result.code.includes('e2ee_recovery_exists')
                      ? 'e2ee.recovery.exists'
                      : /e2ee_recovery_(?:authentication|invalid-input)/.test(result.code)
                        ? 'e2ee.recovery.wrongFile'
                        : 'e2ee.recovery.failed'
            )}
          </Alert.Description>
        </Alert.Root>
      )}
      <AlertDialog.Root
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('e2ee.recovery.passkeyRemoveTitle', { name: removing?.label ?? '' })}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t('e2ee.recovery.passkeyRemoveBody')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const entryId = removing?.entryId ?? '';
                setRemoving(undefined);
                void run(() => removePasskey(entryId));
              }}
            >
              {t('e2ee.recovery.passkeyRemove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={naming !== undefined}
        onOpenChange={(open) => {
          if (!open) setNaming(undefined);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('e2ee.recovery.passkeyNameTitle')}</AlertDialog.Title>
            <AlertDialog.Description>{t('e2ee.recovery.passkeyNameHelp')}</AlertDialog.Description>
          </AlertDialog.Header>
          <Input
            aria-label={t('e2ee.recovery.passkeyNameTitle')}
            value={naming ?? ''}
            maxLength={64}
            onChange={(event) => setNaming(event.target.value)}
          />
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={busy || !naming?.trim()}
              onClick={() => {
                const label = naming ?? '';
                setNaming(undefined);
                void run(async () => {
                  const added = await port.addPasskey(label);
                  return added.outcome === 'added'
                    ? { kind: 'notice', key: 'e2ee.recovery.passkeyAdded' }
                    : undefined;
                });
              }}
            >
              {t('e2ee.recovery.passkeyAdd')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={dialog !== undefined}
        onOpenChange={(open) => {
          if (!open) setDialog(undefined);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t(
                dialog === 'continue'
                  ? 'e2ee.recovery.replaceRevokeTitle'
                  : 'e2ee.recovery.replaceTitle'
              )}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {/* Separate lines, not a joining space: Chinese takes no space between sentences. */}
              <span {...stylex.props(styles.line)}>
                {t(
                  dialog === 'continue'
                    ? 'e2ee.recovery.replaceContinueBody'
                    : 'e2ee.recovery.replaceBody'
                )}
              </span>
              <span {...stylex.props(styles.line)}>{t('e2ee.recovery.replaceOldFile')}</span>
            </AlertDialog.Description>
          </AlertDialog.Header>
          {!!plan?.uncovered.length && (
            <div {...stylex.props(styles.body)}>
              <p>{t('e2ee.recovery.replaceUncovered')}</p>
              <ul>
                {plan.uncovered.map((workspace) => (
                  <li key={workspace.id}>{workspace.name}</li>
                ))}
              </ul>
            </div>
          )}
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            {dialog === 'continue' && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => {
                  setDialog(undefined);
                  if (replacement) void run(() => finishReplacement(replacement, true));
                }}
              >
                {t('e2ee.recovery.replaceRevokeFirst')}
              </Button>
            )}
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const step = dialog;
                setDialog(undefined);
                if (!replacement) return;
                void run(async () => {
                  if (step === 'continue') return finishReplacement(replacement, false);
                  const begun = await replacement.begin();
                  return begun.outcome === 'begun'
                    ? { kind: 'notice', key: 'e2ee.recovery.replaceBegun' }
                    : undefined;
                });
              }}
            >
              {t(
                dialog === 'continue' ? 'e2ee.recovery.replaceFinish' : 'e2ee.recovery.replaceSave'
              )}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}
