import { describe, expect, it } from 'vitest';

import {
  ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION,
  ACP_CAPABILITY_REFRESH_CACHE_PROTOCOL_VERSION,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsAcpAuthenticationInteractionsProtocol,
  machineSupportsAcpCapabilityRefreshCacheProtocol,
  machineSupportsLocalFileResourcesProtocol,
  machineSupportsProtocolCapability,
  machineSupportsSubagentEvents,
  machineSupportsIosSimulatorControls,
  negotiatedAcpCapabilitiesRefreshForce,
  resolveNewSessionHistoryBackend,
  machineSupportsSessionInputDispatch,
  machineSupportsSessionHistoryIncremental,
  machineSupportsSessionHistoryWatch,
  machineSupportsSessionHistoryPatches,
} from '../src/machine-protocol-capabilities';
import {
  MachineAcpCapabilitiesRefreshRequestSchema,
  safeParseLocalSessionControlRequest,
} from '../src/message-schemas';

it('admits local Session automation only when the daemon advertises it', () => {
  for (const machine of [
    undefined,
    { protocolCapabilities: {} },
    { protocolCapabilities: { schedules: 3, remoteAutomationControl: 1 } },
  ]) {
    expect(machineSupportsProtocolCapability(machine, 'sessionAutomations')).toBe(false);
  }
  expect(
    machineSupportsProtocolCapability(
      { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES },
      'sessionAutomations'
    )
  ).toBe(true);
});

it('negotiates content patches independently and keeps old history requests valid', () => {
  for (const machine of [
    undefined,
    { protocolCapabilities: { sessionHistoryIncremental: 1 } },
    { protocolCapabilities: { sessionHistoryPatches: 1 } },
  ])
    expect(machineSupportsSessionHistoryPatches(machine)).toBe(false);
  expect(
    machineSupportsSessionHistoryPatches({
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    })
  ).toBe(true);
  const request = {
    type: 'session/history-read',
    machineId: 'synthetic-machine',
    workspaceId: 'synthetic-workspace',
    sessionId: 'synthetic-session',
    query: { kind: 'readChanges', checkpoint: 'synthetic-checkpoint' },
  };
  for (const query of [
    request.query,
    { ...request.query, withPatches: true },
    { ...request.query, kind: 'watchChanges', waitMs: 15_000, withPatches: true },
  ])
    expect(safeParseLocalSessionControlRequest(JSON.stringify({ ...request, query })).success).toBe(
      true
    );
  expect(
    safeParseLocalSessionControlRequest(
      JSON.stringify({
        ...request,
        query: { ...request.query, withPatches: false },
      })
    ).success
  ).toBe(false);
});

it('requires independent checkpoint observation and validates its bounded wait', () => {
  expect(machineSupportsSessionHistoryWatch(undefined)).toBe(false);
  expect(
    machineSupportsSessionHistoryWatch({ protocolCapabilities: { sessionHistoryIncremental: 1 } })
  ).toBe(false);
  expect(
    machineSupportsSessionHistoryWatch({ protocolCapabilities: { sessionHistoryWatch: 1 } })
  ).toBe(false);
  expect(
    machineSupportsSessionHistoryWatch({
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    })
  ).toBe(true);
  const request = {
    type: 'session/history-read',
    machineId: 'synthetic-machine',
    workspaceId: 'synthetic-workspace',
    sessionId: 'synthetic-session',
    query: {
      kind: 'watchChanges',
      checkpoint: 'synthetic-checkpoint',
      waitMs: 15_000,
      includeBodiesFrom: 0,
    },
  };
  expect(safeParseLocalSessionControlRequest(JSON.stringify(request)).success).toBe(true);
  for (const waitMs of [-1, 15_001, 1.5])
    expect(
      safeParseLocalSessionControlRequest(
        JSON.stringify({ ...request, query: { ...request.query, waitMs } })
      ).success
    ).toBe(false);
});

it('requires independently negotiated owner input dispatch, including mixed daemon versions', () => {
  expect(machineSupportsSessionInputDispatch(undefined)).toBe(false);
  expect(
    machineSupportsSessionInputDispatch({
      protocolCapabilities: { sessionHistory: 2, sessionInputAcceptance: 1 },
    })
  ).toBe(false);
  expect(
    machineSupportsSessionInputDispatch({ protocolCapabilities: { sessionInputDispatch: 0 } })
  ).toBe(false);
  expect(
    machineSupportsSessionInputDispatch({
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    })
  ).toBe(true);
});

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

it('negotiates subagent events and Codex auth profiles independently on the same daemon', () => {
  const machine = { protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES };
  expect(machineSupportsSubagentEvents(machine)).toBe(true);
  expect(
    machineSupportsProtocolCapability(machine, MACHINE_PROTOCOL_CAPABILITIES.codexAuthProfiles)
  ).toBe(true);
  expect(machineSupportsSubagentEvents({ protocolCapabilities: { codexAuthProfiles: 1 } })).toBe(
    false
  );
  expect(
    machineSupportsProtocolCapability(
      { protocolCapabilities: { subagentEvents: 1 } },
      MACHINE_PROTOCOL_CAPABILITIES.codexAuthProfiles
    )
  ).toBe(false);
});

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
  const buildRequest = (
    machine: { protocolCapabilities?: Record<string, number> } | undefined
  ) => ({
    type: 'machine/acp-capabilities-refresh' as const,
    machineId: 'machine-1',
    workspaceId: 'workspace-1',
    configId: 'config-1',
    ...negotiatedAcpCapabilitiesRefreshForce(machine, true),
  });

  it('shares one version binding between advertisement and negotiation', () => {
    expect(
      CURRENT_MACHINE_PROTOCOL_CAPABILITIES[MACHINE_PROTOCOL_CAPABILITIES.acpCapabilityRefreshCache]
    ).toBe(ACP_CAPABILITY_REFRESH_CACHE_PROTOCOL_VERSION);
    expect(
      machineSupportsAcpCapabilityRefreshCacheProtocol({
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      })
    ).toBe(true);
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

it('negotiates private simulator controls independently of preview support', () => {
  expect(machineSupportsIosSimulatorControls(undefined)).toBe(false);
  expect(machineSupportsIosSimulatorControls({ protocolCapabilities: { iosSimulator: 1 } })).toBe(
    false
  );
  expect(
    machineSupportsIosSimulatorControls({
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    })
  ).toBe(true);
});

it('negotiates incremental history recovery independently of legacy paging', () => {
  expect(machineSupportsSessionHistoryIncremental(undefined)).toBe(false);
  expect(
    machineSupportsSessionHistoryIncremental({ protocolCapabilities: { sessionHistory: 2 } })
  ).toBe(false);
  expect(
    machineSupportsSessionHistoryIncremental({
      protocolCapabilities: { sessionHistoryIncremental: 0 },
    })
  ).toBe(false);
  expect(
    machineSupportsSessionHistoryIncremental({
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    })
  ).toBe(true);
});
