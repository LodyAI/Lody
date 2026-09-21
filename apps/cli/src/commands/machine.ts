import { Command } from 'commander';
import {
  getMachineFlockAcpCapabilities,
  getMachineFlockDocId,
  getMachineFlockRateLimits,
  isMachineDocRoomId,
  parseRateLimitEntryKey,
  readMachineFlockRowsFromFlock,
  type AgentConfigMeta,
  type MachineFlockReadableFlock,
  type MachineId,
  type MachineLegacyMetaFields,
  type MachineMeta,
  type MachineViewMeta,
  type WorkspaceId,
} from '@lody/shared';
import {
  getAuthContextOrThrow,
  listAliveDocMetas,
  printJson,
  resolveWorkspaceOrThrow,
  runOneShotCommand,
  withWorkspaceManager,
  type CommonCommandOptions,
} from '@/lib/command-runtime';
import { renderTerminalTable } from '@/lib/terminal-table';
import { listMergedAgentConfigs } from '@/lib/agent-config-machine-flock';

type MachineListOptions = CommonCommandOptions & {
  onlineOnly?: boolean;
  includeAcpCapabilities?: boolean;
  includeAgents?: boolean;
};

type MachineRateLimits = MachineViewMeta['raceLimits'];
/**
 * Machine liveness is THREE-state. A null presence snapshot means the room could not
 * be joined, which is "unknown", never "offline" (`lib/loro/AGENTS.md`). `online` keeps
 * its original meaning — KNOWN online — and `onlineStatus` is additive so a `--json`
 * consumer can tell "we checked and it is down" from "we could not check". Previously
 * only a stderr warning carried that distinction, so anything parsing stdout recorded
 * an unreachable presence room as a confident offline.
 */
type MachineOnlineStatus = 'online' | 'offline' | 'unknown';

type MachineListEntry = MachineMeta &
  Pick<MachineViewMeta, 'acpCapabilities' | 'raceLimits'> & {
    online: boolean;
    onlineStatus: MachineOnlineStatus;
    agentConfigs?: AgentConfigMeta[];
  };

export function sortMachineMetas(
  machines: MachineMeta[],
  onlineMachineIds: ReadonlySet<MachineId>,
  currentMachineId?: MachineId
): MachineMeta[] {
  return [...machines].sort((left, right) => {
    const leftOnline = onlineMachineIds.has(left.id);
    const rightOnline = onlineMachineIds.has(right.id);
    if (leftOnline !== rightOnline) {
      return leftOnline ? -1 : 1;
    }

    const leftIsCurrent = left.id === currentMachineId;
    const rightIsCurrent = right.id === currentMachineId;
    if (leftIsCurrent !== rightIsCurrent) {
      return leftIsCurrent ? -1 : 1;
    }

    const nameCompare = left.name.localeCompare(right.name);
    if (nameCompare !== 0) {
      return nameCompare;
    }

    return left.id.localeCompare(right.id);
  });
}

export function formatMachineCli(machine: Pick<MachineMeta, 'supportRegistryAgentTypes'>): string {
  const values = machine.supportRegistryAgentTypes ?? [];
  const unique = Array.from(new Set(values));
  return unique.length > 0 ? unique.join(',') : '-';
}

export function toMachineListEntry(
  machine: MachineMeta,
  onlineMachineIds: ReadonlySet<MachineId> | null
): MachineListEntry {
  const legacy = machine as MachineLegacyMetaFields;
  const online = onlineMachineIds?.has(machine.id) === true;
  return {
    ...machine,
    acpCapabilities: legacy.acpCapabilities,
    raceLimits: legacy.raceLimits ?? {},
    online,
    onlineStatus: onlineMachineIds === null ? 'unknown' : online ? 'online' : 'offline',
  };
}

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

async function mergeMachineFlockJsonState(
  repo: { openFlockDoc(flockDocId: string): Promise<{ flock: MachineFlockReadableFlock }> },
  workspaceId: WorkspaceId,
  machine: MachineListEntry,
  includeAcpCapabilities: boolean
): Promise<MachineListEntry> {
  const handle = await repo.openFlockDoc(getMachineFlockDocId(workspaceId, machine.id));
  const rows = readMachineFlockRowsFromFlock(handle.flock, {
    families: includeAcpCapabilities ? ['acpCapability', 'rateLimit'] : ['rateLimit'],
  });
  const acpCapabilities = includeAcpCapabilities ? getMachineFlockAcpCapabilities(rows) : {};
  const rateLimits = getMachineFlockRateLimits(rows);
  if (Object.keys(acpCapabilities).length === 0 && Object.keys(rateLimits).length === 0) {
    return machine;
  }
  return {
    ...machine,
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
  };
}

export function toMachineJsonEntry(
  machine: MachineListEntry,
  options: { includeAcpCapabilities: boolean; includeAgents: boolean }
): MachineListEntry | Omit<MachineListEntry, 'acpCapabilities' | 'agentConfigs'> {
  const withoutOptional = { ...machine };
  if (!options.includeAcpCapabilities) {
    delete withoutOptional.acpCapabilities;
  }
  if (!options.includeAgents) {
    delete withoutOptional.agentConfigs;
  }
  return withoutOptional;
}

