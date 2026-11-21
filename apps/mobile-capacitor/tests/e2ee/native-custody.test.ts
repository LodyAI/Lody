import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Context, Effect, Layer, ManagedRuntime, Result } from 'effect';
import { IDBFactory, IDBKeyRange, IDBObjectStore } from 'fake-indexeddb';
import {
  ClientIdentityOriginals,
  ClientInstallationStore,
  ClientKeyCustody,
  WorkspaceScope,
} from '@lody/e2ee-core/services';
import { indexedDbClientInstallationStore } from '@lody/e2ee-core/adapters/indexeddb';
import { browserClientWriter } from '@lody/e2ee-core/adapters/browser-custody';
import { nativeCustody } from '../../src/e2ee/native-custody';
import { NativeFixture, args, binding, payload, record } from './native-fixture';
import { sha256 } from '@noble/hashes/sha2.js';
let held: Set<string>;
let close: (() => Promise<void>)[] = [];
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  held = new Set();
  const locks = {
    request: async (name: string, _options: unknown, callback: (value: unknown) => unknown) => {
      if (held.has(name)) return callback(null);
      held.add(name);
      try {
        return await callback({ name, mode: 'exclusive' });
      } finally {
        held.delete(name);
      }
    },
  };
  vi.stubGlobal('navigator', { locks });
});
afterEach(async () => {
  for (const stop of close.splice(0)) await stop();
  vi.unstubAllGlobals();
});
async function setup(plugin = new NativeFixture(), prepared = true, target = binding) {
  const scope = Layer.succeed(WorkspaceScope, { genesis: target.genesis });
  const stores = Layer.mergeAll(
    indexedDbClientInstallationStore({
      databaseName: 'fixture-installations:' + target.accountId + ':' + target.workspaceId,
      accountId: target.accountId,
      workspaceId: target.workspaceId,
      mode: 'create-or-open',
    }),
    browserClientWriter({ accountId: target.accountId, workspaceId: target.workspaceId })
  ).pipe(Layer.provide(scope));
  const app = ManagedRuntime.make(
    nativeCustody({ binding: target, plugin, databaseName: 'fixture-native-originals' }).pipe(
      Layer.provideMerge(stores)
    )
  );
  close.push(() => app.dispose());
  const context = await app.context();
  const installed = Context.get(context, ClientInstallationStore);
  if (prepared && !(await app.runPromise(installed.read())))
    await app.runPromise(
      installed.compareAndSet(null, {
        binding: target,
        revision: 0,
        phase: 'prepared',
        wrapped: [],
      })
    );
  const custody = Context.get(context, ClientKeyCustody),
    originals = Context.get(context, ClientIdentityOriginals);
  return {
    app,
    custody,
    originals,
    plugin,
    installed,
    run: <A>(e: Effect.Effect<A, unknown>) => app.runPromise(e),
  };
}
it('requires the durable prepared installation before creating native protection', async () => {
  const f = await setup(undefined, false);
  await expect(f.run(f.custody.create())).rejects.toBeDefined();
  expect(f.plugin.keys.size).toBe(0);
});
it('does not adopt an orphan native ready key as a usable installation', async () => {
  const f = await setup();
  await f.plugin.install(args);
  expect(await f.run(f.custody.status())).toBe('indeterminate');
  await expect(f.run(f.custody.create())).rejects.toBeDefined();
});
it('preserves first wrappers and reopens the exact originals without native rewrapping', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  const first = await f.run(f.custody.wrap('signing-private-key', payload));
  expect(await f.run(f.custody.wrap('signing-private-key', payload))).toEqual(first);
  const rows = await f.run(f.originals.read());
  expect(rows).toEqual([{ purpose: 'signing-private-key', blob: first }]);
  const plain = await f.run(
    Effect.acquireUseRelease(
      f.custody.unwrap('signing-private-key', first),
      (value) => Effect.sync(() => new Uint8Array(value)),
      (value) => Effect.sync(() => value.fill(0))
    )
  );
  expect(plain).toEqual(payload);
  await f.app.dispose();
  const reopened = await setup(f.plugin);
  expect(await reopened.run(reopened.custody.wrap('signing-private-key', payload))).toEqual(first);
  expect(f.plugin.wraps).toBe(1);
});
it('refuses changed identity material instead of replacing its first wrapper', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  const first = await f.run(f.custody.wrap('signing-private-key', payload));
  await expect(
    f.run(f.custody.wrap('signing-private-key', Uint8Array.of(1, 2, 3)))
  ).rejects.toBeDefined();
  expect(await f.run(f.originals.read())).toEqual([
    { purpose: 'signing-private-key', blob: first },
  ]);
});
it('does not repeat an unknown native wrapping outcome after reopen', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  f.plugin.failAfterWrap = true;
  await expect(f.run(f.custody.wrap('signing-private-key', payload))).rejects.toBeDefined();
  await f.app.dispose();
  f.plugin.failAfterWrap = false;
  const reopened = await setup(f.plugin);
  await expect(
    reopened.run(reopened.custody.wrap('signing-private-key', payload))
  ).rejects.toBeDefined();
  expect(f.plugin.wraps).toBe(1);
});
it('checks native v1 before installation side effects', async () => {
  const f = await setup();
  f.plugin.version = 2;
  await expect(f.run(f.custody.create())).rejects.toBeDefined();
  expect(f.plugin.keys.size).toBe(0);
});
it('does not recreate a lost native key for the retained identity', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  await f.run(f.custody.wrap('signing-private-key', payload));
  f.plugin.keys.clear();
  await expect(f.run(f.custody.create())).rejects.toBeDefined();
  expect(f.plugin.keys.size).toBe(0);
});

