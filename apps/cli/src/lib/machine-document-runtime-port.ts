import type { MachineCatalogBinding } from '@lody/shared';
import type { LoroDocumentManager } from './loro/doc';
import type {
  SessionId,
  SessionMeta,
  AgentConfigId,
  AgentConfigMeta,
  AcpCapabilityCacheEntry,
  LocalProjectId,
  LocalProjectMeta,
} from '@lody/shared';
import type { MachineSessionLaunchSnapshot } from '../session/session-launch-config-resolver';

/** Trusted whole-machine catalog capability. Every MachineDocument catalog
 * operation is selected together; runtime/presence metadata stays independent. */
export type MachineDocumentRuntimePort = Pick<
  LoroDocumentManager,
  | 'hasAgentConfig'
  | 'findSoleAgentConfig'
  | 'getBuiltinAgentOptOuts'
  | 'getAgentConfigById'
  | 'getAgentConfigForMachineLaunch'
  | 'createAgentConfig'
  | 'updateRateLimits'
  | 'updateAcpCapabilities'
  | 'updateAcpAuthMethods'
  | 'getAcpCapabilities'
> & {
  readonly binding: MachineCatalogBinding;
  close(): void;
  readSessionLaunchSnapshot(
    sessionId: SessionId,
    sessionMeta: SessionMeta | undefined
  ): Promise<MachineSessionLaunchSnapshot>;
  readAgentConfigs(): Promise<Record<AgentConfigId, AgentConfigMeta>>;
  readAgentConfig(id: AgentConfigId): Promise<AgentConfigMeta | undefined>;
  saveAgentConfig(config: AgentConfigMeta, expected: AgentConfigMeta | undefined): Promise<void>;
  removeAgentConfig(expected: AgentConfigMeta): Promise<void>;
  readCatalog(): Promise<{
    capabilities: Record<string, AcpCapabilityCacheEntry>;
    rateLimits: Record<string, import('acp-extension-core').RateLimit>;
    projects: Record<LocalProjectId, LocalProjectMeta>;
  }>;
  saveLocalProject(
    project: LocalProjectMeta,
    expected: LocalProjectMeta | undefined
  ): Promise<void>;
  removeLocalProject(expected: LocalProjectMeta): Promise<void>;
  importMagpie(
    machine: import('@lody/shared').MachineMeta,
    request: import('@lody/shared').MagpieImport
  ): Promise<ReturnType<typeof import('../commands/magpie-import').importMagpieProviders>>;
  upload(): Promise<void>;
};