function formatMachineAgents(machine: Pick<MachineListEntry, 'agentConfigs'>): string {
  const configs = machine.agentConfigs ?? [];
  if (configs.length === 0) {
    return '-';
  }
  return configs.map((config) => `${config.name} (${config.agentType})`).join(',');
}

async function attachAgentConfigsToMachines(
  repo: Parameters<typeof listMergedAgentConfigs>[0],
  workspaceId: WorkspaceId,
  machines: MachineListEntry[]
): Promise<MachineListEntry[]> {
  const configs = await listMergedAgentConfigs(
    repo,
    workspaceId,
    machines.map((machine) => machine.id)
  );
  const configsByMachine = new Map<MachineId, AgentConfigMeta[]>();
  for (const config of configs) {
    const current = configsByMachine.get(config.machineId) ?? [];
    current.push(config);
    configsByMachine.set(config.machineId, current);
  }
  for (const values of configsByMachine.values()) {
    values.sort((left, right) => {
      const nameCompare = left.name.localeCompare(right.name);
      if (nameCompare !== 0) {
        return nameCompare;
      }
      return left.id.localeCompare(right.id);
    });
  }
  return machines.map((machine) => ({
    ...machine,
    agentConfigs: configsByMachine.get(machine.id) ?? [],
  }));
}

function printHumanMachineList(
  machines: MachineListEntry[],
  currentMachineId: MachineId,
  includeAgents: boolean
): void {
  if (machines.length === 0) {
    console.log('No machines found.');
    return;
  }

  const columns = [{ header: 'ID' }, { header: 'Name' }, { header: 'Status' }, { header: 'CLI' }];
  if (includeAgents) {
    columns.push({ header: 'Agents' });
  }

  console.log(
    renderTerminalTable(
      columns,
      machines.map((machine) => {
        const row = [
          machine.id,
          machine.id === currentMachineId ? `${machine.name} (current)` : machine.name,
          machine.onlineStatus,
          formatMachineCli(machine),
        ];
        if (includeAgents) {
          row.push(formatMachineAgents(machine));
        }
        return row;
      })
    )
  );
}

export const machineCommand = new Command('machine')
  .description('Inspect registered machines')
  .addCommand(
    new Command('list')
      .description('List machines in a workspace')
      .option('--workspace <selector>', 'Target workspace id, slug, or name')
      .option('--online-only', 'Only include machines with a recent heartbeat')
      .option('--json', 'Print JSON output')
      .option('--include-acp-capabilities', 'Include acpCapabilities in JSON output')
      .option('--include-agents', 'Include agent config summaries per machine')
      .option('--debug', 'Enable debug output')
      .action(async (options: MachineListOptions) => {
        await runOneShotCommand('machine', options, async () => {
          const auth = getAuthContextOrThrow('machine');
          const workspace = await resolveWorkspaceOrThrow(auth, options.workspace);

          await withWorkspaceManager(auth, workspace, 'machine', async (manager) => {
            // Online status comes from the ephemeral presence room, not from
            // durable machine meta (whose lastSeen is a legacy registration
            // timestamp). A null snapshot means presence could not be joined.
            const onlineMachineIds = await manager.getOnlineMachineIds();
            if (onlineMachineIds === null) {
              console.error(
                'Warning: presence room unavailable; machine online status is unknown, reported as onlineStatus "unknown".'
              );
            }
            const onlineIds = onlineMachineIds ?? new Set<MachineId>();
            let machines = sortMachineMetas(
              (await listAliveDocMetas<MachineMeta>(manager, isMachineDocRoomId)).map(
                (entry) => entry.meta
              ),
              onlineIds,
              auth.machineId
            )
              .map((machine) => toMachineListEntry(machine, onlineMachineIds))
              .filter((machine) => !options.onlineOnly || machine.online);

            if (options.includeAgents === true) {
              machines = await attachAgentConfigsToMachines(
                manager.repo,
                workspace.id as WorkspaceId,
                machines
              );
            }

            if (options.json) {
              const includeAcpCapabilities = options.includeAcpCapabilities === true;
              const includeAgents = options.includeAgents === true;
              const jsonMachines = await Promise.all(
                machines.map((machine) =>
                  mergeMachineFlockJsonState(
                    manager.repo,
                    workspace.id as WorkspaceId,
                    machine,
                    includeAcpCapabilities
                  )
                )
              );
              printJson({
                ok: true,
                workspaceId: workspace.id,
                machines: jsonMachines.map((machine) =>
                  toMachineJsonEntry(machine, { includeAcpCapabilities, includeAgents })
                ),
              });
              return;
            }

            printHumanMachineList(machines, auth.machineId, options.includeAgents === true);
          });
        });
      })
  );
