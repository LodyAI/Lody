/**
 * Durable protocols understood by a Machine daemon.
 *
 * Values are positive integer protocol versions so clients can negotiate a
 * compatible workflow without coupling behavior to a CLI release version.
 * Unknown keys must be preserved by readers for forward compatibility.
 */
export type MachineProtocolCapabilities = Record<string, number>;

export const MACHINE_PROTOCOL_CAPABILITIES = {
  localProjectRemoval: 'localProjectRemoval',
  providerSetup: 'providerSetup',
  schedules: 'schedules',
  preparedSessionInput: 'preparedSessionInput',
} as const;

export const LOCAL_PROJECT_REMOVAL_PROTOCOL_VERSION = 1;
export const PROVIDER_SETUP_PROTOCOL_VERSION = 1;
export const SCHEDULES_PROTOCOL_VERSION = 1;
export const PREPARED_SESSION_INPUT_PROTOCOL_VERSION = 1;

type MachineProtocolCapabilityCarrier = {
  protocolCapabilities?: MachineProtocolCapabilities;
};

export function getMachineProtocolCapabilityVersion(
  machine: MachineProtocolCapabilityCarrier | null | undefined,
  capability: string
): number {
  const version = machine?.protocolCapabilities?.[capability];
  return typeof version === 'number' && Number.isInteger(version) && version > 0 ? version : 0;
}

export function machineSupportsProtocolCapability(
  machine: MachineProtocolCapabilityCarrier | null | undefined,
  capability: string,
  minimumVersion = 1
): boolean {
  return getMachineProtocolCapabilityVersion(machine, capability) >= minimumVersion;
}

/**
 * The capability set this build advertises, and the checks that read it.
 *
 * Advertiser and checker share these bindings on purpose: a key and its
 * required version must never travel apart, because a mismatch fails silently
 * in the "supported" direction and there is no version fallback to catch it.
 */
export const CURRENT_MACHINE_PROTOCOL_CAPABILITIES: MachineProtocolCapabilities = {
  [MACHINE_PROTOCOL_CAPABILITIES.localProjectRemoval]: LOCAL_PROJECT_REMOVAL_PROTOCOL_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.providerSetup]: PROVIDER_SETUP_PROTOCOL_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.schedules]: SCHEDULES_PROTOCOL_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.preparedSessionInput]: PREPARED_SESSION_INPUT_PROTOCOL_VERSION,
};

/** Whether the target daemon supports preflighted local-project worktree cleanup and results. */
export function machineSupportsLocalProjectRemovalProtocol(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.localProjectRemoval,
    LOCAL_PROJECT_REMOVAL_PROTOCOL_VERSION
  );
}

/** Whether the target daemon can consume a durable `providerSetup` Flock row. */
export function machineSupportsProviderSetupProtocol(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.providerSetup,
    PROVIDER_SETUP_PROTOCOL_VERSION
  );
}

export function machineSupportsSchedulesProtocol(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.schedules,
    SCHEDULES_PROTOCOL_VERSION
  );
}

export function machineSupportsPreparedSessionInputProtocol(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.preparedSessionInput,
    PREPARED_SESSION_INPUT_PROTOCOL_VERSION
  );
}
