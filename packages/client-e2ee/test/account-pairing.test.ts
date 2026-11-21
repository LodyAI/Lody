import 'fake-indexeddb/auto';
import { expect, it } from 'vitest';
import { Cause, Effect, Exit, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { getFunctionName } from 'convex/server';
import { accountPairingErrorCode } from '@lody/platform';
import {
  makePersonalCloudAccountPairingPorts,
  makePersonalCloudAccountPairingRelay,
  makePersonalAccountPairingStore,
} from '../src/account-pairing';
import type { PersonalCloudConnection } from '../src/network';

const lookupId = 'ab'.repeat(16);
const genesisHash = '11'.repeat(32);
function relayOver(work: (name: string, args: unknown) => Promise<unknown>) {
  const invoke = (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
    work(getFunctionName(ref), args);
  const client = {
    query: invoke,
    mutation: invoke,
    action: invoke,
  } as unknown as PersonalCloudConnection['client'];
  return makePersonalCloudAccountPairingRelay({
    client,
    currentAccount: () => Effect.succeed('account-A'),
  });
}
const failure = async (work: Effect.Effect<unknown, unknown>) => {
  const exit = await Effect.runPromiseExit(work);
  if (Exit.isSuccess(exit)) throw new Error('expected a failure');
  return Cause.squash(exit.cause);
};
const submission = {
  lookupId,
  requestHex: 'aa',
  requestTagHex: 'bb',
  direction: 'requester-shows' as const,
  deviceName: 'Lody mobile',
  expiresAt: 2,
  workspaces: [{ workspaceId: 'workspace-A', genesisHash }],
};

it.each([
  ['e2ee_account_pairing_disabled', 'pairing-unavailable'],
  ['e2ee_account_pairing_rate_limited', 'pairing-rate-limited'],
] as const)(
  'the new device explains the service refusal %s as %s instead of a retryable failure',
  async (server, code) => {
    const relay = relayOver(async () => {
      throw Object.assign(new Error('synthetic-private-cause'), { data: { code: server } });
    });
    const error = await failure(relay.submit(submission));
    expect(accountPairingErrorCode(error)).toBe(code);
    expect(String(error)).not.toContain('synthetic-private-cause');
  }
);

it('an unknown service failure stays the generic retryable relay failure', async () => {
  const relay = relayOver(async () => {
    throw Object.assign(new Error('synthetic-private-cause'), {
      data: { code: 'e2ee_account_pairing_incomplete' },
    });
  });
  const error = await failure(relay.claim(lookupId));
  expect(accountPairingErrorCode(error)).toBeNull();
  expect(String(error)).toContain('e2ee_pairing_relay_failed');
});

function portsOver(
  work: (name: string, args: unknown) => Promise<unknown>,
  account: () => string | null,
  runExit?: Parameters<typeof makePersonalCloudAccountPairingPorts>[0]['runExit']
) {
  const invoke = (ref: Parameters<typeof getFunctionName>[0], args: unknown) =>
    work(getFunctionName(ref), args);
  const client = {
    query: invoke,
    mutation: invoke,
    action: invoke,
  } as unknown as PersonalCloudConnection['client'];
  return makePersonalCloudAccountPairingPorts({
    client,
    currentAccount: () => Effect.sync(account),
    ...(runExit ? { runExit } : {}),
  });
}

it('a signed-out app sends no pairing append, workspace list or history call', async () => {
  const calls: string[] = [];
  const ports = portsOver(
    async (name) => {
      calls.push(name);
      return null;
    },
    () => null
  );
  const appended = ports.appendRecord({
    workspaceId: 'workspace-A',
    requestId: 'request-A',
    recordHex: 'aa',
    credentialHash: '11'.repeat(32),
  });
  await expect(appended).rejects.toThrow('e2ee_pairing_relay_failed');
  await expect(ports.requester.workspaces()).rejects.toThrow('e2ee_pairing_relay_failed');
  await expect(ports.requester.history({ workspaceId: 'workspace-A' })).rejects.toThrow(
    'e2ee_pairing_relay_failed'
  );
  expect(calls).toEqual([]);
});

it.each(['workspaces', 'history'] as const)(
  'an unanswered %s call fails as retryable at its bound instead of holding pairing',
  async (operation) => {
    const clock = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
    try {
      await clock.context();
      let entered!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      const ports = portsOver(
        () => {
          entered();
          return new Promise(() => {});
        },
        () => 'account-A',
        (effect) => clock.runPromiseExit(effect)
      );
      const listing = (
        operation === 'workspaces'
          ? ports.requester.workspaces()
          : ports.requester.history({ workspaceId: 'workspace-A' })
      ).then(
        () => null,
        (error: unknown) => error
      );
      await started;
      await clock.runPromise(TestClock.adjust(30_000));
      const error = await listing;
      expect(String(error)).toContain('e2ee_pairing_relay_failed');
      expect(accountPairingErrorCode(error)).toBeNull();
    } finally {
      await clock.dispose();
    }
  }
);

// Exercise the private cloud adapter and the real portable requester/workflow together.
// The old relay-only fixtures never returned the backend's ledgerCapacity field.
async function historyPairingFixture() {
  const { Result } = await import('effect');
  const { accountUserId, hashRecordBytes } = await import('@lody/e2ee-core/protocol');
  const { envelopeFixture } = await import('../../../packages/e2ee-core/test/keys/fixture');
  const { makePortableAccountPairingRequester } =
    await import('@lody/e2ee-client/account-requester');
  const { makeAccountPairing } = await import('@lody/e2ee-client/account-pairing');
  const { verifyPersonalHistory } = await import('@lody/e2ee-client/history');
  const signed = envelopeFixture(0, 100, Result.getOrThrow(accountUserId('acc1')).toBytes());
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
  const genesisHash = hex(signed.context.genesis.toBytes());
  const records = signed.records().map(hex);
  const page = {
    workspaceId: 'workspace-A',
    genesisHash,
    checkpoint: { length: records.length, headHash: hex(signed.view().head.toBytes()) },
    startIndex: 0,
    recordsHex: records,
    position: 'opaque/final',
    nextCursor: null,
    ledgerCapacity: {
      limitBytes: 33554432,
      observedBytes: 1,
      observedLength: records.length,
      nearLimit: false,
    },
  };
  let reply: unknown = page;
  let networkFailure: Error | undefined;
  let submitFailure: Error | undefined;
  const submissions: unknown[] = [];
  const ports = portsOver(
    async (name, args) => {
      if (name === 'e2eeWorkspaces:history') {
        if (networkFailure) throw networkFailure;
        return typeof reply === 'function' ? reply(args) : reply;
      }
      if (name === 'e2eeMembers:workspaces')
        return [{ id: 'workspace-A', name: 'Alpha', genesisHash }];
      if (name === 'e2eeAccountPairing:submit') {
        submissions.push(structuredClone(args));
        if (submitFailure) throw submitFailure;
        return {
          requestId: 'request-A',
          status: 'pending',
          deviceName: 'Phone',
          approximateLocation: null,
          requestedAt: 0,
          expiresAt: 600000,
        };
      }
      if (name === 'e2eeAccountPairing:claim') return null;
      throw new Error('unexpected fixture operation');
    },
    () => 'acc1'
  );
  const identity = {
    signingPublicKey: new Uint8Array(32).fill(1),
    encryptionPublicKey: new Uint8Array(32).fill(2),
    possessionProof: new Uint8Array(64).fill(3),
    credentialHash: new Uint8Array(32).fill(4),
  };
  let prepared: unknown;
  let accepted: unknown;
  const verify = (pages: unknown) =>
    verifyPersonalHistory(
      {
        workspaceId: page.workspaceId,
        genesisHash,
        genesisRecordHex: records[0]!,
      },
      pages
    );
  const requester = makePortableAccountPairingRequester({
    accountId: 'acc1',
    workspaces: () => [{ workspaceId: page.workspaceId, name: 'Alpha', genesisHash }],
    history: (request) =>
      Effect.tryPromise({ try: () => ports.requester.history(request), catch: (cause) => cause }),
    host: () =>
      Effect.succeed({
        workspaceId: page.workspaceId,
        genesisHash,
        // The host independently verifies the supplied pages before retaining originals.
        prepareAccountIdentity: (pin) =>
          verify(pin.history).pipe(
            Effect.map(() => {
              prepared ??= structuredClone(pin);
              return identity;
            })
          ),
        pendingPersonalJoin: () => Effect.succeed(null),
        acceptAccountHistory: (input) =>
          verify(input.pages).pipe(
            Effect.map(() => {
              accepted = structuredClone(input);
            })
          ),
        acceptAccountInvitation: (input) =>
          Effect.sync(() => {
            accepted = structuredClone(input);
          }),
      }),
  });
  const store = makePersonalAccountPairingStore('synthetic-' + crypto.randomUUID());
  const workflow = makeAccountPairing({
    store,
    account: 'acc1',
    deviceName: 'Phone',
    relay: ports.relay,
    requesterWorkspaces: requester,
    approverWorkspaces: () => Effect.succeed([]),
    now: () => 0,
  });
  return {
    page,
    ports,
    workflow,
    store,
    requester,
    submissions,
    identity,
    admission: hashRecordBytes(signed.records().at(-1)!).toBytes(),
    prepared: () => prepared,
    accepted: () => accepted,
    reply: (value: unknown) => {
      reply = value;
    },
    offline: (error?: Error) => {
      networkFailure = error;
    },
    failSubmit: (error?: Error) => {
      submitFailure = error;
    },
  };
}

it('a backend history page with capacity metadata prepares and submits the phone pairing request', async () => {
  const f = await historyPairingFixture();
  try {
    const state = await Effect.runPromise(f.workflow.requestAccountPairing({}));
    expect(state).toMatchObject({
      status: 'waiting',
      workspaces: [{ workspaceId: 'workspace-A', state: 'pending' }],
    });
    expect(f.prepared()).toMatchObject({ history: [{ recordsHex: f.page.recordsHex }] });
    expect(f.submissions).toHaveLength(1);
    const normalized = await f.ports.requester.history({ workspaceId: 'workspace-A' });
    expect(normalized).not.toHaveProperty('ledgerCapacity');
    expect(normalized.recordsHex).toEqual(f.page.recordsHex);
  } finally {
    f.store.close();
  }
});

it('capacity metadata lets the verified requester route history and invitation approvals', async () => {
  const f = await historyPairingFixture();
  try {
    const [workspace] = await Effect.runPromise(f.requester());
    await Effect.runPromise(workspace!.identity());
    await Effect.runPromise(workspace!.acceptHistory!(f.admission));
    const original = structuredClone(f.accepted());
    expect(original).toMatchObject({ pages: [{ recordsHex: f.page.recordsHex }] });
    await Effect.runPromise(workspace!.accept(new Uint8Array([9]), f.admission));
    expect(f.accepted()).toMatchObject({
      invitationHex: '09',
      genesisRecordHex: f.page.recordsHex[0],
    });
    expect(await Effect.runPromise(workspace!.identity())).toEqual(f.identity);
  } finally {
    f.store.close();
  }
});

it('a failed history read recovers without losing its cause or replacing a journaled pairing request', async () => {
  const f = await historyPairingFixture();
  try {
    const offline = new Error('synthetic-offline');
    f.offline(offline);
    await expect(f.ports.requester.history({ workspaceId: 'workspace-A' })).rejects.toBe(offline);
    expect(Exit.isFailure(await Effect.runPromiseExit(f.workflow.requestAccountPairing({})))).toBe(
      true
    );
    expect(await Effect.runPromise(f.store.latestRequest())).toBeNull();
    f.offline();
    f.failSubmit(offline);
    expect(Exit.isFailure(await Effect.runPromiseExit(f.workflow.requestAccountPairing({})))).toBe(
      true
    );
    const original = await Effect.runPromise(f.store.latestRequest());
    expect(original).not.toBeNull();
    f.failSubmit();
    const state = await Effect.runPromise(f.workflow.requestAccountPairing({}));
    expect(state.lookupId).toBe(original!.lookupId);
    expect(f.submissions[1]).toEqual(f.submissions[0]);
    expect(await Effect.runPromise(f.store.latestRequest())).toEqual(original);
    await Effect.runPromise(f.store.addJoined(original!.lookupId, 'workspace-A'));
    await Effect.runPromise(f.store.settle(original!.lookupId, 'requester', 'approved', 0));
    f.offline(offline);
    expect(await Effect.runPromise(f.workflow.accountPairingRequest())).toMatchObject({
      lookupId: original!.lookupId,
      status: 'joined',
      workspaces: [{ state: 'joined' }],
    });
    expect(await Effect.runPromise(f.store.latestRequest())).toEqual(original);
  } finally {
    f.store.close();
  }
});

it('capacity normalization never authorizes mismatched scope, incomplete history or tampered signatures', async () => {
  const f = await historyPairingFixture();
  try {
    const [workspace] = await Effect.runPromise(f.requester());
    const { hashRecordBytes } = await import('@lody/e2ee-core/protocol');
    const damaged = Buffer.from(f.page.recordsHex.at(-1)!, 'hex');
    damaged[damaged.length - 1] ^= 1;
    for (const invalid of [
      { ...f.page, workspaceId: 'foreign' },
      { ...f.page, genesisHash: 'ff'.repeat(32) },
      { ...f.page, startIndex: 1 },
      { ...f.page, checkpoint: { ...f.page.checkpoint, length: f.page.checkpoint.length + 1 } },
      { ...f.page, recordsHex: [...f.page.recordsHex.slice(0, -1), '00'] },
      {
        ...f.page,
        recordsHex: [...f.page.recordsHex.slice(0, -1), damaged.toString('hex')],
        // Match the tampered endpoint: rejection must still depend on signed history.
        checkpoint: {
          ...f.page.checkpoint,
          headHash: Buffer.from(hashRecordBytes(damaged).toBytes()).toString('hex'),
        },
      },
    ]) {
      f.reply(invalid);
      expect(Exit.isFailure(await Effect.runPromiseExit(workspace!.identity()))).toBe(true);
      expect(
        Exit.isFailure(await Effect.runPromiseExit(workspace!.acceptHistory!(f.admission)))
      ).toBe(true);
      expect(f.prepared()).toBeUndefined();
      expect(f.accepted()).toBeUndefined();
    }
    f.reply(f.page);
    expect(await Effect.runPromise(workspace!.identity())).toEqual(f.identity);
  } finally {
    f.store.close();
  }
});

it('a slow multi-page backend history remains usable and pins each suffix request to the first checkpoint', async () => {
  const f = await historyPairingFixture();
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const requests: unknown[] = [];
  f.reply(async (request: { cursor?: string; checkpoint?: unknown }) => {
    requests.push(structuredClone(request));
    if (!request.cursor) {
      entered();
      await paused;
      return { ...f.page, recordsHex: f.page.recordsHex.slice(0, 1), nextCursor: 'suffix' };
    }
    return { ...f.page, startIndex: 1, recordsHex: f.page.recordsHex.slice(1) };
  });
  try {
    const preparing = Effect.runPromise(f.workflow.requestAccountPairing({}));
    await started;
    expect(await Effect.runPromise(f.store.latestRequest())).toBeNull();
    release();
    expect(await preparing).toMatchObject({ status: 'waiting' });
    expect(requests).toEqual([
      { workspaceId: 'workspace-A' },
      { workspaceId: 'workspace-A', cursor: 'suffix', checkpoint: f.page.checkpoint },
    ]);
    expect(f.prepared()).toMatchObject({ history: [{ startIndex: 0 }, { startIndex: 1 }] });
  } finally {
    release();
    f.store.close();
  }
});
