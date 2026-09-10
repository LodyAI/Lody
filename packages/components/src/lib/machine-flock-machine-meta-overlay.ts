import {
  getMachineFlockAcpCapabilities,
  getMachineFlockDeleteLocalProjectIds,
  getMachineFlockLocalProjects,
  getMachineFlockRateLimits,
  type LocalProjectId,
  parseRateLimitEntryKey,
  type MachineFlockRowMap,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';

type MachineRateLimits = MachineViewMeta['raceLimits'];

function isLegacyRateLimitEntryForCliType(key: string, cliType: string): boolean {
  if (key === cliType) {
    return true;
  }
  const parsed = parseRateLimitEntryKey(key);
  return (
    parsed.cliType === cliType && parsed.limitId !== null && !parsed.limitId.startsWith(cliType)
  );
}

function mergeRateLimits(
  legacyRateLimits: MachineRateLimits | undefined,
  flockRateLimits: MachineRateLimits
): MachineRateLimits {
  const flockCliTypes = new Set(
    Object.keys(flockRateLimits).map((key) => parseRateLimitEntryKey(key).cliType)
  );
  if (flockCliTypes.size === 0) {
    return legacyRateLimits ?? {};
  }

  const nextRateLimits: MachineRateLimits = {};
  for (const [key, value] of Object.entries(legacyRateLimits ?? {})) {
    const parsed = parseRateLimitEntryKey(key);
    if (
      flockCliTypes.has(parsed.cliType) &&
      isLegacyRateLimitEntryForCliType(key, parsed.cliType)
    ) {
      continue;
    }
    nextRateLimits[key] = value;
  }
  return {
    ...nextRateLimits,
    ...flockRateLimits,
  };
}

function mergeLocalProjects(
  legacyLocalProjects: MachineViewMeta['localProjects'],
  flockLocalProjects: MachineViewMeta['localProjects'],
  deletedLocalProjectIds: ReadonlySet<LocalProjectId>
): MachineViewMeta['localProjects'] {
  const localProjects = {
    ...(legacyLocalProjects ?? {}),
    ...(flockLocalProjects ?? {}),
  };
  for (const localProjectId of deletedLocalProjectIds) {
    delete localProjects[localProjectId];
  }
  return localProjects;
}

export function mergeMachineFlockMachineMeta(
  rawMachines: Map<MachineId, MachineViewMeta>,
  machineFlockRowsByMachineId: ReadonlyMap<MachineId, MachineFlockRowMap>
): Map<MachineId, MachineViewMeta> {
  if (machineFlockRowsByMachineId.size === 0) {
    return rawMachines;
  }

  let nextMachines: Map<MachineId, MachineViewMeta> | null = null;
  for (const [machineId, rows] of machineFlockRowsByMachineId) {
    const machine = (nextMachines ?? rawMachines).get(machineId);
    if (!machine) continue;

    const localProjects = getMachineFlockLocalProjects(rows);
    const deletedLocalProjectIds = getMachineFlockDeleteLocalProjectIds(rows);
    const acpCapabilities = getMachineFlockAcpCapabilities(rows);
    const rateLimits = getMachineFlockRateLimits(rows);
    if (
      Object.keys(localProjects).length === 0 &&
      deletedLocalProjectIds.size === 0 &&
      Object.keys(acpCapabilities).length === 0 &&
      Object.keys(rateLimits).length === 0
    ) {
      continue;
    }

    nextMachines ??= new Map(rawMachines);
    nextMachines.set(machineId, {
      ...machine,
      ...(Object.keys(localProjects).length > 0 || deletedLocalProjectIds.size > 0
        ? {
            localProjects: mergeLocalProjects(
              machine.localProjects,
              localProjects,
              deletedLocalProjectIds
            ),
          }
        : {}),
      ...(Object.keys(acpCapabilities).length > 0
        ? {
            acpCapabilities: {
              ...(machine.acpCapabilities ?? {}),
              ...acpCapabilities,
            },
          }
        : {}),
      ...(Object.keys(rateLimits).length > 0
        ? {
            raceLimits: mergeRateLimits(machine.raceLimits, rateLimits),
          }
        : {}),
    });
  }

  return nextMachines ?? rawMachines;
}
