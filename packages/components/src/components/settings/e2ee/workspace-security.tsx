import { notifyE2eeLedgerChanged } from '../../../providers/e2ee-runtime-notifications';
import { useState } from 'react';
import { Dialog } from '@lody/ui/dialog';
import { useWorkspaceRecoveryReady } from './recovery-vault-section';
import { useE2eeRecoverySection } from './recovery-host';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { E2eeAttentionRows, E2eeDevicesPanel, E2eeSecurityPanel } from './security-panel';
import { useMemberJoinAttention, useSecurityState } from './security-state';
import { AccountSettingsComponent } from '../account-setting';
import { CompactSection } from '../compact-layout';
import { E2eeWorkspaceConsole } from '@/components/pages/e2ee-workspace-console';
import { E2eeConsoleSection, type E2eeConsoleTab } from '@/components/pages/e2ee-console-section';

const KNOWN_ERRORS = [
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

function SecuritySettings({
  scope,
  consoleTab,
  setConsoleTab,
}: {
  scope: ReturnType<typeof useSecurityState>;
  /** The console owns its own control reader; it exists only while open. */
  consoleTab: E2eeConsoleTab | null;
  setConsoleTab: (tab: E2eeConsoleTab | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const recoveryReady = useWorkspaceRecoveryReady(
    consoleTab === null ? undefined : scope.workspaceId,
    scope.accountId
  );
  // The proxy is new on every call; keep one.
  const [updater] = useState(() => getIpcServices()?.updater);
  const RecoverySection = useE2eeRecoverySection();
  const joinRequests = useMemberJoinAttention(
    scope.native,
    scope.workspaceId,
    scope.accountId,
    !!scope.state.data?.mayRotate
  );
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
      setError(
        KNOWN_ERRORS.map((code) => `e2ee_${code}`).find((code) => message.includes(code)) ??
          'e2ee_management_retry'
      );
    } finally {
      await scope.state.refetch();
      setBusy(false);
    }
  };
  const panelState = {
    state: scope.state.data,
    busy,
    error: error ?? (scope.state.isError ? 'e2ee_management_retry' : undefined),
  };
  const retry = () => {
    void perform(async () => {
      if (scope.workspaceId) await scope.native?.refresh(scope.workspaceId);
    });
  };
  const update = () => {
    void perform(async () => {
      if (!scope.native?.updateKeys) throw new Error('e2ee_management_unauthorized');
      await scope.native.updateKeys(scope.workspaceId!);
    });
  };
  return (
    <>
      <E2eeSecurityPanel
        {...panelState}
        joinRequests={joinRequests}
        onOpenConsole={scope.workspaceId ? (tab) => setConsoleTab(tab ?? 'overview') : undefined}
        onRetry={retry}
        onUpdate={update}
      />
      {scope.workspaceId && (
        <Dialog.Root
          open={consoleTab !== null}
          onOpenChange={(open) => {
            if (!open) setConsoleTab(null);
          }}
        >
          <Dialog.Content
            data-testid="e2ee-console-dialog"
            width={1000}
            closeButton={false}
            style={{ height: 'min(760px, calc(100dvh - 64px))', padding: 0 }}
          >
            {consoleTab !== null && (
              <E2eeWorkspaceConsole
                workspaceId={scope.workspaceId}
                presentation="modal"
                initialTab={consoleTab}
                onClose={() => setConsoleTab(null)}
                {...(recoveryReady === undefined ? {} : { recoveryReady })}
                {...(updater ? { onCheckForUpdates: () => void updater.checkForUpdates() } : {})}
                sections={
                  <>
                    {(panelState.state?.rotationRequired ||
                      panelState.state?.updatePending ||
                      joinRequests) && (
                      <E2eeConsoleSection tab="overview">
                        <CompactSection>
                          <E2eeAttentionRows
                            {...panelState}
                            joinRequests={joinRequests}
                            onUpdate={update}
                          />
                        </CompactSection>
                      </E2eeConsoleSection>
                    )}
                    <E2eeConsoleSection tab="devices">
                      <E2eeDevicesPanel
                        {...panelState}
                        onRetry={retry}
                        onUpdate={update}
                        onRevoke={(key, confirmation) => {
                          void perform(async () => {
                            if (!scope.native?.revokeDevice)
                              throw new Error('e2ee_management_unauthorized');
                            await scope.native.revokeDevice(scope.workspaceId!, key, confirmation);
                          });
                        }}
                      />
                    </E2eeConsoleSection>
                    {RecoverySection && (
                      <E2eeConsoleSection tab="recovery">
                        {/* Remount per account: no plan, failure, retry or dialog state crosses accounts. */}
                        <RecoverySection key={scope.accountId ?? ''} accountId={scope.accountId} />
                      </E2eeConsoleSection>
                    )}
                  </>
                }
              />
            )}
          </Dialog.Content>
        </Dialog.Root>
      )}
    </>
  );
}

export function WorkspaceSettings() {
  const scope = useSecurityState();
  const key = `${scope.accountId}:${scope.workspaceId}`;
  // Keyed by account and workspace: an open console never carries over to another one.
  const [open, setOpen] = useState<{ key: string; tab: E2eeConsoleTab } | null>(null);
  const consoleTab = open?.key === key ? open.tab : null;
  const setConsoleTab = (tab: E2eeConsoleTab | null) => setOpen(tab ? { key, tab } : null);
  // An encrypted workspace keeps the ordinary General page (name, icon, members,
  // danger zone). Encryption management lives in the console the entry card opens.
  return scope.encrypted ? (
    <>
      <SecuritySettings
        key={key}
        scope={scope}
        consoleTab={consoleTab}
        setConsoleTab={setConsoleTab}
      />
      <AccountSettingsComponent
        surface="workspace"
        encryptedTeamManagement={false}
        onOpenEncryptionConsole={scope.workspaceId ? () => setConsoleTab('members') : undefined}
      />
    </>
  ) : (
    <AccountSettingsComponent surface="workspace" />
  );
}
