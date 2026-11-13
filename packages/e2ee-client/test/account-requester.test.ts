import { Effect, Exit, Fiber, Result } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { accountUserId, hashRecordBytes } from '@lody/e2ee-core/protocol';
import { envelopeFixture } from '../../e2ee-core/test/keys/fixture';
import {
  makeAccountE2eeRuntime,
  makePortableAccountPairingApprover,
  makePortableAccountPairingRequester,
  type AccountPairingApproverSession,
  type AccountPairingIdentityHost,
  type AccountPairingKeyDeliveryEvent,
} from '../src/account-requester';

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

/** A real signed ledger: the owner's genesis, then the owner admitting a personal phone. */
function fixture() {
  const f = envelopeFixture(0, 100, Result.getOrThrow(accountUserId('acc1')).toBytes());
  const genesisHash = hex(f.context.genesis.toBytes());
  const page = {
    workspaceId: 'w1',
    genesisHash,
    checkpoint: { length: f.records().length, headHash: hex(f.view().head.toBytes()) },
    startIndex: 0,
    recordsHex: f.records().map(hex),
    position: 'opaque/final',
    nextCursor: null,
  };
  const [[membershipId]] = [...f.view().inspectState().members.entries()];
  const calls: { kind: string; value?: unknown }[] = [];
  let pending: { pairingSessionId: string } | null = null;
  const host: AccountPairingIdentityHost = {
    workspaceId: 'w1',
    genesisHash,
    prepareAccountIdentity: (pin) =>
      Effect.sync(() => {
        calls.push({ kind: 'prepare', value: pin });
        return {
          signingPublicKey: new Uint8Array(32).fill(1),
          encryptionPublicKey: new Uint8Array(32).fill(2),
          possessionProof: new Uint8Array(64).fill(3),
          credentialHash: new Uint8Array(32).fill(4),
        };
      }),
    pendingPersonalJoin: () => Effect.succeed(pending),
    acceptAccountInvitation: (value) =>
      Effect.sync(() => void calls.push({ kind: 'accept', value })),
    activate: () => Effect.sync(() => void calls.push({ kind: 'activate' })),
  };
  const requester = (accountId = 'acc1') =>
    makePortableAccountPairingRequester({
      workspaces: () => [{ workspaceId: 'w1', name: 'Alpha', genesisHash }],
      host: () => Effect.succeed(host),
      history: () => Effect.succeed(page),
      accountId,
    });
  return {
    f,
    calls,
    requester,
    membershipId: membershipId!,
    setPending: (value: typeof pending) => (pending = value),
  };
}

