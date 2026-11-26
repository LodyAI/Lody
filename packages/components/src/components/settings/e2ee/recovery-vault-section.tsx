import { recoveryAvailabilityMessage } from '@/lib/e2ee-actionable-failure';
import { useAtomValue } from 'jotai';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FileKey2, KeyRound, Lock, MoreHorizontal, type LucideIcon } from 'lucide-react';
import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Badge, type BadgeTone } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { Menu } from '@lody/ui/menu';
import { Spinner } from '@lody/ui/spinner';
import { AlertDialog } from '@/ui/dialog';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { control, space, text } from '@lody/ui/tokens/scales.stylex';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@/atoms/settings';
import { toIntlLocaleOrEn } from '@/lib/intl-locale';
import { CompactRow, CompactSection } from '../compact-layout';
import { settingsMaterial } from '../material.stylex';
import {
  useRecoveryPort,
  type RecoveryPasskey,
  type RecoveryPlan,
  type RecoveryRestoreResult,
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

const flushHeadingTheme = stylex.createTheme(settingsMaterial, {
  headingInset: '0px',
});

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
  methodRow: {
    display: { default: 'flex', '@media (min-width: 640px)': 'grid' },
    flexDirection: 'column',
    gridTemplateColumns: { default: null, '@media (min-width: 640px)': 'minmax(0, 1fr) auto' },
    alignItems: { default: 'stretch', '@media (min-width: 640px)': 'center' },
    gap: { default: space[3], '@media (min-width: 640px)': space[4] },
    paddingInline: space[4],
    paddingBlock: space[3],
    minWidth: 0,
  },
  methodIdentity: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: space[3],
    minWidth: 0,
  },
  methodIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: '16px',
    height: '16px',
    marginTop: '2px',
    color: colors.secondaryLabel,
  },
  methodBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
    flexGrow: 1,
  },
  methodHeader: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: space[2],
    minWidth: 0,
  },
  methodTitle: {
    margin: 0,
    fontSize: text.bodySize,
    fontWeight: 500,
    lineHeight: 1.4,
    color: colors.label,
  },
  methodHelper: {
    margin: 0,
    fontSize: text.footnoteSize,
    lineHeight: 1.45,
    color: colors.secondaryLabel,
  },
  rowActions: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: space[1.5],
    flexWrap: 'nowrap',
    justifyContent: { default: 'flex-start', '@media (min-width: 640px)': 'flex-end' },
  },
  workspaceActions: {
    display: 'flex',
    alignItems: 'center',
    gap: space[3],
    flexWrap: 'wrap',
    minHeight: control.small,
    justifyContent: { default: 'flex-start', '@media (min-width: 640px)': 'flex-end' },
  },
  stack: { display: 'flex', flexDirection: 'column', gap: space[6] },
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
      results: readonly RecoveryRestoreResult[];
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

export function preferredRecoveryUnlock(
  methods: RecoveryPlan['methods'],
  passkey: boolean
): RecoveryUnlockMethod | undefined {
  if (!methods) return undefined;
  if (passkey && methods.hasPasskey === true) return 'passkey';
  if (methods.hasFile) return 'file';
  if (methods.hasPassword) return 'password';
  return passkey && methods.hasPasskey !== false ? 'passkey' : 'file';
}

const recoveryErrorKey = (code: string, method?: RecoveryUnlockMethod) =>
  recoveryAvailabilityMessage(code) ??
  (code.includes('e2ee_recovery_disabled')
    ? 'e2ee.recovery.disabled'
    : code.includes('e2ee_recovery_prf-unavailable')
      ? 'e2ee.recovery.passkeyUnsupported'
      : code.includes('e2ee_recovery_replacing')
        ? 'e2ee.recovery.replacingElsewhere'
        : code.includes('e2ee_recovery_exists')
          ? 'e2ee.recovery.exists'
          : /e2ee_recovery_(?:authentication|invalid-input)/.test(code)
            ? method === 'password'
              ? 'e2ee.recovery.wrongPassword'
              : method === 'passkey'
                ? 'e2ee.recovery.wrongPasskey'
                : 'e2ee.recovery.wrongFile'
            : 'e2ee.recovery.failed');

