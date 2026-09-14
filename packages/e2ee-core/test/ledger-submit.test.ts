import { describe, expect, it } from 'vitest';
import {
  LedgerClient,
  MAX_LEDGER_READ_PAGE_RECORDS,
  MemoryLedgerStore,
  MemoryLedgerStream,
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
        await admitDeviceOp(created.anchor, phone, 'personal', true)
      )
    ).record;
    const recB = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, laptop, 'personal', false)
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
        await admitDeviceOp(created.anchor, phone, 'personal', true)
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
        await admitDeviceOp(created.anchor, phone, 'personal', true)
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

  it('returns unsupported without CAS enqueue and does not invent a new signature', async () => {
    const { owner, created, stream, a } = await clients();
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, phone, 'personal', true)
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
        await admitDeviceOp(created.anchor, phone, 'personal', true)
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
        await admitDeviceOp(created.anchor, phone, 'personal', true)
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
        await admitDeviceOp(created.anchor, phone, 'personal', true)
      )
    ).record;
    const recB = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, laptop, 'personal', false)
      )
    ).record;
    expect((await a.client.submit(recA)).status).toBe('committed');
    expect((await b.client.submit(recB)).status).toBe('conflict');
    expect((await b.client.submit(recB)).status).toBe('conflict');
    expect(stream.records).toEqual([recA]);
    const refreshed = await b.client.read();
    const recB2 = (
      await append(refreshed, owner, await admitDeviceOp(created.anchor, laptop, 'personal', false))
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
        await admitDeviceOp(created.anchor, phone, 'personal', true)
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
        await admitDeviceOp(created.anchor, phone, 'personal', true)
      )
    ).record;
    a.store.failSave = 'before';
    await expect(a.client.submit(record)).rejects.toThrow('disk-failure');
    expect(stream.records).toEqual([]);
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
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const chained = await append(
      good.ledger,
      owner,
      await admitDeviceOp(created.anchor, laptop, 'personal', false)
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
      await admitDeviceOp(created.anchor, phone, 'personal', true)
    );
    const second = await append(
      first.ledger,
      owner,
      await admitDeviceOp(created.anchor, laptop, 'personal', false)
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
    await expect(client.read()).rejects.toThrow('disk-failure');
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
