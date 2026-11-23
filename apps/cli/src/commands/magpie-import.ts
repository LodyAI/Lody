import {
  MAGPIE_TARGETS,
  getMachineFlockAgentConfigs,
  getMachineFlockProviderSetups,
  getMachineFlockProviderSetupCancellations,
  machineFlockKeys,
  machineSupportsProtocolCapability,
  magpieProviderSettings,
  normalizeMagpieGateway,
  parseMagpieImportLink,
  readMachineFlockRowsFromFlock,
  supportsBuiltinProviderSetup,
  writeAgentConfigToFlock,
  writeMachineFlockRowToFlock,
  type AgentConfigId,
  type AgentConfigMeta,
  type MachineFlockWritableFlock,
  type MachineMeta,
  type MagpieImport,
  type MagpieTarget,
} from '@lody/shared';

export function resolveMagpieImport(options: {
  gateway?: string;
  link?: string;
  targets?: string;
}): MagpieImport {
  if (options.link !== undefined && options.gateway !== undefined)
    throw new Error('Use either --link or --gateway.');
  const request =
    options.link !== undefined
      ? parseMagpieImportLink(options.link)
      : {
          gatewayUrl: normalizeMagpieGateway(options.gateway ?? 'http://127.0.0.1:3425'),
          targets: [...MAGPIE_TARGETS],
        };
  const targets =
    options.targets === undefined
      ? request.targets
      : options.targets.split(',').map((t) => t.trim());
  if (
    !targets.length ||
    new Set(targets).size !== targets.length ||
    targets.some((t) => !request.targets.includes(t as MagpieTarget))
  ) {
    throw new Error(`Invalid --targets; choose from ${request.targets.join(',')}.`);
  }
  return { gatewayUrl: request.gatewayUrl, targets: targets as MagpieTarget[] };
}

/** Validate the entire selection before writing any provider. CLI execution itself is consent. */
export function assertMagpieImportMachine(machine: MachineMeta, request: MagpieImport): void {
  if (
    !machineSupportsProtocolCapability(machine, 'magpieImport') ||
    !machineSupportsProtocolCapability(machine, 'providerSetup')
  ) {
    throw new Error('Update and start this machine’s Lody daemon to import Magpie providers.');
  }
  if (request.targets.includes('pi') && !machineSupportsProtocolCapability(machine, 'builtinPi')) {
    throw new Error(
      'This machine does not support builtin Pi; update it or select --targets without pi.'
    );
  }
}

/** Synchronous read/write batch; the command owns serialization, flush and publication. */
export function importMagpieProviders(input: {
  flock: MachineFlockWritableFlock;
  machine: MachineMeta;
  request: MagpieImport;
  existing: readonly AgentConfigMeta[];
  newId: () => AgentConfigId;
  now: number;
}) {
  const { flock, machine, request, existing, newId, now } = input;
  assertMagpieImportMachine(machine, request);
  return request.targets.map((target) => {
    const settings = magpieProviderSettings(target, request.gatewayUrl);
    const matches = (config: AgentConfigMeta) =>
      config.machineId === machine.id &&
      config.cliType === 'builtin' &&
      config.agentType === settings.agentType &&
      config.magpieGatewayUrl === request.gatewayUrl;
    const rows = readMachineFlockRowsFromFlock(flock);
    const cancellations = getMachineFlockProviderSetupCancellations(rows);
    const known = [...Object.values(getMachineFlockAgentConfigs(rows)), ...existing].find(
      (config) => !cancellations[config.id] && matches(config)
    );
    if (known) return { target, agentConfigId: known.id, status: 'existing' as const };
    const setup = Object.values(getMachineFlockProviderSetups(rows)).find(
      (task) => !cancellations[task.id] && matches(task.config)
    );
    if (setup && setup.status !== 'failed') {
      return { target, agentConfigId: setup.id, status: setup.status };
    }
    const config: AgentConfigMeta = setup?.config ?? {
      ...settings,
      description: undefined,
      id: newId(),
      machineId: machine.id,
    };
    if (supportsBuiltinProviderSetup(settings.agentType)) {
      writeMachineFlockRowToFlock(flock, {
        key: machineFlockKeys.providerSetup(config.id),
        value: {
          v: 1,
          id: config.id,
          machineId: machine.id,
          config,
          status: 'queued',
          attempt: (setup?.attempt ?? 0) + 1,
          createdAt: setup?.createdAt ?? now,
          updatedAt: now,
        },
      });
      return { target, agentConfigId: config.id, status: 'queued' as const };
    }
    writeAgentConfigToFlock(flock, config);
    return { target, agentConfigId: config.id, status: 'created' as const };
  });
}
