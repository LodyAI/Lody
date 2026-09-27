import { describe, expect, it } from 'vitest';

import {
  ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION,
  ACP_CAPABILITY_REFRESH_CACHE_PROTOCOL_VERSION,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsAcpAuthenticationInteractionsProtocol,
  machineSupportsAcpCapabilityRefreshCacheProtocol,
  machineSupportsLocalFileResourcesProtocol,
  negotiatedAcpCapabilitiesRefreshForce,
} from '../src/machine-protocol-capabilities';
import {
  MachineAcpCapabilitiesRefreshRequestSchema,
  safeParseLocalSessionControlRequest,
} from '../src/message-schemas';

describe('ACP authentication interaction protocol capability', () => {
  it('shares one version binding between advertisement and negotiation', () => {
    expect(
      CURRENT_MACHINE_PROTOCOL_CAPABILITIES[
        MACHINE_PROTOCOL_CAPABILITIES.acpAuthenticationInteractions
      ]
    ).toBe(ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION);
    expect(
      machineSupportsAcpAuthenticationInteractionsProtocol({
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      })
    ).toBe(true);
  });

  it('treats a missing or older capability as unsupported', () => {
    expect(machineSupportsAcpAuthenticationInteractionsProtocol(undefined)).toBe(false);
    expect(
      machineSupportsAcpAuthenticationInteractionsProtocol({
        protocolCapabilities: {
          [MACHINE_PROTOCOL_CAPABILITIES.acpAuthenticationInteractions]:
            ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION - 1,
        },
      })
    ).toBe(false);
  });
});

it('requires an advertised local file resource protocol, independent of release version', () => {
  expect(machineSupportsLocalFileResourcesProtocol(undefined)).toBe(false);
  expect(
    machineSupportsLocalFileResourcesProtocol({ protocolCapabilities: { localFileResources: 0 } })
  ).toBe(false);
  expect(
    machineSupportsLocalFileResourcesProtocol({
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    })
  ).toBe(true);
});

describe('ACP capability refresh cache protocol capability', () => {
  // The refresh request as a daemon without this capability parses it: the same
  // strict schema minus the field that build never declared. Derived from the
  // current schema so it cannot drift away from what actually shipped.
  const previousGenerationRequestSchema = MachineAcpCapabilitiesRefreshRequestSchema.omit({
    force: true,
  });
  const buildRequest = (machine: { protocolCapabilities?: Record<string, number> } | undefined) => ({
    type: 'machine/acp-capabilities-refresh' as const,
    machineId: 'machine-1',
    workspaceId: 'workspace-1',
    configId: 'config-1',
    ...negotiatedAcpCapabilitiesRefreshForce(machine, true),
  });

  it('shares one version binding between advertisement and negotiation', () => {
    expect(
      CURRENT_MACHINE_PROTOCOL_CAPABILITIES[
        MACHINE_PROTOCOL_CAPABILITIES.acpCapabilityRefreshCache
      ]
    ).toBe(ACP_CAPABILITY_REFRESH_CACHE_PROTOCOL_VERSION);
    expect(
      machineSupportsAcpCapabilityRefreshCacheProtocol({
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      })
    ).toBe(true);
  });

  it.each([
    { name: 'no advertised capabilities', machine: undefined },
    { name: 'an unrelated capability set', machine: { protocolCapabilities: { providerSetup: 1 } } },
    {
      name: 'a zero version',
      machine: { protocolCapabilities: { acpCapabilityRefreshCache: 0 } },
    },
  ])('sends a request a previous-generation daemon still accepts given $name', ({ machine }) => {
    const request = buildRequest(machine);

    // Not just "force is falsy": a strict schema rejects the key even when its
    // value is undefined, so the key must be absent from the payload entirely.
    expect(Object.keys(request)).not.toContain('force');
    expect(previousGenerationRequestSchema.safeParse(request).success).toBe(true);
    expect(safeParseLocalSessionControlRequest(JSON.stringify(request)).success).toBe(true);
  });

  it('sends force only to a daemon that advertised the capability', () => {
    const request = buildRequest({ protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES });

    expect(request.force).toBe(true);
    expect(safeParseLocalSessionControlRequest(JSON.stringify(request)).success).toBe(true);
    // The regression this negotiation prevents: a previous-generation daemon
    // rejects the whole request rather than ignoring an unknown field.
    expect(previousGenerationRequestSchema.safeParse(request).success).toBe(false);
  });

  it('never forces a request the caller did not ask to force', () => {
    expect(
      negotiatedAcpCapabilitiesRefreshForce(
        { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES },
        undefined
      )
    ).toEqual({});
    expect(
      negotiatedAcpCapabilitiesRefreshForce(
        { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES },
        false
      )
    ).toEqual({});
  });
});
