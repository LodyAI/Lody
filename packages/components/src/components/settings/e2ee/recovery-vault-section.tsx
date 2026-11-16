import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Badge, type BadgeTone } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Spinner } from '@lody/ui/spinner';
import { AlertDialog } from '@/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@/atoms/settings';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { CompactRow, CompactSection } from '../compact-layout';
import {
  useRecoveryPort,
  type RecoveryPasskey,
  type RecoveryPlan,
  type RecoveryReplacementPort,
  type RecoverySecurityEvent,
  type RecoveryUnlockMethod,
  type RecoveryUnlockOptions,
  type RecoveryWorkspaceStatus,
} from './recovery-port';

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

const MIN_PASSWORD_CHARS = 12;
const validPasswordInput = (value: string) =>
  [...value.normalize('NFC')].length >= MIN_PASSWORD_CHARS &&
  new TextEncoder().encode(value.normalize('NFC')).byteLength <= 1024;

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[3],
    padding: space[4],
    fontSize: text.subheadlineSize,
  },
  dialogFields: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[2],
  },
  fieldHint: {
    color: colors.secondaryLabel,
    fontSize: text.footnoteSize,
  },
  fieldError: {
    color: colors.destructive,
    fontSize: text.footnoteSize,
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
        | 'e2ee.recovery.passkeyRemoveIncomplete'
        | 'e2ee.recovery.fileSavedNotice'
        | 'e2ee.recovery.passwordSetNotice'
        | 'e2ee.recovery.passwordRemoved'
        | 'e2ee.recovery.passwordRemoveIncomplete';
    }
  | {
      kind: 'restored';
      results: readonly { name: string; outcome: string; partialEpochKey?: boolean }[];
    }
  | { kind: 'setupAll'; done: number; failed: readonly string[] }
  | { kind: 'created'; vaultId: string; method?: 'file' | 'passkey' | 'password' }
  | { kind: 'opened'; vaultId: string; count: number }
  | { kind: 'error'; code: string; method?: RecoveryUnlockMethod };

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
 * Account recovery vault controls, enabled by default; desktop main independently honors
 * `LODY_E2EE_RECOVERY_VAULT=off` as an emergency kill switch. The host's recovery port
 * owns the unlock, file, passkey ceremony and Argon2id password derivation; this view
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
  // `disabled`: the host refused because recovery is off there (desktop main started
  // with `LODY_E2EE_RECOVERY_VAULT=off`), which no retry changes; `failed`: anything else.
  const [planFailed, setPlanFailed] = useState<false | 'failed' | 'disabled'>(false);
  const [reload, setReload] = useState(0);
  const [dialog, setDialog] = useState<'begin' | 'continue'>();
  const [passkey, setPasskey] = useState(false);
  const [events, setEvents] = useState<readonly RecoverySecurityEvent[]>([]);
  const [naming, setNaming] = useState<{ mode: 'add' | 'create'; label: string }>();
  const [passkeys, setPasskeys] = useState<readonly RecoveryPasskey[]>();
  const [pending, setPending] = useState<readonly RecoveryPasskey[]>([]);
  const [removing, setRemoving] = useState<RecoveryPasskey>();
  const [passwordDialog, setPasswordDialog] = useState<'create' | 'set' | 'change'>();
  const [currentPassword, setCurrentPassword] = useState('');
  const [nextPassword, setNextPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [unlockPrompt, setUnlockPrompt] = useState<{
    run: (password: string) => Promise<Result | undefined>;
  }>();
  const [unlockPassword, setUnlockPassword] = useState('');
  const [removingPassword, setRemovingPassword] = useState(false);

  const closePasswordDialog = () => {
    setPasswordDialog(undefined);
    setCurrentPassword('');
    setNextPassword('');
    setConfirmPassword('');
  };
  const openPasswordDialog = (nextMode: 'create' | 'set' | 'change') => {
    setCurrentPassword('');
    setNextPassword('');
    setConfirmPassword('');
    setPasswordDialog(nextMode);
  };
  const closeUnlockPrompt = () => {
    setUnlockPrompt(undefined);
    setUnlockPassword('');
  };

  useEffect(() => {
    if (!enabled || !port) return;
    let live = true;
    void port.plan().then(
      (next) => {
        if (!live) return;
        setPlan(next);
        setPlanFailed(false);
      },
      (error: unknown) => {
        if (!live) return;
        setPlan(undefined);
        setPlanFailed(
          error instanceof Error && error.message.includes('e2ee_recovery_disabled')
            ? 'disabled'
            : 'failed'
        );
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
  const {
    create,
    createWithPasskey,
    createWithPassword,
    saveFile,
    setPassword,
    removePassword,
    checkFile,
    replacement,
  } = port;
  const methods = plan?.methods;
  const hasFile = methods ? methods.hasFile : true;
  const hasPassword = methods?.hasPassword === true;
  const hasPasskey = methods?.hasPasskey;
  const passwordSupported = Boolean(createWithPassword || setPassword || hasPassword);

  // One state decides which actions exist, so only one primary action shows at a time.
  // When the state cannot be read, retry leads and the actions that change nothing stay;
  // creating stays too because main and the service refuse a second vault.
  const mode = !plan
    ? planFailed
      ? planFailed
      : 'loading'
    : plan.replacing
      ? 'replacing'
      : plan.hasVault
        ? 'ready'
        : 'none';
  // An older file, passkey or password still restores during a replacement.
  const canRestore =
    mode === 'failed' || ((mode === 'ready' || mode === 'replacing') && !!plan?.uncovered.length);

  const run = async (
    work: () => Promise<Result | undefined>,
    unlockMethod?: RecoveryUnlockMethod
  ) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await work();
      if (next) setResult(next);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      // Dismissing the system prompt is a choice, not a failure.
      if (!code.includes('e2ee_recovery_cancelled'))
        setResult({ kind: 'error', code, method: unlockMethod });
    } finally {
      setBusy(false);
    }
  };

  const preferredUnlock: RecoveryUnlockMethod | undefined =
    methods === undefined
      ? undefined
      : passkey && hasPasskey === true
        ? 'passkey'
        : hasFile
          ? 'file'
          : passkey && hasPasskey !== false
            ? 'passkey'
            : hasPassword
              ? 'password'
              : 'file';

  const triggerWithUnlock = (
    action: (
      method?: RecoveryUnlockMethod,
      options?: RecoveryUnlockOptions
    ) => Promise<Result | undefined>,
    forcedMethod?: RecoveryUnlockMethod
  ) => {
    const chosen = forcedMethod ?? preferredUnlock;
    if (chosen === 'password') {
      setUnlockPassword('');
      setUnlockPrompt({
        run: (pwd) => action('password', { password: pwd }),
      });
      return;
    }
    void run(() => action(chosen), chosen);
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

  const runSetupAll = async (
    method: RecoveryUnlockMethod,
    options?: RecoveryUnlockOptions
  ): Promise<Result | undefined> => {
    const settled = options
      ? await port.setupWorkspaces(
          unfinished.map((row) => row.id),
          method,
          options
        )
      : await port.setupWorkspaces(
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
  };

  const setupAll = (method: RecoveryUnlockMethod) => {
    if (method === 'password') {
      triggerWithUnlock((_m, options) => runSetupAll('password', options), 'password');
      return;
    }
    void run(() => runSetupAll(method), method);
  };

  const removePasskey = async (
    entryId: string,
    method?: RecoveryUnlockMethod,
    options?: RecoveryUnlockOptions
  ): Promise<Result | undefined> => {
    const removed =
      method === undefined && options === undefined
        ? await port.removePasskey(entryId)
        : options === undefined
          ? await port.removePasskey(entryId, method)
          : await port.removePasskey(entryId, method, options);
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

  const canCreatePasskey = Boolean(passkey && createWithPasskey);
  const canCreatePassword = Boolean(createWithPassword);
  const canCreateFile = Boolean(create);
  const primaryCreate: 'passkey' | 'password' | 'file' | null = canCreatePasskey
    ? 'passkey'
    : canCreatePassword
      ? 'password'
      : canCreateFile
        ? 'file'
        : null;

  const canRemovePassword = Boolean(
    removePassword && hasPassword && (hasFile || hasPasskey === true)
  );
  const showPasswordNudge =
    mode === 'ready' && hasPasskey === true && hasPassword && Boolean(removePassword);
  const canRestorePassword =
    canRestore && passwordSupported && (mode === 'failed' || methods?.hasPassword !== false);

  // Restoring leads when it is this host's only next step: a replacement it cannot
  // continue, or nothing to set up and no file check/save. Desktop always has a step that
  // leads instead (continue, set up all, check or save file), so its restore stays secondary.
  const restorePrimaryMethod: RecoveryUnlockMethod = hasFile
    ? 'file'
    : passkey && hasPasskey !== false
      ? 'passkey'
      : 'password';
  const restoreLeads =
    canRestore &&
    ((mode === 'replacing' && !replacement) ||
      (mode === 'ready' &&
        unfinished.length === 0 &&
        !(hasFile && checkFile) &&
        !(!hasFile && saveFile)));

  const restoreButton = (method: RecoveryUnlockMethod) => (
    <Button
      size="small"
      variant={restoreLeads && method === restorePrimaryMethod ? 'primary' : 'secondary'}
      disabled={busy}
      onClick={() => {
        if (method === 'password') {
          triggerWithUnlock(async (_m, options) => {
            const restored = await port.restore('password', options);
            return restored.outcome === 'restored'
              ? { kind: 'restored', results: restored.results }
              : undefined;
          }, 'password');
          return;
        }
        void run(async () => {
          const restored = await port.restore(method);
          return restored.outcome === 'restored'
            ? { kind: 'restored', results: restored.results }
            : undefined;
        }, method);
      }}
    >
      {method === 'file'
        ? t('e2ee.recovery.restore')
        : method === 'passkey'
          ? t('e2ee.recovery.restorePasskey')
          : t('e2ee.recovery.restorePassword')}
    </Button>
  );

  const openPasskeyCreate = () => {
    void port.passkeyDefaultLabel().then(
      (label) => setNaming({ mode: 'create', label }),
      () => setNaming({ mode: 'create', label: '' })
    );
  };
  const openPasskeyAdd = () => {
    void port.passkeyDefaultLabel().then(
      (label) => setNaming({ mode: 'add', label }),
      () => setNaming({ mode: 'add', label: '' })
    );
  };

  const showSetupFile = hasFile;
  const showSetupPasskey = passkey && hasPasskey !== false;
  const showSetupPassword = hasPassword;
  const setupLead: RecoveryUnlockMethod = showSetupFile
    ? 'file'
    : showSetupPasskey
      ? 'passkey'
      : 'password';

  const changeNeedsCurrentPassword =
    passwordDialog === 'change' && !(passkey && hasPasskey === true);
  const passwordMismatch = confirmPassword.length > 0 && nextPassword !== confirmPassword;
  const canSubmitPasswordDialog =
    !busy &&
    validPasswordInput(nextPassword) &&
    nextPassword === confirmPassword &&
    (!changeNeedsCurrentPassword || validPasswordInput(currentPassword));

  // Until the first plan answers, nothing below would be accurate: say it is loading.
  if (mode === 'loading')
    return (
      <div {...stylex.props(styles.stack)} data-testid="e2ee-recovery" aria-busy>
        <CompactSection title={t('e2ee.recovery.methods')} boxed>
          <CompactRow label={t('e2ee.recovery.loading')}>
            <Spinner size="small" />
          </CompactRow>
        </CompactSection>
      </div>
    );
  // The host has recovery turned off: no action here can work, so offer none.
  if (mode === 'disabled')
    return (
      <div {...stylex.props(styles.stack)} data-testid="e2ee-recovery">
        <Alert.Root data-testid="e2ee-recovery-disabled">
          <Alert.Description>{t('e2ee.recovery.disabled')}</Alert.Description>
        </Alert.Root>
      </div>
    );

  const fileRow = (
    <CompactRow
      key="file"
      label={t('e2ee.recovery.file')}
      helper={
        mode === 'ready' || mode === 'replacing'
          ? mode === 'replacing'
            ? t('e2ee.recovery.fileReplacing')
            : !hasFile
              ? t('e2ee.recovery.fileNotSaved')
              : checkedAt
                ? t('e2ee.recovery.fileSavedChecked', {
                    date: new Intl.DateTimeFormat(toIntlLocaleOrEn(i18n?.language), {
                      month: 'short',
                      day: 'numeric',
                    }).format(new Date(checkedAt)),
                  })
                : t('e2ee.recovery.fileSaved')
          : mode === 'none'
            ? canCreateFile || canCreatePasskey || canCreatePassword
              ? t('e2ee.recovery.fileNone')
              : t('e2ee.recovery.createElsewhere')
            : t('e2ee.recovery.offlineHint')
      }
      alignTop
    >
      <div {...stylex.props(styles.rowActions)}>
        {create && (mode === 'none' || mode === 'failed') && (
          <Button
            size="small"
            variant={mode === 'none' && primaryCreate === 'file' ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const created = await create();
                if (created.outcome !== 'created') return undefined;
                // Creation saves and reads the file back, so it counts as a check.
                markChecked(Date.now());
                return { kind: 'created', vaultId: created.vaultId, method: 'file' };
              }, 'file')
            }
          >
            {t('e2ee.recovery.create')}
          </Button>
        )}
        {saveFile && mode === 'ready' && !hasFile && (
          <Button
            size="small"
            variant={unfinished.length === 0 ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() =>
              triggerWithUnlock(async (unlockMethod, options) => {
                const saved = await saveFile(unlockMethod ?? 'passkey', options);
                if (saved.outcome !== 'saved') return undefined;
                markChecked(Date.now());
                return { kind: 'notice', key: 'e2ee.recovery.fileSavedNotice' };
              })
            }
          >
            {t('e2ee.recovery.saveFile')}
          </Button>
        )}
        {checkFile && ((mode === 'ready' && hasFile) || mode === 'failed') && (
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
              }, 'file')
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
        {canRestore && (mode === 'failed' || hasFile) && restoreButton('file')}
      </div>
    </CompactRow>
  );

  const passkeyRow =
    passkey &&
    ((mode === 'none' && canCreatePasskey) ||
      mode === 'ready' ||
      mode === 'replacing' ||
      (canRestore && hasPasskey !== false)) ? (
      <CompactRow
        key="passkey"
        label={t('e2ee.recovery.passkey')}
        helper={
          mode === 'none' ? t('e2ee.recovery.passkeyNoneHelp') : t('e2ee.recovery.passkeyHelp')
        }
        alignTop
      >
        <div {...stylex.props(styles.rowActions)}>
          {mode === 'none' && canCreatePasskey && (
            <Button
              size="small"
              variant={primaryCreate === 'passkey' ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={openPasskeyCreate}
            >
              {t('e2ee.recovery.createWithPasskey')}
            </Button>
          )}
          {mode === 'ready' && (
            <Button size="small" variant="secondary" disabled={busy} onClick={openPasskeyAdd}>
              {t('e2ee.recovery.passkeyAdd')}
            </Button>
          )}
          {mode === 'ready' && (
            <Button
              size="small"
              variant="ghost"
              disabled={busy}
              onClick={() =>
                triggerWithUnlock(async (unlockMethod, options) => {
                  const listed =
                    unlockMethod === undefined && options === undefined
                      ? await port.listPasskeys()
                      : options === undefined
                        ? await port.listPasskeys(unlockMethod)
                        : await port.listPasskeys(unlockMethod, options);
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
          {canRestore && hasPasskey !== false && restoreButton('passkey')}
        </div>
      </CompactRow>
    ) : null;

  const passwordRow =
    passwordSupported &&
    ((mode === 'none' && canCreatePassword) || mode === 'ready' || canRestorePassword) ? (
      <CompactRow
        key="password"
        label={t('e2ee.recovery.password')}
        helper={
          mode === 'none'
            ? t('e2ee.recovery.passwordNoneHelp')
            : hasPassword
              ? t('e2ee.recovery.passwordSavedHelp')
              : t('e2ee.recovery.passwordUnsetHelp')
        }
        alignTop
      >
        <div {...stylex.props(styles.rowActions)}>
          {mode === 'none' && canCreatePassword && (
            <Button
              size="small"
              variant={primaryCreate === 'password' ? 'primary' : 'secondary'}
              disabled={busy}
              onClick={() => openPasswordDialog('create')}
            >
              {t('e2ee.recovery.createWithPassword')}
            </Button>
          )}
          {mode === 'ready' && setPassword && (
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => openPasswordDialog(hasPassword ? 'change' : 'set')}
            >
              {hasPassword ? t('e2ee.recovery.passwordChange') : t('e2ee.recovery.passwordSet')}
            </Button>
          )}
          {mode === 'ready' && canRemovePassword && (
            <Button
              size="small"
              variant="secondary"
              tone="destructive"
              disabled={busy}
              onClick={() => setRemovingPassword(true)}
            >
              {t('e2ee.recovery.passwordRemove')}
            </Button>
          )}
          {canRestorePassword && restoreButton('password')}
        </div>
      </CompactRow>
    ) : null;

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
      {showPasswordNudge && (
        <Alert.Root data-testid="e2ee-recovery-password-nudge">
          <Alert.Title>{t('e2ee.recovery.passwordNudgeTitle')}</Alert.Title>
          <Alert.Description>{t('e2ee.recovery.passwordNudgeBody')}</Alert.Description>
          <Alert.Actions>
            <Button
              size="small"
              variant="secondary"
              disabled={busy}
              onClick={() => setRemovingPassword(true)}
            >
              {t('e2ee.recovery.passwordRemove')}
            </Button>
          </Alert.Actions>
        </Alert.Root>
      )}
      {unfinished.length > 0 && (
        <Alert.Root tone="warning" data-testid="e2ee-recovery-uncovered">
          <Alert.Title>
            {t('e2ee.recovery.uncoveredTitle', { count: unfinished.length })}
          </Alert.Title>
          <Alert.Description>{t('e2ee.recovery.uncoveredBody')}</Alert.Description>
          <Alert.Actions>
            {showSetupFile && (
              <Button
                variant={setupLead === 'file' ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => setupAll('file')}
              >
                {t('e2ee.recovery.setupAll')}
              </Button>
            )}
            {showSetupPasskey && (
              <Button
                variant={setupLead === 'passkey' ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => setupAll('passkey')}
              >
                {t('e2ee.recovery.setupAllPasskey')}
              </Button>
            )}
            {showSetupPassword && (
              <Button
                variant={setupLead === 'password' ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => setupAll('password')}
              >
                {t('e2ee.recovery.setupAllPassword')}
              </Button>
            )}
          </Alert.Actions>
        </Alert.Root>
      )}
      <CompactSection title={t('e2ee.recovery.methods')} boxed>
        {mode === 'none' ? (
          <>
            {passkeyRow}
            {passwordRow}
            {fileRow}
          </>
        ) : (
          <>
            {fileRow}
            {passkeyRow}
            {passwordRow}
          </>
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
                  onClick={() =>
                    triggerWithUnlock((unlockMethod, options) =>
                      removePasskey(row.entryId, unlockMethod, options)
                    )
                  }
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
                        triggerWithUnlock(async (unlockMethod, options) => {
                          const done =
                            unlockMethod === undefined && options === undefined
                              ? await port.setupWorkspace(workspace.id)
                              : options === undefined
                                ? await port.setupWorkspace(workspace.id, unlockMethod)
                                : await port.setupWorkspace(workspace.id, unlockMethod, options);
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
                      {workspace.status.kind === 'saved'
                        ? t('e2ee.recovery.setupContinue')
                        : t('e2ee.recovery.setup')}
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
                {row.outcome === 'Committed'
                  ? row.partialEpochKey
                    ? t('e2ee.recovery.restorePartial', { name: row.name })
                    : t('e2ee.recovery.restoreDone', { name: row.name })
                  : row.outcome === 'Pending' || row.outcome === 'Unconfirmed'
                    ? t('e2ee.recovery.restoreWaiting', { name: row.name })
                    : row.outcome === 'not-backed-up'
                      ? t('e2ee.recovery.restoreNotBackedUp', { name: row.name })
                      : t('e2ee.recovery.restoreFailed', { name: row.name })}
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
              label={
                event.kind === 'personal_device_recovered'
                  ? t('e2ee.recovery.eventRecovered', {
                      time: new Date(event.occurredAt).toLocaleString(),
                    })
                  : event.kind === 'vault_replacement_finished'
                    ? t('e2ee.recovery.eventReplaced', {
                        time: new Date(event.occurredAt).toLocaleString(),
                      })
                    : t('e2ee.recovery.eventReplacing', {
                        time: new Date(event.occurredAt).toLocaleString(),
                      })
              }
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
        <p aria-live="polite">
          {result.method === 'passkey'
            ? t('e2ee.recovery.createdPasskey', { vaultId: short(result.vaultId) })
            : result.method === 'password'
              ? t('e2ee.recovery.createdPassword', { vaultId: short(result.vaultId) })
              : t('e2ee.recovery.created', { vaultId: short(result.vaultId) })}
        </p>
      )}
      {result?.kind === 'opened' && (
        <p aria-live="polite">
          {t('e2ee.recovery.opened', { vaultId: short(result.vaultId), count: result.count })}
        </p>
      )}
      {result?.kind === 'error' && (
        <Alert.Root tone="danger">
          <Alert.Description>
            {result.code.includes('e2ee_recovery_disabled')
              ? t('e2ee.recovery.disabled')
              : result.code.includes('e2ee_recovery_prf-unavailable')
                ? t('e2ee.recovery.passkeyUnsupported')
                : result.code.includes('e2ee_recovery_replacing')
                  ? t('e2ee.recovery.replacingElsewhere')
                  : result.code.includes('e2ee_recovery_exists')
                    ? t('e2ee.recovery.exists')
                    : /e2ee_recovery_(?:authentication|invalid-input)/.test(result.code)
                      ? result.method === 'password'
                        ? t('e2ee.recovery.wrongPassword')
                        : t('e2ee.recovery.wrongFile')
                      : t('e2ee.recovery.failed')}
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
                triggerWithUnlock((unlockMethod, options) =>
                  removePasskey(entryId, unlockMethod, options)
                );
              }}
            >
              {t('e2ee.recovery.passkeyRemove')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={removingPassword}
        onOpenChange={(open) => {
          if (!open) setRemovingPassword(false);
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('e2ee.recovery.passwordRemoveTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('e2ee.recovery.passwordRemoveBody')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                setRemovingPassword(false);
                if (!removePassword) return;
                const removalUnlock: RecoveryUnlockMethod =
                  passkey && hasPasskey === true ? 'passkey' : hasFile ? 'file' : 'password';
                triggerWithUnlock(async (unlockMethod, options) => {
                  const removed = await removePassword(unlockMethod ?? 'passkey', options);
                  if (removed.outcome === 'cancelled') return undefined;
                  return {
                    kind: 'notice',
                    key:
                      removed.outcome === 'removed'
                        ? 'e2ee.recovery.passwordRemoved'
                        : 'e2ee.recovery.passwordRemoveIncomplete',
                  };
                }, removalUnlock);
              }}
            >
              {t('e2ee.recovery.passwordRemove')}
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
            value={naming?.label ?? ''}
            maxLength={64}
            onChange={(event) =>
              setNaming((prev) => (prev ? { ...prev, label: event.target.value } : prev))
            }
          />
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={busy || !naming?.label.trim()}
              onClick={() => {
                const target = naming;
                setNaming(undefined);
                if (!target) return;
                if (target.mode === 'create') {
                  if (!createWithPasskey) return;
                  void run(async () => {
                    const created = await createWithPasskey(target.label);
                    return created.outcome === 'created'
                      ? { kind: 'created', vaultId: created.vaultId, method: 'passkey' }
                      : undefined;
                  }, 'passkey');
                  return;
                }
                triggerWithUnlock(async (unlockMethod, options) => {
                  const added =
                    unlockMethod === undefined && options === undefined
                      ? await port.addPasskey(target.label)
                      : options === undefined
                        ? await port.addPasskey(target.label, unlockMethod)
                        : await port.addPasskey(target.label, unlockMethod, options);
                  return added.outcome === 'added'
                    ? { kind: 'notice', key: 'e2ee.recovery.passkeyAdded' }
                    : undefined;
                });
              }}
            >
              {naming?.mode === 'create'
                ? t('e2ee.recovery.createWithPasskey')
                : t('e2ee.recovery.passkeyAdd')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={passwordDialog !== undefined}
        onOpenChange={(open) => {
          if (!open) closePasswordDialog();
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {passwordDialog === 'create'
                ? t('e2ee.recovery.passwordCreateTitle')
                : passwordDialog === 'change'
                  ? t('e2ee.recovery.passwordChangeTitle')
                  : t('e2ee.recovery.passwordSetTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {passwordDialog === 'create'
                ? t('e2ee.recovery.passwordCreateHelp')
                : passwordDialog === 'change'
                  ? t('e2ee.recovery.passwordChangeHelp')
                  : t('e2ee.recovery.passwordSetHelp')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <div {...stylex.props(styles.dialogFields)}>
            {changeNeedsCurrentPassword && (
              <Input
                type="password"
                autoComplete="current-password"
                data-testid="e2ee-recovery-current-password"
                aria-label={t('e2ee.recovery.passwordCurrentLabel')}
                placeholder={t('e2ee.recovery.passwordCurrentLabel')}
                disabled={busy}
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            )}
            <Input
              type="password"
              autoComplete="new-password"
              data-testid="e2ee-recovery-new-password"
              aria-label={t('e2ee.recovery.passwordLabel')}
              placeholder={t('e2ee.recovery.passwordPlaceholder')}
              disabled={busy}
              value={nextPassword}
              onChange={(event) => setNextPassword(event.target.value)}
            />
            <Input
              type="password"
              autoComplete="new-password"
              data-testid="e2ee-recovery-confirm-password"
              aria-label={t('e2ee.recovery.passwordConfirmLabel')}
              placeholder={t('e2ee.recovery.passwordConfirmPlaceholder')}
              disabled={busy}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
            />
            <span {...stylex.props(styles.fieldHint)}>{t('e2ee.recovery.passwordLengthHint')}</span>
            {passwordMismatch && (
              <span {...stylex.props(styles.fieldError)}>
                {t('e2ee.recovery.passwordMismatch')}
              </span>
            )}
          </div>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            {changeNeedsCurrentPassword && hasFile && setPassword && (
              <Button
                variant="secondary"
                disabled={
                  busy || !validPasswordInput(nextPassword) || nextPassword !== confirmPassword
                }
                onClick={() => {
                  const chosen = nextPassword;
                  closePasswordDialog();
                  void run(async () => {
                    const updated = await setPassword({ password: chosen, method: 'file' });
                    return updated.outcome === 'updated'
                      ? { kind: 'notice', key: 'e2ee.recovery.passwordSetNotice' }
                      : undefined;
                  }, 'file');
                }}
              >
                {t('e2ee.recovery.passwordResetWithFile')}
              </Button>
            )}
            <Button
              disabled={!canSubmitPasswordDialog}
              onClick={() => {
                const action = passwordDialog;
                const chosen = nextPassword;
                const current = currentPassword;
                closePasswordDialog();
                if (action === 'create') {
                  if (!createWithPassword) return;
                  void run(async () => {
                    const created = await createWithPassword(chosen);
                    return created.outcome === 'created'
                      ? { kind: 'created', vaultId: created.vaultId, method: 'password' }
                      : undefined;
                  }, 'password');
                  return;
                }
                if (!setPassword) return;
                if (action === 'change') {
                  if (passkey && hasPasskey === true) {
                    void run(async () => {
                      const updated = await setPassword({ password: chosen, method: 'passkey' });
                      return updated.outcome === 'updated'
                        ? { kind: 'notice', key: 'e2ee.recovery.passwordSetNotice' }
                        : undefined;
                    }, 'passkey');
                  } else {
                    void run(async () => {
                      const updated = await setPassword({
                        password: chosen,
                        method: 'password',
                        currentPassword: current,
                      });
                      return updated.outcome === 'updated'
                        ? { kind: 'notice', key: 'e2ee.recovery.passwordSetNotice' }
                        : undefined;
                    }, 'password');
                  }
                  return;
                }
                const setUnlock: RecoveryUnlockMethod =
                  passkey && hasPasskey === true ? 'passkey' : 'file';
                void run(async () => {
                  const updated = await setPassword({ password: chosen, method: setUnlock });
                  return updated.outcome === 'updated'
                    ? { kind: 'notice', key: 'e2ee.recovery.passwordSetNotice' }
                    : undefined;
                }, setUnlock);
              }}
            >
              {passwordDialog === 'create'
                ? t('e2ee.recovery.createWithPassword')
                : passwordDialog === 'change'
                  ? t('e2ee.recovery.passwordChange')
                  : t('e2ee.recovery.passwordSet')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={unlockPrompt !== undefined}
        onOpenChange={(open) => {
          if (!open) closeUnlockPrompt();
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>{t('e2ee.recovery.passwordUnlockTitle')}</AlertDialog.Title>
            <AlertDialog.Description>
              {t('e2ee.recovery.passwordUnlockHelp')}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <div {...stylex.props(styles.dialogFields)}>
            <Input
              type="password"
              autoComplete="current-password"
              data-testid="e2ee-recovery-unlock-password"
              aria-label={t('e2ee.recovery.passwordLabel')}
              placeholder={t('e2ee.recovery.passwordPlaceholder')}
              disabled={busy}
              value={unlockPassword}
              onChange={(event) => setUnlockPassword(event.target.value)}
            />
            <span {...stylex.props(styles.fieldHint)}>{t('e2ee.recovery.passwordLengthHint')}</span>
          </div>
          <AlertDialog.Footer>
            <AlertDialog.Cancel disabled={busy}>{t('common.cancel')}</AlertDialog.Cancel>
            <Button
              disabled={busy || !validPasswordInput(unlockPassword)}
              onClick={() => {
                const pendingAction = unlockPrompt;
                const entered = unlockPassword;
                closeUnlockPrompt();
                if (!pendingAction) return;
                void run(() => pendingAction.run(entered), 'password');
              }}
            >
              {t('e2ee.lostAll.continue')}
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
              {dialog === 'continue'
                ? t('e2ee.recovery.replaceRevokeTitle')
                : t('e2ee.recovery.replaceTitle')}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {/* Separate lines, not a joining space: Chinese takes no space between sentences. */}
              <span {...stylex.props(styles.line)}>
                {dialog === 'continue'
                  ? t('e2ee.recovery.replaceContinueBody')
                  : t('e2ee.recovery.replaceBody')}
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
              {dialog === 'continue'
                ? t('e2ee.recovery.replaceFinish')
                : t('e2ee.recovery.replaceSave')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </div>
  );
}