describe('portable account pairing requester', () => {
  it('proves possession for the membership the verified history gives this account', async () => {
    const { f, calls, requester, membershipId } = fixture();
    const [workspace] = await Effect.runPromise(requester()());
    await Effect.runPromise(workspace!.identity());
    expect(calls).toEqual([
      {
        kind: 'prepare',
        value: {
          genesisRecordHex: hex(f.genesisRecord),
          membershipId,
          // The same verified history, so the host can classify a revoked identity.
          history: [expect.objectContaining({ startIndex: 0, nextCursor: null })],
        },
      },
    ]);
    // Another account finds no membership and prepares nothing.
    const [other] = await Effect.runPromise(requester('acc2')());
    const refused = await Effect.runPromiseExit(other!.identity());
    expect(Exit.isFailure(refused)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('installs with the signer of the authenticated admission record as endorser, then activates', async () => {
    const { f, calls, requester, membershipId } = fixture();
    const [workspace] = await Effect.runPromise(requester()());
    const admission = f.records().at(-1)!;
    const recordHash = hashRecordBytes(admission).toBytes();
    await Effect.runPromise(workspace!.accept(new Uint8Array([9, 9]), recordHash));
    expect(calls).toEqual([
      {
        kind: 'accept',
        value: {
          invitationHex: '0909',
          endorser: hex(f.owner.raw),
          genesisRecordHex: hex(f.genesisRecord),
          membershipId,
          pairingSessionId: hex(recordHash).slice(0, 32),
        },
      },
      { kind: 'activate' },
    ]);
  });

  it('refuses a record hash missing from the verified history and an unrelated pending join', async () => {
    const { f, calls, requester, setPending } = fixture();
    const [workspace] = await Effect.runPromise(requester()());
    const missing = await Effect.runPromiseExit(
      workspace!.accept(new Uint8Array([1]), new Uint8Array(32).fill(7))
    );
    expect(Exit.isFailure(missing)).toBe(true);
    setPending({ pairingSessionId: 'aa'.repeat(16) });
    const blocked = await Effect.runPromiseExit(
      workspace!.accept(new Uint8Array([1]), hashRecordBytes(f.records().at(-1)!).toBytes())
    );
    expect(JSON.stringify(blocked)).toContain('pairing-journal-busy');
    expect(calls).toEqual([]);
  });

  it('reuses verified history from identity() and queries only incremental records on accept()', async () => {
    const f = envelopeFixture(0, 100, Result.getOrThrow(accountUserId('acc1')).toBytes());
    const genesisHash = hex(f.context.genesis.toBytes());
    const allRecords = f.records();
    const initialRecords = allRecords.slice(0, -1);
    const admission = allRecords.at(-1)!;
    const queries: { workspaceId: string; after?: string }[] = [];
    const req = makePortableAccountPairingRequester({
      workspaces: () => [{ workspaceId: 'w1', name: 'Alpha', genesisHash }],
      host: () =>
        Effect.succeed({
          workspaceId: 'w1',
          genesisHash,
          prepareAccountIdentity: () =>
            Effect.succeed({
              signingPublicKey: new Uint8Array(32).fill(1),
              encryptionPublicKey: new Uint8Array(32).fill(2),
              possessionProof: new Uint8Array(64).fill(3),
              credentialHash: new Uint8Array(32).fill(4),
            }),
          pendingPersonalJoin: () => Effect.succeed(null),
          acceptAccountInvitation: () => Effect.void,
          activate: () => Effect.void,
        }),
      history: (input) =>
        Effect.sync(() => {
          queries.push(input);
          if (input.after === 'pos-1') {
            return {
              workspaceId: 'w1',
              genesisHash,
              checkpoint: { length: allRecords.length, headHash: hex(f.view().head.toBytes()) },
              startIndex: initialRecords.length,
              recordsHex: [hex(admission)],
              position: 'pos-2',
              nextCursor: null,
            };
          }
          return {
            workspaceId: 'w1',
            genesisHash,
            checkpoint: {
              length: initialRecords.length,
              headHash: hex(hashRecordBytes(initialRecords.at(-1)!).toBytes()),
            },
            startIndex: 0,
            recordsHex: initialRecords.map(hex),
            position: 'pos-1',
            nextCursor: null,
          };
        }),
      accountId: 'acc1',
    });
    const [first] = await Effect.runPromise(req());
    await Effect.runPromise(first!.identity());
    const [second] = await Effect.runPromise(req());
    await Effect.runPromise(
      second!.accept(new Uint8Array([9, 9]), hashRecordBytes(admission).toBytes())
    );
    expect(queries).toEqual([{ workspaceId: 'w1' }, { workspaceId: 'w1', after: 'pos-1' }]);
  });

  it('merges explicit workspace hints when the requester list has not populated yet', async () => {
    const { f } = fixture();
    const genesisHash = hex(f.context.genesis.toBytes());
    const req = makePortableAccountPairingRequester({
      workspaces: () => [],
      host: (workspaceId) =>
        workspaceId === 'w1'
          ? Effect.succeed({
              workspaceId: 'w1',
              genesisHash,
              prepareAccountIdentity: () =>
                Effect.succeed({
                  signingPublicKey: new Uint8Array(32).fill(1),
                  encryptionPublicKey: new Uint8Array(32).fill(2),
                  possessionProof: new Uint8Array(64).fill(3),
                  credentialHash: new Uint8Array(32).fill(4),
                }),
              pendingPersonalJoin: () => Effect.succeed(null),
              acceptAccountInvitation: () => Effect.void,
            })
          : Effect.succeed(null),
      history: () =>
        Effect.succeed({
          workspaceId: 'w1',
          genesisHash,
          checkpoint: { length: f.records().length, headHash: hex(f.view().head.toBytes()) },
          startIndex: 0,
          recordsHex: f.records().map(hex),
          position: 'pos-1',
          nextCursor: null,
        }),
      accountId: 'acc1',
    });
    const withoutHints = await Effect.runPromise(req());
    expect(withoutHints).toEqual([]);
    const withHints = await Effect.runPromise(
      req([{ workspaceId: 'w1', name: 'Alpha', genesisHash }])
    );
    expect(withHints.map((item) => item.workspaceId)).toEqual(['w1']);
  });
});

describe('account-level runtime', () => {
  it('routes listed methods by workspace and advertises nothing else', async () => {
    const seen: string[] = [];
    const runtime = makeAccountE2eeRuntime({
      methods: ['status', 'preparePersonalJoin'],
      account: async () => null,
      runtimeFor: (workspaceId) =>
        workspaceId === 'w1'
          ? ({
              status: async (id: string) => (seen.push(`status:${id}`), { workspaceId: id }),
              preparePersonalJoin: async (offer: { workspaceId: string }) => (
                seen.push(`prepare:${offer.workspaceId}`),
                { pairingSessionId: 'p', signingPublicKey: 'k', status: 'pending' }
              ),
            } as never)
          : undefined,
    });
    await runtime.status!('w1');
    await runtime.preparePersonalJoin!({ workspaceId: 'w1' } as never);
    expect(seen).toEqual(['status:w1', 'prepare:w1']);
    await expect(runtime.status!('w2')).rejects.toMatchObject({ code: 'unsupported' });
    expect('revokeDevice' in runtime).toBe(false);
    expect('requestAccountPairing' in runtime).toBe(false);
  });
});

describe('portable account pairing approver key delivery', () => {
  /** An approving session whose mailbox never confirms an envelope for the new device. */
  const approverSession = (
    rounds: { count: number; released?: number },
    device = 1
  ): AccountPairingApproverSession => ({
    release: () =>
      Effect.sync(() => {
        rounds.released = (rounds.released ?? 0) + 1;
      }),
    binding: { device: { toBytes: () => new Uint8Array(32).fill(device) } },
    accountApproval: {
      sign: () => Effect.die('unused'),
      settle: () => Effect.succeed('committed' as const),
      invitation: () => Effect.succeed(null),
      access: () => Effect.succeed({ workspaceId: 'w1', credential: 'synthetic' }),
    },
    refresh: () => Effect.void,
    keyRound: () =>
      Effect.sync(() => {
        rounds.count += 1;
      }),
    keyDeliveryEvidence: () => Effect.succeed('e2ee_key_not_sent'),
  });
  const fixedRetry = (sleeps: number[]) => ({
    delays: [10, 20, 40],
    sleep: (ms: number) => Effect.sync(() => sleeps.push(ms)),
  });
  const deliver = async (
    sessions: (AccountPairingApproverSession | null)[],
    retry: typeof fixedRetry | null = fixedRetry
  ) => {
    const events: AccountPairingKeyDeliveryEvent[] = [];
    const sleeps: number[] = [];
    let ended: () => void = () => {};
    const done = new Promise<void>((resolve) => (ended = resolve));
    const first = sessions.shift()!;
    const workspaces = await Effect.runPromise(
      makePortableAccountPairingApprover({
        workspaces: () => [{ workspaceId: 'w1', name: 'Alpha', genesisHash: '11'.repeat(32) }],
        session: () => Effect.succeed(events.length === 0 ? first : (sessions.shift() ?? null)),
        appendRecord: () => Effect.void,
        onKeyDelivery: (event) => {
          events.push(event);
          if (event.state === 'ended' || event.state === 'delivered') ended();
        },
        ...(retry ? { keyDeliveryRetry: retry(sleeps) } : {}),
      })()
    );
    await Effect.runPromise(workspaces[0]!.deliverKeys!(new Uint8Array(32).fill(2), 'r1'));
    await done;
    return { events, sleeps };
  };

  it('stops a delivery that never reaches the mailbox after its retry bound', async () => {
    const rounds = { count: 0, released: 0 };
    const session = approverSession(rounds);
    const { events, sleeps } = await deliver([session, session, session, session]);
    expect(rounds.count).toBe(4);
    // Every attempt released the session it held: no reader stays open in the backoff.
    expect(rounds.released).toBe(4);
    expect(sleeps).toEqual([10, 20, 40]);
    expect(events.map((event) => event.state)).toEqual([
      'running',
      'retrying',
      'retrying',
      'retrying',
      'ended',
    ]);
    expect(events.at(-1)!.code).toBe('e2ee_key_not_sent');
  });

  it('catches up with the ledger before retrying a delivery the mailbox refused as stale', async () => {
    const rounds = { count: 0 };
    let ledgerCurrent = false;
    const session = {
      ...approverSession(rounds),
      refresh: () =>
        Effect.sync(() => {
          ledgerCurrent = true;
        }),
      keyDeliveryEvidence: () =>
        Effect.succeed(ledgerCurrent ? ('delivered' as const) : ('e2ee_key_not_sent' as const)),
    };
    const { events } = await deliver([session, session]);
    expect(events.at(-1)!.state).toBe('delivered');
    expect(rounds.count).toBe(2);
  });

  it('still retries the round when the ledger catch-up fails', async () => {
    const rounds = { count: 0 };
    const session = { ...approverSession(rounds), refresh: () => Effect.fail('offline') };
    const { events } = await deliver([session, session, session, session]);
    expect(rounds.count).toBe(4);
    expect(events.at(-1)!.code).toBe('e2ee_key_not_sent');
  });

  it('continues the retries with the default schedule when a ledger catch-up hangs', async () => {
    vi.useFakeTimers();
    try {
      const rounds = { count: 0, released: 0 };
      let cancelled = 0;
      const session = {
        ...approverSession(rounds),
        refresh: () =>
          Effect.never.pipe(
            Effect.onInterrupt(() =>
              Effect.sync(() => {
                cancelled += 1;
              })
            )
          ),
      };
      const delivered = deliver(
        Array.from({ length: 9 }, () => session),
        null
      );
      await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
      const { events } = await delivered;
      expect(rounds.count).toBe(9);
      expect(rounds.released).toBe(9);
      expect(cancelled).toBe(8);
      expect(events.at(-1)!.state).toBe('ended');
    } finally {
      vi.useRealTimers();
    }
  });

  it('ends without another round once the approving session is no longer available to the account', async () => {
    const rounds = { count: 0 };
    const { events } = await deliver([approverSession(rounds), null]);
    expect(rounds.count).toBe(1);
    expect(events.map((event) => [event.state, event.code])).toEqual([
      ['running', undefined],
      ['retrying', 'e2ee_key_not_sent'],
      ['ended', 'e2ee_key_delivery_closed'],
    ]);
  });

  it("never continues on another account's session for the same workspace", async () => {
    // Account A's first delivery fails; during the backoff account B signs in and opens
    // the same workspace, so the lookup now returns B's session (B's own device).
    const original = { count: 0, released: 0 };
    const other = { count: 0, released: 0 };
    const otherSession = approverSession(other, 9);
    let evidenceAsked = false;
    const { events } = await deliver([
      approverSession(original),
      {
        ...otherSession,
        keyDeliveryEvidence: (device) => {
          evidenceAsked = true;
          return otherSession.keyDeliveryEvidence(device);
        },
      },
    ]);
    expect(original.count).toBe(1);
    expect(other.count).toBe(0);
    // The foreign session is released without any other call.
    expect([original.released, other.released]).toEqual([1, 1]);
    expect(evidenceAsked).toBe(false);
    expect(events.map((event) => [event.state, event.code])).toEqual([
      ['running', undefined],
      ['retrying', 'e2ee_key_not_sent'],
      ['ended', 'e2ee_key_delivery_owner_changed'],
    ]);
  });

  it('releases the sessions it already opened when a later workspace fails to list', async () => {
    const rounds = { count: 0, released: 0 };
    const exit = await Effect.runPromiseExit(
      makePortableAccountPairingApprover({
        workspaces: () => [
          { workspaceId: 'w1', name: 'Alpha', genesisHash: '11'.repeat(32) },
          { workspaceId: 'w2', name: 'Beta', genesisHash: '22'.repeat(32) },
        ],
        session: (workspaceId) =>
          workspaceId === 'w1'
            ? Effect.succeed(approverSession(rounds))
            : Effect.fail(new Error('synthetic approval session failure')),
        appendRecord: () => Effect.void,
      })()
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(rounds.released).toBe(1);
  });

  it('reports a failed release of a delivery session instead of dropping it', async () => {
    const rounds = { count: 0 };
    const failure = new Error('synthetic close failure');
    const reported: [string, unknown][] = [];
    let ended: () => void = () => {};
    const done = new Promise<void>((resolve) => (ended = resolve));
    const session = {
      ...approverSession(rounds),
      keyDeliveryEvidence: () => Effect.succeed('delivered'),
      release: () => Effect.fail(failure),
    };
    const [workspace] = await Effect.runPromise(
      makePortableAccountPairingApprover({
        workspaces: () => [{ workspaceId: 'w1', name: 'Alpha', genesisHash: '11'.repeat(32) }],
        session: () => Effect.succeed(session),
        appendRecord: () => Effect.void,
        onKeyDelivery: (event) => {
          if (event.state === 'delivered' || event.state === 'ended') ended();
        },
        diagnostics: (scope, cause) => reported.push([scope, cause]),
      })()
    );
    await Effect.runPromise(workspace!.deliverKeys!(new Uint8Array(32).fill(2), 'r1'));
    await done;
    expect(reported).toEqual([['account-pairing-key-delivery-release', failure]]);
    // The workflow's own release reaches it as a failure to record, not a success.
    expect(Exit.isFailure(await Effect.runPromiseExit(workspace!.release!()))).toBe(true);
  });

  it('releases the sessions it already opened when listing is interrupted', async () => {
    const rounds = { count: 0, released: 0 };
    let opened: () => void = () => {};
    const firstOpened = new Promise<void>((resolve) => (opened = resolve));
    const listing = makePortableAccountPairingApprover({
      workspaces: () => [
        { workspaceId: 'w1', name: 'Alpha', genesisHash: '11'.repeat(32) },
        { workspaceId: 'w2', name: 'Beta', genesisHash: '22'.repeat(32) },
      ],
      // The second lookup never settles: a page cancellation interrupts the listing.
      session: (workspaceId) =>
        workspaceId === 'w1'
          ? Effect.sync(() => {
              opened();
              return approverSession(rounds);
            })
          : Effect.never,
      appendRecord: () => Effect.void,
    })();
    const fiber = Effect.runFork(listing);
    await firstOpened;
    await Effect.runPromise(Fiber.interrupt(fiber));
    expect(rounds.released).toBe(1);
  });

  it('opens only workspaces matching the approver filter', async () => {
    const opened: string[] = [];
    const rounds = { count: 0, released: 0 };
    const workspaces = await Effect.runPromise(
      makePortableAccountPairingApprover({
        workspaces: () => [
          { workspaceId: 'w1', name: 'Alpha', genesisHash: '11'.repeat(32) },
          { workspaceId: 'w2', name: 'Beta', genesisHash: '22'.repeat(32) },
        ],
        session: (workspaceId) =>
          Effect.sync(() => {
            opened.push(workspaceId);
            return approverSession(rounds);
          }),
        appendRecord: () => Effect.void,
      })({ geneses: new Set(['22'.repeat(32)]), workspaceIds: new Set(['w2']) })
    );
    expect(opened).toEqual(['w2']);
    expect(workspaces.map((item) => item.workspaceId)).toEqual(['w2']);
    await Effect.runPromise(workspaces[0]!.release!());
    expect(rounds.released).toBe(1);
  });
});
