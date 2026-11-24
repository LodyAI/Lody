import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Effect, Layer } from 'effect';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { createStore, type PlatformSessionState } from '@lody/platform';
import { ClientCustodyError } from '@lody/e2ee-core/services';
import { makePersonalAccountPairingStore, personalEntryPins } from '@lody/client-e2ee';
import { personalEntry } from '@lody/client-e2ee';
import { desktopOffer } from './desktop-fixture';
/** When set, the registry assembles this runtime per workspace instead of the public host. */
const injected = vi.hoisted(() => ({
  runtime: undefined as ((workspaceId: string) => unknown) | undefined,
}));
vi.mock('@lody/e2ee-client', async (original) => {
  const real = await original<typeof import('@lody/e2ee-client')>();
  return {
    ...real,
    makePersonalWorkspaceRuntime: ((options) =>
      injected.runtime
        ? Effect.succeed(injected.runtime(options.workspaceId) as never)
        : real.makePersonalWorkspaceRuntime(options)) as typeof real.makePersonalWorkspaceRuntime,
  };
});
afterEach(() => vi.unstubAllGlobals());
const run = <A>(work: Effect.Effect<A, unknown>) => Effect.runPromise(work);
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
it('factory assembly and missing pairing leave native owners untouched and report desktop approval', async () => {
  const session = createStore<PlatformSessionState>({
    status: 'authenticated',
    user: { id: 'account-A', name: 'A', email: 'a@example.test', image: null },
  });
  const owner = personalEntry({
    run: Effect.runPromise,
    pins: personalEntryPins('pins'),
    ports: () => {
      throw new Error('unapproved must not acquire native host');
    },
    ledgerRecords: () => () => Effect.succeed([]),
  });
  const first = owner.createRuntime({ session })!;
  expect(first).toBe(owner.createRuntime({ session }));
  // The facade forwards machine sharing to the shared host (#4306).
  expect(first.readMachineSharing).toBeTypeOf('function');
  expect(first.updateMachineSharing).toBeTypeOf('function');
  expect(first.approvePersonalJoin).toBeUndefined();
  await expect(first.open('workspace-A')).rejects.toMatchObject({ code: 'approval-required' });
  await expect(first.pendingPersonalJoin!('workspace-A')).resolves.toBeNull();
  await expect(first.status('workspace-A')).rejects.toMatchObject({ code: 'approval-required' });
  await owner.close();
});
it('retains only independently verified desktop pins, isolates accounts and refuses another genesis', async () => {
  const pins = personalEntryPins('pins'),
    offer = await desktopOffer();
  await run(pins.prepare('A', offer));
  expect((await run(pins.read('A', offer.workspaceId)))?.offer).toEqual(offer);
  expect(await run(pins.read('B', offer.workspaceId))).toBeNull();
  await expect(
    run(pins.prepare('A', { ...offer, genesisHash: 'ff'.repeat(32) }))
  ).rejects.toBeDefined();
  await run(pins.finish('A', offer, 'ready'));
  await run(pins.prepare('A', offer));
  expect((await run(pins.read('A', offer.workspaceId)))?.phase).toBe('ready');
  await expect(
    run(pins.prepare('A', { ...offer, pairingSessionId: '33'.repeat(16) }))
  ).rejects.toBeDefined();
  expect((await run(pins.read('A', offer.workspaceId)))?.phase).toBe('ready');
  await expect(run(pins.prepare('A', await desktopOffer(12)))).rejects.toBeDefined();
  expect((await run(pins.read('A', offer.workspaceId)))?.offer).toEqual(offer);
});
it('preserves the pending original through quota abort and rejects superseding unknown pairing', async () => {
  const pins = personalEntryPins('pins'),
    offer = await desktopOffer();
  await run(pins.prepare('A', offer));
  const second = { ...offer, pairingSessionId: '22'.repeat(16) };
  await expect(run(pins.prepare('A', second))).rejects.toBeDefined();
  const original = IDBObjectStore.prototype.put;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    if (this.name === 'pins') throw new DOMException('quota', 'QuotaExceededError');
    return original.call(this, value, key);
  });
  try {
    await expect(run(pins.finish('A', offer, 'ready'))).rejects.toBeDefined();
  } finally {
    put.mockRestore();
  }
  expect(await run(pins.read('A', offer.workspaceId))).toEqual({
    version: 1,
    accountId: 'A',
    offer,
    phase: 'pending',
  });
  await run(pins.finish('A', offer, 'cancelled'));
  await run(pins.prepare('A', second));
  expect((await run(pins.read('A', offer.workspaceId)))?.offer).toEqual(second);
});
it('surfaces the real public host acquisition failure without native or ordinary fallback', async () => {
  const pins = personalEntryPins('pins'),
    offer = await desktopOffer();
  await run(pins.prepare('account-A', offer));
  const session = createStore<PlatformSessionState>({
    status: 'authenticated',
    user: { id: 'account-A', name: 'A', email: 'a@example.test', image: null },
  });
  const owner = personalEntry({
    run: Effect.runPromise,
    pins,
    ports: () =>
      Layer.effectContext(Effect.fail(new ClientCustodyError({ reason: 'unavailable' }))),
    ledgerRecords: () => () => Effect.succeed([]),
  });
  const runtime = owner.createRuntime({ session })!;
  await expect(runtime.open(offer.workspaceId)).rejects.toMatchObject({
    _tag: 'ClientCustodyError',
    reason: 'unavailable',
  });
  await owner.close();
});

