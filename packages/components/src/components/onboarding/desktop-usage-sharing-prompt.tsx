import * as stylex from '@stylexjs/stylex';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { Button } from '@lody/ui/button';
import { Dialog } from '@lody/ui/dialog';
import { desktopOnboardingCompletionRevisionAtom } from '@/atoms/onboarding';
import {
  rememberDesktopAccountChoice,
  readDeviceUsageChoice,
  subscribeUsageSharing,
  writeDeviceUsageSharing,
} from '@/lib/usage-sharing';
import { usePlatformSession } from '@lody/platform/react';
import { getIpcServices } from '@/lib/electron-ipc-client';

const styles = stylex.create({
  footer: { flexDirection: { default: 'row', '@media (max-width: 480px)': 'row' } },
});

export function DesktopUsageSharingPrompt() {
  const session = usePlatformSession();
  const choice = useSyncExternalStore(subscribeUsageSharing, readDeviceUsageChoice, () => null);
  if (choice !== null || session.status !== 'authenticated') return null;
  return <CompletedOnboardingPrompt key={session.user.id} accountId={session.user.id} />;
}

function CompletedOnboardingPrompt({ accountId }: { accountId: string }) {
  const revision = useAtomValue(desktopOnboardingCompletionRevisionAtom);
  const [completed, setCompleted] = useState(false);
  useEffect(() => {
    let live = true;
    void getIpcServices()
      ?.app.isOnboardingCompleted()
      .then((value) => {
        if (live) setCompleted(value === true);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [revision]);
  return completed ? <UsageSharingDialog accountId={accountId} /> : null;
}

function UsageSharingDialog({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function change(enabled: boolean) {
    setPending(true);
    setFailed(false);
    try {
      const native = getIpcServices();
      if (!native) throw new Error('Missing desktop bridge');
      await native.app.setUsageSharingEnabled(enabled);
      rememberDesktopAccountChoice(accountId, enabled);
      writeDeviceUsageSharing(enabled);
    } catch (error) {
      console.error('Failed to save desktop usage preference', error);
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
