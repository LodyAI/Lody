import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Effect, Layer, ManagedRuntime } from 'effect';
import { TestClock } from 'effect/testing';
import { ConvexHttpClient } from 'convex/browser';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { makeClientRecovery } from '../src/recovery';
import { makeRecoveryWorkspaces, type RecoveryWorkspaceProgress } from '../src/recovery-workspaces';
import type { RecoveryVaultCiphertextDto } from '@lody/cloud-api';
import { RecoveryVaults } from '@lody/e2ee-core';
import { RecoveryVaultLocalStore, RecoveryVaultStore } from '@lody/e2ee-core/services';
import { decodeRecoveryVaultCiphertext, encodeRecoveryVaultCiphertext } from '@lody/e2ee-core/host';
import { parseRecoveryFile } from '@lody/e2ee-core/protocol';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('location', { origin: 'https://lody.ai' });
});
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const entries = new Map<string, RecoveryVaultCiphertextDto>();
  let index: RecoveryVaultCiphertextDto | null = null;
  let vaultId: string | null = null;
  let intercept: ((path: string) => Promise<unknown> | undefined) | undefined;
  let current: { accountId: string; sessionId: string } | null = {
    accountId: 'abc',
    sessionId: 'login',
  };
  const paths: string[] = [];
  const client = new ConvexHttpClient('https://synthetic.test', {
    fetch: async (_url, init) => {
      const {
        path,
        args: [args],
      } = JSON.parse(String(init?.body));
      paths.push(path);
      const intercepted = intercept?.(path);
      let value: unknown;
      if (intercepted) value = await intercepted;
      else if (path === 'e2eeMembers:workspaces')
        value = [{ id: 'w1', name: 'Alpha', genesisHash: 'a'.repeat(64) }];
      else if (path === 'e2eeRecoveryVault:hasAccountVault') value = { exists: vaultId !== null };
      else if (path === 'e2eeRecoveryVault:replacementState')
        value = { current: vaultId, replacing: null };
      else if (path === 'e2eeRecoveryVault:putImmutable') {
        vaultId = args.vaultId;
        entries.set(args.entry.entryId, args.entry);
        value = { ok: true };
      } else if (path === 'e2eeRecoveryVault:readEntry') value = entries.get(args.entryId) ?? null;
      else if (path === 'e2eeRecoveryVault:readEntries')
        value = (args.entryIds as string[]).map((id) => entries.get(id) ?? null);
      else if (path === 'e2eeRecoveryVault:deleteUnreferenced') {
        entries.delete(args.entryId);
        value = { ok: true };
      } else if (path === 'e2eeRecoveryVault:readIndex') value = index;
      else if (path === 'e2eeRecoveryVault:compareAndSwapIndex') {
        index = args.next;
        value = { outcome: 'Committed' };
      } else throw new Error('unexpected synthetic operation: ' + path);
      return new Response(JSON.stringify({ status: 'success', value }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const options = {
    platform: 'web' as const,
    accountId: 'abc',
    sessionId: 'login',
    currentSession: () => current,
    enabled: () => true,
    client,
  };
  const service = makeClientRecovery(options);
  const journal = new Map<string, Uint8Array>();
  /** Another host's vault on the same account: core writes the file with that host's locator. */
  const seedVault = (locator: string) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const created = yield* (yield* RecoveryVaults).create({ locator });
          vaultId = created.vault.vaultId;
          return created.recoveryFile.slice();
        })
      ).pipe(
        Effect.provide(
          RecoveryVaults.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(RecoveryVaultStore, {
                  putImmutable: (_vault, entry) =>
                    Effect.sync(() => {
                      entries.set(entry.entryId, encodeRecoveryVaultCiphertext(entry));
                    }),
                  readEntry: (_vault, entryId) => {
                    const stored = entries.get(entryId);
                    return stored
                      ? Effect.fromResult(decodeRecoveryVaultCiphertext(stored))
                      : Effect.succeed(null);
                  },
                  readIndex: () => Effect.succeed(null),
                  compareAndSwapIndex: () => Effect.succeed('Conflict' as const),
                  deleteUnreferenced: () => Effect.void,
                }),
                Layer.succeed(RecoveryVaultLocalStore, {
                  read: (key) => Effect.succeed(journal.get(key) ?? null),
                  list: () => Effect.succeed([]),
                  compareAndSwap: (key, _expected, next) =>
                    Effect.sync(() => {
                      journal.set(key, next.slice());
                      return 'Committed' as const;
                    }),
                })
              )
            )
          )
        )
      )
    );
  return {
    options,
    service,
    entries,
    paths,
    seedVault,
    vaultId: () => vaultId,
    setIntercept: (next?: (path: string) => Promise<unknown> | undefined) => {
      intercept = next;
    },
    logout: () => {
      current = null;
    },
  };
}
it('first browser login creates an empty vault after file readback, and the saved file reopens it', async () => {
  const f = fixture();
  let file = new Uint8Array();
  let borrowed: Uint8Array | undefined;
  expect(
    await Effect.runPromise(
      f.service.create(async (bytes) => {
        expect(f.entries.size).toBe(0);
        borrowed = bytes;
        file = bytes.slice();
        return bytes.slice();
      })
    )
  ).toEqual({ workspaces: 0, passkeys: [], vaultId: expect.any(String) });
  expect(borrowed!.every((value) => value === 0)).toBe(true);
  expect(await Effect.runPromise(f.service.list({ file }))).toEqual({
    workspaces: 0,
    passkeys: [],
  });
  const originalEntries = [...f.entries];
  await expect(
    Effect.runPromise(f.service.create(async (bytes) => bytes.slice()))
  ).rejects.toBeDefined();
  expect([...f.entries]).toEqual(originalEntries);
  file.fill(0);
});
it.each(['mismatched-file', 'logout'] as const)(
  'does not upload a new vault after %s during file confirmation',
  async (reason) => {
    const f = fixture();
    await expect(
      Effect.runPromise(
        f.service.create(async (bytes) => {
          if (reason === 'logout') f.logout();
          const read = bytes.slice();
          if (reason === 'mismatched-file') read[read.length - 1] ^= 1;
          return read;
        })
      )
    ).rejects.toBeDefined();
    expect([...f.entries]).toEqual([]);
  }
);
it('bounds hung vault and workspace recovery RPCs at 90s while preserving 30s Unconfirmed slow relays', async () => {
  const f = fixture();
  let file = new Uint8Array();
  await Effect.runPromise(
    f.service.create(async (bytes) => {
      file = bytes.slice();
      return bytes.slice();
    })
  );
  const clock = ManagedRuntime.make(TestClock.layer({ warningDelay: '1 hour' }));
  try {
    await clock.context();
    // 1. A permanently hung vault read fails at 90s and releases the serial command permit.
    let listEntered!: () => void;
    const listStarted = new Promise<void>((resolve) => {
      listEntered = resolve;
    });
    f.setIntercept((path) => {
      if (path !== 'e2eeRecoveryVault:readIndex') return undefined;
      listEntered();
      return new Promise(() => {});
    });
    const hungList = clock.runPromise(f.service.list({ file }));
    hungList.catch(() => undefined);
    await listStarted;
    await clock.runPromise(TestClock.adjust(89_999));
    const early = await Promise.race([
      hungList.then(
        () => 'settled',
        () => 'settled'
      ),
      new Promise((resolve) => setTimeout(resolve, 0)).then(() => 'waiting'),
    ]);
    expect(early).toBe('waiting');
    await clock.runPromise(TestClock.adjust(1));
    await expect(hungList).rejects.toThrow('e2ee_recovery_failed');

    f.setIntercept(undefined);
    expect(await clock.runPromise(f.service.list({ file }))).toEqual({
      workspaces: 0,
      passkeys: [],
    });

    // 2. In makeRecoveryWorkspaces, a slow 45s RPC reports Unconfirmed at 30s and still succeeds,
    // while a permanently hung 90s RPC settles as Failed and releases the active session.
    const workspaces = makeRecoveryWorkspaces({
      ...f.options,
      commands: {
        restore: async () => {
          throw new Error('unused');
        },
        setup: async () => ({ outcome: 'Committed', recoverable: true }),
      },
    });
    let resolveSlow!: (value: unknown) => void;
    const slowStarted = new Promise<void>((resolve) => {
      f.setIntercept((path) =>
        path === 'e2eeRecoveryVault:replacementState'
          ? new Promise((r) => {
              resolveSlow = r;
              resolve();
            })
          : undefined
      );
    });
    const observed: RecoveryWorkspaceProgress[] = [];
    const slowBatch = clock.runPromise(
      workspaces.setup({ file }, ['w1'], (next) => observed.push(next))
    );
    await slowStarted;
    await clock.runPromise(TestClock.adjust(30_000));
    expect(observed.at(-1)).toEqual({
      results: [{ workspaceId: 'w1', name: 'Alpha', outcome: 'Unconfirmed' }],
      waiting: false,
      pending: true,
    });
    await clock.runPromise(TestClock.adjust(15_000));
    resolveSlow({ current: f.vaultId(), replacing: null });
    expect(await slowBatch).toEqual([
      { workspaceId: 'w1', name: 'Alpha', outcome: 'not-admitted' },
    ]);

    let hungEntered!: () => void;
    const hungStarted = new Promise<void>((resolve) => {
      hungEntered = resolve;
    });
    f.setIntercept((path) => {
      if (path !== 'e2eeRecoveryVault:replacementState') return undefined;
      hungEntered();
      return new Promise(() => {});
    });
    const hungBatch = clock.runPromise(workspaces.setup({ file }, ['w1']));
    await hungStarted;
    await clock.runPromise(TestClock.adjust(90_000));
    expect(await hungBatch).toEqual([{ workspaceId: 'w1', name: 'Alpha', outcome: 'Failed' }]);

    f.setIntercept(undefined);
    expect(await clock.runPromise(workspaces.setup({ file }, ['w1']))).toEqual([
      { workspaceId: 'w1', name: 'Alpha', outcome: 'not-admitted' },
    ]);
  } finally {
    file.fill(0);
    await clock.dispose();
  }
});
it('sets, rotates and removes the vault password wrap from a browser login, keeping the file', async () => {
  const f = fixture();
  let file = new Uint8Array();
  const { vaultId } = await Effect.runPromise(
    f.service.create(async (bytes) => {
      file = bytes.slice();
      return bytes.slice();
    })
  );
  try {
    const first = 'correct horse battery';
    const second = 'staple orbit lantern';
    await Effect.runPromise(f.service.setPassword({ file }, first));
    expect(await Effect.runPromise(f.service.list({ password: first }))).toMatchObject({
      workspaces: 0,
    });
    expect(await Effect.runPromise(f.service.methods(vaultId))).toMatchObject({
      hasFile: true,
      hasPassword: true,
    });
    await Effect.runPromise(f.service.setPassword({ password: first }, second));
    await expect(Effect.runPromise(f.service.list({ password: first }))).rejects.toBeDefined();
    expect(await Effect.runPromise(f.service.list({ password: second }))).toMatchObject({
      workspaces: 0,
    });
    expect(await Effect.runPromise(f.service.removePassword({ file }))).toEqual({
      removed: true,
      pending: false,
    });
    await expect(Effect.runPromise(f.service.list({ password: second }))).rejects.toBeDefined();
    expect(await Effect.runPromise(f.service.list({ file }))).toMatchObject({ workspaces: 0 });
  } finally {
    file.fill(0);
  }
}, 120_000);

