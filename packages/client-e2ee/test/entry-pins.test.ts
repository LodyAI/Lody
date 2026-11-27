import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Effect, Layer, Result } from 'effect';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { Bytes, signGenesisRecord } from '@lody/e2ee-core/protocol';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import { makePersonalWorkspaceRuntime, type PersonalPairingOffer } from '@lody/e2ee-client';
import { createStore, type PlatformSessionState } from '@lody/platform';
import { personalEntry } from '../src/entry';
import { personalEntryPins } from '../src/entry-pins';

vi.mock('@lody/e2ee-client', async (original) => ({
  ...(await original<typeof import('@lody/e2ee-client')>()),
  makePersonalWorkspaceRuntime: vi.fn(),
}));
afterEach(() => vi.mocked(makePersonalWorkspaceRuntime).mockReset());
const signedIn = (id: string): PlatformSessionState => ({
  status: 'authenticated',
  user: { id, name: id, email: 'a@example.test', image: null },
});

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => {
  vi.unstubAllGlobals();
});
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
/** A verifiable synthetic personal offer for one workspace. */
const offerFor = (workspaceId: string, seed: number) =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const device = yield* importBrowserDevice({
          signingPrivate: new Uint8Array(32).fill(seed),
          encryptionPrivate: new Uint8Array(32).fill(seed + 1),
        });
        const signed = yield* signGenesisRecord({
          signer: device,
          encryptionPublicKey: device.enc,
          initialKey: Result.getOrThrow(Bytes.epochKey(new Uint8Array(32).fill(seed + 2))),
          membershipId: Result.getOrThrow(Bytes.membershipId(new Uint8Array(16).fill(seed))),
          userId: Result.getOrThrow(Bytes.userId(new Uint8Array(32).fill(8))),
        });
        return {
          version: 1,
          workspaceId,
          genesisHash: hex(signed.genesis.toBytes()),
          genesisRecordHex: hex(signed.record),
          endorser: hex(device.publicKey.toBytes()),
          membershipId: hex(new Uint8Array(16).fill(seed)),
          pairingSessionId: hex(new Uint8Array(16).fill(seed + 3)),
        } satisfies PersonalPairingOffer;
      })
    )
  );

it('an approving device finds every workspace it is ready in for the signed-in account, and only those', async () => {
  const pins = personalEntryPins('lody-e2ee:web:v1:entry-pins');
  const run = <A>(work: Effect.Effect<A, unknown>) => Effect.runPromise(work);
  const [w1, w2, pending, cancelled, other] = await Promise.all([
    offerFor('workspace-1', 10),
    offerFor('workspace-2', 20),
    offerFor('workspace-3', 30),
    offerFor('workspace-4', 40),
    offerFor('workspace-5', 50),
  ]);
  for (const offer of [w1, w2, pending, cancelled]) await run(pins.prepare('account-A', offer));
  await run(pins.finish('account-A', w1, 'ready'));
  await run(pins.finish('account-A', w2, 'ready'));
  await run(pins.finish('account-A', cancelled, 'cancelled'));
  await run(pins.prepare('account-B', other));
  await run(pins.finish('account-B', other, 'ready'));

  const ready = await run(pins.listReady('account-A'));
  expect(ready.map((pin) => pin.offer.workspaceId).sort()).toEqual(['workspace-1', 'workspace-2']);
  expect(ready.find((pin) => pin.offer.workspaceId === 'workspace-2')?.offer).toEqual(w2);
  await expect(run(pins.listReady('account-C'))).resolves.toEqual([]);
});

it.each(['authenticated', 'unauthenticated', 'switched'] as const)(
  'recordCreated waits for cold session resolution and handles %s',
  async (outcome) => {
    const session = createStore<PlatformSessionState>({ status: 'loading' });
    const pins = personalEntryPins('creation-pins');
    const offer = await offerFor('workspace-A', 10);
    const owner = personalEntry({
      run: Effect.runPromise,
      pins,
      ports: () => Layer.effectContext(Effect.die('must not acquire a host')),
      ledgerRecords: () => () => Effect.succeed([]),
      recordCreated: async ({ accountId, workspaceId, genesisHash }) => {
        expect({ workspaceId, genesisHash }).toEqual({
          workspaceId: offer.workspaceId,
          genesisHash: offer.genesisHash,
        });
        await Effect.runPromise(pins.prepare(accountId, offer));
        await Effect.runPromise(pins.finish(accountId, offer, 'ready'));
        if (outcome === 'switched') session.set(signedIn('account-B'));
      },
    });
    try {
      const runtime = owner.createRuntime({ session })!;
      const recording = runtime.recordCreated!({
        workspaceId: offer.workspaceId,
        genesisHash: offer.genesisHash,
      });
      const settled = recording.then(
        () => null,
        (error: unknown) => error
      );
      expect(await Effect.runPromise(pins.read('account-A', offer.workspaceId))).toBeNull();
      session.set(
        outcome === 'unauthenticated' ? { status: 'unauthenticated' } : signedIn('account-A')
      );
      if (outcome === 'authenticated') expect(await settled).toBeNull();
      else expect(await settled).toMatchObject({ code: 'scope-mismatch' });
      expect((await Effect.runPromise(pins.read('account-A', offer.workspaceId)))?.phase).toBe(
        outcome === 'unauthenticated' ? undefined : 'ready'
      );
      expect(await Effect.runPromise(pins.read('account-B', offer.workspaceId))).toBeNull();
    } finally {
      await owner.close();
    }
  }
);

