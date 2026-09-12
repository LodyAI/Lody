import { createHash } from 'node:crypto';
import { verifyAsync } from '@noble/ed25519';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkSigningKey } from '../src/wire';
import { MemoryStore, MemoryStream, deferred } from './control-fixtures';
import {
  ControlLogClient,
  WebCryptoControl,
  decodeRecord,
  encodeRecord,
  fromHex,
  replayChain,
  signingBytes,
  toHex,
  type ControlEvent,
  type ControlPolicy,
  type TrustAnchor,
} from '../src';

const crypto = new WebCryptoControl();
const genesis = 'a1'.repeat(32);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const identityKey = '01' + '00'.repeat(31);
const publicForgery = '01' + '00'.repeat(63);
type DeviceKey = { publicKey: string; key: CryptoKey };
const keys: Record<string, DeviceKey> = {};

beforeAll(async () => {
  for (const id of ['a', 'b', 'c', 'management', 'attacker']) {
    const pair = (await globalThis.crypto.subtle.generateKey('Ed25519', false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    keys[id] = {
      key: pair.privateKey,
      publicKey: toHex(
        new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', pair.publicKey))
      ),
    };
  }
});

type State = {
  members: Record<string, { instance: string; role: 'owner' | 'admin' | 'member' }>;
  devices: Record<string, { user: string; key: string }>;
  management: string;
};
function anchor(): TrustAnchor<State> {
  return {
    genesis,
    state: {
      members: { A: { instance: 'A1', role: 'owner' }, B: { instance: 'B1', role: 'admin' } },
      devices: {
        a: { user: 'A', key: keys.a!.publicKey },
        b: { user: 'B', key: keys.b!.publicKey },
      },
      management: keys.management!.publicKey,
    },
  };
}
function fail(message: string): never {
  throw new Error(message);
}

// Deliberately synthetic policy, NOT the product role/recovery protocol.
const policy: ControlPolicy<State> = {
  transition(state, event) {
    const member = state.members[event.actor];
    const device = state.devices[event.device];
    if (!member || member.instance !== event.memberInstance || device?.user !== event.actor)
      fail('not-authorized');
    const signers = [{ id: event.device, publicKey: device.key }];
    if (event.kind === 'invite') {
      if (member.role === 'member') fail('not-authorized');
      const tuple: unknown = JSON.parse(decoder.decode(fromHex(event.payload)));
      if (!Array.isArray(tuple) || tuple.length !== 4 || !tuple.every((x) => typeof x === 'string'))
        fail('bad-action');
      const [user, instance, deviceId, publicKey] = tuple as [string, string, string, string];
      if (state.members[user] || state.devices[deviceId]) fail('already-member');
      state.members[user] = { instance, role: 'member' };
      state.devices[deviceId] = { user, key: publicKey };
    } else if (event.kind === 'remove') {
      if (member.role !== 'owner') fail('not-authorized');
      const user = decoder.decode(fromHex(event.payload));
      if (!state.members[user] || state.members[user].role === 'owner') fail('bad-removal');
      delete state.members[user];
      for (const [id, entry] of Object.entries(state.devices))
        if (entry.user === user) delete state.devices[id];
      signers.push({ id: 'management', publicKey: state.management });
    } else fail('unknown-action');
    return { state, signers };
  },
};

function invite(previous = genesis, id = 1): ControlEvent {
  return {
    genesis,
    previous,
    operationId: id.toString(16).padStart(32, '0'),
    actor: 'B',
    memberInstance: 'B1',
    device: 'b',
    kind: 'invite',
    payload: toHex(encoder.encode(JSON.stringify(['C', 'C1', 'c', keys.c!.publicKey]))),
  };
}
function removal(previous = genesis, id = 2): ControlEvent {
  return {
    genesis,
    previous,
    operationId: id.toString(16).padStart(32, '0'),
    actor: 'A',
    memberInstance: 'A1',
    device: 'a',
    kind: 'remove',
    payload: toHex(encoder.encode('B')),
  };
}
async function sign(
  event: ControlEvent,
  ids = event.kind === 'remove' ? ['a', 'management'] : ['b']
): Promise<string> {
  return crypto.sign(
    event,
    ids.map((id) => ({ id, key: keys[id]!.key }))
  );
}
function client(store = new MemoryStore(), stream = new MemoryStream()) {
  return { store, stream, log: new ControlLogClient(anchor(), policy, store, stream, crypto) };
}

describe('canonical wire and real cryptography', () => {
  it('verifies RFC 8032 section 7.1 test 1 and rejects altered inputs', async () => {
    const publicKey = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const signature =
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f' +
      'b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
    expect(await crypto.verify(publicKey, new Uint8Array(), signature)).toBe(true);
    expect(await crypto.verify(publicKey, new Uint8Array([1]), signature)).toBe(false);
    expect(await crypto.verify(keys.attacker!.publicKey, new Uint8Array(), signature)).toBe(false);
  });

  it('rejects a public constant forgery under an identity public key', async () => {
    for (const message of [new Uint8Array(), encoder.encode('arbitrary control action')]) {
      expect(await crypto.verify(identityKey, message, publicForgery)).toBe(false);
    }
  });

  it('rejects all eight small-order points, encoding aliases and mixed-order signing keys', async () => {
    // Public vectors: noble-ed25519 3.2.0 test/ed25519.helpers.ts and
    // test/vectors/ed25519/edge-cases.json. No test/production secret keys.
    const forbidden = [
      identityKey,
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
      '00'.repeat(31) + '80',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
      'ec' + 'ff'.repeat(30) + '7f',
      '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc85',
      '00'.repeat(32),
      'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac03fa',
      '01' + '00'.repeat(30) + '80', // x=0 with its sign bit set
      'ee' + 'ff'.repeat(30) + '7f', // identity encoded with unreduced y=p+1
      'ff'.repeat(32),
      'cdb267ce40c5cd45306fa5d2f29731459387dbf9eb933b7bd5aed9a765b88d4d',
    ];
    for (const key of forbidden) {
      expect(() => checkSigningKey(key)).toThrow('invalid-signing-key');
      expect(await crypto.verify(key, encoder.encode('test'), publicForgery)).toBe(false);
    }
    expect(() => checkSigningKey(keys.a!.publicKey)).not.toThrow();
  });

  it('requires prime-subgroup R but allows a valid identity R with a normal public key', async () => {
    // Synthetic known-answer fixtures with A=basepoint (known scalar 1).
    // S=SHA512(R || A || message) mod L. The first only satisfies the cofactored
    // equation; the second also satisfies the strict prime-subgroup equation.
    const publicKey = '58' + '66'.repeat(31);
    const message = encoder.encode('Lody signature profile fixture');
    const cases = [
      ['00'.repeat(32) + '3f1a75a341a57a8a7c0b8a556419ab2f487caae889f6d88ef25e70aa36dbac09', false],
      [identityKey + '55b6570482a983af4fd1cad8f6b0bd79e5c5bd65a28138118e8262044a7e9001', true],
    ] as const;
    for (const [signature, accepted] of cases) {
      expect(
        await verifyAsync(fromHex(signature), message, fromHex(publicKey), { zip215: false })
      ).toBe(true);
      expect(await crypto.verify(publicKey, message, signature)).toBe(accepted);
    }
  });

  it('rejects scalar overflow and noncanonical R', async () => {
    // RFC 8032 test 1: adding subgroup order L to S must not preserve validity.
    const publicKey = 'd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a';
    const signature =
      'e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555f' +
      'b8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b';
    expect(await crypto.verify(publicKey, new Uint8Array(), signature)).toBe(true);
    const order = fromHex('edd3f55c1a631258d69cf7a2def9de1400000000000000000000000000000010');
    const changed = fromHex(signature);
    let carry = 0;
    for (let i = 0; i < 32; i++) {
      const sum = changed[32 + i]! + order[i]! + carry;
      changed[32 + i] = sum & 255;
      carry = sum >>> 8;
    }
    expect(await crypto.verify(publicKey, new Uint8Array(), toHex(changed))).toBe(false);
    expect(
      await crypto.verify(publicKey, new Uint8Array(), 'ff'.repeat(32) + signature.slice(64))
    ).toBe(false);
  });

  it('has an independently specified canonical serialization and hash domain', async () => {
    const event = { ...invite(), payload: '' };
    const sig = '00'.repeat(64);
    const expected = `[["lody-control/v1","${genesis}","${genesis}","${'0'.repeat(31)}1","B","B1","b","invite",""],[["b","${sig}"]]]`;
    expect(encodeRecord({ event, signatures: [['b', sig]] })).toBe(expected);
    expect(decoder.decode(signingBytes(event, ['b']))).toBe(
      `[["lody-control/v1","${genesis}","${genesis}","${'0'.repeat(31)}1","B","B1","b","invite",""],["b"]]`
    );
    const hash = createHash('sha256')
      .update('lody-control-record/v1\0')
      .update(expected)
      .digest('hex');
    expect(await crypto.hashRecord(expected)).toBe(hash);
    expect(hash).not.toBe(createHash('sha256').update(expected).digest('hex'));
  });

  it('rejects aliases, malformed fields, duplicate/extra signers and oversized messages', async () => {
    const wire = await sign(invite());
    for (const bad of [
      ` ${wire}`,
      wire.replace('"b"', '"\\u0062"'),
      wire.replace('lody-control/v1', 'lody-control/v2'),
      wire + '[]',
      '[]',
      'x'.repeat(150 * 1024),
    ]) {
      expect(() => decodeRecord(bad)).toThrow();
    }
    for (const change of [
      { operationId: 'x' },
      { genesis: 'A1'.repeat(32) },
      { actor: 'B\ud800' },
      { payload: '00'.repeat(65537) },
    ]) {
      await expect(sign({ ...invite(), ...change })).rejects.toThrow();
    }
    const { event, signatures } = decodeRecord(wire);
    expect(() => encodeRecord({ event, signatures: [...signatures, ...signatures] })).toThrow(
      'unsorted-or-duplicate'
    );
    const tuple = JSON.parse(wire) as unknown[][];
    tuple[0]!.push('extra');
    expect(() => decodeRecord(JSON.stringify(tuple))).toThrow('invalid-event');
  });

  it('binds every event field and the signer list', async () => {
    const wire = await sign(invite());
    const { event, signatures } = decodeRecord(wire);
    for (const field of [
      'genesis',
      'previous',
      'operationId',
      'actor',
      'memberInstance',
      'device',
      'kind',
      'payload',
    ] as const) {
      const changed = {
        ...event,
        [field]:
          field === 'payload'
            ? '00'
            : field === 'genesis' || field === 'previous'
              ? 'b2'.repeat(32)
              : field === 'operationId'
                ? 'ff'.repeat(16)
                : 'different',
      };
      expect(
        await crypto.verify(keys.b!.publicKey, signingBytes(changed, ['b']), signatures[0]![1])
      ).toBe(false);
    }
    expect(
      await crypto.verify(keys.b!.publicKey, signingBytes(event, ['attacker']), signatures[0]![1])
    ).toBe(false);
  });

  it('copies input before awaiting crypto and supports non-extractable signing keys', async () => {
    const event = { ...invite() };
    const original = { ...event };
    const pending = sign(event);
    event.actor = 'attacker';
    const wire = await pending;
    expect(decodeRecord(wire).event).toEqual(original);
    expect(keys.b!.key.extractable).toBe(false);
    await expect(replayChain(anchor(), [wire], policy)).resolves.toMatchObject({ length: 1 });
  });
});

describe('verified chain and prior-state authorization', () => {
  it('retains C when invitation precedes removal and rejects the opposite order', async () => {
    const add = await sign(invite());
    const removeAfter = await sign(removal(await crypto.hashRecord(add)));
    const result = await replayChain(anchor(), [add, removeAfter], policy);
    expect(Object.keys(result.state.members).sort()).toEqual(['A', 'C']);
    expect(Object.keys(result.state.devices).sort()).toEqual(['a', 'c']);
    const remove = await sign(removal());
    const staleActor = await sign(invite(await crypto.hashRecord(remove)));
    await expect(replayChain(anchor(), [remove, staleActor], policy)).rejects.toThrow(
      'not-authorized'
    );
  });

  it('requires device and management signatures, not a self-advertised public key', async () => {
    const remove = removal();
    await expect(
      replayChain(anchor(), [await sign(remove, ['management'])], policy)
    ).rejects.toThrow('wrong-signers');
    await expect(replayChain(anchor(), [await sign(remove, ['a'])], policy)).rejects.toThrow(
      'wrong-signers'
    );
    const forged = await crypto.sign(invite(), [{ id: 'b', key: keys.attacker!.key }]);
    await expect(replayChain(anchor(), [forged], policy)).rejects.toThrow('bad-signature');
    await expect(
      replayChain(anchor(), [await sign({ ...invite(), memberInstance: 'B0' })], policy)
    ).rejects.toThrow('not-authorized');
    await expect(
      replayChain(anchor(), [await sign({ ...invite(), kind: 'unknown' })], policy)
    ).rejects.toThrow('unknown-action');
  });

  it('rejects duplicate operation IDs, gaps, swapped records and cross-Team records', async () => {
    const first = await sign(invite());
    const second = await sign(removal(await crypto.hashRecord(first)));
    await expect(replayChain(anchor(), [second], policy)).rejects.toThrow('wrong-parent');
    await expect(replayChain(anchor(), [second, first], policy)).rejects.toThrow('wrong-parent');
    const reused = await sign(removal(await crypto.hashRecord(first), 1));
    await expect(replayChain(anchor(), [first, reused], policy)).rejects.toThrow(
      'operation-reused'
    );
    await expect(
      replayChain({ ...anchor(), genesis: 'b2'.repeat(32) }, [first], policy)
    ).rejects.toThrow('wrong-genesis');
  });

  it("does not let policy mutation alter a failed transition's anchor", async () => {
    const trusted = anchor();
    const before = structuredClone(trusted);
    const forged = await crypto.sign(invite(), [{ id: 'b', key: keys.attacker!.key }]);
    await expect(replayChain(trusted, [forged], policy)).rejects.toThrow('bad-signature');
    expect(trusted).toEqual(before);
  });
});

describe('CAS driver and durable outbox', () => {
  it('returns historical authority only alongside a fully verified current prefix, including after restart', async () => {
    const { log, stream, store } = client();
    const wire = await sign(invite());
    const head = await crypto.hashRecord(wire);
    const remove = await sign(removal(head));
    stream.append(stream.tail, wire);
    stream.append(stream.tail, remove);
    store.journal = { genesis, pages: [], pending: wire };
    const evidence = await log.readAtHead(head);
    expect(evidence.atHead).toEqual(await replayChain(anchor(), [wire], policy));
    expect(evidence.snapshot).toEqual(await replayChain(anchor(), [wire, remove], policy));
    expect(evidence.atHead!.state.members.B).toBeDefined();
    expect(evidence.snapshot.state.members.B).toBeUndefined();
    expect(store.journal!.pending).toBe(wire);
    expect(await client(store, stream).log.readAtHead(head)).toEqual(evidence);
    expect((await log.readAtHead(genesis)).atHead!.state).toEqual(anchor().state);
    expect((await log.readAtHead('ff'.repeat(32))).atHead).toBeNull();
    expect((await log.readAtHead(evidence.snapshot.head)).atHead).toEqual(evidence.snapshot);
    const previousJournal = structuredClone(store.journal);
    stream.onRead = async () => {
      throw new Error('offline');
    };
    await expect(log.readAtHead(head)).rejects.toThrow('offline');
    expect(store.journal).toEqual(previousJournal);
  });

  it('does not return a historical head through a bad later page or failed checkpoint', async () => {
    const { log, stream, store } = client();
    const wire = await sign(invite());
    const head = await crypto.hashRecord(wire);
    stream.append(stream.tail, wire);
    store.failSave = 'before';
    await expect(log.readAtHead(head)).rejects.toThrow('disk-failure');
    expect(store.journal).toBeNull();
    const bad = await sign(removal(head), ['a']);
    stream.append(stream.tail, bad);
    await expect(log.readAtHead(head)).rejects.toThrow('wrong-signers');
    expect(store.journal!.pages).toEqual([stream.pages[0]]);
    await expect(log.readAtHead(genesis)).rejects.toThrow('wrong-signers');
  });

  it('does not submit or clear an absent pending operation while looking it up', async () => {
    const { log, store, stream } = client();
    const wire = await sign(invite());
    store.journal = { genesis, pages: [], pending: wire };
    expect(await log.readOperation(invite().operationId)).toEqual({
      wire: null,
      snapshot: { head: genesis, length: 0, state: anchor().state },
    });
    expect(stream.rows).toEqual([]);
    expect(store.journal).toEqual({ genesis, pages: [], pending: wire });
  });

  it('returns exact historical wire with the fully refreshed state and preserves pending', async () => {
    const { log, store, stream } = client();
    const wire = await sign(invite());
    const remove = await sign(removal(await crypto.hashRecord(wire)));
    stream.append(stream.tail, wire);
    stream.append(stream.tail, remove);
    store.journal = { genesis, pages: [], pending: wire };
    const result = await log.readOperation(invite().operationId);
    expect(result.wire).toBe(wire);
    expect(result.snapshot.length).toBe(2);
    expect(result.snapshot.state.members.B).toBeUndefined();
    expect(result.snapshot.state.members.C).toBeDefined();
    expect(store.journal).toEqual({ genesis, pages: stream.pages, pending: wire });
    expect(await client(store, stream).log.readOperation(invite().operationId)).toEqual(result);
    expect((await log.readOperation('ff'.repeat(16))).wire).toBeNull();
    expect(stream.rows.map((row) => row.wire)).toEqual([wire, remove]);
  });

  it('rejects a later invalid page even when the requested operation was already found', async () => {
    const { log, store, stream } = client();
    const wire = await sign(invite());
    const bad = await sign(removal(await crypto.hashRecord(wire)), ['a']);
    stream.append(stream.tail, wire);
    stream.append(stream.tail, bad);
    await expect(log.readOperation(invite().operationId)).rejects.toThrow('wrong-signers');
    expect(store.journal?.pages).toEqual([stream.pages[0]]);
    await expect(client(store, stream).log.readOperation(invite().operationId)).rejects.toThrow(
      'wrong-signers'
    );
    expect(stream.rows.map((row) => row.wire)).toEqual([wire, bad]);
  });

  it('does not return cached evidence when catch-up or checkpoint persistence fails', async () => {
    const { log, store, stream } = client();
    const wire = await sign(invite());
    stream.append(stream.tail, wire);
    store.failSave = 'before';
    await expect(log.readOperation(invite().operationId)).rejects.toThrow('disk-failure');
    expect(store.journal).toBeNull();
    await log.read();
    const saved = structuredClone(store.journal);
    stream.onRead = async () => {
      throw new Error('offline');
    };
    await expect(log.readOperation(invite().operationId)).rejects.toThrow('offline');
    expect(store.journal).toEqual(saved);
  });

  it('rejects noncanonical operation IDs without touching the journal', async () => {
    const { log, store, stream } = client();
    for (const id of ['', 'FF'.repeat(16), '00'.repeat(15), '00'.repeat(17)]) {
      await expect(log.readOperation(id)).rejects.toThrow();
    }
    expect(store.journal).toBeNull();
    expect(stream.rows).toEqual([]);
  });

  it('commits every record in a read page with its single opaque cursor', async () => {
    const { log, stream, store } = client();
    const good = await sign(invite());
    const remove = await sign(removal(await crypto.hashRecord(good)));
    stream.onRead = async (offset) => ({
      records: offset === stream.initialOffset ? [good, remove] : [],
      nextOffset: 'one-page-tail',
      upToDate: true,
    });
    expect(await log.read()).toMatchObject({ length: 2 });
    expect(store.journal).toEqual({
      genesis,
      pending: null,
      pages: [{ records: [good, remove], nextOffset: 'one-page-tail' }],
    });
    const restarted = await client(store, stream).log.read();
    expect(restarted.state.members.B).toBeUndefined();
    expect(restarted.state.members.C).toBeDefined();
    expect(restarted.length).toBe(2);
  });

  it('does not persist the good prefix inside an invalid page or clear pending', async () => {
    const { log, stream, store } = client();
    const good = await sign(invite());
    const invalid = await sign(removal(await crypto.hashRecord(good)), ['a']);
    store.journal = { genesis, pages: [], pending: good };
    stream.onRead = async () => ({
      records: [good, invalid],
      nextOffset: 'one-page-tail',
      upToDate: true,
    });
    await expect(log.resume()).rejects.toThrow('wrong-signers');
    expect(store.journal).toEqual({ genesis, pages: [], pending: good });
    await expect(client(store, stream).log.read()).rejects.toThrow('wrong-signers');
  });

  it('normalizes the empty initial cursor once and rejects later empty cursor jumps', async () => {
    const { log, stream, store } = client();
    stream.onRead = async () => ({ records: [], nextOffset: 'empty-tail', upToDate: true });
    expect(await log.read()).toMatchObject({ length: 0 });
    expect(store.journal?.pages).toEqual([{ records: [], nextOffset: 'empty-tail' }]);
    expect(await client(store, stream).log.read()).toMatchObject({ length: 0 });
    stream.onRead = async () => ({ records: [], nextOffset: 'unexplained-tail', upToDate: true });
    await expect(log.read()).rejects.toThrow('incomplete-read');
    expect(store.journal?.pages).toEqual([{ records: [], nextOffset: 'empty-tail' }]);
  });

  it('does not publish after partial catch-up or advance to a repeated page cursor', async () => {
    const { log, stream, store } = client();
    const first = await sign(invite()),
      second = await sign(removal(await crypto.hashRecord(first)));
    stream.onRead = async (offset) =>
      offset === stream.initialOffset
        ? { records: [first], nextOffset: 'page-one', upToDate: false }
        : { records: [second], nextOffset: 'page-one', upToDate: true };
    await expect(log.submit(second)).rejects.toThrow('invalid-offset');
    expect(stream.rows).toEqual([]);
    expect(store.journal).toEqual({
      genesis,
      pending: null,
      pages: [{ records: [first], nextOffset: 'page-one' }],
    });
  });

  it('verifies read-back, persists progress, and treats an exact retry as historical success', async () => {
    const { log, store, stream } = client();
    const wire = await sign(invite());
    const first = await log.submit(wire);
    expect(first.status).toBe('committed');
    expect(first.snapshot.state.members.C).toBeDefined();
    expect(store.journal).toMatchObject({
      pending: null,
      pages: [{ records: [wire], nextOffset: 'cursor-1' }],
    });
    const remove = await sign(removal(first.snapshot.head));
    await log.submit(remove);
    const retry = await log.submit(wire);
    expect(retry.status).toBe('committed');
    expect(retry.snapshot.state.members.B).toBeUndefined();
    expect(retry.snapshot.state.members.C).toBeDefined();
    expect(stream.rows).toHaveLength(2);
    await expect(log.submit(await sign({ ...invite(), payload: '00' }))).rejects.toThrow(
      'operation-reused'
    );
  });

  it('allows only one of two same-head submissions; revoked B cannot re-sign after refresh', async () => {
    const stream = new MemoryStream();
    const member = client(new MemoryStore(), stream);
    const owner = client(new MemoryStore(), stream);
    const entered = deferred();
    const release = deferred();
    const add = await sign(invite());
    stream.onAppend = async (offset, wire) => {
      if (wire === add) {
        entered.resolve();
        await release.promise;
      }
      return stream.append(offset, wire);
    };
    const invitation = member.log.submit(add);
    await entered.promise;
    const removalResult = await owner.log.submit(await sign(removal()));
    expect(removalResult.status).toBe('committed');
    release.resolve();
    const invitationResult = await invitation;
    expect(invitationResult.status).toBe('conflict');
    expect(invitationResult.snapshot.state.members.C).toBeUndefined();
    expect(member.store.journal?.pending).toBeNull();
    await expect(
      member.log.submit(await sign(invite(removalResult.snapshot.head)))
    ).rejects.toThrow('not-authorized');
    expect(stream.rows).toHaveLength(1);
  });

  it('invitation winning CAS preserves C; owner must explicitly create a new removal', async () => {
    const stream = new MemoryStream();
    const member = client(new MemoryStore(), stream);
    const owner = client(new MemoryStore(), stream);
    const staleRemoval = await sign(removal());
    const invited = await member.log.submit(await sign(invite()));
    expect((await owner.log.submit(staleRemoval)).status).toBe('conflict');
    const removed = await owner.log.submit(await sign(removal(invited.snapshot.head)));
    expect(removed.status).toBe('committed');
    expect(Object.keys(removed.snapshot.state.members).sort()).toEqual(['A', 'C']);
  });

  it('resolves a lost append response by reading the actual committed bytes', async () => {
    const { log, stream, store } = client();
    stream.onAppend = async (offset, wire) => {
      stream.append(offset, wire);
      throw new Error('response-lost');
    };
    expect((await log.submit(await sign(invite()))).status).toBe('committed');
    expect(store.journal?.pending).toBeNull();
    expect(stream.rows).toHaveLength(1);
  });

  it('keeps unknown attempts across restart and retries byte-for-byte, never another operation', async () => {
    const { log, stream, store } = client();
    const wire = await sign(invite());
    stream.onAppend = async () => {
      throw new Error('unreachable');
    };
    expect((await log.submit(wire)).status).toBe('unknown');
    expect(store.journal?.pending).toBe(wire);
    await expect(log.submit(await sign(removal()))).rejects.toThrow('pending-attempt-exists');
    stream.onAppend = undefined;
    const restarted = client(store, stream).log;
    expect((await restarted.resume()).status).toBe('committed');
    expect(stream.rows.map((r) => r.wire)).toEqual([wire]);
    expect(store.journal?.pending).toBeNull();
  });

  it('does not trust an accepted/duplicate acknowledgement with no verified record', async () => {
    const { log, stream, store } = client();
    stream.onAppend = async () => 'accepted';
    const wire = await sign(invite());
    const result = await log.submit(wire);
    expect(result.status).toBe('unknown');
    expect(result.snapshot.length).toBe(0);
    expect(result.snapshot.state.members.C).toBeUndefined();
    expect(store.journal?.pending).toBe(wire);
  });

  it('returns unsupported without ordinary append or retained speculative authority', async () => {
    const { log, stream, store } = client();
    stream.onAppend = async () => 'unsupported';
    const result = await log.submit(await sign(invite()));
    expect(result.status).toBe('unsupported');
    expect(result.snapshot.length).toBe(0);
    expect(stream.rows).toHaveLength(0);
    expect(store.journal?.pending).toBeNull();
  });

  it.each(['resume', 'submit'] as const)(
    'retains an uncertain request when %s reports unsupported',
    async (method) => {
      const { log, stream, store } = client();
      const wire = await sign(invite());
      let finishOriginal!: () => void;
      stream.onAppend = async (offset, value) => {
        // The client loses its connection, but the server still owns this request.
        finishOriginal = () => {
          stream.append(offset, value);
        };
        throw new Error('response-lost-before-server-commit');
      };
      expect((await log.submit(wire)).status).toBe('unknown');
      stream.onAppend = async () => 'unsupported';
      const restarted = client(store, stream).log;
      const retry = method === 'resume' ? await restarted.resume() : await restarted.submit(wire);
      expect(retry.status).toBe('unknown');
      expect(store.journal?.pending).toBe(wire);
      finishOriginal();
      expect((await client(store, stream).log.resume()).status).toBe('committed');
      expect(stream.rows.map((record) => record.wire)).toEqual([wire]);
      expect(store.journal?.pending).toBeNull();
    }
  );

  it.each(['before', 'after'] as const)(
    'never uploads after outbox save rejects %s its atomic write',
    async (mode) => {
      const { log, stream, store } = client();
      store.failSave = mode;
      const wire = await sign(invite());
      await expect(log.submit(wire)).rejects.toThrow('disk-failure');
      expect(stream.rows).toHaveLength(0);
      expect(store.journal?.pending ?? null).toBe(mode === 'before' ? null : wire);
      expect((await log.submit(wire)).status).toBe('committed');
    }
  );

  it.each(['before', 'after'] as const)(
    'recovers after server commit and checkpoint save rejects %s its atomic write',
    async (mode) => {
      const { log, stream, store } = client();
      const wire = await sign(invite());
      stream.onAppend = async (offset, value) => {
        const result = stream.append(offset, value);
        store.failSave = mode;
        return result;
      };
      await expect(log.submit(wire)).rejects.toThrow('disk-failure');
      expect(store.journal?.pending).toBe(wire);
      stream.onAppend = undefined;
      const restarted = client(store, stream).log;
      expect((await restarted.resume()).status).toBe('committed');
      expect(stream.rows).toHaveLength(1);
      expect(store.journal?.pending).toBeNull();
    }
  );

  it('retains pending when read-back fails and resolves after restart', async () => {
    const { log, stream, store } = client();
    const wire = await sign(invite());
    stream.onAppend = async (offset, value) => {
      const result = stream.append(offset, value);
      stream.onRead = async () => {
        throw new Error('read-unavailable');
      };
      return result;
    };
    await expect(log.submit(wire)).rejects.toThrow('read-unavailable');
    expect(store.journal?.pending).toBe(wire);
    stream.onRead = undefined;
    expect((await client(store, stream).log.resume()).status).toBe('committed');
    expect(stream.rows).toHaveLength(1);
  });

  it('does not skip a bad record, and saves only the preceding verified prefix', async () => {
    const { log, stream, store } = client();
    const good = await sign(invite());
    const invalid = await sign(removal(await crypto.hashRecord(good)), ['a']);
    stream.append(stream.tail, good);
    stream.append(stream.tail, invalid);
    await expect(log.read()).rejects.toThrow('wrong-signers');
    expect(store.journal?.pages.flatMap((page) => page.records)).toEqual([good]);
    await expect(client(store, stream).log.read()).rejects.toThrow('wrong-signers');
    expect(store.journal?.pages).toHaveLength(1);
  });

  it('rejects truncated reads, repeated offsets, and tampered persisted records', async () => {
    const { log, stream, store } = client();
    stream.onRead = async () => ({ records: [], nextOffset: 'missing-tail', upToDate: false });
    await expect(log.read()).rejects.toThrow('incomplete-read');
    expect(store.journal).toBeNull();
    const wire = await sign(invite());
    stream.onRead = async () => ({
      records: [wire],
      nextOffset: stream.initialOffset,
      upToDate: true,
    });
    await expect(log.read()).rejects.toThrow('invalid-offset');
    stream.onRead = undefined;
    await log.submit(wire);
    store.journal = {
      ...store.journal!,
      pages: [{ records: [wire.replace('"B1"', '"B0"')], nextOffset: 'cursor-1' }],
    };
    await expect(client(store, stream).log.read()).rejects.toThrow('not-authorized');
    store.journal = { ...store.journal!, genesis: 'b2'.repeat(32) };
    await expect(client(store, stream).log.read()).rejects.toThrow('journal-anchor-mismatch');
  });

  it('serializes two client instances sharing a journal without losing a pending attempt', async () => {
    const { stream, store, log } = client();
    const entered = deferred();
    const release = deferred();
    stream.onAppend = async () => {
      entered.resolve();
      await release.promise;
      throw new Error('unreachable');
    };
    const wire = await sign(invite());
    const first = log.submit(wire);
    await entered.promise;
    const second = client(store, stream).log.submit(await sign(removal()));
    const rejected = expect(second).rejects.toThrow('pending-attempt-exists');
    release.resolve();
    expect((await first).status).toBe('unknown');
    await rejected;
    expect(store.journal?.pending).toBe(wire);
    expect(stream.rows).toHaveLength(0);
  });
});
