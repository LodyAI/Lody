import { useId, useSyncExternalStore } from 'react';
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
  claimAccountUsageSave,
  clearPostHogLocalStorage,
  hasInFlightAccountUsageSave,
  isEnvUsageSharingDisabledClient,
  pendingAccountChoice,
  readDeviceUsageSharing,
  setPendingAccountChoice,
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
  const accountId = session.status === 'authenticated' ? session.user.id : null;
  const preference = usePlatform().cloudApi?.useOptionalAuthenticatedQuery?.(
    cloudOperations.analytics.getUsageSharing,
    accountId ? {} : 'skip'
  );
  const account = preference?.data;
  const save = useCloudMutation(cloudOperations.analytics.setUsageSharing);
  const snapshot = useSyncExternalStore(
    subscribeUsageSharing,
    () => {
      const envOff = isEnvUsageSharingDisabledClient();
      const device = readDeviceUsageSharing();
      const pending = accountId ? pendingAccountChoice(accountId) : null;
      return `${envOff ? 1 : 0}:${device ? 1 : 0}:${pending === null ? 'n' : pending ? 1 : 0}`;
    },
    () => '0:1:n'
  );
  const [envFlag, deviceFlag, pendingFlag] = snapshot.split(':');
  const envDisabled = envFlag === '1';
  const device = deviceFlag === '1';
  const pendingChoice = pendingFlag === '1' ? true : pendingFlag === '0' ? false : null;
  const enabled = !envDisabled && device && (pendingChoice === true || account !== false);

  function change(next: boolean) {
    if (envDisabled) return;
    if (accountId) {
      const needsPending =
        preference !== undefined && (account !== next || hasInFlightAccountUsageSave(accountId));
      setPendingAccountChoice(accountId, needsPending ? next : null);
    } else if (window.__LODY_ELECTRON__) {
      setPendingAccountChoice('next-login', next ? null : false);
    }
    if (!next) clearPostHogLocalStorage();
    writeDeviceUsageSharing(next);
    if (window.__LODY_ELECTRON__) {
      void getIpcServices()
        ?.app.setUsageSharingEnabled(next)
        .catch(() => {});
    }
    if (accountId) {
      const finish = claimAccountUsageSave(accountId, next);
      if (finish) {
        void save({ enabled: next }).then(
          () => finish(true),
          () => finish(false)
        );
      }
    }
  }

  const descriptionId = useId();
  const label = t('settings.general.usageSharing.label');
  const control = (
    <Switch
      aria-label={label}
      aria-describedby={descriptionId}
      checked={enabled}
      disabled={envDisabled}
      onCheckedChange={change}
    />
  );
  const helper = <span id={descriptionId}>{t('settings.general.usageSharing.helper')}</span>;
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