async function editNativeJournal<A>(
  work: (tx: IDBTransaction, done: (value: A) => void) => void
): Promise<A> {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('fixture-native-originals', 1);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    return await new Promise<A>((resolve, reject) => {
      const tx = db.transaction(['markers', 'wraps'], 'readwrite');
      let result: A;
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(tx.error);
      work(tx, (value) => {
        result = value;
      });
    });
  } finally {
    db.close();
  }
}

for (const phase of [null, 'installing'] as const) {
  for (const pending of [false, true]) {
    it(`refuses KEK recreation with retained ${pending ? 'pending' : 'complete'} original and ${phase ?? 'missing'} marker`, async () => {
      const f = await setup();
      await f.run(f.custody.create());
      await f.run(f.custody.wrap('signing-private-key', payload));
      await f.app.dispose();
      f.plugin.keys.clear();
      const before = await editNativeJournal<unknown[]>((tx, done) => {
        const markers = tx.objectStore('markers');
        if (phase === null) markers.delete(record(args));
        else markers.put({ version: 1, binding: record(args), phase }, record(args));
        const wraps = tx.objectStore('wraps');
        const cursor = wraps.openCursor();
        cursor.onsuccess = () => {
          if (cursor.result) {
            if (pending) cursor.result.update({ ...cursor.result.value, blob: null });
            cursor.result.continue();
          } else {
            const rows = wraps.getAll();
            rows.onsuccess = () => done(rows.result);
          }
        };
      });
      const reopened = await setup(f.plugin);
      const status = await reopened.run(reopened.custody.status());
      const created = await reopened.run(Effect.result(reopened.custody.create()));
      expect(status).toBe('indeterminate');
      expect(Result.isFailure(created)).toBe(true);
      expect(f.plugin.keys.size).toBe(0);
      const after = await editNativeJournal<unknown[]>((tx, done) => {
        const rows = tx.objectStore('wraps').getAll();
        rows.onsuccess = () => done(rows.result);
      });
      expect(after).toEqual(before);
      const marker = await editNativeJournal<unknown>((tx, done) => {
        const row = tx.objectStore('markers').get(record(args));
        row.onsuccess = () => done(row.result);
      });
      expect(marker).toEqual(
        phase === null ? undefined : { version: 1, binding: record(args), phase }
      );
    });
  }
}

