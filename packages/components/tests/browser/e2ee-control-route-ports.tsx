import { createElement, type ReactNode } from 'react';
import type { PlatformE2eeWorkspaces } from '@lody/platform';

/** Browser equivalent of the owning route suite's injected platform and display ports.
 * The route, retirement owner and signed-ledger verification remain production code. */
export const fixture = {
  workspaceId: 'control-reader-workspace',
  accountId: 'synthetic-account',
  genesisHash: '',
  port: undefined as PlatformE2eeWorkspaces | undefined,
  checkpoints: [] as number[],
  modes: [] as string[],
};
const noop = () => {};
export const desktopWindowId = () => '';
export const readEncryptedLocalIdentity = () => null;
export const isE2eeMemberRemoved = () => false;
export const e2eeAccessLoss = () => null;
export const retainEncryptedWorkspaceCleanup = noop;
export const resumeEncryptedWorkspaceCleanup = async () => {};
export const createFileRoute = () => (options: { component: () => ReactNode }) => ({
  options,
  useParams: () => ({ workspaceId: fixture.workspaceId }),
});
export const useNavigate = () => noop;
export const useSetAtom = () => noop;
export const setWorkspaceContextAtom = {};
export const useE2eeAccountId = () => fixture.accountId;
export const usePlatform = () => ({ e2eeWorkspaces: fixture.port });
export const usePlatformSession = () => ({
  status: 'authenticated',
  user: { id: fixture.accountId },
});
export const usePlatformWorkspaces = () => ({ status: 'ready', workspaces: [] });
export const useTranslation = () => ({ t: (key: string) => key });
export const readWorkspaceModeEvidence = () => ({});
export const readE2eeGenesisPin = () => fixture.genesisHash;
export const readObservedLedgerCheckpoint = () => undefined;
export const recoverE2eeWorkspaceIdentity = async () => {};
export const repairUnreadableE2eeCaches = noop;
export const resetObservedLedgerProgress = noop;
export const retainEncryptedWorkspaceMode = (
  _storage: unknown,
  _account: string,
  mode: { genesisHash: string }
) => {
  fixture.modes.push(mode.genesisHash);
};
export const retainObservedLedgerCheckpoint = (
  _storage: unknown,
  _account: string,
  _workspace: string,
  history: { view: { length: number } }
) => {
  fixture.checkpoints.push(history.view.length);
  return true;
};
export const classifyE2eeControlFailure = () => ({ kind: 'network', code: 'synthetic' });
export const personalHostFailureCode = () => undefined;
export const e2eeControlDiagnostics = () => '{}';
export const E2eeWorkspaceControlPage = ({
  history,
  failure,
}: {
  history: { view: { length: number } } | null;
  failure: unknown;
}) =>
  createElement(
    'output',
    { 'data-control-state': true },
    failure ? 'failed' : (history?.view.length ?? 'loading')
  );
export const E2eeRemoteMachinePairing = () => null;
export const E2eeIdentityRecovery = () => null;
export const E2eeTeamSettingsHost = () => null;
export const E2eePersonalPairing = () => null;
// The approval guide replaces the full page only for devices that still need approval.
export const E2eeDeviceApprovalGuide = () =>
  createElement('output', { 'data-approval-guide': true });
export const E2eeLedgerAudit = () => null;
