import type {
  E2eeAccountPairingPreview,
  E2eeAccountPairingRequestState,
  E2eeWorkspaceRuntime,
} from '@lody/platform';

// Synthetic code from packages/e2ee-core/test/pairing-vector.json, parsed by real core.
export const CODE = '50M6-HA79-55MT-KTHA-DANE-PAVB-NF38';

export const TYPO = CODE.replace('HA79', 'HA78');

export const NOW = 1_800_000_000_000;

/** A host holding one request and its progress, like a desktop or portable host. */
export function requesterHost(initial: E2eeAccountPairingRequestState | null = null) {
  const host = {
    state: initial,
    started: [] as Array<{ pairingString?: string }>,
    cancelled: 0,
    runtime: {} as Pick<
      E2eeWorkspaceRuntime,
      'requestAccountPairing' | 'accountPairingRequest' | 'cancelAccountPairing'
    >,
  };
  host.runtime = {
    requestAccountPairing: async (input) => {
      host.started.push(input);
      host.state = {
        direction: input.pairingString ? 'approver-shows' : 'requester-shows',
        pairingString: input.pairingString ? null : CODE,
        expiresAt: NOW + 600_000,
        status: 'waiting',
        workspaces: [{ workspaceId: 'w1', name: 'Alpha', state: 'pending' }],
      };
      return host.state;
    },
    accountPairingRequest: async () => host.state,
    cancelAccountPairing: async () => {
      host.cancelled++;
      host.state = null;
    },
  };
  return host;
}

export const preview: E2eeAccountPairingPreview = {
  requestId: 'request-1',
  deviceName: 'Synthetic phone',
  approximateLocation: null,
  requestedAt: NOW,
  expiresAt: NOW + 600_000,
  workspaces: [
    { workspaceId: 'w1', name: 'Alpha' },
    { workspaceId: 'w2', name: 'Beta' },
  ],
  unavailable: [{ workspaceId: 'w3', name: 'Gamma' }],
};

export function approverHost() {
  const host = {
    request: preview as E2eeAccountPairingPreview | null,
    failure: null as Error | null,
    inspected: [] as string[],
    approved: [] as string[][],
    declined: [] as string[],
    runtime: {} as Pick<
      E2eeWorkspaceRuntime,
      | 'accountPairingCode'
      | 'inspectAccountPairing'
      | 'approveAccountPairing'
      | 'declineAccountPairing'
    >,
  };
  host.runtime = {
    accountPairingCode: async () => ({ pairingString: CODE, expiresAt: NOW + 600_000 }),
    inspectAccountPairing: async (code) => {
      host.inspected.push(code);
      if (host.failure) throw host.failure;
      return host.request;
    },
    approveAccountPairing: async (input) => {
      host.approved.push(input.workspaceIds);
      return {
        workspaces: input.workspaceIds.map((workspaceId, index) => ({
          workspaceId,
          outcome: index === 0 ? ('admitted' as const) : ('awaiting-delivery' as const),
        })),
      };
    },
    declineAccountPairing: async (input) => {
      host.declined.push(input.requestId);
    },
  };
  return host;
}