it('preserves another valid installation original without blocking explicit first installation', async () => {
  const f = await setup();
  const foreign = { ...args, installationId: 'bc'.repeat(32) };
  await f.plugin.install(foreign);
  const response = await f.plugin.wrap({
    ...foreign,
    purpose: 'signing-private-key',
    plaintext: Buffer.from(payload).toString('base64'),
  });
  const original = {
    version: 1,
    binding: record(foreign),
    purpose: 'signing-private-key',
    digest: Buffer.from(sha256(payload)).toString('hex'),
    blob: Uint8Array.from(Buffer.from(response.wrapped, 'base64')),
  };
  const key = JSON.stringify([record(foreign), 'signing-private-key', 'identity']);
  await editNativeJournal<void>((tx, done) => {
    tx.objectStore('wraps').add(original, key);
    done();
  });
  await f.run(f.custody.create());
  expect(await f.run(f.custody.status())).toBe('available');
  const saved = await editNativeJournal<unknown>((tx, done) => {
    const row = tx.objectStore('wraps').get(key);
    row.onsuccess = () => done(row.result);
  });
  expect(saved).toEqual(original);
});

it('refuses a journal row whose key hides another binding without deleting it', async () => {
  const f = await setup();
  const foreign = { ...args, installationId: 'bc'.repeat(32) };
  const key = JSON.stringify([record(foreign), 'signing-private-key', 'identity']);
  const original = {
    version: 1,
    binding: record(args),
    purpose: 'signing-private-key',
    digest: Buffer.from(sha256(payload)).toString('hex'),
    blob: Uint8Array.from([1, ...new Uint8Array(60)]),
  };
  await editNativeJournal<void>((tx, done) => {
    tx.objectStore('wraps').add(original, key);
    done();
  });
  const status = await f.run(Effect.result(f.custody.status()));
  expect(Result.isFailure(status) && status.failure).toMatchObject({ reason: 'corrupt' });
  await expect(f.run(f.custody.create())).rejects.toBeDefined();
  expect(f.plugin.keys.size).toBe(0);
  const saved = await editNativeJournal<unknown>((tx, done) => {
    const row = tx.objectStore('wraps').get(key);
    row.onsuccess = () => done(row.result);
  });
  expect(saved).toEqual(original);
});
it('maps native lock failures without exposing the raw error and keeps originals', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  const original = await f.run(f.custody.wrap('signing-private-key', payload));
  f.plugin.fail = 'LOCKED';
  const result = await f.run(Effect.result(f.custody.unwrap('signing-private-key', original)));
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: 'ClientCustodyError',
    reason: 'locked',
  });
  expect(await f.run(f.originals.read())).toEqual([
    { purpose: 'signing-private-key', blob: original },
  ]);
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
it('retains the native writer through close, queues same-realm calls and keeps another account usable', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  const entered = signal(),
    release = signal();
  const native = f.plugin.wrap.bind(f.plugin);
  f.plugin.wrap = async (input) => {
    entered.resolve();
    await release.promise;
    return native(input);
  };
  // Methods are captured by the acquired Layer, so acquire the gated bridge anew.
  await f.app.dispose();
  const gated = await setup(f.plugin);
  const wrapping = gated.run(gated.custody.wrap('signing-private-key', payload)).then(
    () => 'success',
    () => 'closed'
  );
  await entered.promise;
  const nativeLock = [...held][0];
  expect(nativeLock).toBeDefined();
  const disposing = gated.app.dispose();
  const contender = await setup(f.plugin);
  // Same-realm callers now queue behind the native operation, including close.
  // Awaiting this before releasing the operation would deadlock the fixture.
  const queuedStatus = contender.run(contender.custody.status());
  const other = await setup(f.plugin, true, { ...binding, accountId: 'another-account' });
  await other.run(other.custody.create());
  expect(await other.run(other.custody.status())).toBe('available');
  expect(held.has(nativeLock!)).toBe(true);
  release.resolve();
  await disposing;
  expect(await wrapping).toBe('closed');
  expect(await queuedStatus).toBe('available');
  // Close kept the original write until native settled; reopen can reconcile it.
  const reopened = await setup(f.plugin);
  expect((await reopened.run(reopened.originals.read()))[0]?.blob).toBeInstanceOf(Uint8Array);
  expect(f.plugin.wraps).toBe(1);
});
it('atomically owns and wipes a late native plaintext after caller cancellation', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  const original = await f.run(f.custody.wrap('signing-private-key', payload));
  await f.app.dispose();
  const entered = signal(),
    release = signal(),
    native = f.plugin.unwrap.bind(f.plugin);
  f.plugin.unwrap = async (input) => {
    entered.resolve();
    await release.promise;
    return native(input);
  };
  const reopened = await setup(f.plugin),
    abort = new AbortController();
  let wiped: Uint8Array | undefined;
  const pending = reopened.app
    .runPromise(
      Effect.acquireUseRelease(
        reopened.custody.unwrap('signing-private-key', original),
        () => Effect.void,
        (bytes) =>
          Effect.sync(() => {
            wiped = bytes;
            bytes.fill(0);
          })
      ),
      { signal: abort.signal }
    )
    .then(
      () => 'success',
      () => 'cancelled'
    );
  await entered.promise;
  abort.abort();
  release.resolve();
  expect(await pending).toBe('cancelled');
  expect(wiped).toHaveLength(payload.length);
  expect(wiped?.every((x) => x === 0)).toBe(true);
  expect(await reopened.run(reopened.custody.status())).toBe('available');
});

