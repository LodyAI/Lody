import type {
  LocalProjectControlRequest,
  LocalProjectControlResponse,
  LocalProjectId,
  MachineId,
  ProjectSkillsResult,
  WorkspaceId,
} from '@lody/shared';
import { assertLocalProjectControlResponse } from './local-project-rpc-file-provider';

/**
 * `knownFingerprint` lets the host answer `unchanged: true` with no groups when
 * the caller's cached copy is still current.
 */
export type LocalProjectSkillsTransport = {
  listSkills: (args: {
    readonly skillDirs: readonly string[];
    readonly knownFingerprint?: string;
  }) => Promise<ProjectSkillsResult>;
  listGlobalSkills: (args?: { readonly knownFingerprint?: string }) => Promise<ProjectSkillsResult>;
};

export function createLocalProjectSkillsTransport(args: {
  readonly workspaceId: WorkspaceId;
  readonly machineId: MachineId;
  /** Required to list project-scoped skills; omitted for global-only transports
     (machine-global skills are not bound to any project). */
  readonly localProjectId?: LocalProjectId;
  readonly requestedByUserId: string;
  readonly requestLocalProjectControl: (
    request: LocalProjectControlRequest,
    options?: { timeoutMs?: number }
  ) => Promise<LocalProjectControlResponse | null>;
}): LocalProjectSkillsTransport {
  return {
    listSkills: async ({ skillDirs, knownFingerprint }) => {
      if (!args.localProjectId) {
        throw new Error('localProjectId is required to list project skills.');
      }
      const response = await args.requestLocalProjectControl(
        {
          type: 'local-project/list-skills',
          machineId: args.machineId,
          workspaceId: args.workspaceId,
          localProjectId: args.localProjectId,
          skillDirs: [...skillDirs],
          ...(knownFingerprint ? { knownFingerprint } : {}),
          requestedByUserId: args.requestedByUserId,
        },
        { timeoutMs: 120_000 }
      );
      return assertLocalProjectControlResponse(response, 'local-project/list-skills').result;
    },
    listGlobalSkills: async ({ knownFingerprint } = {}) => {
      const response = await args.requestLocalProjectControl(
        {
          type: 'local-project/list-global-skills',
          machineId: args.machineId,
          workspaceId: args.workspaceId,
          ...(knownFingerprint ? { knownFingerprint } : {}),
          requestedByUserId: args.requestedByUserId,
        },
        { timeoutMs: 120_000 }
      );
      return assertLocalProjectControlResponse(response, 'local-project/list-global-skills').result;
    },
  };
}