it('application close settles an unclassified account waiter without opening native resources', async () => {
  const session = createStore<PlatformSessionState>({ status: 'loading' });
  const owner = personalEntry({
    run: Effect.runPromise,
    pins: personalEntryPins('pins'),
    ports: () => {
      throw new Error('must not acquire');
    },
    ledgerRecords: () => () => Effect.succeed([]),
  });
  const runtime = owner.createRuntime({ session })!,
    pending = runtime.open('workspace-A', undefined, undefined, 'waiting-account').then(
      () => 'stale',
      () => 'closed'
    );
  await owner.close();
  expect(await pending).toBe('closed');
});

it('closing a preallocated reader settles its account wait without retiring another future reader', async () => {
  const session = createStore<PlatformSessionState>({ status: 'loading' });
  const owner = personalEntry({
    run: Effect.runPromise,
    pins: personalEntryPins('pins'),
    ports: () => {
      throw new Error('must not acquire');
    },
    ledgerRecords: () => () => Effect.succeed([]),
  });
  const runtime = owner.createRuntime({ session })!,
    pending = runtime.open('workspace-A', undefined, 'account-A', 'preallocated').then(
      () => 'stale',
      () => 'closed'
    );
  await runtime.close('workspace-A', 'account-A', 'preallocated');
  expect(await pending).toBe('closed');
  session.set({
    status: 'authenticated',
    user: { id: 'account-A', name: 'A', email: 'a@example.test' },
  });
  await expect(runtime.open('workspace-A')).rejects.toMatchObject({ code: 'approval-required' });
  await owner.close();
});

