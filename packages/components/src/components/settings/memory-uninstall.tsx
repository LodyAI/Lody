import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import type { MemoryInstallFailure, MemoryProviderResponse } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Spinner } from '@lody/ui/spinner';
import { AlertDialog } from '@/ui/dialog';
import type { useMemoryProvider } from '@/hooks/use-memory-provider';
import { settingsCatalog as catalog } from './surface';
import { FormMessage } from './form-primitives';
import { useMemoryJobPoll } from './use-memory-job-poll';

const POLL_INTERVAL_MS = 3_000;
/** Past the daemon's own npm budget, so the machine gives up first and says why. */
const RUN_BUDGET_MS = 12 * 60_000;

type Phase = 'idle' | 'confirming' | 'starting' | 'running' | 'failed';

/**
 * The uninstall control for an installed provider: a button for its heading,
 * the confirmation it opens, and the line saying how the last attempt ended.
 * Kept in the block that owns the provider rather than in one card, because
 * the card changes under it the moment the package is gone.
 */
export function useMemoryUninstall({
  name,
  providerKey,
  state,
  onUninstalled,
}: {
  name: string;
  providerKey: string;
  state: ReturnType<typeof useMemoryProvider>;
  onUninstalled?: () => void;
}): { busy: boolean; action: (disabled: boolean) => ReactNode; message: ReactNode } {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<Phase>('idle');
  const [failure, setFailure] = useState<MemoryInstallFailure>();
  const [endsAt, setEndsAt] = useState(0);
  const busy = phase === 'starting' || phase === 'running';

  const settle = (result: MemoryProviderResponse | undefined) => {
    const job = result?.uninstall;
    if (!job) {
      setPhase('failed');
      return;
    }
    if (job.status === 'running') return;
    if (job.status === 'failed') {
      setFailure(job.failure);
      setPhase('failed');
      return;
    }
    setPhase('idle');
    onUninstalled?.();
    // The reply already carries the probe; reading again puts every block
    // on the page back on the install card without waiting for the timer.
    void state.refresh();
  };

  useMemoryJobPoll({
    active: phase === 'running',
    intervalMs: POLL_INTERVAL_MS,
    endsAt,
    ask: state.uninstallPoll,
    onReply: (result) => {
      // A reply that never reached the machine is not the job's answer.
      if (result?.uninstall) settle(result);
    },
    onExpire: () => setPhase('failed'),
  });

  const start = async () => {
    if (busy) return;
    setFailure(undefined);
    setPhase('starting');
    const result = await state.uninstall();
    if (result?.uninstall?.status === 'running') {
      setEndsAt(Date.now() + RUN_BUDGET_MS);
      setPhase('running');
    } else settle(result);
  };

  const action = (disabled: boolean) => (
    <>
      <Button
        type="button"
        size="small"
        variant="ghost"
        disabled={disabled || busy}
        aria-busy={busy}
        onClick={() => setPhase('confirming')}
      >
        {t('settings.memory.uninstall.action')}
        {busy ? <Spinner size="small" label={null} {...stylex.props(catalog.icon)} /> : null}
      </Button>
      <AlertDialog.Root
        open={phase === 'confirming'}
        onOpenChange={(open) => {
          if (!open) setPhase((current) => (current === 'confirming' ? 'idle' : current));
        }}
      >
        <AlertDialog.Content>
          <AlertDialog.Header>
            <AlertDialog.Title>
              {t('settings.memory.uninstall.title', { provider: name })}
            </AlertDialog.Title>
            <AlertDialog.Description>
              {t(
                [
                  `settings.memory.uninstall.notice.${providerKey}`,
                  'settings.memory.uninstall.notice',
                ],
                {
                  provider: name,
                }
              )}
            </AlertDialog.Description>
          </AlertDialog.Header>
          <AlertDialog.Footer>
            <AlertDialog.Cancel>{t('common.cancel')}</AlertDialog.Cancel>
            <Button type="button" variant="destructive" onClick={() => void start()}>
              {t('settings.memory.uninstall.confirm')}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </>
  );

  const message = busy ? (
    <span role="status" {...stylex.props(catalog.meta)}>
      {t('settings.memory.uninstall.running', { provider: name })}
    </span>
  ) : phase === 'failed' ? (
    <FormMessage tone="error">
      {t(
        failure
          ? [
              `settings.memory.uninstall.failed.${failure}.${providerKey}`,
              `settings.memory.uninstall.failed.${failure}`,
            ]
          : [`settings.memory.uninstall.failed.${providerKey}`, 'settings.memory.uninstall.failed'],
        { provider: name }
      )}
    </FormMessage>
  ) : null;

  return { busy, action, message };
}
