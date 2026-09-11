import { describe, expect, it } from 'vitest';

import {
  ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION,
  CONTEXT_COMPACTION_RECONCILIATION_PROTOCOL_VERSION,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsAcpAuthenticationInteractionsProtocol,
  machineSupportsContextCompactionReconciliationProtocol,
  machineSupportsLocalFileResourcesProtocol,
} from '../src/machine-protocol-capabilities';

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

it('binds legacy compaction reconciliation to its advertised protocol version', () => {
  expect(
    CURRENT_MACHINE_PROTOCOL_CAPABILITIES[
      MACHINE_PROTOCOL_CAPABILITIES.contextCompactionReconciliation
    ]
  ).toBe(CONTEXT_COMPACTION_RECONCILIATION_PROTOCOL_VERSION);
  expect(machineSupportsContextCompactionReconciliationProtocol(undefined)).toBe(false);
  expect(
    machineSupportsContextCompactionReconciliationProtocol({
      protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
    })
  ).toBe(true);
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