it.each(['admission', 'executor'] as const)(
  'wipes its captured plaintext after %s refuses the lazy host',
  async (failure) => {
    const session = createStore<PlatformSessionState>({
      status: 'authenticated',
      user: { id: 'account-A', name: 'A', email: 'a@example.test' },
    });
    const rejected = new Error('synthetic executor rejected');
    const owner = personalEntry({
      run: (program) =>
        failure === 'executor' ? Promise.reject(rejected) : Effect.runPromise(program),
      pins: personalEntryPins('pins'),
      ports: () => {
        throw new Error('unapproved must not acquire native host');
      },
      ledgerRecords: () => () => Effect.succeed([]),
    });
    const body = Uint8Array.of(21, 32, 43),
      captured: Uint8Array[] = [],
      original = Uint8Array.prototype.fill;
    const wipe = vi.spyOn(Uint8Array.prototype, 'fill').mockImplementation(function (
      this: Uint8Array,
      value: number,
      start?: number,
      end?: number
    ) {
      if (this !== body && this.length === 3 && this[0] === 21 && this[1] === 32 && this[2] === 43)
        captured.push(this);
      return original.call(this, value, start, end);
    });
    try {
      const pending = owner.createRuntime({ session })!.seal('workspace-A', {
        epoch: 0,
        room: { kind: 'doc', docId: 'captured-doc' },
        context: {
          protocol: 'loro-streams-crdt-payload-protection',
          version: 2,
          kind: 'update_batch',
        },
        plaintext: body,
        additionalData: Uint8Array.of(4, 5),
      });
      if (failure === 'executor') await expect(pending).rejects.toBe(rejected);
      else await expect(pending).rejects.toMatchObject({ code: 'approval-required' });
      expect(captured.length).toBeGreaterThan(0);
      for (const copy of captured) expect(copy).toEqual(new Uint8Array(3));
      expect(body).toEqual(Uint8Array.of(21, 32, 43));
    } finally {
      wipe.mockRestore();
      await owner.close();
    }
  }
);
it('keeps a member join apart from personal pairing in the pin journal', async () => {
  const pins = personalEntryPins('pins'),
    offer = await desktopOffer();
  await run(pins.prepare('A', offer, 'member'));
  expect(await run(pins.read('A', offer.workspaceId))).toMatchObject({
    phase: 'pending',
    kind: 'member',
  });
  // The same identity offer can never be re-pinned as a personal pairing, or back.
  await expect(run(pins.prepare('A', offer))).rejects.toMatchObject({ code: 'conflict' });
  await run(pins.finish('A', offer, 'ready'));
  expect(await run(pins.read('A', offer.workspaceId))).toMatchObject({
    phase: 'ready',
    kind: 'member',
  });
  const personal = personalEntryPins('personal-pins');
  await run(personal.prepare('A', offer));
  await expect(run(personal.prepare('A', offer, 'member'))).rejects.toMatchObject({
    code: 'conflict',
  });
  expect((await run(personal.read('A', offer.workspaceId)))?.kind).toBeUndefined();
});
it("an exact status loss while approving retires only that workspace's pairing; another ready workspace still approves", async () => {
  const session = createStore<PlatformSessionState>({
    status: 'authenticated',
    user: { id: 'account-A', name: 'A', email: 'a@example.test', image: null },
  });
  const pins = personalEntryPins('pins'),
    revoked = await desktopOffer(),
    other = { ...revoked, workspaceId: 'workspace-B' };
  for (const offer of [revoked, other]) {
    await run(pins.prepare('account-A', offer));
    await run(pins.finish('account-A', offer, 'ready'));
  }
  const released: string[] = [];
  // The public runtime refuses `status` with this exact plain result once its verified
  // ledger no longer holds this device.
  injected.runtime = (workspaceId) => ({
    readerLeases: 'preallocated-v1',
    accountApproval: async () => ({
      device: 'ab'.repeat(32),
      refresh: async () => {},
      release: async () => void released.push(workspaceId),
    }),
    status: async () => {
      if (workspaceId === revoked.workspaceId)
        throw Object.assign(new Error('e2ee_device_revoked'), { code: 'e2ee_device_revoked' });
      return { deviceKind: 'personal', memberRole: 'owner' };
    },
    close: async () => {},
  });
  const owner = personalEntry({
    run: Effect.runPromise,
    pins,
    ports: () => ({}) as never,
    ledgerRecords: () => () => Effect.succeed([]),
  });
  try {
    const runtime = owner.createRuntime({ session })!;
    const lost = await runtime.accountApproval!(revoked.workspaceId).then(
      () => null,
      (error: unknown) => error
    );
    expect(lost).toBeInstanceOf(Error);
    expect((lost as Error).constructor).toBe(Error);
    expect((lost as Error).message).toBe('e2ee_device_revoked');
    expect(released).toEqual([revoked.workspaceId]);
    expect((await run(pins.read('account-A', revoked.workspaceId)))?.phase).toBe('cancelled');
    const approval = await runtime.accountApproval!(other.workspaceId);
    await approval.refresh();
    await approval.release();
    expect((await run(pins.read('account-A', other.workspaceId)))?.phase).toBe('ready');
  } finally {
    injected.runtime = undefined;
    await owner.close();
  }
});

