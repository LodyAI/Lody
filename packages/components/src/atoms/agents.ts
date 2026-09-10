import { atom } from 'jotai';
import {
  AGENT_CONFIG_DOC_PREFIX,
  getMachineFlockAgentConfigs,
  getMachineFlockProviderSetups,
  getLodyCodexCustomProvider,
  getMachineFlockDocId,
  getServerNow,
  hasBuiltinRuntimeOverrideValues,
  isAgentBrandId,
  isManagedBuiltinAgentType,
  isBuiltinRuntimeOverrides,
  isCustomAcpLaunchSpec,
  isLoroRepoDocDeleted,
  machineFlockKeys,
  findBuiltinAgentOptOutToRetract,
  planBuiltinAgentOptOutForDeletedConfig,
  providerSetupContainsCodexCredential,
  readMachineFlockRowsFromFlock,
  serializeMachineFlockKey,
  type AgentBrandId,
  type AgentConfigId,
  type AgentConfigCliType,
  type AgentConfigMeta,
  type AcpConfigOptionValue,
  type CustomAcpLaunchSpec,
  type BuiltinRuntimeOverrides,
  type MachineFlockRowMap,
  type MachineId,
  type ProviderSetupCancellation,
  type ProviderSetupTask,
  type TitleGenerationConfig,
  getAgentConfigRoomId,
} from '@lody/shared';
import { atomFamily } from 'jotai/utils';
import { agentConfigMetaCacheAtom } from './doc-meta';
import {
  machineFlockRowsByWorkspaceAtom,
  setMachineFlockRowsForMachineAtom,
} from './machine-flock';
import { activeWorkspaceRuntimeAtom, type WorkspaceRuntime } from './runtime';

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export async function writeAgentConfigToMachineFlock(
  runtime: WorkspaceRuntime,
  config: AgentConfigMeta
): Promise<MachineFlockRowMap> {
  const flockDocId = getMachineFlockDocId(runtime.workspaceId, config.machineId);
  const key = machineFlockKeys.agentConfig(config.id);
  await runtime.writer.flockRowPut(flockDocId, key, config);
  // The write goes through the writer seam (in local-first mode the CLI is the
  // sole author and the row syncs back into the local mirror asynchronously).
  // Read back the current rows from the local mirror and overlay the just-written
  // row so the optimistic jotai cache reflects it immediately in both modes.
  const handle = await runtime.repo.openFlockDoc(flockDocId);
  const rows: MachineFlockRowMap = {
    ...readMachineFlockRowsFromFlock(handle.flock),
    [serializeMachineFlockKey(key)]: { key, value: config },
  };
  // Adding a builtin provider explicitly retracts the earlier removal. Check the
  // local mirror first so the steady state (no opt-out) costs no extra writer round trip.
  const optOutKey = findBuiltinAgentOptOutToRetract(rows, config);
  if (optOutKey) {
    await runtime.writer.flockRowDelete(flockDocId, optOutKey);
    delete rows[serializeMachineFlockKey(optOutKey)];
  }
  return rows;
}

async function deleteAgentConfigFromMachineFlock(
  runtime: WorkspaceRuntime,
  config: AgentConfigMeta
): Promise<MachineFlockRowMap> {
  const flockDocId = getMachineFlockDocId(runtime.workspaceId, config.machineId);
  const key = machineFlockKeys.agentConfig(config.id);
  const handle = await runtime.repo.openFlockDoc(flockDocId);
  const rows: MachineFlockRowMap = { ...readMachineFlockRowsFromFlock(handle.flock) };
  // The delete is a hard delete and leaves no trace of the row, so a managed builtin
  // provider needs its own removal record; otherwise the next CLI startup only sees
  // "not in the list", treats it as never created and adds it back. Record first, then
  // delete, so an interruption cannot degrade into "removed but not remembered".
  const optOut = planBuiltinAgentOptOutForDeletedConfig(rows, config, getServerNow());
  if (optOut) {
    await runtime.writer.flockRowPut(flockDocId, optOut.key, optOut.value);
    rows[serializeMachineFlockKey(optOut.key)] = optOut;
  }
  await runtime.writer.flockRowDelete(flockDocId, key);
  delete rows[serializeMachineFlockKey(key)];
  return rows;
}

