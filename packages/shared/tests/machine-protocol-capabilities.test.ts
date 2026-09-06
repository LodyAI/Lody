import { describe, expect, it } from 'vitest';

import {
  ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  INLINE_REFERENCES_PROTOCOL_VERSION,
  machineSupportsInlineReferencesProtocol,
  MACHINE_PROTOCOL_CAPABILITIES,
  machineSupportsAcpAuthenticationInteractionsProtocol,
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

describe('inline reference protocol capability', () => {
  it('advertises the negotiated version', () => {
    expect(CURRENT_MACHINE_PROTOCOL_CAPABILITIES.inlineReferences).toBe(
      INLINE_REFERENCES_PROTOCOL_VERSION
    );
    expect(
      machineSupportsInlineReferencesProtocol({
        protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
      })
    ).toBe(true);
  });
  it.each([
    undefined,
    null,
    {},
    { protocolCapabilities: {} },
    ...[0, -1, 0.5, NaN, Infinity].map((inlineReferences) => ({
      protocolCapabilities: { inlineReferences },
    })),
  ])('rejects absent or invalid capability %j', (machine) => {
    expect(machineSupportsInlineReferencesProtocol(machine)).toBe(false);
  });
});
