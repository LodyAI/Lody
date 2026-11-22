import { useContext, useEffect, useRef, useState } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useAuthClient } from '@lody/components/providers/convex-provider';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@lody/components/atoms/settings';
import { MobileRecoveryContext, type MobileRecoveryConfig } from './recovery-context';
import { makeMobileRecovery, type MobileRecovery } from '../e2ee/recovery';
import { MobileRecoverySettings } from './recovery-settings';
import { mobileRecoveryCopy } from './recovery-copy';

function AccountRecovery({ config }: { config: MobileRecoveryConfig }) {
  const { i18n } = useTranslation();
  const session = useAuthClient().useSession();
  const identity = session.data
    ? { accountId: session.data.user.id, sessionId: session.data.session.id }
    : null;
  const liveSession = useRef(identity);
  liveSession.current = identity;
  const accountId = identity?.accountId,
    sessionId = identity?.sessionId;
  const generation = useRef(0);
  const [owner, setOwner] = useState<{
    accountId: string;
    sessionId: string;
    service: MobileRecovery;
    generation: number;
  }>();
  useEffect(() => {
    for (const [locale, copy] of Object.entries(mobileRecoveryCopy))
      i18n.addResourceBundle(locale, 'translation', copy, true, true);
    if (!accountId || !sessionId) {
      setOwner(undefined);
      return;
    }
    const service = makeMobileRecovery({
      ...config,
      accountId,
      sessionId,
      currentSession: () => liveSession.current,
      enabled: config.enabled,
    });
    setOwner({ accountId, sessionId, service, generation: ++generation.current });
    return () => service.dispose();
  }, [accountId, sessionId, config, i18n]);
  return owner && owner.accountId === accountId && owner.sessionId === sessionId ? (
    <MobileRecoverySettings
      key={`${accountId}:${sessionId}:${owner.generation}`}
      service={owner.service}
      run={config.run}
      defaultLabel={config.defaultLabel}
    />
  ) : null;
}
export default function RecoveryEntry() {
  const config = useContext(MobileRecoveryContext);
  const enabled = useAtomValue(e2eeRecoveryVaultFeatureEnabledAtom);
  return config && enabled ? <AccountRecovery config={config} /> : null;
}