it('one Lody Cloud recovery file opens on Web, mobile and desktop-shaped hosts of the same site', async () => {
  const web = fixture();
  let file = new Uint8Array();
  await Effect.runPromise(
    web.service.create(async (bytes) => {
      file = bytes.slice();
      return bytes.slice();
    })
  );
  const written = parseRecoveryFile(file);
  written.unlock.fill(0);
  expect(written.locator).toBe('https://lody.ai');
  vi.stubGlobal('location', { origin: 'capacitor://localhost' });
  const mobile = makeClientRecovery({
    ...web.options,
    platform: 'mobile',
    serviceLocator: 'https://LODY.ai/',
  });
  expect(await Effect.runPromise(mobile.list({ file }))).toEqual({ workspaces: 0, passkeys: [] });
  file.fill(0);
  const desktop = fixture();
  const desktopFile = await desktop.seedVault('https://lody.ai');
  const desktopMobile = makeClientRecovery({
    ...desktop.options,
    platform: 'mobile',
    serviceLocator: 'https://lody.ai',
  });
  expect(await Effect.runPromise(desktopMobile.list({ file: desktopFile }))).toEqual({
    workspaces: 0,
    passkeys: [],
  });
  desktopFile.fill(0);
});
it.each([
  ['another service', 'https://staging.example'],
  ['a legacy account-ID locator', 'abc'],
  ['a legacy Convex deployment locator', 'https://synthetic.convex.cloud'],
])('a recovery file from %s fails closed before any vault read', async (_name, locator) => {
  const f = fixture();
  const file = await f.seedVault(locator);
  const before = f.paths.length;
  await expect(Effect.runPromise(f.service.list({ file }))).rejects.toThrow(
    'e2ee_recovery_authentication'
  );
  expect(f.paths.slice(before)).toEqual([]);
  file.fill(0);
});
it('a host without an HTTP(S) site origin refuses recovery before cloud or journal access', async () => {
  vi.stubGlobal('location', { origin: 'capacitor://localhost' });
  const f = fixture();
  await expect(Effect.runPromise(f.service.list({ file: new Uint8Array(8) }))).rejects.toThrow(
    'e2ee_recovery_disabled'
  );
  expect(f.paths).toEqual([]);
  expect(await indexedDB.databases()).toEqual([]);
});
