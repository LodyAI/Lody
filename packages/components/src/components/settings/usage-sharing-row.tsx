import { useId, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { Switch } from '@lody/ui/switch';
import {
  useCloudMutation,
  usePlatform,
  usePlatformCapability,
  usePlatformSession,
} from '@lody/platform/react';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { getIpcServices } from '@/lib/electron-ipc-client';
import {
  beginAccountUsageSave,
  clearPostHogLocalStorage,
  markAccountOptOutSubmitted,
  markUsageOptOutPending,
  readDeviceUsageSharing,
  subscribeUsageSharing,
  writeDeviceUsageSharing,
} from '@/lib/usage-sharing';
import { MobileSettingsRow, MobileSettingsRowGroup } from '../mobile/mobile-settings-row';
import { CompactRow } from './compact-layout';

export function UsageSharingRow({ mobile = false }: { mobile?: boolean }) {
  const supported = usePlatformCapability('telemetry');
  return supported ? <SharingPreference mobile={mobile} /> : null;
}

function SharingPreference({ mobile }: { mobile: boolean }) {
  const { t } = useTranslation();
  const session = usePlatformSession();
  const authenticated = session.status === 'authenticated';
  const accountId = authenticated ? session.user.id : null;
  const preference = usePlatform().cloudApi?.useOptionalAuthenticatedQuery?.(
    cloudOperations.analytics.getUsageSharing,
    accountId ? {} : 'skip'
  );
  const account = preference?.data;
  const accountError = preference?.error ?? null;
  const loadingAccount =
    authenticated && preference !== undefined && accountError === null && account === undefined;
  const save = useCloudMutation(cloudOperations.analytics.setUsageSharing);
  const device = useSyncExternalStore(subscribeUsageSharing, readDeviceUsageSharing, () => true);
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState<boolean | null>(null);
  const enabled = device && account !== false;
  async function change(next: boolean) {
    setPending(true);
    setRetry(null);
    const endSave = accountId ? beginAccountUsageSave(accountId) : null;
    try {
      if (!next) {
        // Opt-out fails closed: mark pending before writing device state so
        // LodyPostHogProvider in this or another window cannot mirror stale account=true back to on.
        const results = await Promise.allSettled([
          (async () => {
            if (accountId) {
              markUsageOptOutPending(accountId, true);
            } else if (window.__LODY_ELECTRON__) {
              markUsageOptOutPending('next-login', true);
            }
            clearPostHogLocalStorage();
            writeDeviceUsageSharing(false);
          })(),
          (async () => {
            if (!window.__LODY_ELECTRON__) return;
            const native = getIpcServices();
            if (!native) throw new Error('Missing desktop bridge');
            await native.app.setUsageSharingEnabled(false);
          })(),
          accountId ? save({ enabled: false }) : undefined,
        ]);
        if (results.some((result) => result.status === 'rejected')) {
          setRetry(false);
          return;
        }
        if (accountId) {
          if (preference === undefined || account === false) {
            markUsageOptOutPending(accountId, false);
          } else {
            markAccountOptOutSubmitted(accountId, true);
          }
        }
        return;
      }

      // Re-enabling waits for the cloud preference before enabling local desktop/renderer capture.
      if (accountId) {
        await save({ enabled: true });
        markUsageOptOutPending(accountId, false);
        markAccountOptOutSubmitted(accountId, false);
      } else if (window.__LODY_ELECTRON__) {
        markUsageOptOutPending('next-login', false);
      }
      if (window.__LODY_ELECTRON__) {
        const native = getIpcServices();
        if (!native) throw new Error('Missing desktop bridge');
        await native.app.setUsageSharingEnabled(true);
      }
      writeDeviceUsageSharing(true);
    } catch {
      setRetry(next);
    } finally {
      endSave?.();
      setPending(false);
    }
  }

  const descriptionId = useId();
  const label = t('settings.general.usageSharing.label');
  const control = (
    <Switch
      aria-label={label}
      aria-describedby={descriptionId}
      checked={enabled}
      disabled={pending || (!enabled && loadingAccount)}
      onCheckedChange={(value) => void change(value)}
    />
  );
  const helper = (
    <>
      <span id={descriptionId}>{t('settings.general.usageSharing.helper')}</span>
      {retry !== null && (
        <button type="button" onClick={() => void change(retry)}>
          {t('settings.general.usageSharing.error')}
        </button>
      )}
    </>
  );
  return mobile ? (
    <MobileSettingsRowGroup>
      <MobileSettingsRow label={label} helper={helper}>
        {control}
      </MobileSettingsRow>
    </MobileSettingsRowGroup>
  ) : (
    <CompactRow label={label} helper={helper} helperBlock={retry !== null}>
      {control}
    </CompactRow>
  );
}
