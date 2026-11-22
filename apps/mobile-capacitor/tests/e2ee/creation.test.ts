import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Effect, Exit, ManagedRuntime, Result, Scope } from 'effect';
import { TestClock } from 'effect/testing';
import { ConvexHttpClient } from 'convex/browser';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import { createStore, type PlatformSessionState } from '@lody/platform';
import { importBrowserDevice } from '@lody/e2ee-core/adapters/browser-crypto';
import {
  accountIdFromUserId,
  Bytes,
  decodeRecord,
  hashRecordBytes,
  prepareDeviceAdmission,
  signDeviceCredentialBinding,
} from '@lody/e2ee-core/protocol';
import { makeAccountPairing } from '@lody/e2ee-client/account-pairing';
import { makeIndexedDbAccountPairingStore } from '@lody/e2ee-client/account-pairing/browser';
import { makePersonalCloudAccountPairingRelay, personalEntryPins } from '@lody/client-e2ee';
import { mobilePersonalHost } from '../../src/e2ee/mobile-host';
import { NativeFixture, raw } from './native-fixture';

const session = createStore<PlatformSessionState>({
  status: 'authenticated',
  user: { id: 'acca', name: 'A', email: 'a@example.test' },
});
const agent = {
  accountId: 'acca',
  membershipId: '08'.repeat(32),
};
const stops: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('navigator', {
    locks: {
      request: async (_name: string, _options: unknown, callback: (lock: unknown) => unknown) =>
        callback({}),
    },
  });
});
afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) await stop();
  vi.unstubAllGlobals();
});
function boot(run: Parameters<typeof mobilePersonalHost>[1] = Effect.runPromise) {
  const plugin = new NativeFixture();
  let putAttempted: () => void = () => {};
  let envelopeStored: () => void = () => {};
  const state: {
    genesis?: { workspaceId: string; genesisHash: string; recordHex: string };
    records: string[];
    /** Further created workspaces, each with its own ledger, keyed by workspace ID. */
    workspaces: Map<string, { name: string; genesisHash: string; records: string[] }>;
    /** Set: the next append lands, then its reply never arrives. */
    appendLandsUnanswered?: () => void;

    pairing?: Record<string, unknown>;
    approval?: Record<string, unknown>;
    /** Every synthetic operation path, in call order. */
    paths: string[];
    /** Envelope stores this phone attempted; refused ones are kept with `stored: false`. */
    envelopes: { id: string; frameHex: string; stored: boolean }[];
    refusePut: boolean;
    /** This phone's own device key: its own mailbox slot is already installed. */
    selfDevice?: string;
    putAttempted: Promise<void>;
    /** Delays the key-delivery retry asked for; only this injected clock moves. */
    sleeps: number[];
    /** Resolves when an envelope store succeeds. */
    envelopeStored: Promise<void>;
  } = {
    sleeps: [],
    envelopeStored: new Promise<void>((resolve) => (envelopeStored = resolve)),
    records: [],
    workspaces: new Map(),
    paths: [],
    envelopes: [],
    refusePut: false,
    putAttempted: new Promise<void>((resolve) => (putAttempted = resolve)),
  };
  const client = new ConvexHttpClient('https://synthetic.example.test', {
    fetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as {
        path: string;
        args: Record<string, unknown>[];
      };
      let value: unknown;
      state.paths.push(body.path);

      const mailbox = body.args[0] as Record<string, unknown>;
      if (body.path === 'e2eeMailbox:put') {
        state.envelopes.push({
          id: String(mailbox.id),
          frameHex: String(mailbox.frameHex),
          stored: !state.refusePut,
        });
        putAttempted();
        if (state.refusePut) throw new Error('synthetic refused envelope storage');
        envelopeStored();
        value = null;
      } else if (body.path === 'e2eeMailbox:read')
        value =
          state.envelopes.find((item) => item.id === mailbox.id && item.stored)?.frameHex ?? null;
      else if (body.path === 'e2eeMailbox:fetch') value = { items: [], next: null };
      else if (body.path === 'e2eeMailbox:status') {
        const slot = mailbox.slot as { genesis: string; epoch: number; recipient: string };
        value = {
          ...slot,
          revision: 0,
          status:
            slot.recipient === state.selfDevice
              ? 'InstallationReported'
              : state.envelopes.some((item) => item.stored)
                ? 'EnvelopeStored'
                : 'NeedsEnvelope',
        };
      } else if (body.path === 'e2eeMailbox:report' || body.path === 'e2eeMailbox:repair')
        value = null;
      else if (body.path === 'e2eeEpochStaging:readGroup') value = null;
      else if (body.path === 'e2eeMembers:workspaces')
        value = [...state.workspaces].map(([id, workspace]) => ({
          id,
          name: workspace.name,
          genesisHash: workspace.genesisHash,
        }));
      else if (
        body.path === 'e2eeWorkspaces:appendRecord' &&
        state.workspaces.has(String(body.args[0]?.workspaceId))
      ) {
        state.workspaces
          .get(String(body.args[0]?.workspaceId))!
          .records.push(String(body.args[0]?.recordHex));
        value = { ok: true };
      } else if (
        body.path === 'e2eeWorkspaces:history' &&
        state.workspaces.has(String(body.args[0]?.workspaceId))
      ) {
        const workspaceId = String(body.args[0]?.workspaceId);
        const { genesisHash, records: all } = state.workspaces.get(workspaceId)!;
        const start = body.args[0]?.after ? Number(String(body.args[0].after).split(':')[2]) : 0;
        value = {
          workspaceId,
          genesisHash,
          checkpoint: {
            length: all.length,
            headHash: Buffer.from(hashRecordBytes(raw(all.at(-1)!)).toBytes()).toString('hex'),
          },
          startIndex: start,
          recordsHex: all.slice(start),
          position: `p1:${workspaceId}:${all.length}:synthetic:0`,
          nextCursor: null,
        };
      } else if (body.path === 'e2eeWorkspaces:appendRecord') {
        const recordHex = String(body.args[0]?.recordHex);
        if (recordHex) state.records.push(recordHex);
        const landed = state.appendLandsUnanswered;
        if (landed) {
          state.appendLandsUnanswered = undefined;
          landed();
          return new Promise<Response>(() => {});
        }
        value = { ok: true };
      } else if (body.path === 'e2eeWorkspaces:history' && state.genesis) {
        const all = state.records.length ? state.records : [state.genesis.recordHex];
        const start = body.args[0]?.after ? Number(String(body.args[0].after).split(':')[2]) : 0;
        const records = all.slice(start);
        const head = hashRecordBytes(raw(all.at(-1)!)).toBytes();
        value = {
          workspaceId: state.genesis.workspaceId,
          genesisHash: state.genesis.genesisHash,
          checkpoint: { length: all.length, headHash: Buffer.from(head).toString('hex') },
          startIndex: start,
          recordsHex: records,
          position: 'p1:created:' + all.length + ':synthetic:0',
          nextCursor: null,
        };
      } else if (body.path === 'e2eeAccountPairing:submit') {
        const input = body.args[0] as Record<string, unknown>;
        state.pairing = {
          ...input,
          requestId: `request-${String(input.lookupId)}`,
          status: 'pending',
          approximateLocation: null,
          requestedAt: 1,
        };
        value = {
          requestId: `request-${String(input.lookupId)}`,
          status: 'pending',
          deviceName: input.deviceName,
          approximateLocation: null,
          requestedAt: 1,
          expiresAt: input.expiresAt,
        };
      } else if (body.path === 'e2eeAccountPairing:read') {
        value = state.pairing ?? null;
      } else if (body.path === 'e2eeAccountPairing:publish') {
        const input = body.args[0] as Record<string, unknown>;
        state.approval = { ...input, publishedAt: 2 };
        value = { status: 'published' };
      } else if (body.path === 'e2eeAccountPairing:claim') {
        value = state.approval
          ? {
              status: 'approved',
              approvals: [
                {
                  approvalHex: state.approval.approvalHex,
                  approvalTagHex: state.approval.approvalTagHex,
                  invitations: state.approval.invitations,
                  publishedAt: 2,
                },
              ],
            }
          : { status: 'pending', approvals: [] };
      } else if (body.path === 'e2eeAccountPairing:decline') {
        value = { status: 'declined' };
      } else throw new Error('unexpected synthetic operation ' + body.path);
      return new Response(JSON.stringify({ status: 'success', value }), {
        headers: { 'Content-Type': 'application/json' },
      });
    },
  });
  client.setAuth('synthetic-auth');
  const owner = mobilePersonalHost(client, run, plugin, {
    // The mailbox recovers while the retry waits; no real time passes.
    keyDeliveryRetry: {
      sleep: (ms) =>
        Effect.sync(() => {
          state.sleeps.push(ms);
          state.refusePut = false;
        }),
    },
  });
  stops.push(() => owner.close());
  return { owner, plugin, client, state, runtime: owner.createRuntime({ session })! };
}
function failNextCreationWrite(predicate: (value: unknown) => boolean) {
  const original = IDBObjectStore.prototype.put;
  let failed = false;
  IDBObjectStore.prototype.put = function (
    this: IDBObjectStore,
    value: unknown,
    key?: IDBValidKey
  ) {
    if (!failed && this.name === 'creations' && predicate(value)) {
      failed = true;
      throw new Error('synthetic idb write failure');
    }
    return original.call(this, value as never, key);
  } as typeof IDBObjectStore.prototype.put;
  return () => {
    IDBObjectStore.prototype.put = original;
  };
}