async function writeProviderSetupToMachineFlock(
  runtime: WorkspaceRuntime,
  setup: ProviderSetupTask
): Promise<MachineFlockRowMap> {
  if (providerSetupContainsCodexCredential(setup.config)) {
    throw new Error('Provider setup rows cannot contain credentials');
  }
  const flockDocId = getMachineFlockDocId(runtime.workspaceId, setup.machineId);
  const key = machineFlockKeys.providerSetup(setup.id);
  await runtime.writer.flockRowDelete(
    flockDocId,
    machineFlockKeys.providerSetupCancellation(setup.id)
  );
  await runtime.writer.flockRowPut(flockDocId, key, setup);
  const handle = await runtime.repo.openFlockDoc(flockDocId);
  return {
    ...readMachineFlockRowsFromFlock(handle.flock),
    [serializeMachineFlockKey(key)]: { key, value: setup },
  };
}

async function cancelProviderSetupInMachineFlock(
  runtime: WorkspaceRuntime,
  cancellation: ProviderSetupCancellation,
  optimisticRows: MachineFlockRowMap
): Promise<MachineFlockRowMap> {
  const flockDocId = getMachineFlockDocId(runtime.workspaceId, cancellation.machineId);
  const cancellationKey = machineFlockKeys.providerSetupCancellation(cancellation.id);
  const setupKey = machineFlockKeys.providerSetup(cancellation.id);
  const configKey = machineFlockKeys.agentConfig(cancellation.id);

  // The durable marker is the cancellation accept boundary. The target CLI applies
  // the revision CAS and removes the affected rows; local projection only hides them.
  await runtime.writer.flockRowPut(flockDocId, cancellationKey, cancellation);

  const handle = await runtime.repo.openFlockDoc(flockDocId);
  const rows: MachineFlockRowMap = {
    ...readMachineFlockRowsFromFlock(handle.flock),
    ...optimisticRows,
    [serializeMachineFlockKey(cancellationKey)]: {
      key: cancellationKey,
      value: cancellation,
    },
  };
  const currentSetup = getMachineFlockProviderSetups(rows)[cancellation.id];
  if (
    currentSetup &&
    (!cancellation.setupRevision || currentSetup.setupRevision === cancellation.setupRevision)
  ) {
    delete rows[serializeMachineFlockKey(setupKey)];
  }
  if (!cancellation.preservePublishedConfig) {
    delete rows[serializeMachineFlockKey(configKey)];
  }
  return rows;
}

/**
 * Agent config meta as persisted before the machine-association refactor.
 * Exposed for the one-shot migration in `useAgentConfigMigration` only.
 * See docs/backward-compatibility.md BC-AGENT-CONFIG-MACHINE-ASSOCIATION.
 */
export type LegacyAgentConfigMeta = Omit<AgentConfigMeta, 'machineId'>;

type ParsedConfigRaw = {
  id: AgentConfigId;
  name: string;
  description: string | undefined;
  cliType: AgentConfigCliType;
  agentType: string;
  customAcp?: CustomAcpLaunchSpec;
  runtimeOverrides?: BuiltinRuntimeOverrides;
  env: Record<string, string>;
  prompt: string;
  titleGeneration?: TitleGenerationConfig;
  machineId?: MachineId;
  brandId?: AgentBrandId;
};

