import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  makeAccountPairing,
  type AccountPairingAdmissionRecord,
  type AccountPairingRequestRecord,
  type AccountPairingStore,
} from '../src/account-pairing';
import { accountPairingStoreChecks } from './account-pairing-store-contract';

/** Reference store for tests: the same semantics as the durable adapters. */
function memoryStore(): AccountPairingStore {
  const terminal = new Map<string, 'approved' | 'declined' | 'expired' | 'cancelled'>();
  const requests: AccountPairingRequestRecord[] = [];
  const joined = new Map<string, Set<string>>();
  const approved = new Map<string, { request: Uint8Array; requestTag: string }>();
  const admissions = new Map<string, AccountPairingAdmissionRecord>();
  const key = (workspaceId: string, signingKey: string) => `${workspaceId}\u0000${signingKey}`;
  return {
    terminal: (id) => Effect.sync(() => terminal.get(id) ?? null),
    settle: (id, _role, state) =>
      Effect.sync(() => {
        if (!terminal.has(id)) terminal.set(id, state);
      }),
    latestRequest: () => Effect.sync(() => requests.at(-1) ?? null),
    hasRequest: (id) => Effect.sync(() => requests.some((item) => item.lookupId === id)),
    insertRequest: (record) =>
      requests.some((item) => item.lookupId === record.lookupId)
        ? Effect.fail(new Error('duplicate request'))
        : Effect.sync(() => void requests.push(record)),
    joined: (id) => Effect.sync(() => new Set(joined.get(id) ?? [])),
    addJoined: (id, workspaceId) =>
      Effect.sync(() => void joined.set(id, new Set([...(joined.get(id) ?? []), workspaceId]))),
    approvedRequest: (id) => Effect.sync(() => approved.get(id) ?? null),
    putApprovedRequest: (id, request, requestTag) =>
      Effect.sync(() => {
        if (!approved.has(id)) approved.set(id, { request, requestTag });
      }),
    admission: (workspaceId, signingKey) =>
      Effect.sync(() => admissions.get(key(workspaceId, signingKey)) ?? null),
    insertAdmission: (record) =>
      admissions.has(key(record.workspaceId, record.signingKey))
        ? Effect.fail(new Error('duplicate admission'))
        : Effect.sync(
            () => void admissions.set(key(record.workspaceId, record.signingKey), record)
          ),
    setAdmissionInvitation: (workspaceId, signingKey, invitation) =>
      Effect.sync(() => {
        const current = admissions.get(key(workspaceId, signingKey));
        if (current && !current.invitation)
          admissions.set(key(workspaceId, signingKey), { ...current, invitation });
      }),
    deleteAdmission: (workspaceId, signingKey, requestId) =>
      Effect.sync(() => {
        if (admissions.get(key(workspaceId, signingKey))?.requestId === requestId)
          admissions.delete(key(workspaceId, signingKey));
      }),
    admissionCount: (id) =>
      Effect.sync(() => [...admissions.values()].filter((item) => item.lookupId === id).length),
  };
}

describe('account pairing store contract (reference)', () => {
  for (const [name, check] of accountPairingStoreChecks(async () => memoryStore())) it(name, check);
});

describe('portable account pairing workflow', () => {
  it('runs request, approval and install with platform-neutral crypto and a store port', async () => {
    const fill = (byte: number, size = 32) => new Uint8Array(size).fill(byte);
    const requests = new Map<string, Record<string, unknown>>();
    const approvals = new Map<string, unknown[]>();
    const relay = {
      submit: (args: { lookupId: string; expiresAt: number; deviceName: string }) =>
        Effect.sync(() => {
          requests.set(args.lookupId, { ...args, requestId: 'request-1' });
          return {
            requestId: 'request-1',
            status: 'pending' as const,
            deviceName: args.deviceName,
            approximateLocation: null,
            requestedAt: 0,
            expiresAt: args.expiresAt,
          };
        }),
      read: (lookupId: string) =>
        Effect.sync(() => {
          const row = requests.get(lookupId) as never;
          return row
            ? { ...(row as object), status: 'pending', approximateLocation: null, requestedAt: 0 }
            : null;
        }) as never,
      decline: () => Effect.void,
      publish: (args: { lookupId: string }) =>
        Effect.sync(() => void approvals.set(args.lookupId, [{ ...args, publishedAt: 0 }])),
      claim: (lookupId: string) =>
        Effect.sync(() => ({
          status: 'pending' as const,
          approvals: (approvals.get(lookupId) ?? []) as never,
        })),
    };
    const installed: string[] = [];
    const requester = makeAccountPairing({
      store: memoryStore(),
      account: 'synthetic-account',
      deviceName: 'Synthetic browser',
      relay: relay as never,
      approverWorkspaces: () => Effect.succeed([]),
      requesterWorkspaces: () =>
        Effect.succeed([
          {
            workspaceId: 'w1',
            name: 'Alpha',
            genesis: fill(0x11),
            identity: () =>
              Effect.succeed({
                signingPublicKey: fill(0x30),
                encryptionPublicKey: fill(0x40),
                possessionProof: fill(0x50, 64),
                credentialHash: fill(0x60),
              }),
            accept: () => Effect.sync(() => void installed.push('w1')),
          },
        ]),
    });
    const approver = makeAccountPairing({
      store: memoryStore(),
      account: 'synthetic-account',
      deviceName: 'Synthetic desktop',
      relay: relay as never,
      requesterWorkspaces: () => Effect.succeed([]),
      approverWorkspaces: () =>
        Effect.succeed([
          {
            workspaceId: 'w1',
            name: 'Alpha',
            genesis: fill(0x11),
            signingPublicKey: fill(0x70),
            sign: () => Effect.succeed({ requestId: 'admit-1', record: new Uint8Array([9, 9]) }),
            append: () => Effect.void,
            invitation: () => Effect.succeed(new Uint8Array([7])),
            access: () => Effect.succeed({ workspaceId: 'w1', credential: '99'.repeat(32) }),
          },
        ]),
    });
    const state = await Effect.runPromise(requester.requestAccountPairing({}));
    const preview = await Effect.runPromise(approver.inspectAccountPairing(state.pairingString!));
    expect(preview?.workspaces).toEqual([{ workspaceId: 'w1', name: 'Alpha' }]);
    const result = await Effect.runPromise(
      approver.approveAccountPairing({
        pairingString: state.pairingString!,
        requestId: 'request-1',
        workspaceIds: ['w1'],
      })
    );
    expect(result.workspaces).toEqual([{ workspaceId: 'w1', outcome: 'admitted' }]);
    expect((await Effect.runPromise(requester.accountPairingRequest()))?.status).toBe('joined');
    expect(installed).toEqual(['w1']);
  });
});
