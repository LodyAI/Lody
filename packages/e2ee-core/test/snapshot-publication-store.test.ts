import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it } from 'vitest';
import { ContentCipher } from '../src/content';
import type { PayloadProtectionContext } from '@loro-dev/streams-crdt';
import {
  createContentSnapshotPublication,
  MemorySnapshotPublicationStore,
  type ContentSnapshotPut,
  type SnapshotPublicationStore,
  type SnapshotPublicationTransaction,
} from '../src/snapshot-admission';
import { SqliteSnapshotPublicationStore } from '../src/node-snapshot-publication-store';
import { createStreamsContentProvider } from '../src/streams-content';
import { toHex } from '../src/wire';

const directories: string[] = [];
const children = new Set<ChildProcess>();
async function stop(child: ChildProcess) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
  children.delete(child);
}
afterEach(async () => {
  await Promise.all([...children].map(stop));
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function location() {
  const dir = mkdtempSync(join(tmpdir(), 'e2ee-publication-'));
  directories.push(dir);
  return join(dir, 'snapshots.sqlite');
}

function initialize(path: string) {
  return new SqliteSnapshotPublicationStore(path, { create: true });
}

async function fixture() {
  const pair = await crypto.subtle.generateKey('Ed25519', false, ['sign', 'verify']);
  const device = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)));
  const genesis = 'ab'.repeat(32),
    resource = 'document';
  const cipher = new ContentCipher({ authorize: () => device });
  const provider = createStreamsContentProvider({
    cipher,
    genesis,
    resource,
    model: 'loro',
    writeEpoch: 0,
    author: { actor: 'Alice', memberInstance: 'Alice1', device },
    signingKey: pair.privateKey,
    readKey: () => new Uint8Array(32).fill(9),
    mayWriteDocument: () => true,
  });
  const clock = { now: 1000 },
    permission = { write: true };
  const host = (store: SnapshotPublicationStore) =>
    createContentSnapshotPublication({
      store,
      cipher,
      now: () => clock.now,
      mayWriteDocument: () => permission.write,
    });
  async function input(offset: string, text = 'snapshot'): Promise<ContentSnapshotPut> {
    const sealed = await provider.seal({
      plaintext: new TextEncoder().encode(text),
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'snapshot',
        continuationOffset: offset,
      } as PayloadProtectionContext,
      additionalData: () => new Uint8Array([1, 2, 3]),
    });
    const body = new Uint8Array(11 + sealed.sealed.length);
    body.set([0x4c, 0x53, 0x43, 0x45, 2, 2, 0, 1, 0, 0, 2]);
    body.set(sealed.sealed, 11);
    return {
      streamKey: 'room',
      offset,
      body,
      submittingDevice: device,
      leaseIssuedAt: 1000,
      leaseExpiresAt: 61000,
      expectedGenesis: genesis,
      expectedResource: resource,
    };
  }
  const open = (snapshot: { offset: string; body: Uint8Array }) =>
    provider.open({
      header: snapshot.body.slice(10, 11),
      sealed: snapshot.body.slice(11),
      additionalData: new Uint8Array([1, 2, 3]),
      context: {
        protocol: 'loro-streams-crdt-payload-protection',
        version: 2,
        kind: 'snapshot',
        continuationOffset: snapshot.offset,
      } as PayloadProtectionContext,
    });
  return { input, host, clock, permission, open };
}

for (const backend of ['memory', 'sqlite'] as const) {
  it(`${backend}: atomic rollback and expired transaction handles`, () => {
    const store =
      backend === 'memory'
        ? new MemorySnapshotPublicationStore()
        : new SqliteSnapshotPublicationStore(location(), { create: true });
    let escaped: SnapshotPublicationTransaction | undefined;
    expect(() =>
      store.transaction('room', (tx) => {
        escaped = tx;
        tx.save({ offset: '10', body: new Uint8Array([1]) });
        throw new Error('abort');
      })
    ).toThrow('abort');
    expect(() => escaped!.current()).toThrow('snapshot-transaction-ended');
    expect(store.transaction('room', (tx) => tx.current())).toBeUndefined();
    expect(store.transaction('room', (tx) => tx.admitted('10'))).toBeUndefined();
  });
}

