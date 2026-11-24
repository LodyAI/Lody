import { lazy, Suspense, useContext, type ComponentProps } from 'react';
import { useAtomValue } from 'jotai';
import { AccountSettingsComponent as SharedAccountSettings } from '../../../../packages/components/src/components/settings/account-setting';
import { e2eeRecoveryVaultFeatureEnabledAtom } from '@lody/components/atoms/settings';
import { workspaceContentModeAtom } from '@lody/components/atoms/workspace-content-mode';
import { MobileRecoveryContext } from './recovery-context';

export { persistUserAvatar } from '../../../../packages/components/src/components/settings/account-setting';
const RecoveryEntry = lazy(() => import('./recovery-entry'));
function RecoveryGate() {
  const config = useContext(MobileRecoveryContext);
  const enabled = useAtomValue(e2eeRecoveryVaultFeatureEnabledAtom);
  const mode = useAtomValue(workspaceContentModeAtom);
  const encrypted =
    !!mode?.descriptor &&
    'contentMode' in mode.descriptor &&
    mode.descriptor.contentMode === 'e2ee';
  return config && enabled && encrypted ? (
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
