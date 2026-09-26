import { Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  LedgerClient,
  LedgerError,
  MAX_LEDGER_READ_PAGE_RECORDS,
  MemoryLedgerStore,
  MemoryLedgerStream,
  classifyLedgerPresence,
  classifyUnresolvedSubmit,
  selectSubmitWire,
} from '../src/ledger';
import { buildChain } from '../bench/chain';
import { admitDeviceOp, append, ed25519, signGenesis } from './ledger-fixtures';

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function clients() {
  const owner = await ed25519();
  const created = await signGenesis(owner);
  const stream = new MemoryLedgerStream();
  const open = async () => {
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.open(created.record, store, stream);
    return { store, client };
  };
  const a = await open();
  const b = await open();
  return { owner, created, stream, a, b };
}

describe('L5 CAS and unknown results', () => {
  it('commits one of two racing management submits and keeps exact bytes', async () => {
    const { owner, created, stream, a, b } = await clients();
    const phone = await ed25519();
    const laptop = await ed25519();
    const recA = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    const recB = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal')
      )
    ).record;
    const first = await a.client.submit(recA);
    expect(first.status).toBe('committed');
    const second = await b.client.submit(recB);
    expect(second.status).toBe('conflict');
    expect(stream.records).toHaveLength(1);
    expect(stream.records[0]).toEqual(recA);
    const view = await b.client.read();
    expect(view.head).toEqual(first.ledger.head);
    expect(view.state.devices.size).toBe(2);
  });

  it('treats a lost ACK as committed after read-back of the exact record', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    stream.mode = 'lost-response';
    const lost = await a.client.submit(record);
    expect(lost.status).toBe('committed');
    expect(stream.records[0]).toEqual(record);
    expect(a.store.journal?.pending).toBeNull();
  });

  it('keeps pending bytes on a false ACK and resumes without re-signing', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    stream.mode = 'false-ack';
    const unknown = await a.client.submit(record);
    expect(unknown.status).toBe('unknown');
    expect(a.store.journal?.pending).toEqual(record);
    expect(stream.records).toEqual([]);
    stream.mode = 'ok';
    const resumed = await a.client.resume();
    expect(resumed.status).toBe('committed');
    expect(resumed.ledger.length).toBe(2);
    expect(a.store.journal?.pending).toBeNull();
    expect(stream.records[0]).toEqual(record);
  });

  it('resume without pending throws LedgerError, not FiberFailure', async () => {
    const { a } = await clients();
    try {
      await a.client.resume();
      throw new Error('resume-without-pending');
    } catch (error) {
      expect(error).toBeInstanceOf(LedgerError);
      expect((error as LedgerError).code).toBe('invalid-operation');
    }
  });

  it('returns unsupported without CAS enqueue and does not invent a new signature', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    stream.mode = 'unsupported';
    const result = await a.client.submit(record);
    expect(result.status).toBe('unsupported');
    expect(stream.records).toEqual([]);
    expect(a.store.journal?.pending).toBeNull();
  });

  it('waits on an explicit in-flight barrier rather than sleeping', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    const gate = deferred();
    stream.inflight = gate.promise;
    let done = false;
    const pending = a.client.submit(record).then((result) => {
      done = true;
      return result;
    });
    expect(done).toBe(false);
    gate.resolve();
    const result = await pending;
    expect(result.status).toBe('committed');
    expect(done).toBe(true);
  });

  it('duplicate submit of an already committed record does not CAS again', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    expect((await a.client.submit(record)).status).toBe('committed');
    const copies = stream.records.length;
    expect((await a.client.submit(record)).status).toBe('committed');
    expect(stream.records.length).toBe(copies);
  });

  it('after conflict keeps the old signed bytes unused and requires a fresh prepare', async () => {
    const { owner, created, stream, a, b } = await clients();
    const phone = await ed25519();
    const laptop = await ed25519();
    const recA = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    const recB = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal')
      )
    ).record;
    expect((await a.client.submit(recA)).status).toBe('committed');
    expect((await b.client.submit(recB)).status).toBe('conflict');
    expect((await b.client.submit(recB)).status).toBe('conflict');
    expect(stream.records).toEqual([recA]);
    const refreshed = await b.client.read();
    const recB2 = (
      await append(
        refreshed,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal')
      )
    ).record;
    expect((await b.client.submit(recB2)).status).toBe('committed');
    expect(stream.records).toEqual([recA, recB2]);
  });

  it('unknown results retain the exact pending bytes against caller mutation', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    stream.mode = 'false-ack';
    expect((await a.client.submit(record)).status).toBe('unknown');
    const saved = a.store.journal?.pending;
    expect(saved).toEqual(record);
    record.fill(0);
    expect(a.store.journal?.pending).toEqual(saved);
    expect(a.store.journal?.pending?.some((byte) => byte !== 0)).toBe(true);
  });
});

