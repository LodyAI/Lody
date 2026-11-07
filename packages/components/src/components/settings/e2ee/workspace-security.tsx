import { useNavigate } from '@tanstack/react-router';
import { notifyE2eeLedgerChanged } from '../../../providers/e2ee-runtime-notifications';
import { useState } from 'react';
import { RecoveryVaultSection } from './recovery-vault-section';
import { E2eeSecurityPanel } from './security-panel';
import { useSecurityState } from './security-state';
import { AccountSettingsComponent } from '../account-setting';
function SecuritySettings({ scope }: { scope: ReturnType<typeof useSecurityState> }) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const perform = async (work: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
      if (scope.accountId && scope.workspaceId)
        notifyE2eeLedgerChanged(scope.accountId, scope.workspaceId);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : '';
      const known = [
        'restart-required',
        'local-history-recovery-required',
        'trusted-pin-unavailable',
        'rotation_candidate_unavailable',
        'management_conflict',
        'management_unauthorized',
        'management_operator_required',
        'custody_unavailable',
        'missing-binding',
        'account_unavailable',
        'not_open',
        'account_mismatch',
      ];
      setError(
        known.map((code) => `e2ee_${code}`).find((code) => message.includes(code)) ??
          'e2ee_management_retry'
      );
    } finally {
      await scope.state.refetch();
      setBusy(false);
    }
  };
  return (
    <E2eeSecurityPanel
      state={scope.state.data}
      busy={busy}
      error={error ?? (scope.state.isError ? 'e2ee_management_retry' : undefined)}
      onAuthorize={
        scope.workspaceId
          ? () => {
              void navigate({
                to: '/workspace/e2ee/$workspaceId',
                params: { workspaceId: scope.workspaceId! },
              }).catch(() => setError('e2ee_management_retry'));
            }
          : undefined
      }
      onRetry={() => {
        void perform(async () => {
          if (scope.workspaceId) await scope.native?.refresh(scope.workspaceId);
        });
      }}
      onUpdate={() => {
        void perform(async () => {
          if (!scope.native?.updateKeys) throw new Error('e2ee_management_unauthorized');
          await scope.native.updateKeys(scope.workspaceId!);
        });
      }}
      onRevoke={(key) => {
        void perform(async () => {
          if (!scope.native?.revokeDevice) throw new Error('e2ee_management_unauthorized');
          await scope.native.revokeDevice(scope.workspaceId!, key);
        });
      }}
    />
  );
}

export function WorkspaceSettings() {
  const scope = useSecurityState();
  return scope.encrypted ? (
    <>
      <SecuritySettings key={`${scope.accountId}:${scope.workspaceId}`} scope={scope} />
      <RecoveryVaultSection />
    </>
  ) : (
    <AccountSettingsComponent surface="workspace" />
  );
}