it('forwards recovery-only confirmation to the runtime before removing the last device', async () => {
  const session = createStore<PlatformSessionState>(signedIn('account-A'));
  const pins = personalEntryPins('revoke-pins');
  const offer = await offerFor('workspace-A', 10);
  await Effect.runPromise(pins.prepare('account-A', offer));
  await Effect.runPromise(pins.finish('account-A', offer, 'ready'));
  const devices = new Set([offer.endorser]);
  vi.mocked(makePersonalWorkspaceRuntime).mockReturnValue(
    Effect.succeed({
      revokeDevice: async (
        id: string,
        device: string,
        confirmation?: { confirmedRecoveryOnly: true }
      ) => {
        expect(id).toBe(offer.workspaceId);
        if (confirmation?.confirmedRecoveryOnly !== true) throw new Error('confirmation required');
        devices.delete(device);
      },
    } as unknown as Effect.Success<ReturnType<typeof makePersonalWorkspaceRuntime>>)
  );
  const owner = personalEntry({
    run: Effect.runPromise,
    pins,
    ports: () => Layer.effectContext(Effect.die('synthetic runtime owns the device')),
    ledgerRecords: () => () => Effect.succeed([]),
  });
  try {
    const runtime = owner.createRuntime({ session })!;
    await expect(runtime.revokeDevice!(offer.workspaceId, offer.endorser)).rejects.toThrow(
      'confirmation required'
    );
    expect(devices.size).toBe(1);
    await runtime.revokeDevice!(offer.workspaceId, offer.endorser, { confirmedRecoveryOnly: true });
    expect(devices.size).toBe(0);
  } finally {
    await owner.close();
  }
});

it('claimMemberJoin retains the open reader after admission so retries skip claim and reopen', async () => {
  const pins = personalEntryPins('member-join-retry-pins');
  const offer = await offerFor('ws-join-retry', 21);
  await Effect.runPromise(pins.prepare('acc-1', offer, 'member'));
  const session = createStore<PlatformSessionState>(signedIn('acc-1'));
  let claims = 0;
  let opens = 0;
  let refreshes = 0;
  let closes = 0;
  let keyArrived = false;
  vi.mocked(makePersonalWorkspaceRuntime).mockReturnValue(
    Effect.succeed({
      claimMemberJoin: async () => {
        claims++;
        return { ready: false, state: 'committed' as const };
      },
      open: async (_id: string, _obs: unknown, _acc: unknown, readerOwner?: string) => {
        opens++;
        return {
          workspaceId: offer.workspaceId,
          genesisHash: offer.genesisHash,
          signingPublicKey: '00'.repeat(32),
          epoch: 0,
          hasCurrentKey: false,
          memberRole: 'member' as const,
          deviceKind: 'personal' as const,
          readerOwner: readerOwner ?? 'r1',
        };
      },
      refresh: async () => {
        refreshes++;
        return {
          workspaceId: offer.workspaceId,
          genesisHash: offer.genesisHash,
          signingPublicKey: '00'.repeat(32),
          epoch: 0,
          hasCurrentKey: keyArrived,
          memberRole: 'member' as const,
          deviceKind: 'personal' as const,
        };
      },
      close: async () => {
        closes++;
      },
    } as unknown as Effect.Success<ReturnType<typeof makePersonalWorkspaceRuntime>>)
  );
  const owner = personalEntry({
    run: Effect.runPromise,
    pins,
    ports: () => Layer.effectContext(Effect.die('synthetic runtime owns the device')),
    ledgerRecords: () => () => Effect.succeed([]),
  });
  try {
    const runtime = owner.createRuntime({ session })!;
    expect(await runtime.claimMemberJoin!(offer.workspaceId, offer.pairingSessionId)).toEqual({
      ready: false,
      state: 'committed',
    });
    expect((await Effect.runPromise(pins.read('acc-1', offer.workspaceId)))?.phase).toBe('ready');
    expect({ claims, opens, refreshes, closes }).toEqual({
      claims: 1,
      opens: 1,
      refreshes: 1,
      closes: 0,
    });

    expect(await runtime.claimMemberJoin!(offer.workspaceId, offer.pairingSessionId)).toEqual({
      ready: false,
      state: 'committed',
    });
    expect({ claims, opens, refreshes, closes }).toEqual({
      claims: 1,
      opens: 1,
      refreshes: 2,
      closes: 0,
    });

    keyArrived = true;
    expect(await runtime.claimMemberJoin!(offer.workspaceId, offer.pairingSessionId)).toEqual({
      ready: true,
      state: 'committed',
    });
    expect({ claims, opens, refreshes, closes }).toEqual({
      claims: 1,
      opens: 1,
      refreshes: 3,
      closes: 1,
    });
  } finally {
    await owner.close();
  }
});

