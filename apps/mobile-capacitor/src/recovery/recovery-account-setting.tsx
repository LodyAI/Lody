import { lazy, Suspense, useContext, type ComponentProps } from 'react';
import { useAtomValue } from 'jotai';
import { AccountSettingsComponent as SharedAccountSettings } from '../../../../packages/components/src/components/settings/account-setting';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@lody/components/atoms/settings';
import { MobileRecoveryContext } from './recovery-context';

export { persistUserAvatar } from '../../../../packages/components/src/components/settings/account-setting';
const RecoveryEntry = lazy(() => import('./recovery-entry'));
function RecoveryGate() {
  const config = useContext(MobileRecoveryContext);
  const enabled = useAtomValue(e2eeRecoveryVaultFeatureEnabledAtom);
  return config && enabled ? (
    <Suspense fallback={null}>
      <RecoveryEntry />
    </Suspense>
  ) : null;
}
/** Private account-only composition. Recovery UI/crypto stays lazy behind the runtime setting. */
export function AccountSettingsComponent(props: ComponentProps<typeof SharedAccountSettings>) {
  return (
    <>
      <SharedAccountSettings {...props} />
      {props.surface !== 'workspace' && <RecoveryGate />}
    </>
  );
}
