import { fork, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { linkSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StreamsClient } from '@loro-dev/streams-client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SqliteControlStore } from '../src/node-store';
import { SqliteReceivedKeyStore } from '../src/node-received-key-store';
import { SqliteKeyDeliveryStore } from '../src/node-key-outbox';
import { StreamsKeyDeliveryRemote } from '../src/streams';
import {
  ControlLogClient,
  WebCryptoControl,
  encodeRecord,
  decodeRecord,
  deriveTeamAnchor,
  encodeTeamAction,
  ownerManagedTeamPolicy,
  signingBytes,
  signJoinRequest,
  OrgKeyExchange,
  KeyDelivery,
  type KeyDeliveryStore,
  commitEpochKey,
  type KeyRecipient,
  toHex,
  type ControlJournal,
  type ControlPolicy,
  type JournalTransaction,
  type TeamGenesis,
} from '../src';
import { deferred, MemoryStream, HttpLedger } from './control-fixtures';

const dirs: string[] = [];
const children = new Set<ChildProcess>();
const genesis = 'a1'.repeat(32);
const wire = encodeRecord({
  event: {
    genesis,
    previous: genesis,
    operationId: '01'.repeat(16),
    actor: 'A',
    memberInstance: 'A1',
    device: 'desktop',
    kind: 'test',
    payload: '',
  },
  signatures: [['actor-device', '00'.repeat(64)]],
});
const journal = (): ControlJournal => ({ genesis, pages: [], pending: wire });

function location() {
  const dir = mkdtempSync(join(tmpdir(), 'lody-control-store-'));
  dirs.push(dir);
  return join(dir, 'control.sqlite');
}
function load(path: string) {
  return new SqliteControlStore(path).exclusive((tx) => tx.load());
}
function changeDatabase(path: string, sql: string) {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
async function orgFixture() {
  const encryptionPairs = new Map<string, CryptoKeyPair>();
  const pair = async () => {
    const keys = (await crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    return {
      privateKey: keys.privateKey,
      publicKey: toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey))),
    };
  };
  const encryptionKey = async () => {
    const keys = (await crypto.subtle.generateKey('X25519', false, [
      'deriveBits',
    ])) as CryptoKeyPair;
    const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keys.publicKey)));
    encryptionPairs.set(publicKey, keys);
    return publicKey;
  };
  const [device, recovery, management] = await Promise.all([pair(), pair(), pair()]);
  const acceptedGenesis: TeamGenesis = {
    nonce: 'c1'.repeat(32),
    owner: {
      userId: 'owner',
      instance: 'owner-1',
      recoverySigningKey: recovery.publicKey,
      recoveryEncryptionKey: await encryptionKey(),
      device: {
        id: 'desktop',
        kind: 'personal',
        canManage: true,
        signingKey: device.publicKey,
        encryptionKey: await encryptionKey(),
      },
    },
  };
  return {
    acceptedGenesis,
    device,
    recovery,
    management,
    encryptionPairs,
    anchor: await deriveTeamAnchor(acceptedGenesis),
  };
}