it('reopens exact identities, lost-ACK retries and current pointer without an in-process cache', async () => {
  const path = location();
  initialize(path);
  const f = await fixture(),
    first = await f.input('10'),
    second = await f.input('20');
  await f.host(new SqliteSnapshotPublicationStore(path)).admit(first); // pretend ACK lost
  const restarted = f.host(new SqliteSnapshotPublicationStore(path));
  expect((await restarted.admit(first)).status).toBe('idempotent');
  await restarted.admit(second);
  f.permission.write = false;
  f.clock.now = 61000;
  expect((await f.host(new SqliteSnapshotPublicationStore(path)).admit(first)).currentOffset).toBe(
    '20'
  );
  const current = f.host(new SqliteSnapshotPublicationStore(path)).current('room');
  expect(current).toEqual({ offset: '20', body: second.body });
  expect(new TextDecoder().decode(await f.open(current!))).toBe('snapshot');
  await expect(restarted.admit(await f.input('10', 'replacement'))).rejects.toThrow(
    'snapshot-identity-conflict'
  );
  await expect(restarted.admit(await f.input('30', 'new'))).rejects.toThrow(
    'snapshot-lease-expired'
  );
});

it('SQLite write failure between identity and pointer rolls back both', async () => {
  const path = location();
  initialize(path);
  const f = await fixture(),
    host = f.host(new SqliteSnapshotPublicationStore(path));
  const first = await f.input('10'),
    second = await f.input('20');
  await host.admit(first);
  const db = new DatabaseSync(path);
  db.exec(
    "CREATE TRIGGER fail_pointer BEFORE INSERT ON current_snapshot BEGIN SELECT RAISE(ABORT, 'injected-write-failure'); END;"
  );
  db.close();
  await expect(host.admit(second)).rejects.toThrow('injected-write-failure');
  expect(host.current('room')).toEqual({ offset: '10', body: first.body });
  expect(
    new SqliteSnapshotPublicationStore(path).transaction('room', (tx) => tx.admitted('20'))
  ).toBeUndefined();
  const repaired = new DatabaseSync(path);
  repaired.exec('DROP TRIGGER fail_pointer');
  repaired.close();
  expect((await host.admit(second)).status).toBe('accepted');
});

it('two independent publishers conflict at commit and cannot regress current', async () => {
  const path = location();
  initialize(path);
  const f = await fixture(),
    a = f.host(new SqliteSnapshotPublicationStore(path)),
    b = f.host(new SqliteSnapshotPublicationStore(path));
  const inputs = [await f.input('10', 'a'), await f.input('10', 'b')];
  const results = await Promise.allSettled([a.admit(inputs[0]!), b.admit(inputs[1]!)]);
  expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((x) => x.status === 'rejected').map((x) => x.reason.message)).toEqual([
    'snapshot-identity-conflict',
  ]);
  await a.admit(await f.input('20'));
  await expect(b.admit(await f.input('15'))).rejects.toThrow('snapshot-offset-regression');
  expect(a.current('room')?.offset).toBe('20');
});

it('checks the original lease after storage acquisition, with no partial publication', async () => {
  const f = await fixture(),
    memory = new MemorySnapshotPublicationStore();
  let transactions = 0;
  const store: SnapshotPublicationStore = {
    transaction(key, work) {
      if (++transactions === 2) f.clock.now = 61000;
      return memory.transaction(key, work);
    },
  };
  await expect(f.host(store).admit(await f.input('10'))).rejects.toThrow('snapshot-lease-expired');
  expect(memory.transaction('room', (tx) => tx.current())).toBeUndefined();
});

