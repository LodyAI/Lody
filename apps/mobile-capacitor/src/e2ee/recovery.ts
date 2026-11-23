import { makeClientRecovery } from '@lody/client-e2ee/recovery';
import { makeRecoveryWorkspaces } from '@lody/client-e2ee/recovery-workspaces';
import { LODY_CLOUD_RECOVERY_SERVICE_LOCATOR } from '@lody/e2ee-client/recovery-locator';
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

/**
 * The site whose canonical origin this build's recovery files carry: `VITE_SITE_URL`, as
 * shared components and the release workflows use it, else Lody Cloud. The WebView's own
 * `capacitor://localhost` origin is never a service locator.
 */
export const mobileRecoverySite = (env: { readonly VITE_SITE_URL?: string } = import.meta.env) =>
  env.VITE_SITE_URL?.trim() || LODY_CLOUD_RECOVERY_SERVICE_LOCATOR;

type FixedOptions = 'platform' | 'serviceLocator';
export const makeMobileRecovery = (
  options: Omit<Parameters<typeof makeClientRecovery>[0], FixedOptions>
) => makeClientRecovery({ ...options, platform: 'mobile', serviceLocator: mobileRecoverySite() });
export type MobileRecovery = ReturnType<typeof makeMobileRecovery>;

export type MobileRecoveryOptions = Omit<Parameters<typeof makeClientRecovery>[0], FixedOptions>;

/** Fixed mobile namespace for the shared per-workspace recovery engine. The account screen does not call this. */
export const makeMobileRecoveryWorkspaces = (
  options: Omit<Parameters<typeof makeRecoveryWorkspaces>[0], FixedOptions>
) =>
  makeRecoveryWorkspaces({ ...options, platform: 'mobile', serviceLocator: mobileRecoverySite() });
export type MobileRecoveryWorkspaces = ReturnType<typeof makeMobileRecoveryWorkspaces>;
