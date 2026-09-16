import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  LedgerClient,
  LedgerError,
  MAX_LEDGER_READ_PAGE_RECORDS,
  MAX_LEDGER_RECORDS,
  MemoryLedgerStore,
  MemoryLedgerStream,
} from '../src/ledger';
import { encodeLedgerJournal, SqliteLedgerStore } from '../src/ledger/node-store';
import { buildChain } from '../bench/chain';
import { admitDeviceOp, append, ed25519 } from './ledger-fixtures';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('10k ledger through LedgerClient', () => {
  it('pages, persists, restarts, and appends a 10k signed chain; still bounds pages and totals', async () => {
    const built = await buildChain(10_000);
    const stream = new MemoryLedgerStream();
    stream.pageSize = 512;
    stream.records = built.records.slice(1).map((record) => new Uint8Array(record));
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.open(built.records[0]!, store, stream);
    const view = await client.read();
    expect(view.length).toBe(10_000);
    expect(view.head).toEqual(built.ledger.head);

    const extra = await ed25519();
    const next = (
      await append(
        view,
        built.owner,
        await admitDeviceOp(built.created.anchor, extra, 'personal', false)
      )
    ).record;
    const submitted = await client.submit(next);
    expect(submitted.status).toBe('committed');
    expect(submitted.ledger.length).toBe(10_001);

    const path = join(mkdtempSync(join(tmpdir(), 'lody-ledger-10k-')), 'ledger.sqlite');
    dirs.push(path.slice(0, path.lastIndexOf('/')));
    const disk = new SqliteLedgerStore(path);
    const diskStream = new MemoryLedgerStream();
    diskStream.pageSize = 512;
    diskStream.records = [...stream.records];
    const first = await LedgerClient.open(built.records[0]!, disk, diskStream);
    expect((await first.read()).length).toBe(10_001);
    const restarted = new LedgerClient(built.records[0]!, built.created.anchor, disk, diskStream);
    const again = await restarted.read();
    expect(again.length).toBe(10_001);
    expect(again.head).toEqual(submitted.ledger.head);
    const extra2 = await ed25519();
    const appended = (
      await append(
        again,
        built.owner,
        await admitDeviceOp(built.created.anchor, extra2, 'personal', false)
      )
    ).record;
    expect((await restarted.submit(appended)).status).toBe('committed');
    expect((await restarted.read()).length).toBe(10_002);

    const fatPage = new MemoryLedgerStream();
    fatPage.pageSize = MAX_LEDGER_READ_PAGE_RECORDS + 1;
    fatPage.records = built.records.slice(1, 1 + MAX_LEDGER_READ_PAGE_RECORDS + 1);
    const pageClient = await LedgerClient.open(built.records[0]!, new MemoryLedgerStore(), fatPage);
    expect((await pageClient.read()).length).toBe(1 + MAX_LEDGER_READ_PAGE_RECORDS + 1);

    const tooMany = new MemoryLedgerStream();
    tooMany.pageSize = MAX_LEDGER_RECORDS + 1;
    tooMany.records = Array.from({ length: MAX_LEDGER_RECORDS + 1 }, () => new Uint8Array([1]));
    const oversizeClient = await LedgerClient.open(
      built.records[0]!,
      new MemoryLedgerStore(),
      tooMany
    );
    await expect(oversizeClient.read()).rejects.toMatchObject({
      name: 'LedgerError',
      code: 'oversize',
    });

    expect(MAX_LEDGER_RECORDS).toBeGreaterThanOrEqual(10_000);
    expect(MAX_LEDGER_READ_PAGE_RECORDS).toBeLessThan(MAX_LEDGER_RECORDS);
    expect(() =>
      encodeLedgerJournal({
        genesis: built.created.anchor,
        records: Array.from({ length: MAX_LEDGER_RECORDS + 1 }, () => new Uint8Array([1])),
        pending: null,
        offset: '0',
      })
    ).toThrow('oversize');
  }, 180_000);

  it('rejects a damaged journal on read after a successful short submit', async () => {
    const owner = await ed25519();
    const created = await (await import('./ledger-fixtures')).signGenesis(owner);
    const stream = new MemoryLedgerStream();
    const store = new MemoryLedgerStore();
    const client = await LedgerClient.open(created.record, store, stream);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, phone, 'personal', true)
      )
    ).record;
    expect((await client.submit(record)).status).toBe('committed');
    store.journal = store.journal && {
      ...store.journal,
      records: [store.journal.records[0]!, new Uint8Array([1, 2, 3])],
    };
    const poisoned = new LedgerClient(created.record, created.anchor, store, stream);
    await expect(poisoned.read()).rejects.toBeInstanceOf(LedgerError);
  });
});