describe('received epoch ciphertext persistence', () => {
  async function fixture() {
    const org = await orgFixture();
    const stream = new MemoryStream();
    const controlPath = location();
    const client = new ControlLogClient(
      org.anchor,
      ownerManagedTeamPolicy,
      new SqliteControlStore(controlPath),
      stream
    );
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const publication = await new WebCryptoControl().sign(
      {
        genesis: org.anchor.genesis,
        previous: org.anchor.genesis,
        operationId: 'f1'.repeat(16),
        actor: 'owner',
        memberInstance: 'owner-1',
        device: 'desktop',
        ...encodeTeamAction({
          type: 'epoch.publish',
          configVersion: 0,
          epoch: 0,
          commitment: await commitEpochKey(org.anchor.genesis, secret),
        }),
      },
      [{ id: 'actor-device', key: org.device.privateKey }]
    );
    expect((await client.submit(publication)).status).toBe('committed');
    const recipient: KeyRecipient = {
      kind: 'device',
      actor: 'owner',
      memberInstance: 'owner-1',
      id: 'desktop',
    };
    const keys = org.encryptionPairs.get(org.acceptedGenesis.owner.device.encryptionKey)!;
    const path = location();
    const store = (target: KeyRecipient = recipient) =>
      new SqliteReceivedKeyStore(path, org.anchor.genesis, target);
    const exchange = () =>
      new OrgKeyExchange(org.anchor, new SqliteControlStore(controlPath), stream, () => {});
    const prepare = () =>
      exchange().prepare({
        epoch: 0,
        sender: { actor: 'owner', memberInstance: 'owner-1', device: 'desktop' },
        recipient,
        secret,
        signingKey: org.device.privateKey,
      });
    const envelope = await prepare();
    return {
      org,
      client,
      stream,
      secret,
      recipient,
      keys,
      path,
      store,
      exchange,
      prepare,
      envelope,
    };
  }

  it('persists only the original HPKE ciphertext and reopens it with the protected device identity', async () => {
    const f = await fixture();
    await f.store().receive(f.envelope.context, f.envelope.frame, f.keys, f.exchange());
    const disk = readFileSync(f.path);
    expect(disk.includes(Buffer.from(toHex(f.envelope.frame)))).toBe(true);
    expect(disk.includes(Buffer.from(f.secret))).toBe(false);
    expect(disk.includes(Buffer.from(toHex(f.secret)))).toBe(false);
    expect(await f.store().restore(0, f.keys, f.exchange())).toEqual(f.secret);
    const another = await f.prepare();
    expect(another.frame).not.toEqual(f.envelope.frame);
    await f.store().receive(another.context, another.frame, f.keys, f.exchange());
    expect(readFileSync(f.path)).toEqual(disk);
    // Caller object property order is not a persistent identity format.
    expect(
      await f
        .store({ id: 'desktop', actor: 'owner', kind: 'device', memberInstance: 'owner-1' })
        .restore(0, f.keys, f.exchange())
    ).toEqual(f.secret);
  });

  it('restarts ciphertext delivery after a lost response and completes verified receiver persistence', async () => {
    const f = await fixture();
    const outboxPath = location();
    const id = 'd3'.repeat(16);
    const remoteRows = new Map<string, Uint8Array>();
    let offline = true;
    const remote = {
      put: async (deliveryId: string, bytes: Uint8Array) => {
        if (!offline) remoteRows.set(deliveryId, bytes.slice());
        throw new Error('lost-response');
      },
      read: async (deliveryId: string) => remoteRows.get(deliveryId)?.slice() ?? null,
    };
    const send = () =>
      new KeyDelivery(
        f.exchange(),
        new SqliteKeyDeliveryStore(outboxPath, f.org.anchor.genesis),
        remote
      );
    expect(await send().send(id, f.envelope.frame)).toBe('unknown');
    const saved = readFileSync(outboxPath);
    expect(remoteRows.size).toBe(0);
    offline = false;
    expect(await send().send(id)).toBe('observed');
    expect(remoteRows.get(id)).toEqual(f.envelope.frame);
    expect(readFileSync(outboxPath)).toEqual(saved);
    await f.store().receive(f.envelope.context, remoteRows.get(id)!, f.keys, f.exchange());
    expect(await f.store().restore(0, f.keys, f.exchange())).toEqual(f.secret);
    const other = await f.prepare();
    await expect(send().send(id, other.frame)).rejects.toThrow('key-delivery-id-reused');
    expect(readFileSync(outboxPath)).toEqual(saved);
  });

  it('delivers through the real Streams SDK with false ACK, lost response, restart and receiver restoration', async () => {
    const f = await fixture();
    // Separate synthetic HTTP peer: never shares bytes with the Org control stream.
    const backend = new HttpLedger();
    const outboxPath = location();
    const id = 'b1'.repeat(16);
    const remote = () =>
      new StreamsKeyDeliveryRemote(
        new StreamsClient({
          url: 'https://streams.example.test/v1/buckets/synthetic/streams/org-control',
          fetch: backend.fetch,
          retry: { maxAttempts: 0 },
        }),
        f.exchange()
      );
    const sender = () =>
      new KeyDelivery(
        f.exchange(),
        new SqliteKeyDeliveryStore(outboxPath, f.org.anchor.genesis),
        remote()
      );
    backend.mode = 'false-ack';
    expect(await sender().send(id, f.envelope.frame)).toBe('unknown');
    expect(backend.frames).toEqual([]);
    backend.mode = 'lost-response';
    expect(await sender().send(id)).toBe('observed');
    expect(backend.frames).toHaveLength(1);
    backend.mode = 'ok';
    expect(await sender().send(id)).toBe('observed');
    expect(backend.frames).toHaveLength(1);
    const fetched = await remote().read(id);
    expect(fetched).toEqual(f.envelope.frame);
    await f.store().receive(f.envelope.context, fetched!, f.keys, f.exchange());
    expect(await f.store().restore(0, f.keys, f.exchange())).toEqual(f.secret);
  });

  it('does not append through the SDK if the sender is revoked during the key-stream scan', async () => {
    const f = await fixture();
    const backend = new HttpLedger();
    const entered = deferred();
    const release = deferred();
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (new Request(input, init).method === 'GET') {
        entered.resolve();
        await release.promise;
      }
      return backend.fetch(input, init);
    };
    const remote = new StreamsKeyDeliveryRemote(
      new StreamsClient({
        url: 'https://streams.example.test/v1/buckets/synthetic/streams/org-control',
        fetch,
        retry: { maxAttempts: 0 },
      }),
      f.exchange()
    );
    const sending = remote.put('b2'.repeat(16), f.envelope.frame);
    const rejected = expect(sending).rejects.toThrow('key-sender-management-required');
    await entered.promise;
    const snapshot = await f.client.read();
    const revoked = await new WebCryptoControl().sign(
      {
        genesis: f.org.anchor.genesis,
        previous: snapshot.head,
        operationId: 'b3'.repeat(16),
        actor: 'owner',
        memberInstance: 'owner-1',
        device: 'desktop',
        ...encodeTeamAction({ type: 'device.revoke', configVersion: 0, deviceId: 'desktop' }),
      },
      [{ id: 'actor-device', key: f.org.device.privateKey }]
    );
    expect((await f.client.submit(revoked)).status).toBe('committed');
    release.resolve();
    await rejected;
    expect(backend.frames).toEqual([]);
  });

  it('does not dispatch through a failed durable write or a revocation during that write', async () => {
    for (const failure of ['disk', 'revoke']) {
      const f = await fixture();
      const outboxPath = location();
      const durable = new SqliteKeyDeliveryStore(outboxPath, f.org.anchor.genesis);
      await durable.exclusive(async (tx) => {
        expect(await tx.load('d4'.repeat(16))).toBeNull();
      });
      if (failure === 'disk')
        changeDatabase(
          outboxPath,
          "CREATE TRIGGER reject_key BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'disk-refused'); END;"
        );
      const store: KeyDeliveryStore = {
        exclusive: (work) =>
          durable.exclusive((tx) =>
            work({
              load: (id) => tx.load(id),
              save: async (id, hex) => {
                await tx.save(id, hex);
                const snapshot = await f.client.read();
                const revoked = await new WebCryptoControl().sign(
                  {
                    genesis: f.org.anchor.genesis,
                    previous: snapshot.head,
                    operationId: 'f3'.repeat(16),
                    actor: 'owner',
                    memberInstance: 'owner-1',
                    device: 'desktop',
                    ...encodeTeamAction({
                      type: 'device.revoke',
                      configVersion: 0,
                      deviceId: 'desktop',
                    }),
                  },
                  [{ id: 'actor-device', key: f.org.device.privateKey }]
                );
                expect((await f.client.submit(revoked)).status).toBe('committed');
              },
            })
          ),
      };
      const rows = new Map<string, Uint8Array>();
      const delivery = new KeyDelivery(f.exchange(), store, {
        put: async (id, bytes) => {
          rows.set(id, bytes);
        },
        read: async (id) => rows.get(id) ?? null,
      });
      await expect(delivery.send('d4'.repeat(16), f.envelope.frame)).rejects.toThrow(
        failure === 'disk' ? 'disk-refused' : 'key-sender-management-required'
      );
      expect(rows.size).toBe(0);
      expect(await durable.exclusive((tx) => tx.load('d4'.repeat(16)))).toBe(
        failure === 'disk' ? null : toHex(f.envelope.frame)
      );
    }
  });

  it('rejects forged outbox ciphertext and mismatched remote read-back', async () => {
    const f = await fixture();
    const outboxPath = location();
    const id = 'd5'.repeat(16);
    const store = new SqliteKeyDeliveryStore(outboxPath, f.org.anchor.genesis);
    const wrong = f.envelope.frame.slice();
    wrong[wrong.length - 1]! ^= 1;
    const rows = new Map<string, Uint8Array>();
    const remote = {
      put: async (deliveryId: string, bytes: Uint8Array) => {
        rows.set(deliveryId, bytes);
      },
      read: async () => wrong,
    };
    await store.exclusive((tx) => tx.save(id, toHex(wrong)));
    await expect(new KeyDelivery(f.exchange(), store, remote).send(id)).rejects.toThrow(
      'bad-key-signature'
    );
    expect(rows.size).toBe(0);
    const validStore = new SqliteKeyDeliveryStore(location(), f.org.anchor.genesis);
    await expect(
      new KeyDelivery(f.exchange(), validStore, remote).send(id, f.envelope.frame)
    ).rejects.toThrow('key-delivery-remote-mismatch');
    expect(rows.get(id)).toEqual(f.envelope.frame);
    expect(await validStore.exclusive((tx) => tx.load(id))).toBe(toHex(f.envelope.frame));
  });

  it('rejects wrong scope, missing private keys and current revocation without changing saved ciphertext', async () => {
    const f = await fixture();
    await f.store().receive(f.envelope.context, f.envelope.frame, f.keys, f.exchange());
    const disk = readFileSync(f.path);
    await expect(
      f.store({ ...f.recipient, id: 'other' }).restore(0, f.keys, f.exchange())
    ).rejects.toThrow('invalid-received-key-store');
    const other = await orgFixture();
    await expect(
      f
        .store()
        .restore(
          0,
          other.encryptionPairs.get(other.acceptedGenesis.owner.device.encryptionKey)!,
          f.exchange()
        )
    ).rejects.toThrow('key-recipient-mismatch');
    const snapshot = await f.client.read();
    const revoke = await new WebCryptoControl().sign(
      {
        genesis: f.org.anchor.genesis,
        previous: snapshot.head,
        operationId: 'f2'.repeat(16),
        actor: 'owner',
        memberInstance: 'owner-1',
        device: 'desktop',
        ...encodeTeamAction({ type: 'device.revoke', configVersion: 0, deviceId: 'desktop' }),
      },
      [{ id: 'actor-device', key: f.org.device.privateKey }]
    );
    expect((await f.client.submit(revoke)).status).toBe('committed');
    await expect(f.store().restore(0, f.keys, f.exchange())).rejects.toThrow(
      'inactive-key-recipient'
    );
    expect(readFileSync(f.path)).toEqual(disk);
  });

  it('reports disk rejection without claiming a saved key, and refuses a tampered persisted envelope', async () => {
    const f = await fixture();
    await expect(f.store().restore(0, f.keys, f.exchange())).rejects.toThrow(
      'missing-received-key'
    );
    changeDatabase(
      f.path,
      "CREATE TRIGGER reject_received BEFORE INSERT ON journal BEGIN SELECT RAISE(ABORT, 'disk-refused'); END;"
    );
    await expect(
      f.store().receive(f.envelope.context, f.envelope.frame, f.keys, f.exchange())
    ).rejects.toThrow('disk-refused');
    await expect(f.store().restore(0, f.keys, f.exchange())).rejects.toThrow(
      'missing-received-key'
    );
    changeDatabase(f.path, 'DROP TRIGGER reject_received');
    await f.store().receive(f.envelope.context, f.envelope.frame, f.keys, f.exchange());
    const tampered = f.envelope.frame.slice();
    tampered[tampered.length - 1]! ^= 1;
    const db = new DatabaseSync(f.path);
    try {
      const row = db.prepare('SELECT payload FROM journal WHERE id=1').get()!;
      expect(typeof row.payload).toBe('string');
      db.prepare('UPDATE journal SET payload=? WHERE id=1').run(
        String(row.payload).replace(toHex(f.envelope.frame), toHex(tampered))
      );
    } finally {
      db.close();
    }
    const disk = readFileSync(f.path);
    await expect(f.store().restore(0, f.keys, f.exchange())).rejects.toThrow('bad-key-signature');
    expect(readFileSync(f.path)).toEqual(disk);
  });

  it('retains ciphertext if the final authority refresh fails, then restores it after reconnection', async () => {
    const f = await fixture();
    const exchange = f.exchange();
    const open = exchange.open.bind(exchange);
    exchange.open = async (...args) => {
      const secret = await open(...args);
      f.stream.onRead = async () => {
        throw new Error('offline-after-verification');
      };
      return secret;
    };
    await expect(
      f.store().receive(f.envelope.context, f.envelope.frame, f.keys, exchange)
    ).rejects.toThrow('offline-after-verification');
    const disk = readFileSync(f.path);
    expect(disk.includes(Buffer.from(toHex(f.envelope.frame)))).toBe(true);
    f.stream.onRead = undefined;
    expect(await f.store().restore(0, f.keys, f.exchange())).toEqual(f.secret);
    expect(readFileSync(f.path)).toEqual(disk);
  });
});

