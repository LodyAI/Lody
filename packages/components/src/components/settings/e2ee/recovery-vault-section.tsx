import { useAtomValue } from 'jotai';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { Alert } from '@lody/ui/alert';
import { Button } from '@lody/ui/button';
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

type Result =
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
  if (!enabled || !e2ee) return null;
  const run = async (work: () => Promise<Result | undefined>) => {
    if (busy) return;
    setBusy(true);
    try {
      const next = await work();
      if (next) setResult(next);
    } catch (error) {
      setResult({ kind: 'error', code: error instanceof Error ? error.message : '' });
    } finally {
      setBusy(false);
    }
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
        </div>
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
                  : /e2ee_recovery_(?:authentication|invalid-input)/.test(result.code)
                    ? 'e2ee.recovery.wrongFile'
                    : 'e2ee.recovery.failed'
              )}
            </Alert.Description>
          </Alert.Root>
        )}
      </div>
    </CompactSection>
  );
}