const genesisBody = (recordHex: string) => {
  const decoded = decodeRecord(raw(recordHex));
  if (Result.isFailure(decoded) || decoded.success.body.type !== 'genesis')
    throw new Error('not a genesis record');
  return decoded.success.body;
};

it('creates a signed workspace with native custody and reopens it without a network call', async () => {
  const app = boot();
  const prepared = await app.owner.prepareCreation({
    accountId: agent.accountId,
    requestId: 'creation-request-01',
    name: 'Mobile encrypted',
    slug: 'mobile-encrypted',
  });
  expect(prepared.genesisHashHex).toMatch(/^[0-9a-f]{64}$/);
  expect(prepared.deviceCredentialHash).toMatch(/^[0-9a-f]{64}$/);
  const body = genesisBody(prepared.genesisRecordHex);
  expect(body.membershipId.toBytes()).toHaveLength(16);
  expect(accountIdFromUserId(body.userId)).toEqual(Result.succeed(agent.accountId));
  expect(app.plugin.keys.size).toBe(1);

  app.state.genesis = {
    workspaceId: 'workspace-C',
    genesisHash: prepared.genesisHashHex,
    recordHex: prepared.genesisRecordHex,
  };
  await app.runtime.recordCreated({
    workspaceId: 'workspace-C',
    genesisHash: prepared.genesisHashHex,
    requestId: 'creation-request-01',
  });
  const opened = await app.runtime.open('workspace-C');
  expect(opened).toMatchObject({
    workspaceId: 'workspace-C',
    genesisHash: prepared.genesisHashHex,
    epoch: 0,
    hasCurrentKey: true,
    deviceKind: 'personal',
    memberRole: 'owner',
  });
  expect(opened.signingPublicKey).toMatch(/^[0-9a-f]{64}$/);
  await app.owner.close();

  // A fresh process reopens the same native identity and installed epoch key.
  const nextOwner = mobilePersonalHost(app.client, Effect.runPromise, app.plugin);
  stops.push(() => nextOwner.close());
  const reopened = nextOwner.createRuntime({ session })!;
  await expect(reopened.open('workspace-C')).resolves.toMatchObject({
    genesisHash: prepared.genesisHashHex,
    hasCurrentKey: true,
  });
  await expect(
    nextOwner.prepareCreation({
      accountId: agent.accountId,
      requestId: 'creation-request-01',
      name: 'Mobile encrypted',
      slug: 'mobile-encrypted',
    })
  ).resolves.toMatchObject({ genesisRecordHex: prepared.genesisRecordHex });
});