describe('L5 disk save faults', () => {
  it('does not CAS if pending cannot be saved', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    a.store.failSave = 'before';
    await expect(a.client.submit(record)).rejects.toMatchObject({
      _tag: 'StorageError',
      reason: 'io',
    });
    expect(stream.records).toEqual([]);
  });

  it('keeps pending after a post-persist save fault and resumes the same bytes', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    a.store.failSave = 'after';
    await expect(a.client.submit(record)).rejects.toMatchObject({
      _tag: 'StorageError',
      reason: 'io',
    });
    expect(stream.records).toEqual([]);
    expect(a.store.journal?.pending).toEqual(record);
    const resumed = await a.client.resume();
    expect(resumed.status).toBe('committed');
    expect(stream.records[0]).toEqual(record);
    expect(a.store.journal?.pending).toBeNull();
  });
});

describe('C2 Promise/Effect single implementation', () => {
  it('classifies wire selection and CAS outcomes without I/O', () => {
    const pending = new Uint8Array([1, 2, 3]);
    expect(selectSubmitWire(pending, undefined)).toEqual(pending);
    expect(selectSubmitWire(null, pending)).toEqual(pending);
    expect(() => selectSubmitWire(null, undefined)).toThrow();
    expect(() => selectSubmitWire(pending, new Uint8Array([9]))).toThrow();
    expect(classifyLedgerPresence({ containsWire: true, previousMatchesHead: false })).toBe(
      'committed'
    );
    expect(classifyLedgerPresence({ containsWire: false, previousMatchesHead: false })).toBe(
      'conflict'
    );
    expect(classifyLedgerPresence({ containsWire: false, previousMatchesHead: true })).toBe(
      'absent'
    );
    expect(classifyUnresolvedSubmit({ cas: 'unsupported', retrying: false })).toBe('unsupported');
    expect(classifyUnresolvedSubmit({ cas: 'unsupported', retrying: true })).toBe('unknown');
    expect(classifyUnresolvedSubmit({ cas: 'unknown', retrying: false })).toBe('unknown');
  });

  it('Promise and Effect submit commit the same protocol bytes', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    const streamA = new MemoryLedgerStream();
    const streamB = new MemoryLedgerStream();
    const clientA = await LedgerClient.open(created.record, new MemoryLedgerStore(), streamA);
    const clientB = await LedgerClient.open(created.record, new MemoryLedgerStore(), streamB);
    const promiseResult = await clientA.submit(new Uint8Array(record));
    const effectResult = await Effect.runPromise(clientB.submitEffect(new Uint8Array(record)));
    expect(promiseResult.status).toBe('committed');
    expect(effectResult.status).toBe('committed');
    expect(streamA.records[0]).toEqual(record);
    expect(streamB.records[0]).toEqual(record);
    expect(streamA.records[0]).toEqual(streamB.records[0]);
  });

  it('Promise and Effect keep the same unknown pending bytes after a false ACK', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    const streamA = new MemoryLedgerStream();
    const streamB = new MemoryLedgerStream();
    streamA.mode = 'false-ack';
    streamB.mode = 'false-ack';
    const storeA = new MemoryLedgerStore();
    const storeB = new MemoryLedgerStore();
    const clientA = await LedgerClient.open(created.record, storeA, streamA);
    const clientB = await LedgerClient.open(created.record, storeB, streamB);
    expect((await clientA.submit(new Uint8Array(record))).status).toBe('unknown');
    expect((await Effect.runPromise(clientB.submitEffect(new Uint8Array(record)))).status).toBe(
      'unknown'
    );
    expect(storeA.journal?.pending).toEqual(record);
    expect(storeB.journal?.pending).toEqual(record);
    expect(streamA.records).toEqual([]);
    expect(streamB.records).toEqual([]);
  });

  it('interruption during CAS keeps the persisted pending bytes for resume', async () => {
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
      )
    ).record;
    const stream = new MemoryLedgerStream();
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.open(created.record, store, stream);
    const gate = deferred();
    const reachedCas = deferred();
    const original = stream.appendCas.bind(stream);
    stream.appendCas = (offset, bytes) => {
      reachedCas.resolve();
      stream.inflight = gate.promise;
      return original(offset, bytes);
    };
    const controller = new AbortController();
    const run = Effect.runPromiseExit(client.submitEffect(new Uint8Array(record)), {
      signal: controller.signal,
    });
    await reachedCas.promise;
    controller.abort();
    const exit = await run;
    expect(Exit.isSuccess(exit)).toBe(false);
    // The exact pending bytes were persisted before the interrupted CAS.
    expect(store.journal?.pending).toEqual(record);
    expect(stream.records).toEqual([]);
    gate.resolve();
    const resumed = await client.resume();
    expect(resumed.status).toBe('committed');
    expect(stream.records).toEqual([record]);
    expect(store.journal?.pending).toBeNull();
  });
});