it('rejects missing, empty, foreign and damaged databases instead of resetting them', () => {
  const missing = location();
  expect(() => new SqliteSnapshotPublicationStore(missing)).toThrow();
  writeFileSync(missing, '');
  expect(() => new SqliteSnapshotPublicationStore(missing)).toThrow(
    'unsupported-snapshot-database'
  );
  const foreign = location(),
    db = new DatabaseSync(foreign);
  db.exec('CREATE TABLE unrelated(value TEXT)');
  db.close();
  expect(() => new SqliteSnapshotPublicationStore(foreign)).toThrow(
    'unsupported-snapshot-database'
  );
  const damaged = location();
  writeFileSync(damaged, 'not sqlite');
  expect(() => new SqliteSnapshotPublicationStore(damaged)).toThrow();
  const good = location();
  initialize(good);
  expect(() => new SqliteSnapshotPublicationStore(good, { create: true })).toThrow();
});

function spawnFixture(path: string, mode: string, input: ContentSnapshotPut) {
  const proc = fork(
    new URL('./snapshot-publication-child.ts', import.meta.url),
    [path, mode, JSON.stringify({ ...input, body: Buffer.from(input.body).toString('base64') })],
    { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] }
  );
  children.add(proc);
  let out = '',
    err = '';
  proc.stdout!.on('data', (data) => {
    out += String(data);
  });
  proc.stderr!.on('data', (data) => {
    err += String(data);
  });
  const exited = new Promise<string>((resolve, reject) => {
    proc.once('error', reject);
    proc.once('exit', (code, signal) => {
      children.delete(proc);
      if (code === 0) resolve(out.trim());
      else reject(new Error(`${code}/${signal}: ${err}`));
    });
  });
  // Intentional SIGKILL tests need to consume the exit rejection too.
  void exited.catch(() => {});
  const line = async () => {
    while (!out.includes('\n')) await Promise.race([once(proc.stdout!, 'data'), exited]);
    return out.trim();
  };
  return { proc, exited, line };
}

it('process death before commit rolls back identity and pointer; after commit survives lost ACK', async () => {
  const path = location();
  initialize(path);
  const f = await fixture(),
    first = await f.input('10'),
    second = await f.input('20');
  await f.host(new SqliteSnapshotPublicationStore(path)).admit(first);
  const before = spawnFixture(path, 'before-commit', second);
  expect(await before.line()).toBe('staged');
  expect(() =>
    new SqliteSnapshotPublicationStore(path).transaction('room', (tx) => tx.current())
  ).toThrow('snapshot-store-busy');
  await stop(before.proc);
  const recovered = f.host(new SqliteSnapshotPublicationStore(path));
  expect(recovered.current('room')).toEqual({ offset: '10', body: first.body });
  expect((await recovered.admit(second)).status).toBe('accepted');
  const third = await f.input('30'),
    after = spawnFixture(path, 'after-commit', third);
  expect(await after.line()).toBe('committed');
  await stop(after.proc);
  expect((await f.host(new SqliteSnapshotPublicationStore(path)).admit(third)).status).toBe(
    'idempotent'
  );
  expect(recovered.current('room')).toEqual({ offset: '30', body: third.body });
});

it('two processes publish one identity; the losing request cannot replace it on retry', async () => {
  const path = location();
  initialize(path);
  const f = await fixture(),
    a = await f.input('10', 'a'),
    b = await f.input('10', 'b');
  const results = await Promise.all([
    spawnFixture(path, 'admit', a).exited,
    spawnFixture(path, 'admit', b).exited,
  ]);
  expect(results.filter((x) => x === 'accepted')).toHaveLength(1);
  expect(
    results.every((x) =>
      ['accepted', 'snapshot-identity-conflict', 'snapshot-store-busy'].includes(x)
    )
  ).toBe(true);
  const loser = results[0] === 'accepted' ? b : a;
  await expect(f.host(new SqliteSnapshotPublicationStore(path)).admit(loser)).rejects.toThrow(
    'snapshot-identity-conflict'
  );
});