it('retires stale entry.offer when another tab replaces a cancelled offer before claimPersonalJoin', async () => {
  const pins = personalEntryPins('cross-tab-offer-replace-pins');
  const offer1 = await offerFor('ws-cross-tab', 31);
  const offer2: PersonalPairingOffer = {
    ...offer1,
    pairingSessionId: '44'.repeat(16),
  };
  await Effect.runPromise(pins.prepare('acc-1', offer1));
  const session = createStore<PlatformSessionState>(signedIn('acc-1'));
  let claimCount = 0;
  vi.mocked(makePersonalWorkspaceRuntime).mockImplementation(() =>
    Effect.succeed({
      claimPersonalJoin: async (_id: string, pairingId: string) => {
        claimCount++;
        return {
          ready: pairingId === offer2.pairingSessionId,
          status:
            pairingId === offer2.pairingSessionId ? ('approved' as const) : ('pending' as const),
        };
      },
    } as unknown as Effect.Success<ReturnType<typeof makePersonalWorkspaceRuntime>>)
  );
  const owner = personalEntry({
    run: Effect.runPromise,
    pins,
    ports: () => Layer.effectContext(Effect.die('synthetic runtime owns the device')),
    ledgerRecords: () => () => Effect.succeed([]),
  });
  try {
    const runtime = owner.createRuntime({ session })!;
    expect(await runtime.claimPersonalJoin!(offer1.workspaceId, offer1.pairingSessionId)).toEqual({
      ready: false,
      status: 'pending',
    });

    await Effect.runPromise(pins.finish('acc-1', offer1, 'cancelled'));
    await Effect.runPromise(pins.prepare('acc-1', offer2));

    expect(await runtime.claimPersonalJoin!(offer2.workspaceId, offer2.pairingSessionId)).toEqual({
      ready: true,
      status: 'approved',
    });
    expect(claimCount).toBe(2);
    const saved = await Effect.runPromise(pins.read('acc-1', offer2.workspaceId));
    expect(saved?.phase).toBe('ready');
    expect(saved?.offer.pairingSessionId).toBe(offer2.pairingSessionId);
  } finally {
    await owner.close();
  }
});

it('reports corrupt pins in listAccountPins and closes its cached IDBDatabase on close()', async () => {
  const dbName = 'corrupt-and-close-pins';
  const pins = personalEntryPins(dbName);
  const offer = await offerFor('ws-healthy', 41);
  await Effect.runPromise(pins.prepare('acc-1', offer));
  await Effect.runPromise(pins.finish('acc-1', offer, 'ready'));

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open(dbName, 1);
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('pins', 'readwrite');
      tx.objectStore('pins').put(
        { version: 1, corrupt: true },
        JSON.stringify(['acc-1', 'ws-bad'])
      );
      tx.oncomplete = () => {
        db.close();
        resolve();
      };
      tx.onabort = tx.onerror = () => reject(tx.error);
    };
  });

  const listed = await Effect.runPromise(pins.listAccountPins('acc-1'));
  expect(listed.ready.map((p) => p.offer.workspaceId)).toEqual(['ws-healthy']);
  expect([...listed.corruptWorkspaceIds]).toEqual(['ws-bad']);

  let openCount = 0;
  const origOpen = indexedDB.open.bind(indexedDB);
  const openSpy = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
    openCount++;
    return origOpen(...args);
  });
  try {
    expect((await Effect.runPromise(pins.read('acc-1', 'ws-healthy')))?.phase).toBe('ready');
    expect(openCount).toBe(0);
    pins.close();
    expect((await Effect.runPromise(pins.read('acc-1', 'ws-healthy')))?.phase).toBe('ready');
    expect(openCount).toBe(1);
    pins.close();
  } finally {
    openSpy.mockRestore();
  }
});
