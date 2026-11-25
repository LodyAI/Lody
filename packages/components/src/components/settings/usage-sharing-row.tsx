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
  const preference = usePlatform().cloudApi?.useOptionalAuthenticatedQuery?.(
    cloudOperations.analytics.getUsageSharing,
    session.status === 'authenticated' ? { accountId: session.user.id } : 'skip'
  );
  const account = preference?.data;
  const save = useCloudMutation(cloudOperations.analytics.setUsageSharing);
  const device = useSyncExternalStore(subscribeUsageSharing, readDeviceUsageSharing, () => false);
  const [pending, setPending] = useState(false);
  const [retry, setRetry] = useState<boolean | null>(null);
  const enabled = device && account !== false;
  async function change(next: boolean) {
    setPending(true);
    setRetry(null);
    try {
      // Stop this renderer immediately, including if the server is unreachable.
      const results = await Promise.allSettled([
        (async () => {
          if (!next) writeDeviceUsageSharing(false);
          if (authenticated) markUsageOptOutPending(session.user.id, !next);
          else if (window.__LODY_ELECTRON__) markUsageOptOutPending('next-login', !next);
        })(),
        (async () => {
          if (!window.__LODY_ELECTRON__) return;
          const native = getIpcServices();
          if (!native) throw new Error('Missing desktop bridge');
          await native.app.setUsageSharingEnabled(next);
        })(),
        authenticated ? save({ enabled: next, accountId: session.user.id }) : undefined,
      ]);
      if (results.some((result) => result.status === 'rejected')) {
        setRetry(next);
        return;
      }
      if (authenticated) markUsageOptOutPending(session.user.id, false);
      if (next) writeDeviceUsageSharing(true);
    } catch {
      setRetry(next);
    } finally {
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
      disabled={pending}
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
    <CompactRow label={label} helper={helper}>
      {control}
    </CompactRow>
  );
}