describe('L6 page and cursor catch-up', () => {
  it('does not save a valid prefix of a bad page', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const laptop = await ed25519();
    const good = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
    );
    const chained = await append(
      good.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal')
    );
    const bad = new Uint8Array(chained.record);
    const last = bad.byteLength - 1;
    bad[last] = (bad[last] ?? 0) ^ 0xff;
    stream.pageSize = 2;
    stream.records = [good.record, bad];
    await expect(a.client.read()).rejects.toBeTruthy();
    expect(a.store.journal).toBeNull();
  });

  it('keeps the previous cursor when a later page save fails, then resumes', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const laptop = await ed25519();
    const first = await append(
      created.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, phone, 'personal')
    );
    const second = await append(
      first.ledger,
      owner,
      await admitDeviceOp(created.anchor, created.membershipId, laptop, 'personal')
    );
    stream.pageSize = 1;
    stream.records = [first.record, second.record];
    let saves = 0;
    const inner = a.store;
    const wrapped = {
      exclusive<T>(work: Parameters<(typeof inner)['exclusive']>[0]): Promise<T> {
        return inner.exclusive(async (tx) =>
          work({
            load: () => tx.load(),
            save: async (journal) => {
              saves += 1;
              if (saves === 2) throw new Error('disk-failure');
              await tx.save(journal);
            },
          })
        ) as Promise<T>;
      },
    };
    const client = new LedgerClient(created.record, created.anchor, wrapped, stream);
    await expect(client.read()).rejects.toMatchObject({ _tag: 'StorageError', reason: 'io' });
    expect(inner.journal?.records).toHaveLength(2);
    expect(inner.journal?.offset).toBe('opaque:1/+');
    const resumed = await new LedgerClient(created.record, created.anchor, inner, stream).read();
    expect(resumed.length).toBe(3);
    expect(inner.journal?.offset).toBe('opaque:2/+');
  });
});

describe('adapter pages larger than the extend chunk', () => {
  it('syncs 1025 signed records from one MemoryLedgerStream page', async () => {
    const count = MAX_LEDGER_READ_PAGE_RECORDS + 1;
    const built = await buildChain(count + 1);
    const stream = new MemoryLedgerStream();
    stream.pageSize = count;
    stream.records = built.records.slice(1).map((record) => new Uint8Array(record));
    const client = await LedgerClient.open(built.records[0]!, new MemoryLedgerStore(), stream);
    const view = await client.read();
    expect(view.length).toBe(count + 1);
    expect(view.head).toEqual(built.ledger.head);
  }, 120_000);
});
