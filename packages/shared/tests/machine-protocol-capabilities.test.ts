import { describe, expect, it } from 'vitest';

import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  negotiatedAcpCapabilitiesRefreshForce,
  resolveNewSessionHistoryBackend,
} from '../src/machine-protocol-capabilities';
import {
  MachineAcpCapabilitiesRefreshRequestSchema,
  safeParseLocalSessionControlRequest,
} from '../src/message-schemas';

it('negotiates a new backend preference without changing explicit persisted choices', () => {
  expect(resolveNewSessionHistoryBackend(undefined, { preferred: 'roost' })).toBe('loro');
  expect(
    resolveNewSessionHistoryBackend(
      { protocolCapabilities: { sessionHistory: 1 } },
      { preferred: 'roost' }
    )
  ).toBe('loro');
  expect(
    resolveNewSessionHistoryBackend(
      { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES },
      { preferred: 'roost' }
    )
  ).toBe('roost');
  expect(() => resolveNewSessionHistoryBackend(undefined, { requested: 'roost' })).toThrow(
    'Update the machine'
  );
  expect(
    resolveNewSessionHistoryBackend(undefined, { requested: 'loro', preferred: 'roost' })
  ).toBe('loro');
});

describe('ACP capability refresh cache protocol capability', () => {
  // The refresh request as a daemon without this capability parses it: the same
  // strict schema minus the field that build never declared. Derived from the
  // current schema so it cannot drift away from what actually shipped.
  const previousGenerationRequestSchema = MachineAcpCapabilitiesRefreshRequestSchema.omit({
    force: true,
  });
  const buildRequest = (
    machine: { protocolCapabilities?: Record<string, number> } | undefined
  ) => ({
    type: 'machine/acp-capabilities-refresh' as const,
    machineId: 'machine-1',
    workspaceId: 'workspace-1',
    configId: 'config-1',
    ...negotiatedAcpCapabilitiesRefreshForce(machine, true),
  });

  it.each([
    { name: 'no advertised capabilities', machine: undefined },
    {
      name: 'an unrelated capability set',
      machine: { protocolCapabilities: { providerSetup: 1 } },
    },
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
});
