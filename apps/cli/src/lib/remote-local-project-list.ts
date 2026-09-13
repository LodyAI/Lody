import {
  getMachineFlockDocId,
  isMachineDocRoomId,
  type LocalProjectControlResponse,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
  type MachineMeta,
  type WorkspaceId,
} from '@lody/shared';
import type { LoroRepo } from 'loro-repo';

import { listAliveDocMetas, normalizeCliValue, type AuthContext } from '@/lib/command-runtime';
import type { LoroDocumentManager } from '@/lib/loro/doc';
import { readMachineLocalProjects } from '@/lib/local-project-meta';
import {
  canRequestMachineForCliToken,
  type MachineAccessCheckResult,
  type WorkspaceSummary,
} from '@/lib/workspace';
import { readMachineAccessWithBoundedRetry } from '@/session/session-access-retry';
import { getLogger } from '@/utils/logger';

type ProjectListResponse = Extract<
  LocalProjectControlResponse,
  { ok: true; type: 'local-project/list' }
>;

export type RemoteProjectListDependencies = {
  listMachines: (manager: LoroDocumentManager) => Promise<readonly MachineMeta[]>;
  readProjects: (
    repo: LoroRepo,
    workspaceId: WorkspaceId,
    machineId: MachineId
  ) => Promise<Record<LocalProjectId, LocalProjectMeta>>;
  verifyAccess: (input: {
    auth: AuthContext;
    workspaceId: WorkspaceId;
    machineId: MachineId;
    localProjectId?: LocalProjectId;
  }) => Promise<MachineAccessCheckResult>;
};

const defaultDependencies: RemoteProjectListDependencies = {
  listMachines: async (manager) =>
    (await listAliveDocMetas<MachineMeta>(manager, isMachineDocRoomId)).map((entry) => entry.meta),
  readProjects: readMachineLocalProjects,
  verifyAccess: async ({ auth, workspaceId, machineId, localProjectId }) =>
    await readMachineAccessWithBoundedRetry({
      verify: async () =>
        await canRequestMachineForCliToken({
          token: auth.token,
          workspaceId,
          machineId,
          requesterUserId: auth.userId,
          ...(localProjectId ? { localProjectId } : {}),
        }),
      onRetry: ({ attempt, maxAttempts, delayMs, error }) => {
        getLogger('project').warn(
          `Machine access verification unavailable; retrying ` +
            `(attempt=${attempt}/${maxAttempts} delayMs=${delayMs}): ${error}`
        );
      },
    }),
};

function formatMachineCandidates(machines: readonly MachineMeta[]): string {
  return machines
    .map((machine) => `${machine.name} (${machine.id})`)
    .sort((left, right) => left.localeCompare(right))
    .join(', ');
}

export function selectRemoteProjectMachine(
  machines: readonly MachineMeta[],
  selector: string
): MachineMeta {
  const normalizedSelector = normalizeCliValue(selector);
  if (!normalizedSelector) {
    throw new Error('Missing machine selector.');
  }
  const idMatch = machines.find((machine) => machine.id === normalizedSelector);
  if (idMatch) return idMatch;

  const nameMatches = machines.filter(
    (machine) => normalizeCliValue(machine.name) === normalizedSelector
  );
  if (nameMatches.length === 1) return nameMatches[0]!;
  if (nameMatches.length > 1) {
    throw new Error(
      `Machine selector is ambiguous: ${normalizedSelector}. Use a machine id. Candidates: ${formatMachineCandidates(nameMatches)}`
    );
  }
  throw new Error(
    `Machine not found: ${normalizedSelector}. Candidates: ${formatMachineCandidates(machines)}`
  );
}

export async function listRemoteLocalProjects(args: {
  manager: LoroDocumentManager;
  auth: AuthContext;
  workspace: WorkspaceSummary;
  machineSelector?: string;
  dependencies?: Partial<RemoteProjectListDependencies>;
}): Promise<ProjectListResponse> {
  const dependencies = { ...defaultDependencies, ...args.dependencies };
  const workspaceId = args.workspace.id as WorkspaceId;
  await args.manager.syncMetaOrThrow({ reason: `project.list:${workspaceId}:meta` });

  const machines = await dependencies.listMachines(args.manager);
  const machineAccess = await Promise.all(
    machines.map(async (machine) => ({
      machine,
      access: await dependencies.verifyAccess({
        auth: args.auth,
        workspaceId,
        machineId: machine.id,
      }),
    }))
  );
  const authorizedMachines = machineAccess
    .filter((entry) => entry.access.allowed)
    .map((entry) => entry.machine);
  if (authorizedMachines.length === 0) {
    throw new Error('No authorized machines are available in this workspace.');
  }

  const machine = selectRemoteProjectMachine(
    authorizedMachines,
    normalizeCliValue(args.machineSelector) ?? args.auth.machineId
  );
  await args.manager.syncFlockDocOrThrow(getMachineFlockDocId(workspaceId, machine.id), {
    reason: `project.list:${machine.id}`,
  });

  const localProjects = Object.values(
    await dependencies.readProjects(args.manager.repo, workspaceId, machine.id)
  );
  const projectAccess = await Promise.all(
    localProjects.map(async (project) => ({
      project,
      access: await dependencies.verifyAccess({
        auth: args.auth,
        workspaceId,
        machineId: machine.id,
        localProjectId: project.id,
      }),
    }))
  );
  const projects = projectAccess
    .filter((entry) => entry.access.allowed)
    .map(({ project }) => ({
      localProjectId: project.id,
      name: project.name,
      rootPath: project.rootPath,
    }))
    .sort((left, right) => {
      const nameCompare = left.name.localeCompare(right.name);
      return nameCompare !== 0 ? nameCompare : left.rootPath.localeCompare(right.rootPath);
    });

  return {
    ok: true,
    type: 'local-project/list',
    result: {
      workspaces: [{ workspaceId, workspaceName: args.workspace.name, projects }],
    },
  };
}