function parseAgentConfigRaw(roomId: string, raw: unknown): ParsedConfigRaw | null {
  if (!isPlainObject(raw)) return null;
  if (isLoroRepoDocDeleted(raw)) return null;
  const name = typeof raw.name === 'string' ? raw.name : null;
  const cliType = raw.cliType;
  const agentType = typeof raw.agentType === 'string' ? raw.agentType.trim() : '';
  if (!name || !agentType) return null;
  if (cliType !== 'builtin' && cliType !== 'registry' && cliType !== 'custom') return null;
  const customAcp = isCustomAcpLaunchSpec(raw.customAcp) ? raw.customAcp : undefined;
  if (cliType === 'custom' && !customAcp) return null;
  const runtimeOverrides = isBuiltinRuntimeOverrides(raw.runtimeOverrides)
    ? raw.runtimeOverrides
    : undefined;

  let titleGeneration: TitleGenerationConfig | undefined;
  if (isPlainObject(raw.titleGeneration)) {
    const tc = raw.titleGeneration;
    const configOptionValues = isPlainObject(tc.configOptionValues)
      ? (tc.configOptionValues as Record<string, AcpConfigOptionValue>)
      : undefined;
    if (configOptionValues) {
      titleGeneration = { configOptionValues };
    }
  }

  const machineIdRaw = raw.machineId;
  const machineId =
    typeof machineIdRaw === 'string' && machineIdRaw.trim().length > 0
      ? (machineIdRaw as MachineId)
      : undefined;

  return {
    id:
      (raw.id as AgentConfigId) ?? (roomId.slice(AGENT_CONFIG_DOC_PREFIX.length) as AgentConfigId),
    name,
    description: typeof raw.description === 'string' ? raw.description : undefined,
    cliType: cliType as AgentConfigCliType,
    agentType,
    customAcp,
    runtimeOverrides,
    env: isPlainObject(raw.env) ? (raw.env as Record<string, string>) : {},
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    titleGeneration,
    machineId,
    brandId: isAgentBrandId(raw.brandId) ? raw.brandId : undefined,
  };
}

/**
 * Returns a fully-resolved `AgentConfigMeta` (with `machineId`) or `null`.
 * Configs without `machineId` are treated as legacy and filtered out here —
 * they surface only through `getLegacyAgentConfigsAtom` for the migration.
 */
function buildAgentConfigMeta(roomId: string, raw: unknown): AgentConfigMeta | null {
  const parsed = parseAgentConfigRaw(roomId, raw);
  if (!parsed || !parsed.machineId) return null;
  return {
    id: parsed.id,
    machineId: parsed.machineId,
    name: parsed.name,
    description: parsed.description,
    cliType: parsed.cliType,
    agentType: parsed.agentType,
    customAcp: parsed.customAcp,
    runtimeOverrides: parsed.runtimeOverrides,
    env: parsed.env,
    prompt: parsed.prompt,
    titleGeneration: parsed.titleGeneration,
    brandId: parsed.brandId,
  };
}

function buildLegacyAgentConfigMeta(roomId: string, raw: unknown): LegacyAgentConfigMeta | null {
  const parsed = parseAgentConfigRaw(roomId, raw);
  if (!parsed || parsed.machineId) return null;
  return {
    id: parsed.id,
    name: parsed.name,
    description: parsed.description,
    cliType: parsed.cliType,
    agentType: parsed.agentType,
    customAcp: parsed.customAcp,
    runtimeOverrides: parsed.runtimeOverrides,
    env: parsed.env,
    prompt: parsed.prompt,
    titleGeneration: parsed.titleGeneration,
    brandId: parsed.brandId,
  };
}

function getMergedAgentConfigMap(
  loroRepoMetaCache: Record<string, AgentConfigMeta>,
  machineFlockRowsByMachineId: Record<string, MachineFlockRowMap> | undefined
): Map<AgentConfigId, AgentConfigMeta> {
  const byId = new Map<AgentConfigId, AgentConfigMeta>();
  for (const [roomId, meta] of Object.entries(loroRepoMetaCache)) {
    const config = buildAgentConfigMeta(roomId, meta);
    if (config) {
      byId.set(config.id, config);
    }
  }

  for (const rows of Object.values(machineFlockRowsByMachineId ?? {})) {
    for (const config of Object.values(getMachineFlockAgentConfigs(rows))) {
      byId.set(config.id, config);
    }
  }
  return byId;
}

export const getAgentMetaByIdAtomFamily = atomFamily((agentId?: AgentConfigId) =>
  atom((get) => {
    if (!agentId) return null;
    const runtime = get(activeWorkspaceRuntimeAtom);
    const machineFlockRowsByWorkspace = get(machineFlockRowsByWorkspaceAtom);
    return (
      getMergedAgentConfigMap(
        get(agentConfigMetaCacheAtom),
        runtime ? machineFlockRowsByWorkspace[String(runtime.workspaceId)] : undefined
      ).get(agentId) ?? null
    );
  })
);

