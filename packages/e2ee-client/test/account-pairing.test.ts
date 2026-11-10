import type { E2eeWorkspaceRuntime } from '@lody/platform';
import {
  makeAutomaticPairingRuntime,
  type AutomaticPairingRelay,
} from '../src/automatic-pairing-runtime';
import type { E2eeAutomaticPairingRecord } from '@lody/cloud-api';
import { makeAutomaticPairingExchange } from '../src/automatic-pairing-crypto';
import { decodePairingRequest } from '@lody/e2ee-core/protocol';
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
  it.each(['cancel', 'expiry'] as const)(
    'preserves the first native request and workspace when another window is refused, then %s',
    async (cleanup) => {
      let time = 0;
      const hints = [
        { workspaceId: 'w1', name: 'Alpha', genesisHash: '11'.repeat(32) },
        { workspaceId: 'w2', name: 'Beta', genesisHash: '22'.repeat(32) },
      ];
      const contexts = new Map<string, E2eeAutomaticPairingRecord>();
      const discovery: AutomaticPairingRelay = {
        pending: () => Effect.sync(() => structuredClone([...contexts.values()])),
        read: (id) => Effect.sync(() => structuredClone(contexts.get(id) ?? null)),
        exchange: (command) =>
          Effect.sync(() => {
            let row = contexts.get(command.id);
            if (!row) {
              if (!command.context) throw new Error('missing discovery original');
              row = { context: structuredClone(command.context), state: 'pending' };
              contexts.set(command.id, row);
            }
            if (command.commitment) row.commitment ??= structuredClone(command.commitment);
            if (command.requesterKey) row.requesterKey ??= command.requesterKey;
            if (command.reveal) row.reveal ??= structuredClone(command.reveal);
            if (command.terminal) row.state = command.terminal;
            return structuredClone(row);
          }),
      };
      const store = memoryStore();
      type Submitted = Parameters<Parameters<typeof makeAccountPairing>[0]['relay']['submit']>[0];
      const submitted = new Map<string, Submitted>();
      let available = hints.slice(0, 1);
      let inventoryEntered!: () => void;
      const preparingFirst = new Promise<void>((resolve) => {
        inventoryEntered = resolve;
      });
      let releaseInventory!: () => void;
      const inventoryReady = new Promise<void>((resolve) => {
        releaseInventory = resolve;
      });
      const native = makeAccountPairing({
        store,
        now: () => time,
        account: 'synthetic-account',
        deviceName: 'Synthetic phone',
        relay: {
          submit: (input) =>
            Effect.sync(() => {
              submitted.set(input.lookupId, structuredClone(input));
              return {
                requestId: input.lookupId,
                status: 'pending' as const,
                deviceName: input.deviceName,
                requestedAt: 0,
                expiresAt: input.expiresAt,
                approximateLocation: null,
              };
            }),
          read: () => Effect.succeed(null),
          claim: () => Effect.succeed({ status: 'pending' as const, approvals: [] }),
          publish: () => Effect.void,
          decline: () => Effect.void,
        },
        approverWorkspaces: () => Effect.succeed([]),
        requesterWorkspaces: () =>
          Effect.promise(async () => {
            inventoryEntered();
            await inventoryReady;
            return available.map((hint) => ({
              workspaceId: hint.workspaceId,
              name: hint.name,
              genesis: new Uint8Array(32).fill(hint.workspaceId === 'w1' ? 0x11 : 0x22),
              identity: () =>
                Effect.succeed({
                  signingPublicKey: new Uint8Array(32).fill(0x30),
                  encryptionPublicKey: new Uint8Array(32).fill(0x40),
                  possessionProof: new Uint8Array(64).fill(0x50),
                  credentialHash: new Uint8Array(32).fill(0x60),
                }),
              accept: () => Effect.void,
            }));
          }),
      });
      let emptyReaders = 0;
      let releaseReaders!: () => void;
      const bothReadEmpty = new Promise<void>((resolve) => {
        releaseReaders = resolve;
      });
      const host = {
        accountPairingRequest: async () => {
          const original = await Effect.runPromise(native.accountPairingRequest());
          if (!original && emptyReaders < 2) {
            emptyReaders += 1;
            if (emptyReaders === 2) releaseReaders();
            await bothReadEmpty;
          }
          return original;
        },
        requestAccountPairing: async (
          input: Parameters<NonNullable<E2eeWorkspaceRuntime['requestAccountPairing']>>[0]
        ) => {
          if (input.workspace?.workspaceId === 'w2') {
            // Another window expands the shared native catalog while the first
            // request is suspended in its workspace inventory read.
            await preparingFirst;
            available = hints;
            releaseInventory();
          }
          return Effect.runPromise(
            native.requestAccountPairing({
              pairingString: input.pairingString,
              expiresAt: input.expiresAt,
              preserveExisting: input.preserveExisting,
              workspaceId: input.workspace?.workspaceId,
            })
          );
        },
        cancelAccountPairing: (input?: { expectedLookupId: string }) =>
          Effect.runPromise(native.cancelAccountPairing(input)),
      } as unknown as E2eeWorkspaceRuntime;
      const common = {
        relay: discovery,
        account: () => 'synthetic-account',
        workspaces: () => hints,
        deviceName: 'Synthetic phone',
        canPresent: () => true,
        crypto,
        now: () => time,
        run: Effect.runPromise,
      };
      // Separate coordinators model separate renderers; a per-renderer request
      // slot cannot protect the shared host from this interleaving.
      const first = makeAutomaticPairingRuntime({ ...common, runtime: host });
      const second = makeAutomaticPairingRuntime({ ...common, runtime: host });
      const desktop = makeAutomaticPairingRuntime({
        ...common,
        runtime: {
          readIdentity: async ({ workspaceId }: { workspaceId: string }) => ({
            workspaceId,
            genesisHash: hints.find((hint) => hint.workspaceId === workspaceId)!.genesisHash,
          }),
          inspectAccountPairing: async () => null,
          approveAccountPairing: async () => ({ workspaces: [] }),
        } as unknown as E2eeWorkspaceRuntime,
      });
      try {
        await second.startAutomaticPairing('w2');
        time = 1_000;
        await first.startAutomaticPairing('w1');
        await desktop.pendingAutomaticPairing();
        await first.automaticPairingState('w1');
        await second.automaticPairingState('w2');
        await desktop.pendingAutomaticPairing();
        const results = await Promise.allSettled([
          first.automaticPairingState('w1'),
          second.automaticPairingState('w2'),
        ]);
        expect(results[0]).toMatchObject({ status: 'fulfilled', value: { phase: 'waiting' } });
        expect(results[1]).toMatchObject({
          status: 'rejected',
          reason: { message: 'e2ee_pairing-elsewhere' },
        });
        expect(submitted.size).toBe(1);
        const original = [...submitted.values()][0]!;
        expect(original.workspaces).toEqual([
          { workspaceId: 'w1', genesisHash: hints[0]!.genesisHash },
        ]);
        const saved = await Effect.runPromise(store.latestRequest());
        expect(saved?.lookupId).toBe(original.lookupId);
        expect(await Effect.runPromise(store.terminal(original.lookupId))).toBeNull();
        const decoded = decodePairingRequest(saved!.request);
        expect(decoded).toMatchObject({
          _tag: 'Success',
          success: { rows: [expect.objectContaining({ genesis: new Uint8Array(32).fill(0x11) })] },
        });
        if (cleanup === 'cancel') await second.cancelAutomaticPairing('w2');
        else {
          time = 600_001;
          expect((await second.startAutomaticPairing('w2')).phase).toBe('preparing');
        }
        expect(await Effect.runPromise(store.terminal(original.lookupId))).toBeNull();
        expect((await first.automaticPairingState('w1'))?.phase).toBe('waiting');
        expect([...submitted.values()]).toEqual([original]);
        await first.cancelAutomaticPairing('w1');
        expect(await Effect.runPromise(store.terminal(original.lookupId))).toBe('cancelled');
      } finally {
        releaseReaders();
        releaseInventory();
        first.disposeAutomaticPairing();
        second.disposeAutomaticPairing();
        desktop.disposeAutomaticPairing();
      }
    }
  );

  it.each([
    ['an Admin approver with a snapshot invitation', new Uint8Array([7]), 'w1', false, 'approve'],
    ['an automatic Admin approval', new Uint8Array([7]), 'w1', true, 'approve'],
    ['an automatic Member approval', null, 'history:w1', true, 'approve'],
    ['a Member approver through full history', null, 'history:w1', false, 'approve'],
    ['an old host ignoring the original deadline', null, 'history:w1', true, 'old-host'],
    ['an automatic decline', null, 'history:w1', true, 'decline'],
    ['an automatic cancellation', null, 'history:w1', true, 'cancel'],
    ['an expired automatic approval', null, 'history:w1', true, 'expire'],
    [
      'a background device notification followed by foreground approval',
      null,
      'history:w1',
      true,
      'background',
    ],
  ] as const)(
    'runs request, approval and install for %s',
    async (_, invitation, install, automatic, action) => {
      let time = 0;
      let foreground = action !== 'background';
      const notices: string[] = [];
      const now = () => (automatic ? time : Date.now());
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
        now,
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
              acceptHistory: () => Effect.sync(() => void installed.push('history:w1')),
            },
          ]),
      });
      const approver = makeAccountPairing({
        store: memoryStore(),
        now,
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
              invitation: () => Effect.succeed(invitation),
              access: () => Effect.succeed({ workspaceId: 'w1', credential: '99'.repeat(32) }),
            },
          ]),
      });
      if (automatic) {
        const contexts = new Map<string, E2eeAutomaticPairingRecord>();
        const discovery: AutomaticPairingRelay = {
          pending: () =>
            Effect.sync(() =>
              structuredClone([...contexts.values()].filter((row) => row.state === 'pending'))
            ),
          read: (id) => Effect.sync(() => structuredClone(contexts.get(id) ?? null)),
          exchange: (command) =>
            Effect.sync(() => {
              let row = contexts.get(command.id);
              if (!row) {
                if (!command.context) throw new Error('missing discovery original');
                row = { context: structuredClone(command.context), state: 'pending' };
                contexts.set(command.id, row);
              }
              if (command.commitment) row.commitment ??= structuredClone(command.commitment);
              if (command.requesterKey) row.requesterKey ??= command.requesterKey;
              if (command.reveal) row.reveal ??= structuredClone(command.reveal);
              if (command.terminal) row.state = command.terminal;
              return structuredClone(row);
            }),
        };
        let lostReply = true;
        const requestingRuntime = {
          requestAccountPairing: async (input: { pairingString?: string }) => {
            const result = await Effect.runPromise(
              requester.requestAccountPairing(
                action === 'old-host' ? { pairingString: input.pairingString } : input
              )
            );
            if (lostReply) {
              lostReply = false;
              throw new Error('synthetic lost IPC reply');
            }
            return result;
          },
          accountPairingRequest: () => Effect.runPromise(requester.accountPairingRequest()),
          cancelAccountPairing: () => Effect.runPromise(requester.cancelAccountPairing()),
          status: async () => ({
            deviceKind: 'personal',
            hasDeviceCredential: installed.length > 0,
            hasCurrentKey: installed.length > 0,
          }),
        } as unknown as E2eeWorkspaceRuntime;
        let lostApprovalReply = true;
        const approvingRuntime = {
          inspectAccountPairing: (value: string) =>
            Effect.runPromise(approver.inspectAccountPairing(value)),
          approveAccountPairing: async (
            input: Parameters<typeof approver.approveAccountPairing>[0]
          ) => {
            const result = await Effect.runPromise(approver.approveAccountPairing(input));
            if (lostApprovalReply) {
              lostApprovalReply = false;
              throw new Error('synthetic lost approval reply');
            }
            return result;
          },
          declineAccountPairing: (input: Parameters<typeof approver.declineAccountPairing>[0]) =>
            Effect.runPromise(approver.declineAccountPairing(input)),
          readIdentity: async () => ({ workspaceId: 'w1', genesisHash: '11'.repeat(32) }),
        } as unknown as E2eeWorkspaceRuntime;
        const common = {
          relay: discovery,
          account: () => 'synthetic-account',
          workspaces: () => [{ workspaceId: 'w1', name: 'Alpha', genesisHash: '11'.repeat(32) }],
          deviceName: 'Synthetic phone',
          canPresent: () => foreground,
          notifyPending: (id: string) => {
            notices.push(id);
          },
          crypto,
          now,
          run: Effect.runPromise,
        };
        const phone = makeAutomaticPairingRuntime({ ...common, runtime: requestingRuntime });
        const desktop = makeAutomaticPairingRuntime({ ...common, runtime: approvingRuntime });
        try {
          expect((await phone.startAutomaticPairing('w1')).phase).toBe('preparing');
          if (action === 'background') {
            expect(await desktop.pendingAutomaticPairing()).toEqual([]);
            expect(await desktop.pendingAutomaticPairing()).toEqual([]);
            expect(notices).toHaveLength(1);
            expect((await phone.automaticPairingState('w1'))?.comparisonCode).toBeNull();
            foreground = true;
          }
          expect(await desktop.pendingAutomaticPairing()).toEqual([]);
          time = 5000;
          await phone.automaticPairingState('w1');
          expect(await desktop.pendingAutomaticPairing()).toEqual([]);
          await expect(phone.automaticPairingState('w1')).rejects.toThrow(
            'synthetic lost IPC reply'
          );
          if (action === 'old-host') {
            await expect(phone.automaticPairingState('w1')).rejects.toThrow(
              'e2ee_pairing-update-required'
            );
            expect(await desktop.pendingAutomaticPairing()).toEqual([]);
            expect(installed).toEqual([]);
            return;
          }
          const waiting = await phone.automaticPairingState('w1');
          expect(waiting?.phase).toBe('waiting');
          expect(requests.size).toBe(1);
          expect([...requests.values()][0]!.expiresAt).toBe(600_000);
          const reviews = await desktop.pendingAutomaticPairing();
          expect(reviews).toHaveLength(1);
          expect(reviews[0]!.comparisonCode).toBe(waiting!.comparisonCode);
          expect(reviews[0]!.workspaceId).toBe('w1');
          if (action === 'decline') {
            await desktop.declineAutomaticPairing(reviews[0]!.id);
            expect((await phone.automaticPairingState('w1'))?.phase).toBe('declined');
            expect(installed).toEqual([]);
            return;
          }
          if (action === 'cancel') {
            await phone.cancelAutomaticPairing('w1');
            expect(await desktop.pendingAutomaticPairing()).toEqual([]);
            expect(installed).toEqual([]);
            return;
          }
          if (action === 'expire') {
            time = 600_001;
            await expect(desktop.approveAutomaticPairing(reviews[0]!.id)).rejects.toThrow(
              'e2ee_pairing-expired'
            );
            expect((await phone.automaticPairingState('w1'))?.phase).toBe('expired');
            expect(installed).toEqual([]);
            return;
          }
          await expect(desktop.approveAutomaticPairing(reviews[0]!.id)).rejects.toThrow(
            'synthetic lost approval reply'
          );
          expect(await desktop.pendingAutomaticPairing()).toEqual([]);
          expect((await phone.automaticPairingState('w1'))?.phase).toBe('joined');
          expect(installed).toEqual([install]);
          expect(await desktop.pendingAutomaticPairing()).toEqual([]);
        } finally {
          phone.disposeAutomaticPairing();
          desktop.disposeAutomaticPairing();
        }
        return;
      }
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
      expect(installed).toEqual([install]);
    }
  );
});