/**
 * Account recovery vault controls, enabled by default; desktop main independently honors
 * `LODY_E2EE_RECOVERY_VAULT=off` as an emergency kill switch. The host's recovery port
 * owns the unlock, file, passkey ceremony and Argon2id password derivation; this view
 * receives only outcomes, and offers only the actions the port supports.
 */
export function RecoveryVaultSection({
  accountId,
  onRestored,
  onOpenWorkspace,
  onBackToWorkspaces,
}: {
  accountId?: string | null;
  onRestored?: () => void;
  onOpenWorkspace?: () => void;
  onBackToWorkspaces?: () => void;
} = {}) {
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
  const [restoreProgress, setRestoreProgress] = useState<readonly RecoveryRestoreResult[]>([]);
  const [settingUp, setSettingUp] = useState<RecoveryUnlockMethod | null>(null);
  const operation = useRef(0);
  const observations = useRef<AbortController | null>(null);
  useEffect(() => {
    setRestoreProgress([]);
    setSettingUp(null);
    setResult(undefined);
    setPlan(undefined);
    setPlanFailed(false);
    setEvents([]);
    setBusy(false);
    return () => {
      operation.current++;
      observations.current?.abort();
    };
  }, [accountId, port]);
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
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [removingPassword, setRemovingPassword] = useState(false);

  const closePasswordDialog = () => {
    setPasswordDialog(undefined);
    setCurrentPassword('');
    setNextPassword('');
    setConfirmPassword('');
    setDialogError(null);
  };
  const openPasswordDialog = (nextMode: 'create' | 'set' | 'change') => {
    setCurrentPassword('');
    setNextPassword('');
    setConfirmPassword('');
    setDialogError(null);
    setPasswordDialog(nextMode);
  };
  const closeUnlockPrompt = () => {
    setUnlockPrompt(undefined);
    setUnlockPassword('');
    setDialogError(null);
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
  }, [enabled, port, accountId, result, reload]);

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
    unlockMethod?: RecoveryUnlockMethod,
    options?: { keepDialogOnError?: boolean }
  ): Promise<boolean> => {
    if (busy) return false;
    const ticket = ++operation.current;
    setBusy(true);
    setDialogError(null);
    setRestoreProgress([]);
    try {
      const next = await work();
      if (operation.current !== ticket) return false;
      if (next) setResult(next);
      return true;
    } catch (error) {
      if (operation.current !== ticket) return false;
      const code = error instanceof Error ? error.message : '';
      // Dismissing the system prompt is a choice, not a failure.
      if (code.includes('e2ee_recovery_cancelled')) return true;
      setResult({ kind: 'error', code, method: unlockMethod });
      if (options?.keepDialogOnError) setDialogError(recoveryErrorKey(code, unlockMethod));
      return false;
    } finally {
      if (operation.current === ticket) setBusy(false);
    }
  };

  const preferredUnlock = preferredRecoveryUnlock(methods, passkey);

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
      setDialogError(null);
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
    const ticket = operation.current;
    setSettingUp(method);
    try {
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
    } finally {
      if (operation.current === ticket) setSettingUp(null);
    }
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

  const restore = async (
    method: RecoveryUnlockMethod,
    options?: RecoveryUnlockOptions
  ): Promise<Result | undefined> => {
    const ticket = operation.current;
    setRestoreProgress(
      (plan?.uncovered ?? []).map((row) => ({
        workspaceId: row.id,
        name: row.name,
        outcome: 'Restoring',
      }))
    );
    const observation = new AbortController();
    observations.current?.abort();
    observations.current = observation;
    try {
      const restored = await port.restore(
        method,
        options,
        (row) => {
          if (operation.current !== ticket) return;
          setRestoreProgress((rows) => {
            const index = row.workspaceId
              ? rows.findIndex((old) => old.workspaceId === row.workspaceId)
              : -1;
            return index < 0 ? [...rows, row] : rows.map((old, i) => (i === index ? row : old));
          });
        },
        observation.signal
      );
      if (operation.current !== ticket) return;
      if (restored.outcome !== 'restored') {
        setRestoreProgress([]);
        return;
      }
      setRestoreProgress(restored.results);
      if (restored.results.some((row) => row.outcome === 'Committed')) onRestored?.();
      return { kind: 'restored', results: restored.results };
    } finally {
      observation.abort();
      if (observations.current === observation) observations.current = null;
    }
  };
  const restoreRows = restoreProgress.length
    ? restoreProgress
    : result?.kind === 'restored'
      ? result.results
      : undefined;
  type MethodAction = {
    key: string;
    label: string;
    variant?: 'primary' | 'secondary';
    tone?: 'destructive';
    onClick: () => void;
  };

  const makeRestoreAction = (method: RecoveryUnlockMethod): MethodAction => ({
    key: `restore-${method}`,
    label:
      method === 'file'
        ? t('e2ee.recovery.restore')
        : method === 'passkey'
          ? t('e2ee.recovery.restorePasskey')
          : t('e2ee.recovery.restorePassword'),
    variant: restoreLeads && method === restorePrimaryMethod ? 'primary' : 'secondary',
    onClick: () => {
      if (method === 'password') {
        triggerWithUnlock((_m, options) => restore('password', options), 'password');
        return;
      }
      void run(() => restore(method), method);
    },
  });

  const renderMethodRow = ({
    id,
    icon: Icon,
    title,
    badge,
    helper,
    leadActions,
    secondaryActions,
    restoreAction,
  }: {
    id: RecoveryUnlockMethod;
    icon: LucideIcon;
    title: string;
    badge?: { label: string; tone: BadgeTone };
    helper: string;
    leadActions: MethodAction[];
    secondaryActions: MethodAction[];
    restoreAction: MethodAction | null;
  }) => {
    const ordered =
      restoreLeads && restoreAction
        ? [restoreAction, ...leadActions, ...secondaryActions]
        : [...leadActions, ...secondaryActions, ...(restoreAction ? [restoreAction] : [])];
    const [visibleAction, ...overflowActions] = ordered;
    return (
      <div key={id} data-recovery-method={id} {...stylex.props(styles.methodRow)}>
        <div {...stylex.props(styles.methodIdentity)}>
          <span {...stylex.props(styles.methodIcon)} aria-hidden="true">
            <Icon size={16} />
          </span>
          <div {...stylex.props(styles.methodBody)}>
            <div {...stylex.props(styles.methodHeader)}>
              <p {...stylex.props(styles.methodTitle)}>{title}</p>
              {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
            </div>
            <p {...stylex.props(styles.methodHelper)}>{helper}</p>
          </div>
        </div>
        {(visibleAction || overflowActions.length > 0) && (
          <div {...stylex.props(styles.rowActions)}>
            {visibleAction && (
              <Button
                size="small"
                variant={visibleAction.variant ?? 'secondary'}
                tone={visibleAction.tone}
                disabled={busy}
                onClick={visibleAction.onClick}
              >
                {visibleAction.label}
              </Button>
            )}
            {overflowActions.length > 0 && (
              <Menu.Root>
                <Menu.Trigger
                  render={
                    <Button
                      size="small"
                      variant="ghost"
                      icon
                      disabled={busy}
                      data-testid={`e2ee-recovery-more-${id}`}
                      aria-label={`${title}: ${t('common.more')}`}
                    >
                      <MoreHorizontal size={16} aria-hidden="true" />
                    </Button>
                  }
                />
                <Menu.Content align="end" width="compact">
                  {overflowActions.map((item) => (
                    <Menu.Item
                      key={item.key}
                      tone={item.tone}
                      disabled={busy}
                      onClick={item.onClick}
                    >
                      {item.label}
                    </Menu.Item>
                  ))}
                </Menu.Content>
              </Menu.Root>
            )}
          </div>
        )}
      </div>
    );
  };

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
      <div {...stylex.props(flushHeadingTheme, styles.stack)} data-testid="e2ee-recovery" aria-busy>
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
      <div {...stylex.props(flushHeadingTheme, styles.stack)} data-testid="e2ee-recovery">
        <Alert.Root data-testid="e2ee-recovery-disabled">
          <Alert.Description>{t('e2ee.recovery.disabled')}</Alert.Description>
        </Alert.Root>
      </div>
    );

  const fileLeadActions: MethodAction[] = [];
  if (saveFile && mode === 'ready' && !hasFile) {
    fileLeadActions.push({
      key: 'save-file',
      label: t('e2ee.recovery.saveFile'),
      variant: unfinished.length === 0 ? 'primary' : 'secondary',
      onClick: () =>
        triggerWithUnlock(async (unlockMethod, options) => {
          const saved = await saveFile(unlockMethod ?? 'passkey', options);
          if (saved.outcome !== 'saved') return undefined;
          markChecked(Date.now());
          return { kind: 'notice', key: 'e2ee.recovery.fileSavedNotice' };
        }),
    });
  }
  if (checkFile && ((mode === 'ready' && hasFile) || mode === 'failed')) {
    fileLeadActions.push({
      key: 'check-file',
      label: t('e2ee.recovery.check'),
      variant: mode === 'ready' && unfinished.length === 0 ? 'primary' : 'secondary',
      onClick: () =>
        void run(async () => {
          const opened = await checkFile();
          if (opened.outcome !== 'opened') return undefined;
          markChecked(Date.now());
          return { kind: 'opened', vaultId: opened.vaultId, count: opened.workspaces };
        }, 'file'),
    });
  }
  if (create && (mode === 'none' || mode === 'failed')) {
    fileLeadActions.push({
      key: 'create-file',
      label: t('e2ee.recovery.create'),
      variant: mode === 'none' && primaryCreate === 'file' ? 'primary' : 'secondary',
      onClick: () =>
        void run(async () => {
          const created = await create();
          if (created.outcome !== 'created') return undefined;
          markChecked(Date.now());
          return { kind: 'created', vaultId: created.vaultId, method: 'file' };
        }, 'file'),
    });
  }
  const fileSecondaryActions: MethodAction[] = [];
  if (replacement && mode === 'ready') {
    fileSecondaryActions.push({
      key: 'replace-file',
      label: t('e2ee.recovery.replace'),
      onClick: () => setDialog('begin'),
    });
  }
  const fileRow = renderMethodRow({
    id: 'file',
    icon: FileKey2,
    title: t('e2ee.recovery.file'),
    badge:
      mode === 'ready'
        ? hasFile
          ? checkedAt
            ? { label: t('e2ee.recovery.methodVerified'), tone: 'success' }
            : { label: t('e2ee.recovery.methodSaved'), tone: 'neutral' }
          : { label: t('e2ee.recovery.workspace.notSet'), tone: 'warning' }
        : undefined,
    helper:
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
          : t('e2ee.recovery.offlineHint'),
    leadActions: fileLeadActions,
    secondaryActions: fileSecondaryActions,
    restoreAction: canRestore && (mode === 'failed' || hasFile) ? makeRestoreAction('file') : null,
  });

  const passkeyLeadActions: MethodAction[] = [];
  if (mode === 'none' && canCreatePasskey) {
    passkeyLeadActions.push({
      key: 'create-passkey',
      label: t('e2ee.recovery.createWithPasskey'),
      variant: primaryCreate === 'passkey' ? 'primary' : 'secondary',
      onClick: openPasskeyCreate,
    });
  }
  if (mode === 'ready') {
    passkeyLeadActions.push({
      key: 'add-passkey',
      label: t('e2ee.recovery.passkeyAdd'),
      variant: 'secondary',
      onClick: openPasskeyAdd,
    });
  }
  const passkeySecondaryActions: MethodAction[] = [];
  if (mode === 'ready') {
    passkeySecondaryActions.push({
      key: 'manage-passkey',
      label: t('e2ee.recovery.passkeyManage'),
      onClick: () =>
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
        }),
    });
  }
  const passkeyRow =
    passkey &&
    ((mode === 'none' && canCreatePasskey) ||
      mode === 'ready' ||
      mode === 'replacing' ||
      (canRestore && hasPasskey !== false))
      ? renderMethodRow({
          id: 'passkey',
          icon: KeyRound,
          title: t('e2ee.recovery.passkey'),
          badge:
            mode === 'ready' && hasPasskey === true
              ? { label: t('e2ee.recovery.methodSaved'), tone: 'success' }
              : mode === 'ready' && hasPasskey === false
                ? { label: t('e2ee.recovery.workspace.notSet'), tone: 'neutral' }
                : undefined,
          helper:
            mode === 'none' ? t('e2ee.recovery.passkeyNoneHelp') : t('e2ee.recovery.passkeyHelp'),
          leadActions: passkeyLeadActions,
          secondaryActions: passkeySecondaryActions,
          restoreAction: canRestore && hasPasskey !== false ? makeRestoreAction('passkey') : null,
        })
      : null;

  const passwordLeadActions: MethodAction[] = [];
  if (mode === 'none' && canCreatePassword) {
    passwordLeadActions.push({
      key: 'create-password',
      label: t('e2ee.recovery.createWithPassword'),
      variant: primaryCreate === 'password' ? 'primary' : 'secondary',
      onClick: () => openPasswordDialog('create'),
    });
  }
  if (mode === 'ready' && setPassword) {
    passwordLeadActions.push({
      key: 'set-password',
      label: hasPassword ? t('e2ee.recovery.passwordChange') : t('e2ee.recovery.passwordSet'),
      variant: 'secondary',
      onClick: () => openPasswordDialog(hasPassword ? 'change' : 'set'),
    });
  }
  const passwordSecondaryActions: MethodAction[] = [];
  if (mode === 'ready' && canRemovePassword) {
    passwordSecondaryActions.push({
      key: 'remove-password',
      label: t('e2ee.recovery.passwordRemove'),
      tone: 'destructive',
      onClick: () => setRemovingPassword(true),
    });
  }
  const passwordRow =
    passwordSupported &&
    ((mode === 'none' && canCreatePassword) || mode === 'ready' || canRestorePassword)
      ? renderMethodRow({
          id: 'password',
          icon: Lock,
          title: t('e2ee.recovery.password'),
          badge:
            mode === 'ready'
              ? hasPassword
                ? { label: t('e2ee.recovery.methodSaved'), tone: 'success' }
                : { label: t('e2ee.recovery.workspace.notSet'), tone: 'neutral' }
              : undefined,
          helper:
            mode === 'none'
              ? t('e2ee.recovery.passwordNoneHelp')
              : hasPassword
                ? t('e2ee.recovery.passwordSavedHelp')
                : t('e2ee.recovery.passwordUnsetHelp'),
          leadActions: passwordLeadActions,
          secondaryActions: passwordSecondaryActions,
          restoreAction: canRestorePassword ? makeRestoreAction('password') : null,
        })
      : null;

  const methodRows = (
    mode === 'none' ? [passkeyRow, passwordRow, fileRow] : [fileRow, passkeyRow, passwordRow]
  ).filter(Boolean);

  const hasRestoredWorkspace = Boolean(restoreRows?.some((row) => row.outcome === 'Committed'));
  const resultBanners = (
    <>
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
          <Alert.Description>{t(recoveryErrorKey(result.code, result.method))}</Alert.Description>
        </Alert.Root>
      )}
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
      {restoreRows &&
        (restoreRows.length === 0 ? (
          <p aria-live="polite">{t('e2ee.recovery.restoreNone')}</p>
        ) : (
          <div {...stylex.props(styles.stack)}>
            <ul aria-live="polite">
              {restoreRows.map((row, index) => (
                <li
                  key={row.workspaceId ?? index}
                  data-recovery-result={row.workspaceId}
                  data-recovery-outcome={row.outcome}
                >
                  {row.outcome === 'Restoring'
                    ? t('e2ee.recovery.restoreWorking', { name: row.name })
                    : row.outcome === 'Committed'
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
            {hasRestoredWorkspace && (onOpenWorkspace || onBackToWorkspaces) && (
              <div {...stylex.props(styles.actions)}>
                {onOpenWorkspace && (
                  <Button size="small" variant="primary" onClick={onOpenWorkspace}>
                    {t('e2ee.control.openWorkspace')}
                  </Button>
                )}
                {onBackToWorkspaces && (
                  <Button size="small" variant="secondary" onClick={onBackToWorkspaces}>
                    {t('e2ee.lostAccess.back')}
                  </Button>
                )}
              </div>
            )}
          </div>
        ))}
    </>
  );

  return (
    <div {...stylex.props(flushHeadingTheme, styles.stack)} data-testid="e2ee-recovery">
      {mode === 'failed' && (
        <Alert.Root tone="danger">
          <Alert.Title>{t('e2ee.recovery.planFailedTitle')}</Alert.Title>
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
      {resultBanners}
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
                {settingUp === 'file'
                  ? t('e2ee.recovery.settingUpAll')
                  : t('e2ee.recovery.setupAll')}
              </Button>
            )}
            {showSetupPasskey && (
              <Button
                variant={setupLead === 'passkey' ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => setupAll('passkey')}
              >
                {settingUp === 'passkey'
                  ? t('e2ee.recovery.settingUpAll')
                  : t('e2ee.recovery.setupAllPasskey')}
              </Button>
            )}
            {showSetupPassword && (
              <Button
                variant={setupLead === 'password' ? 'primary' : 'secondary'}
                disabled={busy}
                onClick={() => setupAll('password')}
              >
                {settingUp === 'password'
                  ? t('e2ee.recovery.settingUpAll')
                  : t('e2ee.recovery.setupAllPassword')}
              </Button>
            )}
          </Alert.Actions>
        </Alert.Root>
      )}
      <CompactSection title={t('e2ee.recovery.methods')} boxed>
        {methodRows}
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
                <div
                  data-recovery-workspace={workspace.id}
                  {...stylex.props(styles.workspaceActions)}
                >
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
          if (!open && !busy) closePasswordDialog();
        }}
      >
        <AlertDialog.Content>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!canSubmitPasswordDialog) return;
              const action = passwordDialog;
              const chosen = nextPassword;
              const current = currentPassword;
              if (action === 'create') {
                if (!createWithPassword) return;
                void run(
                  async () => {
                    const created = await createWithPassword(chosen);
                    return created.outcome === 'created'
                      ? { kind: 'created', vaultId: created.vaultId, method: 'password' }
                      : undefined;
                  },
                  'password',
                  { keepDialogOnError: true }
                ).then((ok) => {
                  if (ok) closePasswordDialog();
                });
                return;
              }
              if (!setPassword) return;
              if (action === 'change') {
                if (passkey && hasPasskey === true) {
                  void run(
                    async () => {
                      const updated = await setPassword({ password: chosen, method: 'passkey' });
                      return updated.outcome === 'updated'
                        ? { kind: 'notice', key: 'e2ee.recovery.passwordSetNotice' }
                        : undefined;
                    },
                    'passkey',
                    { keepDialogOnError: true }
                  ).then((ok) => {
                    if (ok) closePasswordDialog();
                  });
                } else {
                  void run(
                    async () => {
                      const updated = await setPassword({
                        password: chosen,
                        method: 'password',
                        currentPassword: current,
                      });
                      return updated.outcome === 'updated'
                        ? { kind: 'notice', key: 'e2ee.recovery.passwordSetNotice' }
                        : undefined;
                    },
                    'password',
                    { keepDialogOnError: true }
                  ).then((ok) => {
                    if (ok) closePasswordDialog();
                  });
                }
                return;
              }
              const setUnlock: RecoveryUnlockMethod =
                passkey && hasPasskey === true ? 'passkey' : 'file';
              void run(
                async () => {
                  const updated = await setPassword({ password: chosen, method: setUnlock });
                  return updated.outcome === 'updated'
                    ? { kind: 'notice', key: 'e2ee.recovery.passwordSetNotice' }
                    : undefined;
                },
                setUnlock,
                { keepDialogOnError: true }
              ).then((ok) => {
                if (ok) closePasswordDialog();
              });
            }}
          >
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
              <span {...stylex.props(styles.fieldHint)}>
                {t('e2ee.recovery.passwordLengthHint')}
              </span>
              {passwordMismatch && (
                <span {...stylex.props(styles.fieldError)}>
                  {t('e2ee.recovery.passwordMismatch')}
                </span>
              )}
              {dialogError && (
                <Alert.Root tone="danger">
                  <Alert.Description>{t(dialogError)}</Alert.Description>
                </Alert.Root>
              )}
            </div>
            <AlertDialog.Footer>
              <AlertDialog.Cancel type="button" disabled={busy}>
                {t('common.cancel')}
              </AlertDialog.Cancel>
              {changeNeedsCurrentPassword && hasFile && setPassword && (
                <Button
                  type="button"
                  variant="secondary"
                  disabled={
                    busy || !validPasswordInput(nextPassword) || nextPassword !== confirmPassword
                  }
                  onClick={() => {
                    const chosen = nextPassword;
                    void run(
                      async () => {
                        const updated = await setPassword({ password: chosen, method: 'file' });
                        return updated.outcome === 'updated'
                          ? { kind: 'notice', key: 'e2ee.recovery.passwordSetNotice' }
                          : undefined;
                      },
                      'file',
                      { keepDialogOnError: true }
                    ).then((ok) => {
                      if (ok) closePasswordDialog();
                    });
                  }}
                >
                  {t('e2ee.recovery.passwordResetWithFile')}
                </Button>
              )}
              <Button type="submit" disabled={!canSubmitPasswordDialog}>
                {busy && <Spinner size="small" />}
                {passwordDialog === 'create'
                  ? t('e2ee.recovery.createWithPassword')
                  : passwordDialog === 'change'
                    ? t('e2ee.recovery.passwordChange')
                    : t('e2ee.recovery.passwordSet')}
              </Button>
            </AlertDialog.Footer>
          </form>
        </AlertDialog.Content>
      </AlertDialog.Root>
      <AlertDialog.Root
        open={unlockPrompt !== undefined}
        onOpenChange={(open) => {
          if (!open && !busy) closeUnlockPrompt();
        }}
      >
        <AlertDialog.Content>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (busy || !validPasswordInput(unlockPassword) || !unlockPrompt) return;
              const pendingAction = unlockPrompt;
              const entered = unlockPassword;
              void run(() => pendingAction.run(entered), 'password', {
                keepDialogOnError: true,
              }).then((ok) => {
                if (ok) closeUnlockPrompt();
              });
            }}
          >
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
              <span {...stylex.props(styles.fieldHint)}>
                {t('e2ee.recovery.passwordLengthHint')}
              </span>
              {dialogError && (
                <Alert.Root tone="danger">
                  <Alert.Description>{t(dialogError)}</Alert.Description>
                </Alert.Root>
              )}
            </div>
            <AlertDialog.Footer>
              <AlertDialog.Cancel type="button" disabled={busy}>
                {t('common.cancel')}
              </AlertDialog.Cancel>
              <Button type="submit" disabled={busy || !validPasswordInput(unlockPassword)}>
                {busy && <Spinner size="small" />}
                {t('e2ee.lostAll.continue')}
              </Button>
            </AlertDialog.Footer>
          </form>
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