describe('detached joining consent persistence', () => {
  it.each(['member.admit', 'member.cancel'] as const)(
    'recovers the exact pending %s and preserves its consumed request after restart',
    async (type) => {
      const org = await orgFixture();
      const applicant = await orgFixture();
      const member = {
        ...applicant.acceptedGenesis.owner,
        userId: 'applicant',
        instance: 'applicant-1',
      };
      const request = await signJoinRequest(
        {
          genesis: org.anchor.genesis,
          requestId: 'e1'.repeat(16),
          approver: { userId: 'owner', instance: 'owner-1' },
          expiresAt: null,
          member,
        },
        { identity: applicant.recovery.privateKey, device: applicant.device.privateKey }
      );
      const actor = type === 'member.admit' ? org.acceptedGenesis.owner : member;
      const key = type === 'member.admit' ? org.device.privateKey : applicant.device.privateKey;
      const event = {
        genesis: org.anchor.genesis,
        previous: org.anchor.genesis,
        operationId: 'e2'.repeat(16),
        actor: actor.userId,
        memberInstance: actor.instance,
        device: actor.device.id,
        ...encodeTeamAction({ type, request, configVersion: 0 }),
      };
      const crypto = new WebCryptoControl();
      const pending = await crypto.sign(event, [{ id: 'actor-device', key }]);
      const path = location();
      const stream = new MemoryStream();
      stream.onAppend = async () => {
        throw new Error('offline');
      };
      const client = () =>
        new ControlLogClient(
          org.anchor,
          ownerManagedTeamPolicy,
          new SqliteControlStore(path),
          stream
        );
      expect((await client().submit(pending)).status).toBe('unknown');
      expect((await load(path))!.pending).toBe(pending);
      stream.onAppend = async (offset, submittedWire) => {
        expect(submittedWire).toBe(pending);
        return stream.append(offset, submittedWire);
      };
      expect((await client().resume()).status).toBe('committed');
      const recovered = await client().read();
      expect(recovered.state.members.has('applicant')).toBe(type === 'member.admit');
      expect([...recovered.state.closedJoinRequests.values()]).toEqual([
        type === 'member.admit' ? 'admitted' : 'cancelled',
      ]);
      expect((await load(path))!.pending).toBeNull();
      expect(stream.rows.map((row) => row.wire)).toEqual([pending]);
      const retryEvent = { ...event, previous: recovered.head, operationId: 'e3'.repeat(16) };
      const retry = await crypto.sign(retryEvent, [{ id: 'actor-device', key }]);
      await expect(client().submit(retry)).rejects.toThrow('join-request-closed');
      expect(await client().read()).toEqual(recovered);
    }
  );
});
async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  children.delete(child);
}
async function holder(path: string, mode: 'save' | 'hold' | 'uncommitted') {
  const child = fork(new URL('./node-store-child.ts', import.meta.url), [path], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  children.add(child);
  let stderr = '';
  child.stderr!.on('data', (chunk) => {
    stderr += String(chunk);
  });
  const failed = new Promise<never>((_, reject) =>
    child.once('exit', (code, signal) =>
      reject(new Error(`fixture exited: ${code}/${signal}: ${stderr}`))
    )
  );
  expect(await Promise.race([once(child, 'message'), failed])).toEqual(['ready', undefined]);
  const locked = once(child, 'message');
  child.send({ mode, genesis, pending: wire });
  expect(await Promise.race([locked, failed])).toEqual(['locked', undefined]);
  return child;
}
afterEach(async () => {
  await Promise.all([...children].map(kill));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

let signedWire: string;
let secondSignedWire: string;
let policy: ControlPolicy<number>;
beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey('Ed25519', false, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  policy = {
    transition(state) {
      return { state: state + 1, signers: [{ id: 'actor-device', publicKey }] };
    },
  };
  signedWire = await new WebCryptoControl().sign(
    {
      genesis,
      previous: genesis,
      operationId: '01'.repeat(16),
      actor: 'A',
      memberInstance: 'A1',
      device: 'desktop',
      kind: 'test',
      payload: '',
    },
    [{ id: 'actor-device', key: pair.privateKey }]
  );
  secondSignedWire = await new WebCryptoControl().sign(
    {
      ...decodeRecord(signedWire).event,
      previous: await new WebCryptoControl().hashRecord(signedWire),
      operationId: '02'.repeat(16),
    },
    [{ id: 'actor-device', key: pair.privateKey }]
  );
});

describe('SQLite control journal (real files, no product database)', () => {
  it('never persists half a multi-record page, including a SQLite save failure and restart', async () => {
    const path = location();
    const stream = new MemoryStream();
    stream.pageSize = 2;
    stream.append(stream.tail, signedWire);
    stream.append(stream.tail, secondSignedWire);
    const make = () =>
      new ControlLogClient({ genesis, state: 0 }, policy, new SqliteControlStore(path), stream);
    await new SqliteControlStore(path).exclusive((tx) => tx.save(journal()));
    changeDatabase(
      path,
      `CREATE TRIGGER reject_page BEFORE INSERT ON journal
      WHEN json_array_length(json_extract(NEW.payload, '$[2]')) > 0
      BEGIN SELECT RAISE(ABORT, 'page-write-failure'); END;`
    );
    await expect(make().read()).rejects.toThrow('page-write-failure');
    expect(await load(path)).toEqual(journal());
    changeDatabase(path, 'DROP TRIGGER reject_page;');
    expect(await make().read()).toMatchObject({ state: 2, length: 2 });
    expect(await load(path)).toEqual({
      ...journal(),
      pages: [{ records: [signedWire, secondSignedWire], nextOffset: stream.tail }],
    });
    expect(await make().read()).toMatchObject({ state: 2, length: 2 });
  });

  it('rejects the old per-record journal version without resetting or rewriting its payload', async () => {
    const path = location();
    await new SqliteControlStore(path).exclusive((tx) => tx.save(journal()));
    const oldPayload = JSON.stringify([
      'lody-control-journal/v1',
      genesis,
      [[wire, 'old-cursor']],
      wire,
    ]);
    const db = new DatabaseSync(path);
    db.prepare('UPDATE journal SET payload=?').run(oldPayload);
    db.exec('PRAGMA user_version=1;');
    db.close();
    await expect(load(path)).rejects.toThrow('unsupported-journal-database');
    const reader = new DatabaseSync(path);
    expect(reader.prepare('SELECT payload FROM journal').get()?.payload).toBe(oldPayload);
    expect(reader.prepare('PRAGMA user_version').get()?.user_version).toBe(1);
    reader.close();
  });

  it.each(['v1', 'v2'])(
    'rejects %s Org journals with committed pages or pending-only bytes without rewriting or submitting',
    async (legacy) => {
      const { acceptedGenesis, device, management, anchor } = await orgFixture();
      const owner = acceptedGenesis.owner;
      // Pin the old signed domains independently; do not derive legacy fixtures from the new codec.
      const legacyGenesis = createHash('sha256')
        .update(
          JSON.stringify([
            `lody-team-genesis/${legacy}`,
            acceptedGenesis.nonce,
            owner.userId,
            owner.instance,
            owner.recoverySigningKey,
            owner.recoveryEncryptionKey,
            owner.device.id,
            owner.device.signingKey,
            owner.device.encryptionKey,
            owner.device.kind,
            management.publicKey,
            'c2'.repeat(32),
          ])
        )
        .digest('hex');
      expect(anchor.genesis).not.toBe(legacyGenesis);
      const cryptoControl = new WebCryptoControl();
      const legacyWire = await cryptoControl.sign(
        {
          genesis: legacyGenesis,
          previous: legacyGenesis,
          operationId: 'c3'.repeat(16),
          actor: owner.userId,
          memberInstance: owner.instance,
          device: owner.device.id,
          kind: 'team-device-revoke',
          payload: toHex(
            new TextEncoder().encode(
              JSON.stringify([
                `lody-team-action/${legacy}`,
                'device.revoke',
                '0',
                ...(legacy === 'v1' ? ['device'] : []),
                'desktop',
              ])
            )
          ),
        },
        [{ id: 'actor-device', key: device.privateKey }]
      );
      const record = decodeRecord(legacyWire);
      expect(
        await cryptoControl.verify(
          device.publicKey,
          signingBytes(record.event, ['actor-device']),
          record.signatures[0]![1]
        )
      ).toBe(true);

      for (const committed of [false, true]) {
        const path = location();
        const stream = new MemoryStream();
        if (committed) stream.append(stream.tail, legacyWire);
        const saved: ControlJournal = {
          genesis: legacyGenesis,
          pages: committed ? stream.pages : [],
          pending: committed ? null : legacyWire,
        };
        await new SqliteControlStore(path).exclusive((tx) => tx.save(saved));
        const before = readFileSync(path);
        const beforeRows = structuredClone(stream.rows);
        for (const method of ['read', 'resume'] as const) {
          const client = new ControlLogClient(
            anchor,
            ownerManagedTeamPolicy,
            new SqliteControlStore(path),
            stream
          );
          await expect(client[method]()).rejects.toThrow('journal-anchor-mismatch');
          expect(await load(path)).toEqual(saved);
          expect(readFileSync(path)).toEqual(before);
          expect(stream.rows).toEqual(beforeRows);
        }
      }
    }
  );

  it('replays a current Org policy record after reopening its SQLite journal', async () => {
    const { acceptedGenesis, device, anchor } = await orgFixture();
    const path = location();
    const stream = new MemoryStream();
    const owner = acceptedGenesis.owner;
    const currentWire = await new WebCryptoControl().sign(
      {
        genesis: anchor.genesis,
        previous: anchor.genesis,
        operationId: 'c4'.repeat(16),
        actor: owner.userId,
        memberInstance: owner.instance,
        device: owner.device.id,
        ...encodeTeamAction({ type: 'device.revoke', configVersion: 0, deviceId: 'desktop' }),
      },
      [{ id: 'actor-device', key: device.privateKey }]
    );
    const make = () =>
      new ControlLogClient(anchor, ownerManagedTeamPolicy, new SqliteControlStore(path), stream);
    expect(await make().submit(currentWire)).toMatchObject({ status: 'committed' });
    expect(await load(path)).toEqual({
      genesis: anchor.genesis,
      pages: stream.pages,
      pending: null,
    });
    const restored = await make().read();
    expect(restored.length).toBe(1);
    expect(restored.state.requiresKeyRotation).toBe(true);
    expect(restored.state.members.get(owner.userId)?.devices.size).toBe(0);
    expect(restored.state.owner.userId).toBe(owner.userId);
    await expect(make().resume()).rejects.toThrow('no-pending-attempt');
  });

  it('persists exact bytes independently of callback success and owns input/output copies', async () => {
    const path = location();
    const store = new SqliteControlStore(path);
    expect(await load(path)).toBeNull();
    const value = journal();
    await expect(
      store.exclusive(async (tx) => {
        const saving = tx.save(value);
        (value as { pending: string | null }).pending = null;
        await saving;
        const loaded = await tx.load();
        expect(loaded).toEqual(journal());
        (loaded as { pending: string | null }).pending = null;
        expect(await tx.load()).toEqual(journal());
        throw new Error('later-network-failure');
      })
    ).rejects.toThrow('later-network-failure');
    expect(await load(path)).toEqual(journal());
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('keeps the lock across saves and awaits; contention never runs a second callback', async () => {
    const path = location();
    const entered = deferred();
    const release = deferred();
    const store = new SqliteControlStore(path);
    const first = store.exclusive(async (tx) => {
      await tx.save(journal());
      entered.resolve();
      await release.promise;
      await tx.save({ ...journal(), pending: null });
    });
    await entered.promise;
    try {
      for (const contender of [store, new SqliteControlStore(path)]) {
        await expect(
          contender.exclusive(async (tx) => {
            await tx.save({ genesis, pages: [], pending: null });
            throw new Error('entered-without-exclusive-lock');
          })
        ).rejects.toThrow('journal-busy');
      }
    } finally {
      release.resolve();
      await first;
    }
    expect(await load(path)).toEqual({ ...journal(), pending: null });
  });

  for (const mode of ['hold', 'save', 'uncommitted'] as const) {
    it(`recovers ${mode} process termination and releases the OS lock`, async () => {
      const path = location();
      const baseline = { ...journal(), pending: null };
      await new SqliteControlStore(path).exclusive((tx) => tx.save(baseline));
      const child = await holder(path, mode);
      await expect(load(path)).rejects.toThrow('journal-busy');
      await kill(child);
      expect(await load(path)).toEqual(mode === 'save' ? journal() : baseline);
    });
  }

  it('expires escaped transaction handles on success and failure', async () => {
    const path = location();
    let escaped!: JournalTransaction;
    for (const fail of [false, true]) {
      const result = new SqliteControlStore(path).exclusive(async (tx) => {
        escaped = tx;
        if (fail) throw new Error('failure');
      });
      if (fail) await expect(result).rejects.toThrow('failure');
      else await result;
      await expect(escaped.load()).rejects.toThrow('journal-transaction-ended');
      await expect(escaped.save(journal())).rejects.toThrow('journal-transaction-ended');
      expect(await load(path)).toBeNull();
    }
  });

  it('fails closed on foreign schemas, unknown versions and malformed persisted data', async () => {
    const foreign = location();
    changeDatabase(
      foreign,
      "CREATE TABLE unrelated (value TEXT); INSERT INTO unrelated VALUES ('keep');"
    );
    const before = readFileSync(foreign);
    await expect(load(foreign)).rejects.toThrow('foreign-journal-database');
    expect(readFileSync(foreign)).toEqual(before);
    const path = location();
    await new SqliteControlStore(path).exclusive((tx) => tx.save(journal()));
    changeDatabase(path, 'PRAGMA user_version=3;');
    await expect(load(path)).rejects.toThrow('unsupported-journal-database');
    changeDatabase(path, "PRAGMA user_version=2; UPDATE journal SET payload='[]';");
    await expect(load(path)).rejects.toThrow('invalid-journal');
    await expect(load(path)).rejects.toThrow('invalid-journal');
  });

  it('rejects memory/relative paths, symbolic links and hard links without modifying data', async () => {
    for (const path of [':memory:', 'relative.sqlite'])
      await expect(load(path)).rejects.toThrow('journal-path-must-be-absolute');
    const path = location();
    await new SqliteControlStore(path).exclusive((tx) => tx.save(journal()));
    symlinkSync(path, `${path}.symlink`);
    await expect(load(`${path}.symlink`)).rejects.toThrow('unsafe-journal-file');
    linkSync(path, `${path}.hardlink`);
    await expect(load(`${path}.hardlink`)).rejects.toThrow('unsafe-journal-file');
    await expect(load(path)).rejects.toThrow('unsafe-journal-file');
  });

  it('resumes a real signed pending request after lost server response and a new store instance', async () => {
    const path = location();
    const stream = new MemoryStream();
    const make = () =>
      new ControlLogClient({ genesis, state: 0 }, policy, new SqliteControlStore(path), stream);
    stream.onAppend = async (offset, body) => {
      stream.append(offset, body);
      stream.onRead = async () => {
        throw new Error('offline');
      };
      throw new Error('lost-response');
    };
    await expect(make().submit(signedWire)).rejects.toThrow('offline');
    expect((await load(path))?.pending).toBe(signedWire);
    stream.onRead = undefined;
    stream.onAppend = async () => {
      throw new Error('must-not-resubmit-observed-record');
    };
    expect(await make().resume()).toMatchObject({
      status: 'committed',
      snapshot: { state: 1, length: 1 },
    });
    expect(await load(path)).toEqual({ genesis, pages: stream.pages, pending: null });
  });

  it('retains pending when SQLite rejects the checkpoint after server commit', async () => {
    const path = location();
    await load(path);
    changeDatabase(
      path,
      `CREATE TRIGGER reject_checkpoint BEFORE INSERT ON journal
      WHEN json_array_length(json_extract(NEW.payload, '$[2]')) > 0
      BEGIN SELECT RAISE(ABORT, 'checkpoint-write-failure'); END;`
    );
    const stream = new MemoryStream();
    const make = () =>
      new ControlLogClient({ genesis, state: 0 }, policy, new SqliteControlStore(path), stream);
    await expect(make().submit(signedWire)).rejects.toThrow('checkpoint-write-failure');
    expect(await load(path)).toEqual({ genesis, pages: [], pending: signedWire });
    expect(stream.rows).toHaveLength(1);
    changeDatabase(path, 'DROP TRIGGER reject_checkpoint;');
    expect(await make().resume()).toMatchObject({ status: 'committed', snapshot: { state: 1 } });
    expect(await load(path)).toEqual({ genesis, pages: stream.pages, pending: null });
  });

  it('does not upload when SQLite rejects saving the pending request', async () => {
    const path = location();
    await load(path);
    changeDatabase(
      path,
      `CREATE TRIGGER reject_pending BEFORE INSERT ON journal
      WHEN json_type(NEW.payload, '$[3]') != 'null'
      BEGIN SELECT RAISE(ABORT, 'pending-write-failure'); END;`
    );
    const stream = new MemoryStream();
    const client = new ControlLogClient(
      { genesis, state: 0 },
      policy,
      new SqliteControlStore(path),
      stream
    );
    await expect(client.submit(signedWire)).rejects.toThrow('pending-write-failure');
    expect(stream.rows).toEqual([]);
    expect(await load(path)).toBeNull();
    changeDatabase(path, 'DROP TRIGGER reject_pending;');
    expect(await client.submit(signedWire)).toMatchObject({ status: 'committed' });
    expect(stream.rows).toHaveLength(1);
  });

  it('bounds persisted data and leaves the prior checkpoint intact on oversized saves', async () => {
    const path = location();
    const store = new SqliteControlStore(path);
    await store.exclusive((tx) => tx.save(journal()));
    const original = decodeRecord(wire);
    const largeWire = encodeRecord({
      ...original,
      event: { ...original.event, payload: '00'.repeat(65536) },
    });
    const oversized = {
      ...journal(),
      pages: Array.from({ length: 129 }, (_, i) => ({
        records: [largeWire],
        nextOffset: `opaque-${i}`,
      })),
    };
    await expect(store.exclusive((tx) => tx.save(oversized))).rejects.toThrow('journal-too-large');
    expect(await load(path)).toEqual(journal());
    changeDatabase(path, 'UPDATE journal SET payload=CAST(zeroblob(16777217) AS TEXT);');
    await expect(load(path)).rejects.toThrow('journal-too-large');
  });

  it('replays disk records cryptographically instead of trusting the SQLite checkpoint', async () => {
    const path = location();
    const original = decodeRecord(signedWire);
    const tampered = encodeRecord({ ...original, event: { ...original.event, payload: '01' } });
    await new SqliteControlStore(path).exclusive((tx) =>
      tx.save({ genesis, pending: null, pages: [{ records: [tampered], nextOffset: 'opaque-1' }] })
    );
    const client = new ControlLogClient(
      { genesis, state: 0 },
      policy,
      new SqliteControlStore(path),
      new MemoryStream()
    );
    await expect(client.read()).rejects.toThrow('bad-signature');
    expect((await load(path))?.pages[0]?.records[0]).toBe(tampered);
  });
});
