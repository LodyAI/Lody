/**
 * Durable protocols understood by a Machine daemon.
 *
 * Values are positive integer protocol versions so clients can negotiate a
 * compatible workflow without coupling behavior to a CLI release version.
 * Unknown keys must be preserved by readers for forward compatibility.
 */
export type MachineProtocolCapabilities = Record<string, number>;

export const MACHINE_PROTOCOL_CAPABILITIES = {
  builtinPi: 'builtinPi',
  subagentCancellation: 'subagentCancellation',
  acpAuthenticationInteractions: 'acpAuthenticationInteractions',
  localProjectRemoval: 'localProjectRemoval',
  providerSetup: 'providerSetup',
  localFileResources: 'localFileResources',
  acpProtocolAuthentication: 'acpProtocolAuthentication',
  acpCapabilityRefreshCache: 'acpCapabilityRefreshCache',
} as const;

export const ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION = 2;
export const SUBAGENT_CANCELLATION_PROTOCOL_VERSION = 1;
export const LOCAL_PROJECT_REMOVAL_PROTOCOL_VERSION = 1;
export const PROVIDER_SETUP_PROTOCOL_VERSION = 1;
export const LOCAL_FILE_RESOURCES_PROTOCOL_VERSION = 1;
export const ACP_PROTOCOL_AUTHENTICATION_VERSION = 2;
export const ACP_CAPABILITY_REFRESH_CACHE_PROTOCOL_VERSION = 1;

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

export function machineSupportsSubagentCancellation(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.subagentCancellation,
    SUBAGENT_CANCELLATION_PROTOCOL_VERSION
  );
}

/**
 * The capability set this build advertises, and the checks that read it.
 *
 * Advertiser and checker share these bindings on purpose: a key and its
 * required version must never travel apart, because a mismatch fails silently
 * in the "supported" direction and there is no version fallback to catch it.
 */
export const CURRENT_MACHINE_PROTOCOL_CAPABILITIES: MachineProtocolCapabilities = {
  [MACHINE_PROTOCOL_CAPABILITIES.subagentCancellation]: SUBAGENT_CANCELLATION_PROTOCOL_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.acpAuthenticationInteractions]:
    ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.localProjectRemoval]: LOCAL_PROJECT_REMOVAL_PROTOCOL_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.providerSetup]: PROVIDER_SETUP_PROTOCOL_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.localFileResources]: LOCAL_FILE_RESOURCES_PROTOCOL_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.acpProtocolAuthentication]: ACP_PROTOCOL_AUTHENTICATION_VERSION,
  [MACHINE_PROTOCOL_CAPABILITIES.acpCapabilityRefreshCache]:
    ACP_CAPABILITY_REFRESH_CACHE_PROTOCOL_VERSION,
};

/** Whether the target daemon supports interactive Custom/Registry ACP authentication. */
export function machineSupportsAcpAuthenticationInteractionsProtocol(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.acpAuthenticationInteractions,
    ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION
  );
}

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

/**
 * Whether the target daemon can run the baseline standard ACP `authenticate`
 * exchange for a registry or custom agent. Interactive method/form/URL replies
 * additionally require `acpAuthenticationInteractions`; older daemons answer
 * "Authentication is not supported", so sign-in is not offered at all.
 */
export function machineSupportsAcpProtocolAuthentication(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.acpProtocolAuthentication,
    ACP_PROTOCOL_AUTHENTICATION_VERSION
  );
}

export function machineSupportsLocalFileResourcesProtocol(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.localFileResources,
    LOCAL_FILE_RESOURCES_PROTOCOL_VERSION
  );
}

/**
 * Whether the target daemon may answer `machine/acp-capabilities-refresh` from
 * its persisted entry, and therefore understands the `force` field that opts out.
 *
 * Both facts arrive together in one build, so they share one capability: a daemon
 * that never caches is exactly a daemon that rejects `force`.
 */
export function machineSupportsAcpCapabilityRefreshCacheProtocol(
  machine: MachineProtocolCapabilityCarrier | null | undefined
): boolean {
  return machineSupportsProtocolCapability(
    machine,
    MACHINE_PROTOCOL_CAPABILITIES.acpCapabilityRefreshCache,
    ACP_CAPABILITY_REFRESH_CACHE_PROTOCOL_VERSION
  );
}

/**
 * The `force` field to put in a `machine/acp-capabilities-refresh` request,
 * spread into the request so an unsupported target gets no key at all.
 *
 * Omission is required, not cosmetic: a daemon without this capability parses the
 * request with a strict schema, so a `force` key — even one whose value is
 * `undefined` but present — makes it drop the RPC request without a reply or
 * reject the local-control request outright. Omission is also the behavior a
 * forced caller wants, because such a daemon has no cache and always probes.
 */
export function negotiatedAcpCapabilitiesRefreshForce(
  machine: MachineProtocolCapabilityCarrier | null | undefined,
  force: boolean | undefined
): { force?: true } {
  return force === true && machineSupportsAcpCapabilityRefreshCacheProtocol(machine)
    ? { force: true }
    : {};
}