it('single-workspace pairing, member join claim and approval key rounds stay scoped to directional modes and the target workspace', async () => {
  const session = createStore<PlatformSessionState>({
    status: 'authenticated',
    user: { id: 'account-A', name: 'A', email: 'a@example.test', image: null },
  });
  const basePins = personalEntryPins('pins');
  const pinReads: string[] = [];
  const pins = {
    ...basePins,
    read: (accountId: string, workspaceId: string) =>
      basePins
        .read(accountId, workspaceId)
        .pipe(Effect.tap(() => Effect.sync(() => void pinReads.push(workspaceId)))),
  };
  const offer = await desktopOffer();
  await run(basePins.prepare('account-A', offer, 'member'));
  const refreshInputs: unknown[] = [];
  const keyRoundModes: unknown[] = [];
  injected.runtime = () => ({
    readerLeases: 'preallocated-v1',
    accountApproval: async () => ({
      device: 'ab'.repeat(32),
      refresh: async () => {},
      keyRound: async (...args: unknown[]) => void keyRoundModes.push(args),
      release: async () => {},
    }),
    open: async () => ({ deviceKind: 'personal', memberRole: 'member', hasCurrentKey: false }),
    refresh: async (_id: string, input?: unknown) => {
      refreshInputs.push(input);
      return { deviceKind: 'personal', memberRole: 'member', hasCurrentKey: true };
    },
    claimMemberJoin: async () => ({ state: 'committed' as const }),
    status: async () => ({ deviceKind: 'personal', memberRole: 'member' }),
    close: async () => {},
  });
  const store = makePersonalAccountPairingStore('scoped-pairing-test');
  const owner = personalEntry({
    run: Effect.runPromise,
    pins,
    ports: () => ({}) as never,
    ledgerRecords: () => () => Effect.succeed([]),
    accountPairing: {
      store: () => store,
      deviceName: 'Phone',
      appendRecord: async () => ({}),
      relay: {
        submit: () => Effect.fail(new Error('unreachable')),
        read: () => Effect.succeed(null),
        decline: () => Effect.succeed({ status: 'declined' as const }),
        publish: () => Effect.succeed({ status: 'published' as const }),
        claim: () => Effect.succeed(null),
      },
      requester: {
        workspaces: async () => [
          { workspaceId: offer.workspaceId, name: 'Target', genesisHash: offer.genesisHash },
          { workspaceId: 'workspace-untouched', name: 'Other', genesisHash: '22'.repeat(32) },
        ],
        history: async () => {
          throw new Error('synthetic history failure after host filter');
        },
      },
    },
  });
  try {
    const runtime = owner.createRuntime({ session })!;
    expect(await runtime.claimMemberJoin!(offer.workspaceId, 'req-1')).toEqual({
      ready: true,
      state: 'committed',
    });
    expect(refreshInputs).toEqual([{ keyMode: 'receive' }]);
    const approval = (await runtime.accountApproval!(offer.workspaceId)) as {
      keyRound(mode?: 'full' | 'distribute'): Promise<void>;
      release(): Promise<void>;
    };
    await approval.keyRound('distribute');
    await approval.keyRound();
    await approval.release();
    expect(keyRoundModes).toEqual([['distribute'], []]);

    pinReads.length = 0;
    // Target workspace is now ready, so host() skips it; workspace-untouched must never be probed.
    await expect(
      runtime.requestAccountPairing!({
        workspace: {
          workspaceId: offer.workspaceId,
          name: 'Target',
          genesisHash: offer.genesisHash,
        },
      })
    ).rejects.toMatchObject({ code: 'invalid-input' });
    expect(pinReads).toEqual([offer.workspaceId]);
  } finally {
    store.close();
    injected.runtime = undefined;
    await owner.close();
  }
});
