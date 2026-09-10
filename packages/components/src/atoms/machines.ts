import { atom } from 'jotai';
import {
  getMachineRoomId,
  MACHINE_DOC_PREFIX,
  type MachineLegacyMetaFields,
  type MachineViewMeta,
  type MachineId,
} from '@lody/shared';
import { atomFamily } from 'jotai/utils';
import { machineMetaAtomFamily, machineMetaCacheAtom } from './doc-meta';

const normalizeSupportRegistryAgentTypes = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const normalized = value
    .filter((agentType): agentType is string => typeof agentType === 'string')
    .map((agentType) => agentType.trim())
    .filter((agentType) => agentType.length > 0);
  return normalized.length > 0 ? normalized : [];
};

export const getMachineMetaByIdAtomFamily = atomFamily((machineId?: MachineId) =>
  atom((get) => {
    if (!machineId) return null;
    const raw = get(machineMetaAtomFamily(getMachineRoomId(machineId)));
    if (!raw) return null;
    const supportRegistryAgentTypes = normalizeSupportRegistryAgentTypes(
      raw.supportRegistryAgentTypes
    );
    const legacy = raw as MachineLegacyMetaFields;
    return {
      ...raw,
      id: raw.id ?? machineId,
      name: raw.name ?? machineId,
      cliVersion: raw.cliVersion ?? '',
      os: raw.os ?? '',
      sessions: raw.sessions ?? [],
      supportRegistryAgentTypes,
      acpCapabilities: legacy.acpCapabilities,
      localProjects: legacy.localProjects,
      workspacePaths: legacy.workspacePaths ?? {},
      needToArchiveSessions: legacy.needToArchiveSessions ?? {},
      needToDeleteSessions: legacy.needToDeleteSessions ?? {},
      raceLimits: legacy.raceLimits ?? {},
    } satisfies MachineViewMeta;
  })
);

export const getAllMachineIdsAtom = atom((get) => {
  const cache = get(machineMetaCacheAtom);
  return Object.keys(cache).map((roomId) => roomId.slice(MACHINE_DOC_PREFIX.length) as MachineId);
});

/**
 * Fields on MachineViewMeta that are relevant to the sidebar display.
 * Online/offline status comes from the presence atoms (useMachineOnlineStatus),
 * not from machine meta, so no liveness field is tracked here. Structural
 * equality avoids returning a new Map when nothing meaningful changed.
 */
const MACHINE_META_VISIBLE_KEYS: readonly (keyof MachineViewMeta)[] = [
  'id',
  'name',
  'ownerUserId',
  'localProjects',
  'workspacePaths',
  'sessions',
  'cliVersion',
  'os',
  'supportRegistryAgentTypes',
  'acpCapabilities',
  'needToArchiveSessions',
  'needToDeleteSessions',
  'rpcVersion',
  'supportsLocalProjectHistoryRpc',
  'protocolCapabilities',
  'raceLimits',
] as const;

function machineMetaEqual(a: MachineViewMeta, b: MachineViewMeta): boolean {
  for (const key of MACHINE_META_VISIBLE_KEYS) {
    const av = a[key];
    const bv = b[key];
    if (av === bv) continue;
    if (typeof av === 'object' || typeof bv === 'object') {
      if (JSON.stringify(av) !== JSON.stringify(bv)) return false;
    } else {
      return false;
    }
  }
  return true;
}

let _prevMachineMetaMap = new Map<MachineId, MachineViewMeta>();
export const getMachineMetaMapAtom = atom((get) => {
  const machineIds = get(getAllMachineIdsAtom);
  const map = new Map<MachineId, MachineViewMeta>();
  for (const id of machineIds) {
    const meta = get(getMachineMetaByIdAtomFamily(id));
    if (meta) map.set(id, meta);
  }

  // Structural equality: return previous reference if nothing changed
  if (map.size === _prevMachineMetaMap.size) {
    let equal = true;
    for (const [id, meta] of map) {
      const prev = _prevMachineMetaMap.get(id);
      if (!prev || !machineMetaEqual(prev, meta)) {
        equal = false;
        break;
      }
    }
    if (equal) return _prevMachineMetaMap;
  }

  _prevMachineMetaMap = map;
  return map;
});
