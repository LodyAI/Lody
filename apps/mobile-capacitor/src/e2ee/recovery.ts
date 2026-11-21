import { makeClientRecovery } from '@lody/client-e2ee/recovery';
import { makeRecoveryWorkspaces } from '@lody/client-e2ee/recovery-workspaces';
export { visibleSecurityEvents } from '@lody/client-e2ee/recovery';
export type {
  ClientRecoveryUnlock as MobileRecoveryUnlock,
  ClientSecurityEvent as MobileSecurityEvent,
  ClientRecoverySummary as MobileRecoverySummary,
} from '@lody/client-e2ee/recovery';
export type {
  RecoveryWorkspaceProgress as MobileRecoveryWorkspaceProgress,
  RecoveryWorkspaceResult as MobileRecoveryWorkspaceResult,
} from '@lody/client-e2ee/recovery-workspaces';
export const makeMobileRecovery = (
  options: Omit<Parameters<typeof makeClientRecovery>[0], 'platform'>
) => makeClientRecovery({ ...options, platform: 'mobile' });
export type MobileRecovery = ReturnType<typeof makeMobileRecovery>;

export type MobileRecoveryOptions = Omit<Parameters<typeof makeClientRecovery>[0], 'platform'>;

/** Fixed mobile namespace for the shared per-workspace recovery engine. The account screen does not call this. */
export const makeMobileRecoveryWorkspaces = (
  options: Omit<Parameters<typeof makeRecoveryWorkspaces>[0], 'platform'>
) => makeRecoveryWorkspaces({ ...options, platform: 'mobile' });
export type MobileRecoveryWorkspaces = ReturnType<typeof makeMobileRecoveryWorkspaces>;