it('retries a failed local commit with the exact retained ciphertext, never rewraps', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  const originalPut = IDBObjectStore.prototype.put;
  let block = true;
  const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
    this: IDBObjectStore,
    value: unknown,
    ...putArgs: Parameters<IDBObjectStore['put']> extends [unknown, ...infer R] ? R : never
  ) {
    if (
      block &&
      this.name === 'wraps' &&
      typeof value === 'object' &&
      value !== null &&
      'blob' in value &&
      value.blob !== null
    )
      throw new DOMException('quota', 'QuotaExceededError');
    return originalPut.call(this, value, ...putArgs);
  });
  try {
    await expect(f.run(f.custody.wrap('signing-private-key', payload))).rejects.toBeDefined();
    await expect(f.run(f.originals.read())).rejects.toBeDefined();
    block = false;
    const recovered = await f.run(f.custody.wrap('signing-private-key', payload));
    expect(await f.run(f.originals.read())).toEqual([
      { purpose: 'signing-private-key', blob: recovered },
    ]);
    expect(f.plugin.wraps).toBe(1);
  } finally {
    put.mockRestore();
  }
});
it('retirement forbids status and wrapping while explicit deletion targets the exact incarnation', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  const first = await f.run(f.custody.wrap('signing-private-key', payload));
  await f.run(
    f.installed.compareAndSet(0, { binding, revision: 1, phase: 'retired', wrapped: [] })
  );
  await expect(f.run(f.custody.status())).rejects.toBeDefined();
  await expect(f.run(f.custody.wrap('signing-private-key', payload))).rejects.toBeDefined();
  // Explicit deletion can still target this exact retired incarnation; close never did it.
  expect(f.plugin.keys.has(record(args))).toBe(true);
  await f.run(f.custody.delete());
  expect(f.plugin.keys.has(record(args))).toBe(false);
  await expect(f.run(f.custody.unwrap('signing-private-key', first))).rejects.toBeDefined();
});
it('authenticates frozen purpose boundaries and enforces the 4096-byte native limit', async () => {
  const f = await setup();
  await f.run(f.custody.create());
  const body = new Uint8Array(4096).fill(7),
    blob = await f.run(f.custody.wrap('installed-epoch-key', body));
  const plain = await f.run(
    Effect.acquireUseRelease(
      f.custody.unwrap('installed-epoch-key', blob),
      (bytes) => Effect.sync(() => new Uint8Array(bytes)),
      (bytes) => Effect.sync(() => bytes.fill(0))
    )
  );
  expect(plain).toEqual(body);
  plain.fill(0);
  await expect(f.run(f.custody.unwrap('rotation-candidate', blob))).rejects.toBeDefined();
  await expect(
    f.run(f.custody.wrap('installed-epoch-key', new Uint8Array(4097)))
  ).rejects.toBeDefined();
  expect(f.plugin.wraps).toBe(1);
});