it('keeps the original creation intent and rejects a changed one', async () => {
  const app = boot();
  const intent = {
    accountId: agent.accountId,
    requestId: 'creation-request-02',
    name: 'First name',
    slug: 'first-name',
  };
  const first = await app.owner.prepareCreation(intent);
  await expect(app.owner.prepareCreation({ ...intent, name: 'Changed' })).rejects.toMatchObject({
    code: 'conflict',
  });
  await expect(
    app.runtime.recordCreated({
      workspaceId: 'workspace-D',
      genesisHash: '00'.repeat(32),
      requestId: intent.requestId,
    })
  ).rejects.toMatchObject({ code: 'missing_binding' });
  await expect(
    app.runtime.recordCreated({
      workspaceId: 'workspace-D',
      genesisHash: first.genesisHashHex,
      requestId: intent.requestId,
    })
  ).resolves.toBeUndefined();
});

it('signs a real account-pairing admission from the created workspace', async () => {
  const app = boot();
  const prepared = await app.owner.prepareCreation({
    accountId: agent.accountId,
    requestId: 'creation-request-03',
    name: 'Pairing source',
    slug: 'pairing-source',
  });
  app.state.genesis = {
    workspaceId: 'workspace-E',
    genesisHash: prepared.genesisHashHex,
    recordHex: prepared.genesisRecordHex,
  };
  await app.runtime.recordCreated({
    workspaceId: 'workspace-E',
    genesisHash: prepared.genesisHashHex,
    requestId: 'creation-request-03',
  });
  const opened = await app.runtime.open('workspace-E');
  const approval = await app.runtime.accountApproval!('workspace-E');
  expect(approval.device).toBe(opened.signingPublicKey);
  const scope = Effect.runSync(Scope.make());
  const fresh = await Effect.runPromise(
    Scope.provide(
      importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(21),
        encryptionPrivate: new Uint8Array(32).fill(22),
      }),
      scope
    )
  );
  try {
    const proof = await Effect.runPromise(
      prepareDeviceAdmission({
        genesis: Result.getOrThrow(Bytes.genesisHash(raw(prepared.genesisHashHex))),
        membershipId: Result.getOrThrow(Bytes.membershipId(raw(opened.membershipId!))),
        encryptionPublicKey: fresh.enc,
        kind: 'personal',
        signer: fresh,
      })
    );
    const signed = await approval.sign({
      signingPublicKey: fresh.publicKey.toBytes(),
      encryptionPublicKey: fresh.enc.toBytes(),
      possessionProof: proof.possessionSignature.toBytes(),
    });
    const record = decodeRecord(signed.record);
    expect(Result.isFailure(record)).toBe(false);
    if (Result.isSuccess(record) && record.success.body.type === 'ordinary')
      expect(record.success.body.operation.type).toBe('admitDevice');
    // A signed original is not committed by signing alone.
    await expect(approval.settle(signed.record)).resolves.not.toBe('committed');
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

it('does not accept a creation record for another workspace genesis', async () => {
  const app = boot();
  const prepared = await app.owner.prepareCreation({
    accountId: agent.accountId,
    requestId: 'creation-request-05',
    name: 'Bound once',
    slug: 'bound-once',
  });
  app.state.genesis = {
    workspaceId: 'workspace-F',
    genesisHash: prepared.genesisHashHex,
    recordHex: prepared.genesisRecordHex,
  };
  await app.runtime.recordCreated({
    workspaceId: 'workspace-F',
    genesisHash: prepared.genesisHashHex,
    requestId: 'creation-request-05',
  });
  await expect(
    app.runtime.recordCreated({
      workspaceId: 'workspace-G',
      genesisHash: prepared.genesisHashHex,
      requestId: 'creation-request-05',
    })
  ).rejects.toMatchObject({ code: 'conflict' });
});

// Keep the real genesis signer bound to the account identity, not a server label.
it('refuses an account ID outside the frozen ledger encoding before signing', async () => {
  const plugin = new NativeFixture();
  const client = new ConvexHttpClient('https://synthetic.example.test');
  client.setAuth('synthetic-auth');
  const owner = mobilePersonalHost(client, Effect.runPromise, plugin);
  stops.push(() => owner.close());
  await expect(
    owner.prepareCreation({
      accountId: 'Account-A',
      requestId: 'creation-request-06',
      name: 'Wrong account',
      slug: 'wrong-account',
    })
  ).rejects.toMatchObject({ code: 'account_identity_required' });
});

it.each([
  [
    'partial',
    (value: unknown) => {
      const row = value as { phase?: string; wrapped?: unknown[]; epochBlob?: string | null };
      return row.phase === 'preparing' && row.wrapped?.length === 3 && row.epochBlob === null;
    },
  ],
  [
    'with-epoch',
    (value: unknown) => {
      const row = value as { phase?: string; wrapped?: unknown[]; epochBlob?: string | null };
      return (
        row.phase === 'preparing' && row.wrapped?.length === 3 && typeof row.epochBlob === 'string'
      );
    },
  ],
])('regenerates after the %s creation write fails', async (_label, predicate) => {
  const app = boot();
  const intent = {
    accountId: agent.accountId,
    requestId: `creation-request-${_label}-early`,
    name: 'Early failure',
    slug: 'early-failure',
  };
  const restore = failNextCreationWrite(predicate);
  try {
    await expect(app.owner.prepareCreation(intent)).rejects.toThrow('synthetic idb write failure');
  } finally {
    restore();
  }
  const prepared = await app.owner.prepareCreation(intent);
  expect(prepared.genesisHashHex).toMatch(/^[0-9a-f]{64}$/);
  await app.runtime.recordCreated({
    workspaceId: `workspace-${_label}`,
    genesisHash: prepared.genesisHashHex,
    requestId: intent.requestId,
  });
  await expect(app.runtime.open(`workspace-${_label}`)).resolves.toMatchObject({
    genesisHash: prepared.genesisHashHex,
    hasCurrentKey: true,
  });
});

it('shares one signed genesis and one workspace binding across concurrent calls', async () => {
  const app = boot();
  const intent = {
    accountId: agent.accountId,
    requestId: 'creation-request-concurrent',
    name: 'Concurrent create',
    slug: 'concurrent-create',
  };
  const [first, second] = await Promise.all([
    app.owner.prepareCreation(intent),
    app.owner.prepareCreation(intent),
  ]);
  expect(first.genesisHashHex).toBe(second.genesisHashHex);
  expect(first.genesisRecordHex).toBe(second.genesisRecordHex);
  expect(app.plugin.keys.size).toBe(1);
  await Promise.all([
    app.runtime.recordCreated({
      workspaceId: 'workspace-concurrent',
      genesisHash: first.genesisHashHex,
      requestId: intent.requestId,
    }),
    app.runtime.recordCreated({
      workspaceId: 'workspace-concurrent',
      genesisHash: first.genesisHashHex,
      requestId: intent.requestId,
    }),
  ]);
  await expect(app.runtime.open('workspace-concurrent')).resolves.toMatchObject({
    genesisHash: first.genesisHashHex,
    hasCurrentKey: true,
  });
});

it('resumes a creation after the final durable record write fails', async () => {
  const app = boot();
  const intent = {
    accountId: agent.accountId,
    requestId: 'creation-request-resume-01',
    name: 'Resumed creation',
    slug: 'resumed-creation',
  };
  const restore = failNextCreationWrite((value) => (value as { phase?: string }).phase === 'ready');
  try {
    await expect(app.owner.prepareCreation(intent)).rejects.toThrow('synthetic idb write failure');
  } finally {
    restore();
  }
  const prepared = await app.owner.prepareCreation(intent);
  expect(prepared.genesisHashHex).toMatch(/^[0-9a-f]{64}$/);
  expect(app.plugin.keys.size).toBe(1);
  await app.runtime.recordCreated({
    workspaceId: 'workspace-resume-01',
    genesisHash: prepared.genesisHashHex,
    requestId: intent.requestId,
  });
  await expect(app.runtime.open('workspace-resume-01')).resolves.toMatchObject({
    genesisHash: prepared.genesisHashHex,
    hasCurrentKey: true,
  });
});

it('reopens a created workspace when the workspace binding write failed', async () => {
  const app = boot();
  const prepared = await app.owner.prepareCreation({
    accountId: agent.accountId,
    requestId: 'creation-request-resume-02',
    name: 'Resumed binding',
    slug: 'resumed-binding',
  });
  const restore = failNextCreationWrite(
    (value) => (value as { boundWorkspaceId?: string }).boundWorkspaceId === 'workspace-resume-02'
  );
  try {
    await expect(
      app.runtime.recordCreated({
        workspaceId: 'workspace-resume-02',
        genesisHash: prepared.genesisHashHex,
        requestId: 'creation-request-resume-02',
      })
    ).rejects.toThrow('synthetic idb write failure');
  } finally {
    restore();
  }
  await expect(
    app.runtime.recordCreated({
      workspaceId: 'workspace-resume-02',
      genesisHash: prepared.genesisHashHex,
      requestId: 'creation-request-resume-02',
    })
  ).resolves.toBeUndefined();
  await expect(app.runtime.open('workspace-resume-02')).resolves.toMatchObject({
    genesisHash: prepared.genesisHashHex,
    hasCurrentKey: true,
  });
});

it('lets the phone approve a desktop account-pairing request for the workspace it created', async () => {
  const app = boot();
  const prepared = await app.owner.prepareCreation({
    accountId: agent.accountId,
    requestId: 'creation-request-08',
    name: 'Phone owner',
    slug: 'phone-owner',
  });
  app.state.genesis = {
    workspaceId: 'workspace-H',
    genesisHash: prepared.genesisHashHex,
    recordHex: prepared.genesisRecordHex,
  };
  app.state.records = [prepared.genesisRecordHex];
  await app.runtime.recordCreated({
    workspaceId: 'workspace-H',
    genesisHash: prepared.genesisHashHex,
    requestId: 'creation-request-08',
  });
  const opened = await app.runtime.open('workspace-H');
  app.state.selfDevice = opened.signingPublicKey!;
  const code = await app.runtime.accountPairingCode!();

  const scope = Effect.runSync(Scope.make());
  const desktop = await Effect.runPromise(
    Scope.provide(
      importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(31),
        encryptionPrivate: new Uint8Array(32).fill(32),
      }),
      scope
    )
  );
  const genesis = Result.getOrThrow(Bytes.genesisHash(raw(prepared.genesisHashHex)));
  const proof = await Effect.runPromise(
    prepareDeviceAdmission({
      genesis,
      membershipId: Result.getOrThrow(Bytes.membershipId(raw(opened.membershipId!))),
      encryptionPublicKey: desktop.enc,
      kind: 'personal',
      signer: desktop,
    })
  );
  const credentialHash = new Uint8Array(32).fill(0x66);
  const binding = await Effect.runPromise(
    signDeviceCredentialBinding({
      genesis,
      pairingSessionId: new Uint8Array(16).fill(7),
      signingPublicKey: desktop.publicKey,
      credentialHash,
      signer: desktop,
    })
  );
  void binding;
  const desktopPairing = makeAccountPairing({
    store: makeIndexedDbAccountPairingStore({ accountId: 'desktop-pairing' }),
    account: agent.accountId,
    deviceName: 'Desktop test',
    relay: makePersonalCloudAccountPairingRelay({
      client: app.client,
      currentAccount: () => Effect.succeed('authenticated'),
    }),
    approverWorkspaces: () => Effect.succeed([]),
    requesterWorkspaces: () =>
      Effect.succeed([
        {
          workspaceId: 'workspace-H',
          name: 'Phone owner',
          genesis: raw(prepared.genesisHashHex),
          identity: () =>
            Effect.succeed({
              signingPublicKey: desktop.publicKey.toBytes(),
              encryptionPublicKey: desktop.enc.toBytes(),
              possessionProof: proof.possessionSignature.toBytes(),
              credentialHash,
            }),
          accept: () => Effect.void,
          acceptHistory: () => Effect.void,
        },
      ]),
  });
  try {
    await Effect.runPromise(
      desktopPairing.requestAccountPairing({ pairingString: code.pairingString })
    );
    const preview = await app.runtime.inspectAccountPairing!(code.pairingString);
    // The mailbox refuses the first envelope store; approval must still succeed.
    app.state.refusePut = true;
    expect(preview?.deviceName).toBe('Desktop test');
    expect(preview?.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['workspace-H']);
    const approved = await app.runtime.approveAccountPairing!({
      pairingString: code.pairingString,
      requestId: preview!.requestId,
      workspaceIds: ['workspace-H'],
    });
    expect(approved.workspaces).toEqual([{ workspaceId: 'workspace-H', outcome: 'admitted' }]);
    expect(app.state.records).toHaveLength(2);
    const admission = decodeRecord(raw(app.state.records[1]!));
    expect(Result.isSuccess(admission)).toBe(true);
    if (Result.isSuccess(admission) && admission.success.body.type === 'ordinary') {
      expect(admission.success.body.operation.type).toBe('admitDevice');
      if (admission.success.body.operation.type === 'admitDevice')
        expect(admission.success.body.operation.signingPublicKey.toBytes()).toEqual(
          desktop.publicKey.toBytes()
        );
    }
    const joined = await Effect.runPromise(desktopPairing.accountPairingRequest());
    expect(joined?.status).toBe('joined');
    // Admitted and joined is not keyed: the snapshot invitation carries no epoch key,
    // so the phone must store an envelope for the new desktop in the background.
    await app.state.putAttempted;
    expect(app.state.paths).toContain('e2eeMailbox:put');
    const refused = app.state.envelopes.map(({ id, frameHex }) => ({ id, frameHex }));
    // Only the desktop needs an envelope (the phone's own slot is installed): one id.
    expect(new Set(refused.map((item) => item.id)).size).toBe(1);
    // The phone's own due retry, with no page or call here, stores the journaled
    // envelope under the same id and bytes: no new signature or encryption.
    await app.state.envelopeStored;
    expect(app.state.sleeps).toEqual([500]);
    expect(app.state.envelopes.filter((item) => item.stored)).toContainEqual({
      ...refused[0]!,
      stored: true,
    });
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

/** Two workspaces this phone created, then an app restart: only W1 is opened again. */
async function relaunchedOwnerOfTwo() {
  const app = boot();
  const created: { workspaceId: string; genesisHashHex: string; genesisRecordHex: string }[] = [];
  for (const workspaceId of ['workspace-W1', 'workspace-W2']) {
    const prepared = await app.owner.prepareCreation({
      accountId: agent.accountId,
      requestId: `creation-${workspaceId}`,
      name: `Team ${workspaceId}`,
      slug: workspaceId,
    });
    app.state.workspaces.set(workspaceId, {
      name: `Team ${workspaceId}`,
      genesisHash: prepared.genesisHashHex,
      records: [prepared.genesisRecordHex],
    });
    await app.runtime.recordCreated({
      workspaceId,
      genesisHash: prepared.genesisHashHex,
      requestId: `creation-${workspaceId}`,
    });
    created.push({ workspaceId, ...prepared });
  }
  await app.owner.close();
  const relaunched = mobilePersonalHost(app.client, Effect.runPromise, app.plugin, {
    keyDeliveryRetry: { sleep: () => Effect.void },
  });
  stops.push(() => relaunched.close());
  const runtime = relaunched.createRuntime({ session })!;
  await runtime.open('workspace-W1');
  return { app, created, runtime };
}
/** A desktop of the same account requests pairing for the given workspaces under `code`. */
async function desktopRequest(
  app: ReturnType<typeof boot>,
  workspaces: { workspaceId: string; genesisHashHex: string; genesisRecordHex: string }[],
  code: string
) {
  const scope = Effect.runSync(Scope.make());
  stops.push(() => Effect.runPromise(Scope.close(scope, Exit.void)));
  const desktop = await Effect.runPromise(
    Scope.provide(
      importBrowserDevice({
        signingPrivate: new Uint8Array(32).fill(41),
        encryptionPrivate: new Uint8Array(32).fill(42),
      }),
      scope
    )
  );
  const credentialHash = new Uint8Array(32).fill(0x67);
  const requested = await Promise.all(
    workspaces.map(async (workspace) => {
      const proof = await Effect.runPromise(
        prepareDeviceAdmission({
          genesis: Result.getOrThrow(Bytes.genesisHash(raw(workspace.genesisHashHex))),
          membershipId: genesisBody(workspace.genesisRecordHex).membershipId,
          encryptionPublicKey: desktop.enc,
          kind: 'personal',
          signer: desktop,
        })
      );
      return {
        workspaceId: workspace.workspaceId,
        name: workspace.workspaceId,
        genesis: raw(workspace.genesisHashHex),
        identity: () =>
          Effect.succeed({
            signingPublicKey: desktop.publicKey.toBytes(),
            encryptionPublicKey: desktop.enc.toBytes(),
            possessionProof: proof.possessionSignature.toBytes(),
            credentialHash,
          }),
        accept: () => Effect.void,
        acceptHistory: () => Effect.void,
      };
    })
  );
  const desktopPairing = makeAccountPairing({
    store: makeIndexedDbAccountPairingStore({ accountId: 'desktop-pairing-two' }),
    account: agent.accountId,
    deviceName: 'Desktop test',
    relay: makePersonalCloudAccountPairingRelay({
      client: app.client,
      currentAccount: () => Effect.succeed(agent.accountId),
    }),
    approverWorkspaces: () => Effect.succeed([]),
    requesterWorkspaces: () => Effect.succeed(requested),
  });
  await Effect.runPromise(desktopPairing.requestAccountPairing({ pairingString: code }));
}
const byId = <T extends { workspaceId: string }>(rows: readonly T[]) =>
  [...rows].sort((a, b) => (a.workspaceId < b.workspaceId ? -1 : 1));
const minePin = (workspaceId: string) =>
  Effect.runPromise(
    personalEntryPins('lody-e2ee:mobile:v1:entry-pins').read(agent.accountId, workspaceId)
  );

it('a relaunched phone approves a desktop request for every workspace it is ready in, opened or not', async () => {
  const { app, created, runtime } = await relaunchedOwnerOfTwo();
  const code = await runtime.accountPairingCode!();
  await desktopRequest(app, created, code.pairingString);
  const preview = await runtime.inspectAccountPairing!(code.pairingString);
  // Both ready workspaces are offered, under the names the account's list gives them.
  expect(byId(preview!.workspaces).map(({ workspaceId, name }) => ({ workspaceId, name }))).toEqual(
    [
      { workspaceId: 'workspace-W1', name: 'Team workspace-W1' },
      { workspaceId: 'workspace-W2', name: 'Team workspace-W2' },
    ]
  );
  const approved = await runtime.approveAccountPairing!({
    pairingString: code.pairingString,
    requestId: preview!.requestId,
    workspaceIds: ['workspace-W1', 'workspace-W2'],
  });
  expect(byId(approved.workspaces)).toEqual([
    { workspaceId: 'workspace-W1', outcome: 'admitted' },
    { workspaceId: 'workspace-W2', outcome: 'admitted' },
  ]);
  for (const workspaceId of ['workspace-W1', 'workspace-W2'])
    expect(app.state.workspaces.get(workspaceId)!.records).toHaveLength(2);
});

it('an unopened workspace that cannot open never stops the phone approving its healthy ones', async () => {
  const { app, created, runtime } = await relaunchedOwnerOfTwo();
  // W2's native key is gone (for example after an OS keychain reset).
  for (const key of [...app.plugin.keys])
    if (key.includes('workspace-W2')) app.plugin.keys.delete(key);
  const code = await runtime.accountPairingCode!();
  await desktopRequest(app, created, code.pairingString);
  const preview = await runtime.inspectAccountPairing!(code.pairingString);
  expect(preview!.workspaces.map((workspace) => workspace.workspaceId)).toEqual(['workspace-W1']);
  const approved = await runtime.approveAccountPairing!({
    pairingString: code.pairingString,
    requestId: preview!.requestId,
    workspaceIds: ['workspace-W1'],
  });
  expect(approved.workspaces).toEqual([{ workspaceId: 'workspace-W1', outcome: 'admitted' }]);
  // A broken workspace proves no access loss: its pin keeps routing it.
  expect((await minePin('workspace-W2'))?.phase).toBe('ready');
});

it('an append that lands but is never answered ends at its bound, and the approval still admits the device exactly once', async () => {
  const clock = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
  stops.push(() => clock.dispose());
  await clock.context();
  const app = boot((program) => clock.runPromise(program));
  const prepared = await app.owner.prepareCreation({
    accountId: agent.accountId,
    requestId: 'creation-request-09',
    name: 'Phone owner',
    slug: 'phone-owner',
  });
  app.state.genesis = {
    workspaceId: 'workspace-H',
    genesisHash: prepared.genesisHashHex,
    recordHex: prepared.genesisRecordHex,
  };
  app.state.records = [prepared.genesisRecordHex];
  await app.runtime.recordCreated({
    workspaceId: 'workspace-H',
    genesisHash: prepared.genesisHashHex,
    requestId: 'creation-request-09',
  });
  await app.runtime.open('workspace-H');
  const code = await app.runtime.accountPairingCode!();
  await desktopRequest(app, [{ workspaceId: 'workspace-H', ...prepared }], code.pairingString);
  const preview = await app.runtime.inspectAccountPairing!(code.pairingString);
  const landed = new Promise<void>((resolve) => (app.state.appendLandsUnanswered = resolve));
  const approving = app.runtime.approveAccountPairing!({
    pairingString: code.pairingString,
    requestId: preview!.requestId,
    workspaceIds: ['workspace-H'],
  });
  await landed;
  await clock.runPromise(TestClock.adjust(30_000));
  // The ledger already holds the admission: settling reads it instead of signing again.
  await expect(approving).resolves.toEqual({
    workspaces: [{ workspaceId: 'workspace-H', outcome: 'admitted' }],
  });
  expect(app.state.records).toHaveLength(2);
});
