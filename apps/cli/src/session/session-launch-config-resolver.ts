import {
  buildSessionLaunchConfig,
  getMachineFlockAgentConfigs,
  getMachineFlockDocId,
  getMachineFlockSessionLaunchConfig,
  getSessionLaunchConfigLegacyFields,
  machineFlockKeys,
  mergeSessionLaunchConfig,
  readMachineFlockRowsFromFlock,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineFlockReadableFlock,
  type MachineId,
  type SessionId,
  type SessionLaunchConfig,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { formatErrorMessage } from '@/utils/format-error';

type LoggerLike = {
  debug(message: string): void;
};

type RepoLike = {
  openFlockDoc(docId: string): Promise<{ flock: MachineFlockReadableFlock }>;
};

export type AgentConfigLaunchFields = Pick<
  AgentConfigMeta,
  'customAcp' | 'runtimeOverrides' | 'env'
>;

type WorkspaceDocumentLike = {
  repo: RepoLike;
  getAgentConfigById(
    agentConfigId: AgentConfigId,
    machineId?: MachineId
  ): Promise<AgentConfigLaunchFields | null>;
};

export type SessionLaunchConfigResolution = {
  config: SessionLaunchConfig | undefined;
  source: 'agent-config' | 'legacy-session' | 'none';
};

export type MachineSessionLaunchSnapshot = {
  legacy: SessionLaunchConfig | undefined;
  agentConfig: AgentConfigMeta | null;
  resolution: SessionLaunchConfigResolution;
};

function resolveSessionLaunchConfigFromSources(input: {
  legacy: SessionLaunchConfig | undefined;
  agentConfig: AgentConfigLaunchFields | null | undefined;
}): SessionLaunchConfigResolution {
  if (!input.agentConfig) {
    return {
      config: input.legacy,
      source: input.legacy ? 'legacy-session' : 'none',
    };
  }
  return {
    config: buildSessionLaunchConfig({
      customAcp: input.agentConfig.customAcp,
      runtimeOverrides: input.agentConfig.runtimeOverrides,
      env: input.agentConfig.env,
      worktreeSetup: input.legacy?.worktreeSetup,
      worktreeCleanup: input.legacy?.worktreeCleanup,
    }),
    source: 'agent-config',
  };
}

export function readMachineSessionLaunchSnapshotFromFlock(input: {
  flock: MachineFlockReadableFlock;
  sessionId: SessionId;
  sessionMeta: SessionMeta | undefined;
}): MachineSessionLaunchSnapshot {
  const metaLegacy = getSessionLaunchConfigLegacyFields(input.sessionMeta);
  const agentConfigId = input.sessionMeta?.agentConfigId;
  const rows = readMachineFlockRowsFromFlock(input.flock, {
    prefixes: [
      machineFlockKeys.sessionLaunchConfig(input.sessionId),
      ...(agentConfigId ? [machineFlockKeys.agentConfig(agentConfigId)] : []),
    ],
  });
  const legacy = mergeSessionLaunchConfig(
    getMachineFlockSessionLaunchConfig(rows, input.sessionId),
    metaLegacy
  );
  const agentConfig = agentConfigId
    ? (getMachineFlockAgentConfigs(rows)[agentConfigId] ?? null)
    : null;
  return {
    legacy,
    agentConfig,
    resolution: resolveSessionLaunchConfigFromSources({ legacy, agentConfig }),
  };
}

async function readMachineSessionLaunchSnapshot(input: {
  repo: RepoLike;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;
  sessionMeta: SessionMeta | undefined;
}): Promise<MachineSessionLaunchSnapshot> {
  const handle = await input.repo.openFlockDoc(
    getMachineFlockDocId(input.workspaceId, input.machineId)
  );
  return readMachineSessionLaunchSnapshotFromFlock({
    flock: handle.flock,
    sessionId: input.sessionId,
    sessionMeta: input.sessionMeta,
  });
}

export async function readLegacySessionLaunchConfig(input: {
  repo: RepoLike;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;
  sessionMeta: SessionMeta | undefined;
  logger: LoggerLike;
}): Promise<SessionLaunchConfig | undefined> {
  const machineId = input.sessionMeta?.machineId ?? input.machineId;
  try {
    return (
      await readMachineSessionLaunchSnapshot({
        repo: input.repo,
        workspaceId: input.workspaceId,
        machineId,
        sessionId: input.sessionId,
        sessionMeta: input.sessionMeta,
      })
    ).legacy;
  } catch (error) {
    input.logger.debug(
      `[${input.sessionId}] Failed to read legacy session launch config row; using legacy meta fallback: ${formatErrorMessage(
        error
      )}`
    );
    return getSessionLaunchConfigLegacyFields(input.sessionMeta);
  }
}

export async function resolveSessionLaunchConfig(input: {
  workspaceDocument: WorkspaceDocumentLike;
  workspaceId: WorkspaceId;
  machineId: MachineId;
  sessionId: SessionId;
  sessionMeta: SessionMeta | undefined;
  logger: LoggerLike;
}): Promise<SessionLaunchConfigResolution> {
  const machineId = input.sessionMeta?.machineId ?? input.machineId;
  let snapshot: MachineSessionLaunchSnapshot;
  try {
    snapshot = await readMachineSessionLaunchSnapshot({
      repo: input.workspaceDocument.repo,
      workspaceId: input.workspaceId,
      machineId,
      sessionId: input.sessionId,
      sessionMeta: input.sessionMeta,
    });
  } catch (error) {
    input.logger.debug(
      `[${input.sessionId}] Failed to read machine launch config rows; using legacy meta and agent config fallback: ${formatErrorMessage(
        error
      )}`
    );
    const legacy = getSessionLaunchConfigLegacyFields(input.sessionMeta);
    snapshot = {
      legacy,
      agentConfig: null,
      resolution: resolveSessionLaunchConfigFromSources({ legacy, agentConfig: null }),
    };
  }

  if (!input.sessionMeta?.agentConfigId) {
    return snapshot.resolution;
  }

  if (snapshot.agentConfig) {
    return snapshot.resolution;
  }

  try {
    const agentConfig = await input.workspaceDocument.getAgentConfigById(
      input.sessionMeta.agentConfigId,
      machineId
    );
    if (!agentConfig) {
      return resolveSessionLaunchConfigFromSources({
        legacy: snapshot.legacy,
        agentConfig: null,
      });
    }
    return resolveSessionLaunchConfigFromSources({ legacy: snapshot.legacy, agentConfig });
  } catch (error) {
    input.logger.debug(
      `[${input.sessionId}] Failed to read agent config ${
        input.sessionMeta.agentConfigId
      }; using legacy session launch config fallback: ${formatErrorMessage(error)}`
    );
    return resolveSessionLaunchConfigFromSources({
      legacy: snapshot.legacy,
      agentConfig: null,
    });
  }
}
