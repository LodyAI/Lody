import { describe, expect, it } from 'vitest';

import {
  ACP_AUTHENTICATION_INTERACTIONS_PROTOCOL_VERSION,
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
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
