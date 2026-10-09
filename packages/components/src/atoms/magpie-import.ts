import { atom } from 'jotai';
import {
  isMagpieImportLink,
  parseMagpieImportLink,
  magpieProviderSettings,
  MAGPIE_GATEWAY_ENV,
  machineSupportsProtocolCapability,
  supportsBuiltinProviderSetup,
  getMachineFlockDocId,
  readMachineFlockRowsFromFlock,
  getMachineFlockAgentConfigs,
  getMachineFlockProviderSetups,
  type MagpieImport,
  type MagpieTarget,
  type AgentConfigId,
} from '@lody/shared';
import { localMachineIdAtom, localCliStartingAtom } from './local-probe';
import { activeWorkspaceRuntimeAtom } from './runtime';
import { getMachineMetaMapAtom } from './machines';
import {
  cmdCreateAgentConfigAtom,
  cmdCreateProviderSetupAtom,
  getAllAgentConfigAtom,
  getAllProviderSetupsAtom,
} from './agents';

export type PendingMagpieImport = MagpieImport & {
  id: string;
  configIds: Record<MagpieTarget, AgentConfigId>;
};
const magpieImportRunningAtom = atom(false);
export const pendingMagpieImportAtom = atom<PendingMagpieImport | null>(null);
export const receiveMagpieImportAtom = atom(null, (_get, set, url: string) => {
  if (!isMagpieImportLink(url)) return false;
  const parsed = parseMagpieImportLink(url);
  set(pendingMagpieImportAtom, {
    ...parsed,
    id: crypto.randomUUID(),
    configIds: {
      claude: crypto.randomUUID() as AgentConfigId,
      codex: crypto.randomUUID() as AgentConfigId,
      pi: crypto.randomUUID() as AgentConfigId,
      dsh: crypto.randomUUID() as AgentConfigId,
    },
  });
  return true;
});

/** Freeze only the OS-local machine; a selected remote machine never participates. */
export const importMagpieProvidersAtom = atom(
  null,
  async (get, set, input: { requestId: string; targets: MagpieTarget[] }) => {
    const { targets } = input;
    if (get(magpieImportRunningAtom)) throw new Error('Magpie import is already running');
    const request = get(pendingMagpieImportAtom);
    const machineId = get(localMachineIdAtom);
    const runtime = get(activeWorkspaceRuntimeAtom);
    const machine = machineId ? get(getMachineMetaMapAtom).get(machineId) : undefined;
    if (
      !request ||
      request.id !== input.requestId ||
      !machineId ||
      !runtime ||
      get(localCliStartingAtom) ||
      typeof window === 'undefined' ||
      window.__LODY_ELECTRON__ !== true ||
      !machineSupportsProtocolCapability(machine, 'magpieImport') ||
      !machineSupportsProtocolCapability(machine, 'providerSetup')
    )
      throw new Error('Local machine is not ready for Magpie import');
    if (
      !targets.length ||
      new Set(targets).size !== targets.length ||
      targets.some((t) => !request.targets.includes(t))
    )
      throw new Error('Invalid Magpie selection');
    if (targets.includes('pi') && !machineSupportsProtocolCapability(machine, 'builtinPi'))
      throw new Error('This machine does not support Pi');
    set(magpieImportRunningAtom, true);
    try {
      const handle = await runtime.repo.openFlockDoc(
        getMachineFlockDocId(runtime.workspaceId, machineId)
      );
      for (const target of targets) {
        if (
          get(localMachineIdAtom) !== machineId ||
          get(activeWorkspaceRuntimeAtom) !== runtime ||
          get(pendingMagpieImportAtom)?.id !== request.id
        )
          throw new Error('Import context changed');
        const settings = magpieProviderSettings(target, request.gatewayUrl);
        const rows = readMachineFlockRowsFromFlock(handle.flock);
        const known = [
          ...get(getAllAgentConfigAtom),
          ...get(getAllProviderSetupsAtom).map((task) => task.config),
          ...Object.values(getMachineFlockAgentConfigs(rows)),
          ...Object.values(getMachineFlockProviderSetups(rows)).map((task) => task.config),
        ];
        // Reopening a link and retrying a partial write must never duplicate or edit existing providers.
        if (
          known.some(
            (c) =>
              c.machineId === machineId &&
              c.cliType === 'builtin' &&
              c.agentType === settings.agentType &&
              c.env?.[MAGPIE_GATEWAY_ENV] === request.gatewayUrl
          )
        )
          continue;
        const config = {
          ...settings,
          description: undefined,
          id: request.configIds[target],
          machineId,
        };
        if (supportsBuiltinProviderSetup(config.agentType))
          await set(cmdCreateProviderSetupAtom, config);
        else await set(cmdCreateAgentConfigAtom, config);
      }
      if (get(pendingMagpieImportAtom)?.id === request.id) set(pendingMagpieImportAtom, null);
    } finally {
      set(magpieImportRunningAtom, false);
    }
  }
);
