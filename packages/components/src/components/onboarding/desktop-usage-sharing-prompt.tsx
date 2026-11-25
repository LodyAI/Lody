import * as stylex from '@stylexjs/stylex';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { desktopOnboardingCompletionRevisionAtom } from '@/atoms/onboarding';
import {
  hasAccountUsagePromptDecision,
  markAccountUsagePromptDecided,
  rememberDesktopAccountChoice,
  readDeviceUsageChoice,
  subscribeUsageSharing,
  writeDeviceUsageSharing,
} from '@/lib/usage-sharing';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { usePlatform, usePlatformSession } from '@lody/platform/react';
import { getIpcServices } from '@/lib/electron-ipc-client';

const styles = stylex.create({
  footer: { flexDirection: { default: 'row', '@media (max-width: 480px)': 'row' } },
});

export function UsageSharingPrompt() {
  const session = usePlatformSession();
  const accountId = session.status === 'authenticated' ? session.user.id : null;
  const choice = useSyncExternalStore(subscribeUsageSharing, readDeviceUsageChoice, () => null);
  const decided = useSyncExternalStore(
    subscribeUsageSharing,
    () => (accountId ? hasAccountUsagePromptDecision(accountId) : false),
    () => false
  );
  const preference = usePlatform().cloudApi?.useOptionalAuthenticatedQuery?.(
    cloudOperations.analytics.getUsageSharing,
    accountId ? { accountId } : 'skip'
  );
  const account = preference?.data;
  if (
    !accountId ||
    decided ||
    choice !== null ||
    account === false ||
    (preference !== undefined && typeof account !== 'boolean')
  ) {
    return null;
  }
  if (typeof window !== 'undefined' && window.__LODY_ELECTRON__) {
    return <DesktopCompletedOnboardingPrompt key={accountId} accountId={accountId} />;
  }
  return <UsageSharingDialog key={accountId} accountId={accountId} />;
}

export const DesktopUsageSharingPrompt = UsageSharingPrompt;

function DesktopCompletedOnboardingPrompt({ accountId }: { accountId: string }) {
  const revision = useAtomValue(desktopOnboardingCompletionRevisionAtom);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    const native = getIpcServices();
    if (!native) return;
    void Promise.all([
      native.app.isOnboardingCompleted(),
      native.app.getUsageSharingEnabled().catch(() => null),
    ])
      .then(([completed, diskChoice]) => {
        if (live) setReady(completed === true && diskChoice === null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [revision]);
  return ready ? <UsageSharingDialog accountId={accountId} /> : null;
}

function UsageSharingDialog({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function change(enabled: boolean) {
    setPending(true);
    setFailed(false);
    try {
      if (typeof window !== 'undefined' && window.__LODY_ELECTRON__) {
        const native = getIpcServices();
        if (!native) throw new Error('Missing desktop bridge');
        await native.app.setUsageSharingEnabled(enabled);
      }
      rememberDesktopAccountChoice(accountId, enabled);
      markAccountUsagePromptDecided(accountId);
      writeDeviceUsageSharing(enabled);
    } catch (error) {
      console.error('Failed to save usage sharing preference', error);
      setFailed(true);
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog.Root open>
      <Dialog.Content closeButton={false}>
        <Dialog.Header>
          <Dialog.Title>{t('onboarding.usageSharing.title')}</Dialog.Title>
          <Dialog.Description>{t('onboarding.usageSharing.description')}</Dialog.Description>
        </Dialog.Header>
        {failed && <p role="alert">{t('settings.general.usageSharing.error')}</p>}
        <Dialog.Footer xstyle={styles.footer}>
          <Button variant="secondary" disabled={pending} onClick={() => void change(false)}>
            {t('onboarding.usageSharing.decline')}
          </Button>
          <Button variant="primary" disabled={pending} onClick={() => void change(true)}>
            {t('onboarding.usageSharing.allow')}
          </Button>
        </Dialog.Footer>
      </Dialog.Content>
    </Dialog.Root>
  );
}
