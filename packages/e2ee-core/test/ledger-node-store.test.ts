import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Ledger, LedgerClient, MemoryLedgerStream } from '../src/ledger';
import {
  decodeLedgerJournal,
  encodeLedgerJournal,
  SqliteLedgerStore,
} from '../src/ledger/node-store';
import { admitDeviceOp, append, ed25519, signGenesis } from './ledger-fixtures';

const dirs: string[] = [];
const children = new Set<ChildProcess>();

function location() {
  const dir = mkdtempSync(join(tmpdir(), 'lody-ledger-store-'));
  dirs.push(dir);
  return join(dir, 'ledger.sqlite');
}

async function kill(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGKILL');
  await exited;
  children.delete(child);
}

afterEach(async () => {
  await Promise.all([...children].map(kill));
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('L6 sqlite journal restart', () => {
  it('reloads verified records after process restart and does not treat disk as authority', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, phone, 'personal', true)
      )
    ).record;
    const stream = new MemoryLedgerStream();
    const first = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    expect((await first.submit(record)).status).toBe('committed');

    const restarted = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    const view = await restarted.read();
    expect(view.length).toBe(2);
    expect(view.head).toEqual((await first.read()).head);

    await new SqliteLedgerStore(path).exclusive(async (tx) => {
      const journal = await tx.load();
      if (!journal) throw new Error('missing-journal');
      const garbled = {
        ...journal,
        records: [journal.records[0]!, new Uint8Array(journal.records[1]!).fill(7)],
      };
      await tx.save(garbled);
    });
    const poisoned = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      new MemoryLedgerStream()
    );
    await expect(poisoned.read()).rejects.toBeTruthy();
  });

  it('retains pending across a killed holder and releases the OS lock', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const store = new SqliteLedgerStore(path);
    const baseline = {
      genesis: created.anchor,
      records: [created.record],
      pending: null as Uint8Array | null,
      offset: 'empty:/+',
    };
    await store.exclusive((tx) => tx.save(baseline));
    const phone = await ed25519();
    const pending = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, phone, 'personal', true)
      )
    ).record;
    const withPending = { ...baseline, pending };
    const child = fork(new URL('./ledger-node-store-child.ts', import.meta.url), [path], {
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
    child.send({ mode: 'save', journal: encodeLedgerJournal(withPending) });
    expect(await Promise.race([locked, failed])).toEqual(['locked', undefined]);
    await expect(store.exclusive((tx) => tx.load())).rejects.toThrow('journal-busy');
    await kill(child);
    const recovered = await store.exclusive((tx) => tx.load());
    expect(recovered?.pending).toEqual(pending);
    expect(recovered?.records).toHaveLength(1);
  });

  it('rolls back an uncommitted sqlite update after process death', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const store = new SqliteLedgerStore(path);
    const baseline = {
      genesis: created.anchor,
      records: [created.record],
      pending: null as Uint8Array | null,
      offset: 'empty:/+',
    };
    await store.exclusive((tx) => tx.save(baseline));
    const child = fork(new URL('./ledger-node-store-child.ts', import.meta.url), [path], {
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
    child.send({ mode: 'uncommitted', journal: encodeLedgerJournal(baseline) });
    expect(await Promise.race([locked, failed])).toEqual(['locked', undefined]);
    await kill(child);
    const recovered = await store.exclusive((tx) => tx.load());
    expect(recovered?.records).toHaveLength(1);
    expect(recovered?.pending).toBeNull();
    expect(recovered?.offset).toBe('empty:/+');
  });

  it('resumes exact pending after restart when CAS ACK was lost, and reloads after commit', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const record = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, phone, 'personal', true)
      )
    ).record;
    const stream = new MemoryLedgerStream();
    stream.mode = 'false-ack';
    const first = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    expect((await first.submit(record)).status).toBe('unknown');
    const pending = await new SqliteLedgerStore(path).exclusive(
      async (tx) => (await tx.load())?.pending
    );
    expect(pending).toEqual(record);

    stream.mode = 'ok';
    const resumed = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    expect((await resumed.resume()).status).toBe('committed');
    expect(stream.records[0]).toEqual(record);

    const after = new LedgerClient(
      created.record,
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    const view = await after.read();
    expect(view.length).toBe(2);
    const loaded = await new SqliteLedgerStore(path).exclusive((tx) => tx.load());
    expect(loaded?.pending).toBeNull();
    expect(loaded?.records).toHaveLength(2);
  });

  it('rejects malformed and foreign journal encodings', () => {
    expect(() => decodeLedgerJournal('{')).toThrow();
    expect(() =>
      decodeLedgerJournal(JSON.stringify(['lody-control-journal/v2', 'aa', [], null, 'x']))
    ).toThrow();
    const ownerPending = JSON.stringify(['lody-e2ee-journal/v0', 'aa', ['bb'], null, 'empty:/+']);
    expect(() => decodeLedgerJournal(`${ownerPending} `)).toThrow();
    expect(() =>
      decodeLedgerJournal(JSON.stringify(['lody-e2ee-journal/v1', 'aa', [], null, 'empty:/+']))
    ).toThrow();
  });

  it('restarts a snapshot journal from sqlite without prefix records', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const phone = await ed25519();
    const extra = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, phone, 'personal', true)
      )
    ).record;
    const proposal = created.ledger.prepareSnapshot(owner.publicKey);
    const snapshot = await Ledger.finalizeSnapshot(
      proposal,
      await owner.sign(proposal.signingBytes)
    );
    const trust = {
      genesis: proposal.genesis,
      endorser: owner.publicKey,
      head: proposal.head,
      headSignature: await owner.sign(proposal.headAttestationSigningBytes),
    };
    const stream = new MemoryLedgerStream();
    stream.records = [created.record, extra];
    const store = new SqliteLedgerStore(path);
    const first = await LedgerClient.openFromSnapshot({ trust, snapshot, store, stream });
    expect((await first.submit(extra)).status).toBe('committed');
    const encoded = await new SqliteLedgerStore(path).exclusive(async (tx) => {
      const journal = await tx.load();
      if (!journal?.snapshot) throw new Error('missing-snapshot-journal');
      expect(journal.records).toHaveLength(1);
      return encodeLedgerJournal(journal);
    });
    expect(encoded.startsWith('["lody-e2ee-journal/v1"')).toBe(true);
    expect(decodeLedgerJournal(encoded).snapshot?.byteLength).toBe(snapshot.byteLength);

    const restarted = await LedgerClient.openJournal(
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    const view = await restarted.read();
    expect(view.origin).toBe('snapshot');
    expect(view.length).toBe(2);
    expect(view.state.devices.size).toBe(2);
    expect(() => view.hashAt(1)).not.toThrow();
  });

  it('keeps v1 journals without snapshotBound and fails closed on a foreign genesis after restart', async () => {
    const path = location();
    const owner = await ed25519();
    const created = await signGenesis(owner);
    const extra = (
      await append(
        created.ledger,
        owner,
        await admitDeviceOp(created.anchor, await ed25519(), 'personal', true)
      )
    ).record;
    const proposal = created.ledger.prepareSnapshot(owner.publicKey);
    const snapshot = await Ledger.finalizeSnapshot(
      proposal,
      await owner.sign(proposal.signingBytes)
    );
    const trust = {
      genesis: proposal.genesis,
      endorser: owner.publicKey,
      head: proposal.head,
      headSignature: await owner.sign(proposal.headAttestationSigningBytes),
    };
    const unbound = encodeLedgerJournal({
      genesis: created.anchor,
      records: [],
      pending: null,
      offset: 'empty:/+',
      snapshot,
      snapshotTrust: trust,
    });
    expect(unbound.startsWith('["lody-e2ee-journal/v1"')).toBe(true);
    expect(JSON.parse(unbound)).toHaveLength(7);
    expect(decodeLedgerJournal(unbound).snapshotBound).toBeUndefined();

    const stream = new MemoryLedgerStream();
    stream.records = [created.record, extra];
    const store = new SqliteLedgerStore(path);
    await store.exclusive((tx) => tx.save(decodeLedgerJournal(unbound)));
    const first = await LedgerClient.openJournal(created.anchor, store, stream);
    const joined = await first.read();
    expect(joined.origin).toBe('snapshot');
    expect(joined.length).toBe(2);
    const encoded = await new SqliteLedgerStore(path).exclusive(async (tx) => {
      const journal = await tx.load();
      if (!journal) throw new Error('missing-journal');
      expect(journal.snapshotBound).toBe(true);
      return encodeLedgerJournal(journal);
    });
    expect(JSON.parse(encoded)).toHaveLength(8);

    const foreign = await signGenesis(await ed25519());
    stream.records.push(foreign.record);
    const before = await new SqliteLedgerStore(path).exclusive(
      async (tx) => (await tx.load())?.offset
    );
    await expect(first.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    const afterFail = await new SqliteLedgerStore(path).exclusive((tx) => tx.load());
    expect(afterFail?.offset).toBe(before);
    expect(afterFail?.records).toHaveLength(1);

    const restarted = await LedgerClient.openJournal(
      created.anchor,
      new SqliteLedgerStore(path),
      stream
    );
    await expect(restarted.read()).rejects.toMatchObject({ code: 'wrong-parent' });
    const afterRestart = await new SqliteLedgerStore(path).exclusive((tx) => tx.load());
    expect(afterRestart?.offset).toBe(before);
  });
});