describe('automatic device verification before account admission', () => {
  const context = {
    version: 1 as const,
    id: '11'.repeat(16),
    accountId: 'account-A',
    workspaceId: 'w1',
    genesisHash: '22'.repeat(32),
    deviceName: 'Synthetic phone',
    expiresAt: 1_900_000_000_000,
  };
  const create = (role: 'requester' | 'approver', start = context) =>
    Effect.runPromise(makeAutomaticPairingExchange({ role, context: start, crypto }));
  it('gives the phone and approving desktop the same code and secret only after the committed reveal', async () => {
    const phone = await create('requester'),
      desktop = await create('approver');
    try {
      await expect(
        Effect.runPromise(
          phone.finish({ publicKey: '04' + '00'.repeat(64), nonce: '00'.repeat(32) })
        )
      ).rejects.toThrow();
      const publicKey = await Effect.runPromise(phone.requestKey(desktop.commitment!));
      const reveal = await Effect.runPromise(desktop.reveal(publicKey));
      const a = await Effect.runPromise(phone.finish(reveal)),
        b = await Effect.runPromise(desktop.finish(publicKey));
      expect(a.comparisonCode).toMatch(/^\d{6}$/);
      expect(a.comparisonCode).toBe(b.comparisonCode);
      expect(a.secret).toEqual(b.secret);
      expect(a.secret).toHaveLength(16);
      phone.dispose();
      expect([...a.secret]).toEqual(Array(16).fill(0));
      await expect(Effect.runPromise(phone.requestKey(desktop.commitment!))).rejects.toThrow();
    } finally {
      phone.dispose();
      desktop.dispose();
    }
  });
  it.each(['accountId', 'workspaceId', 'genesisHash', 'deviceName', 'expiresAt'] as const)(
    'rejects a service rewriting the request %s',
    async (field) => {
      const changed = {
        ...context,
        [field]:
          field === 'expiresAt'
            ? context.expiresAt - 1
            : field === 'genesisHash'
              ? '33'.repeat(32)
              : 'different',
      };
      const phone = await create('requester'),
        desktop = await create('approver', changed);
      try {
        const key = await Effect.runPromise(phone.requestKey(desktop.commitment!));
        await expect(
          Effect.runPromise(phone.finish(await Effect.runPromise(desktop.reveal(key))))
        ).rejects.toThrow();
      } finally {
        phone.dispose();
        desktop.dispose();
      }
    }
  );
  it('freezes both peer originals and rejects responder substitution after the phone reveals its key', async () => {
    const phone = await create('requester'),
      a = await create('approver'),
      replacement = await create('approver');
    try {
      const key = await Effect.runPromise(phone.requestKey(a.commitment!));
      await expect(Effect.runPromise(phone.requestKey(replacement.commitment!))).rejects.toThrow();
      const reveal = await Effect.runPromise(a.reveal(key));
      await expect(
        Effect.runPromise(phone.finish({ ...reveal, nonce: 'ff'.repeat(32) }))
      ).rejects.toThrow();
      await expect(Effect.runPromise(a.reveal('04' + '11'.repeat(64)))).rejects.toThrow();
      const accepted = await Effect.runPromise(phone.finish(reveal));
      expect(accepted.secret).toEqual((await Effect.runPromise(a.finish(key))).secret);
    } finally {
      phone.dispose();
      a.dispose();
      replacement.dispose();
    }
  });
});