export const getAllAgentConfigAtom = atom((get) => {
  const runtime = get(activeWorkspaceRuntimeAtom);
  const machineFlockRowsByWorkspace = get(machineFlockRowsByWorkspaceAtom);
  return [
    ...getMergedAgentConfigMap(
      get(agentConfigMetaCacheAtom),
      runtime ? machineFlockRowsByWorkspace[String(runtime.workspaceId)] : undefined
    ).values(),
  ];
});

export const getAllAgentConfigIdsAtom = atom((get) => get(getAllAgentConfigAtom).map((c) => c.id));

export const getAgentConfigsByMachineAtomFamily = atomFamily((machineId?: MachineId) =>
  atom((get) => {
    if (!machineId) return [] as AgentConfigMeta[];
    return get(getAllAgentConfigAtom).filter((c) => c.machineId === machineId);
  })
);

export const getAllProviderSetupsAtom = atom((get) => {
  const runtime = get(activeWorkspaceRuntimeAtom);
  if (!runtime) return [] as ProviderSetupTask[];
  const rowsByMachine = get(machineFlockRowsByWorkspaceAtom)[String(runtime.workspaceId)];
  const byId = new Map<AgentConfigId, ProviderSetupTask>();
  for (const rows of Object.values(rowsByMachine ?? {})) {
    for (const setup of Object.values(getMachineFlockProviderSetups(rows))) {
      byId.set(setup.id, setup);
    }
  }
  return [...byId.values()];
});

export const getProviderSetupsByMachineAtomFamily = atomFamily((machineId?: MachineId) =>
  atom((get) => {
    if (!machineId) return [] as ProviderSetupTask[];
    return get(getAllProviderSetupsAtom).filter((setup) => setup.machineId === machineId);
  })
);

/**
 * Pre-refactor `AgentConfigMeta` values that have no `machineId` yet. Fed into
 * the one-shot migration hook; do not render directly in the UI.
 */
export const getLegacyAgentConfigsAtom = atom((get) => {
  const cache = get(agentConfigMetaCacheAtom);
  return Object.entries(cache)
    .map(([roomId, meta]) => buildLegacyAgentConfigMeta(roomId, meta))
    .filter((c): c is LegacyAgentConfigMeta => c !== null);
});

export type CreateAgentConfigInput = AgentConfigMeta;

export const cmdCreateAgentConfigAtom = atom(
  null,
  async (get, _set, config: CreateAgentConfigInput) => {
    const runtime = get(activeWorkspaceRuntimeAtom);
    if (!runtime) throw new Error('Runtime not ready');
    if (!config.machineId) throw new Error('machineId is required to create an agent config');
    const rows = await writeAgentConfigToMachineFlock(runtime, config);
    // Replace rather than merge: merge cannot drop a key, so a retracted opt-out would
    // linger in the cache until the next sync.
    _set(setMachineFlockRowsForMachineAtom, {
      workspaceId: runtime.workspaceId,
      machineId: config.machineId,
      rows,
    });
    return config.id;
  }
);

export type CreateProviderSetupInput = {
  config: AgentConfigMeta;
  setupRevision?: string;
};

export const cmdCreateProviderSetupAtom = atom(
  null,
  async (get, set, input: CreateProviderSetupInput) => {
    const { config, setupRevision } = input;
    const runtime = get(activeWorkspaceRuntimeAtom);
    if (!runtime) throw new Error('Runtime not ready');
    const provider = getLodyCodexCustomProvider(config.env);
    if (
      config.cliType !== 'builtin' ||
      !isManagedBuiltinAgentType(config.agentType) ||
      (hasBuiltinRuntimeOverrideValues(config.runtimeOverrides) &&
        !(config.agentType === 'codex' && provider && setupRevision))
    ) {
      throw new Error('Provider setup is only supported for managed builtin agents');
    }
    if (providerSetupContainsCodexCredential(config)) {
      throw new Error('Provider setup rows cannot contain credentials');
    }
    const now = getServerNow();
    const replacesPublishedConfig = get(getAllAgentConfigAtom).some(
      (entry) => entry.id === config.id
    );
    if (provider && !setupRevision?.trim()) {
      throw new Error('Codex provider setup requires an exact setup revision');
    }
    const setup: ProviderSetupTask = {
      v: 1,
      id: config.id,
      machineId: config.machineId,
      config,
      status: provider ? 'awaiting-auth' : 'queued',
      attempt: 1,
      createdAt: now,
      updatedAt: now,
      ...(replacesPublishedConfig ? { replacesPublishedConfig: true } : {}),
      ...(setupRevision ? { setupRevision } : {}),
    };
    const rows = await writeProviderSetupToMachineFlock(runtime, setup);
    set(setMachineFlockRowsForMachineAtom, {
      workspaceId: runtime.workspaceId,
      machineId: setup.machineId,
      rows,
      mode: 'merge',
    });
    return setup.id;
  }
);

