import { useAtomValue } from 'jotai';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
import { Input } from '@lody/ui/input';
import { AlertDialog } from '@/ui/dialog';
import { space, text } from '@lody/ui/tokens/scales.stylex';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@/atoms/settings';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { CompactSection } from '../compact-layout';

const styles = stylex.create({
  body: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: space[3],
    padding: space[4],
    fontSize: text.subheadlineSize,
  },
  actions: { display: 'flex', gap: space[2], flexWrap: 'wrap' },
});

type Plan = {
  replaceable: boolean;
  replacing: boolean;
  covered: readonly { id: string; name: string }[];
  uncovered: readonly { id: string; name: string }[];
};
type Result =
  | {
      kind: 'notice';
      key:
        | 'e2ee.recovery.replaceBegun'
        | 'e2ee.recovery.replaceAbandoned'
        | 'e2ee.recovery.replaceFinished'
        | 'e2ee.recovery.replacePending'
        | 'e2ee.recovery.setupDone'
        | 'e2ee.recovery.passkeyAdded';
    }
  | { kind: 'restored'; results: readonly { name: string; outcome: string }[] }
  | { kind: 'created'; vaultId: string }
  | { kind: 'opened'; vaultId: string; count: number }
  | { kind: 'error'; code: string };

/**
 * Post-MVP recovery file controls, hidden unless Developer mode and the beta
 * switch are on; main additionally refuses unless started with the env gate.
 * Main owns the file dialogs and bytes; this view receives only outcomes.
 */
export function RecoveryVaultSection() {
  const { t } = useTranslation();
  const enabled = useAtomValue(e2eeRecoveryVaultFeatureEnabledAtom);
  const e2ee = getIpcServices()?.e2ee;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();
  const [plan, setPlan] = useState<Plan>();
  const [dialog, setDialog] = useState<'begin' | 'continue'>();
  const [passkey, setPasskey] = useState(false);
  const [naming, setNaming] = useState<string>();
  useEffect(() => {
    if (!enabled || !e2ee) return;
    let live = true;
    void e2ee.recoveryReplacementPlan().then(
      (next) => {
        if (live) setPlan(next);
      },
      () => undefined
    );
    void e2ee.recoveryPasskeyAvailable().then(
      (next) => {
        if (live) setPasskey(next);
      },
      () => undefined
    );
    return () => {
      live = false;
    };
  }, [enabled, e2ee, result]);
  if (!enabled || !e2ee) return null;
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
  const finishReplacement = async (compromised: boolean): Promise<Result | undefined> => {
    const finished = await e2ee.continueRecoveryReplacement({ compromised });
    if (finished.outcome === 'Committed')
      return { kind: 'notice', key: 'e2ee.recovery.replaceFinished' };
    return finished.outcome === 'Pending'
      ? { kind: 'notice', key: 'e2ee.recovery.replacePending' }
      : undefined;
  };
  const short = (vaultId: string) => vaultId.slice(0, 12);
  return (
    <CompactSection title={t('e2ee.recovery.title')}>
      <div {...stylex.props(styles.body)}>
        <p>{t('e2ee.recovery.lead')}</p>
        <div {...stylex.props(styles.actions)}>
          <Button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const created = await e2ee.createRecoveryVault();
                return created.outcome === 'created'
                  ? { kind: 'created', vaultId: created.vaultId }
                  : undefined;
              })
            }
          >
            {t('e2ee.recovery.create')}
          </Button>
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const opened = await e2ee.inspectRecoveryFile();
                return opened.outcome === 'opened'
                  ? { kind: 'opened', vaultId: opened.vaultId, count: opened.workspaces }
                  : undefined;
              })
            }
          >
            {t('e2ee.recovery.check')}
          </Button>
          {plan?.replaceable && !plan.replacing && (
            <Button variant="secondary" disabled={busy} onClick={() => setDialog('begin')}>
              {t('e2ee.recovery.replace')}
            </Button>
          )}
          {!!plan?.uncovered.length && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const restored = await e2ee.restoreFromRecoveryFile();
                  return restored.outcome === 'restored'
                    ? { kind: 'restored', results: restored.results }
                    : undefined;
                })
              }
            >
              {t('e2ee.recovery.restore')}
            </Button>
          )}
          {passkey && !!plan?.uncovered.length && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const restored = await e2ee.restoreFromRecoveryFile('passkey');
                  return restored.outcome === 'restored'
                    ? { kind: 'restored', results: restored.results }
                    : undefined;
                })
              }
            >
              {t('e2ee.recovery.restorePasskey')}
            </Button>
          )}
          {passkey && plan?.replaceable && (
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() =>
                void e2ee.recoveryPasskeyDefaultLabel().then(
                  (label) => setNaming(label),
                  () => setNaming('')
                )
              }
            >
              {t('e2ee.recovery.passkeyAdd')}
            </Button>
          )}
        </div>
        {!!plan?.covered.length && (
          <div {...stylex.props(styles.body)}>
            <p>{t('e2ee.recovery.workspaces')}</p>
            {plan.covered.map((workspace) => (
              <div key={workspace.id} {...stylex.props(styles.actions)}>
                <span>{workspace.name}</span>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() =>
                    void run(async () => {
                      const done = await e2ee.setupWorkspaceRecovery(workspace.id);
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
                  {t('e2ee.recovery.setup')}
                </Button>
                {passkey && (
                  <Button
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const done = await e2ee.setupWorkspaceRecovery(workspace.id, 'passkey');
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
                    {t('e2ee.recovery.setupPasskey')}
                  </Button>
                )}
              </div>
            ))}
          </div>
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
                      ? 'e2ee.recovery.restoreDone'
                      : row.outcome === 'Pending'
                        ? 'e2ee.recovery.restoreWaiting'
                        : 'e2ee.recovery.restoreFailed',
                    { name: row.name }
                  )}
                </li>
              ))}
            </ul>
          ))}
        {plan?.replacing && (
          <>
            <p aria-live="polite">{t('e2ee.recovery.replacing')}</p>
            <div {...stylex.props(styles.actions)}>
              <Button disabled={busy} onClick={() => setDialog('continue')}>
                {t('e2ee.recovery.replaceContinue')}
              </Button>
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const abandoned = await e2ee.abandonRecoveryReplacement();
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
            </div>
          </>
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
          <Alert.Root>
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
      </div>
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
                  const added = await e2ee.addRecoveryPasskey(label);
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
              {dialog === 'begin' && t('e2ee.recovery.replaceBody')}{' '}
              {t('e2ee.recovery.replaceOldFile')}
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
                  void run(() => finishReplacement(true));
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
                void run(async () => {
                  if (step === 'continue') return finishReplacement(false);
                  const begun = await e2ee.beginRecoveryReplacement();
                  return begun.outcome === 'begun'
                    ? { kind: 'notice', key: 'e2ee.recovery.replaceBegun' }
                    : undefined;
                });
              }}
            >
              {t(
                dialog === 'continue'
                  ? 'e2ee.recovery.replaceContinue'
                  : 'e2ee.recovery.replaceSave'
              )}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </CompactSection>
  );
}