export const cmdRetryProviderSetupAtom = atom(null, async (get, set, setupId: AgentConfigId) => {
  const runtime = get(activeWorkspaceRuntimeAtom);
  if (!runtime) throw new Error('Runtime not ready');
  const setup = get(getAllProviderSetupsAtom).find((entry) => entry.id === setupId);
  if (!setup) return;
  const { failureCode: _failureCode, ...retryableSetup } = setup;
  const next: ProviderSetupTask = {
    ...retryableSetup,
    status: 'queued',
    attempt: setup.attempt + 1,
    updatedAt: getServerNow(),
  };
  const rows = await writeProviderSetupToMachineFlock(runtime, next);
  set(setMachineFlockRowsForMachineAtom, {
    workspaceId: runtime.workspaceId,
    machineId: next.machineId,
    rows,
    mode: 'merge',
  });
});

export type CancelProviderSetupInput = {
  id: AgentConfigId;
  machineId: MachineId;
  expectedSetupRevision?: string;
  preservePublishedConfig?: boolean;
};

export const deleteProviderSetupAtom = atom(null, async (get, set, input: CancelProviderSetupInput) => {
  const runtime = get(activeWorkspaceRuntimeAtom);
  if (!runtime) throw new Error('Runtime not ready');
  const setup = get(getAllProviderSetupsAtom).find((entry) => entry.id === input.id);
  if (
    input.expectedSetupRevision &&
    (!setup || setup.setupRevision !== input.expectedSetupRevision)
  ) {
    return;
  }
  const optimisticRows =
    get(machineFlockRowsByWorkspaceAtom)[String(runtime.workspaceId)]?.[String(input.machineId)] ??
    {};
  const cancellation: ProviderSetupCancellation = {
    v: 1,
    id: input.id,
    machineId: input.machineId,
    cancelledAt: getServerNow(),
    ...((input.preservePublishedConfig ?? setup?.replacesPublishedConfig)
      ? { preservePublishedConfig: true }
      : {}),
    ...(input.expectedSetupRevision
      ? { setupRevision: input.expectedSetupRevision }
      : {}),
  };
  const rows = await cancelProviderSetupInMachineFlock(runtime, cancellation, optimisticRows);
  set(setMachineFlockRowsForMachineAtom, {
    workspaceId: runtime.workspaceId,
    machineId: input.machineId,
    rows,
  });
});

export const deleteAgentConfigAtom = atom(null, async (get, _set, configId: AgentConfigId) => {
  const runtime = get(activeWorkspaceRuntimeAtom);
  if (!runtime) throw new Error('Runtime not ready');
  const config = get(getAllAgentConfigAtom).find((entry) => entry.id === configId);
  if (config) {
    const rows = await deleteAgentConfigFromMachineFlock(runtime, config);
    _set(setMachineFlockRowsForMachineAtom, {
      workspaceId: runtime.workspaceId,
      machineId: config.machineId,
      rows,
    });
  }
  await runtime.writer.deleteDoc(getAgentConfigRoomId(configId));
});

export const cmdUpdateAgentConfigAtom = atom(null, async (get, _set, config: AgentConfigMeta) => {
  const runtime = get(activeWorkspaceRuntimeAtom);
  if (!runtime) throw new Error('Runtime not ready');
  const roomId = getAgentConfigRoomId(config.id);
  const existing = await runtime.repo.getDocMeta(roomId);
  const rows = await writeAgentConfigToMachineFlock(runtime, config);
  _set(setMachineFlockRowsForMachineAtom, {
    workspaceId: runtime.workspaceId,
    machineId: config.machineId,
    rows,
    mode: 'merge',
  });
  if (!isLoroRepoDocDeleted(existing)) {
    await runtime.writer.deleteDoc(roomId);
  }
});
