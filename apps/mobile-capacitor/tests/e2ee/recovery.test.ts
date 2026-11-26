import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Effect, Layer } from 'effect';
import { ConvexHttpClient } from 'convex/browser';
import { IDBFactory, IDBKeyRange, IDBDatabase } from 'fake-indexeddb';
import { RecoveryVaults } from '@lody/e2ee-core';
import { RecoveryVaultLocalStore, RecoveryVaultStore } from '@lody/e2ee-core/services';
import { decodeRecoveryVaultCiphertext, encodeRecoveryVaultCiphertext } from '@lody/e2ee-core/host';
import { parseRecoveryFile } from '@lody/e2ee-core/protocol';
import { LODY_CLOUD_RECOVERY_SERVICE_LOCATOR } from '@lody/e2ee-client/recovery-locator';
import { E2eePasskeyCancelled, type E2eePasskeyPort } from '@lody/platform/e2ee-passkey';
import { mobileRecoveryJournal } from '../../src/e2ee/recovery-journal';
import {
  makeMobileRecovery,
  mobileRecoverySite,
  visibleSecurityEvents,
} from '../../src/e2ee/recovery';
import { mobileRecoveryPort } from '../../src/recovery/recovery-port';

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it('mobile security activity ignores future kinds and all server navigation fields', () => {
  expect(
    visibleSecurityEvents([
      {
        id: 'a',
        kind: 'personal_device_recovered',
        occurredAt: 10,
        settingsPath: 'https://evil.test',
      },
      { id: 'b', kind: 'future_kind', occurredAt: 30 },
      { id: 'c', kind: 'vault_replacement_finished', occurredAt: 20, email: 'private' },
      { kind: 'personal_device_recovered', occurredAt: NaN },
    ])
  ).toEqual([
    { kind: 'vault_replacement_finished', occurredAt: 20 },
    { kind: 'personal_device_recovered', occurredAt: 10 },
  ]);
});

/** `locator` is the one the seeded vault's file names, as desktop or Web wrote it. */
async function fixture(locator: string = LODY_CLOUD_RECOVERY_SERVICE_LOCATOR) {
  const entries = new Map<string, ReturnType<typeof encodeRecoveryVaultCiphertext>>();
  let index: ReturnType<typeof encodeRecoveryVaultCiphertext> | null = null;
  let current: { accountId: string; sessionId: string } | null = {
    accountId: 'account-a',
    sessionId: 'login-a',
  };
  let enabled = true;
  let failDelete = false;
  let failRefreshAfter: 'add' | 'remove' | undefined;
  let failIndexReads = false;
  const paths: string[] = [];
  let eventWait: (() => Promise<void>) | undefined;
  const prfOutputs: Uint8Array[] = [];
  const client = new ConvexHttpClient('https://synthetic.example.test', {
    fetch: async (_url, init) => {
      const {
        path,
        args: [args],
      } = JSON.parse(String(init?.body)) as { path: string; args: Record<string, unknown>[] };
      paths.push(path);
      let value: unknown;
      if (path === 'accountSecurityEvents:list') {
        await eventWait?.();
        value = {
          events: [
            { id: 'old', kind: 'personal_device_recovered', occurredAt: 10, settingsPath: 'evil' },
            { id: 'future', kind: 'future_kind', occurredAt: 20 },
          ],
          nextCursor: null,
        };
      } else if (path === 'e2eeMembers:workspaces')
        value = [
          { id: 'ws-a', name: 'Alpha', genesisHash: '11'.repeat(32) },
          { id: 'ws-b', name: 'Beta', genesisHash: '22'.repeat(32) },
        ];
      else if (path === 'e2eeRecoveryVault:hasAccountVault') value = { exists: vaultId !== null };
      else if (path === 'e2eeRecoveryVault:replacementState')
        value = { current: vaultId, replacing: null };
      else if (path === 'e2eeRecoveryVault:readEntries')
        value = (args.entryIds as string[]).map((entryId) => entries.get(entryId) ?? null);
      else if (path === 'e2eeRecoveryVault:readEntry')
        value = entries.get(String(args.entryId)) ?? null;
      else if (path === 'e2eeRecoveryVault:readIndex') {
        if (failIndexReads) throw new Error('synthetic list refresh failure');
        value = index;
      } else if (path === 'e2eeRecoveryVault:putImmutable') {
        vaultId = String(args.vaultId);
        const entry = args.entry as ReturnType<typeof encodeRecoveryVaultCiphertext>;
        const previous = entries.get(entry.entryId);
        if (previous && JSON.stringify(previous) !== JSON.stringify(entry))
          throw new Error('immutable conflict');
        entries.set(entry.entryId, entry);
        value = { ok: true };
      } else if (path === 'e2eeRecoveryVault:compareAndSwapIndex') {
        index = args.next as typeof index;
        value = { outcome: 'Committed' };
        if (failRefreshAfter === 'add') failIndexReads = true;
      } else if (path === 'e2eeRecoveryVault:deleteUnreferenced') {
        if (failDelete) throw new Error('synthetic network detail');
        entries.delete(String(args.entryId));
        if (failRefreshAfter === 'remove') failIndexReads = true;
        value = { ok: true };
      } else throw new Error(`unhandled ${path}`);
      return new Response(JSON.stringify({ status: 'success', value }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  client.setAuth('synthetic-auth');
  const store: RecoveryVaultStore['Service'] = {
    putImmutable: (_id, entry) =>
      Effect.sync(() => {
        entries.set(entry.entryId, encodeRecoveryVaultCiphertext(entry));
      }),
    readEntry: (_id, entryId) =>
      entries.has(entryId)
        ? Effect.fromResult(decodeRecoveryVaultCiphertext(entries.get(entryId)))
        : Effect.succeed(null),
    readIndex: () =>
      index ? Effect.fromResult(decodeRecoveryVaultCiphertext(index)) : Effect.succeed(null),
    compareAndSwapIndex: (_id, _expected, next) =>
      Effect.sync(() => {
        index = encodeRecoveryVaultCiphertext(next);
        return 'Committed' as const;
      }),
    deleteUnreferenced: (_id, entryId) =>
      Effect.sync(() => {
        entries.delete(entryId);
      }),
  };
  const values = new Map<string, Uint8Array>();
  const local: RecoveryVaultLocalStore['Service'] = {
    read: (key) => Effect.succeed(values.get(key)?.slice() ?? null),
    list: (prefix) =>
      Effect.succeed(
        [...values]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({ key, value: value.slice() }))
      ),
    compareAndSwap: (key, _expected, next) =>
      Effect.sync(() => {
        values.set(key, next.slice());
        return 'Committed' as const;
      }),
  };
  const seed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const created = yield* (yield* RecoveryVaults).create({
          locator,
          persistFile: () => Effect.void,
        });
        return { vaultId: created.vault.vaultId, file: created.recoveryFile.slice() };
      }).pipe(
        Effect.provide(
          RecoveryVaults.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(RecoveryVaultStore, store),
                Layer.succeed(RecoveryVaultLocalStore, local)
              )
            )
          )
        )
      )
    )
  );
  let vaultId: string | null = seed.vaultId;
  let nextId = 1;
  let prfEnabled = true;
  let userVerified = true;
  let selectedId = 'AQ';
  let native: (() => Promise<void>) | undefined;
  let userHandle: Uint8Array | null = new Uint8Array();
  const passkey: E2eePasskeyPort = {
    available: async () => true,
    register: async (request) => {
      userHandle = request.userHandle.slice();
      return { credentialId: Buffer.from([nextId++]).toString('base64url'), prfEnabled };
    },
    authenticate: async (request) => {
      await native?.();
      const credentialId = request.allowCredentialIds[0] ?? selectedId;
      return {
        credentialId,
        userHandle: userHandle?.slice() ?? null,
        userVerified,
        prfFirst: (() => {
          const bytes = new Uint8Array(32).fill(Buffer.from(credentialId, 'base64url')[0]);
          prfOutputs.push(bytes);
          return bytes;
        })(),
      };
    },
  };
  const options = {
    accountId: 'account-a',
    sessionId: 'login-a',
    currentSession: () => current,
    enabled: () => enabled,
    client,
    passkey,
  };
  const make = () => makeMobileRecovery(options);
  return {
    ...seed,
    empty: () => {
      entries.clear();
      index = null;
      vaultId = null;
    },
    make,
    options,
    prfOutputs,
    failRefreshAfter: (value: 'add' | 'remove' | undefined) => {
      failRefreshAfter = value;
      if (!value) failIndexReads = false;
    },
    handle: (value: Uint8Array | null) => {
      userHandle = value;
    },
    pauseEvents: (value: () => Promise<void>) => {
      eventWait = value;
    },
    select: (value: string) => {
      selectedId = value;
    },
    paths,
    entries,
    index: () => index,
    enabled: (v: boolean) => {
      enabled = v;
    },
    session: (v: typeof current) => {
      current = v;
    },
    supported: (v: boolean) => {
      prfEnabled = v;
    },
    verified: (v: boolean) => {
      userVerified = v;
    },
    native: (v: () => Promise<void>) => {
      native = v;
    },
    failDelete: (v: boolean) => {
      failDelete = v;
    },
  };
}

it('disabled mobile recovery does not access cloud storage, native prompts or a journal', async () => {
  const f = await fixture();
  f.enabled(false);
  await expect(Effect.runPromise(f.make().list('passkey'))).rejects.toThrow(
    'e2ee_recovery_disabled'
  );
  expect(f.paths).toEqual([]);
  expect(await indexedDB.databases()).toEqual([]);
});
it('an added mobile passkey must prove PRF before it becomes visible, and removing it preserves other passkeys', async () => {
  const f = await fixture();
  const service = f.make();
  await Effect.runPromise(service.add(f.file, '  iPhone   daily  '));
  await Effect.runPromise(service.add(f.file, 'iPad'));
  const listed = await Effect.runPromise(service.list('passkey'));
  expect(listed.passkeys.map((row) => row.label)).toEqual(['iPhone daily', 'iPad']);
  expect(listed.workspaces).toBe(0);
  const before = f.index();
  f.supported(false);
  await expect(Effect.runPromise(service.add(f.file, 'unsupported'))).rejects.toThrow(
    'e2ee_recovery_prf-unavailable'
  );
  expect(f.index()).toEqual(before);
  f.supported(true);
  await Effect.runPromise(service.remove({ file: f.file }, listed.passkeys[0]!.entryId));
  const removed = await Effect.runPromise(service.list({ file: f.file }));
  expect(removed.passkeys.map((row) => row.label)).toEqual(['iPad']);
  await expect(Effect.runPromise(service.list('passkey'))).rejects.toThrow(
    'e2ee_recovery_prf-unavailable'
  );
  f.select('Ag');
  expect(
    (await Effect.runPromise(service.list('passkey'))).passkeys.map((row) => row.label)
  ).toEqual(['iPad']);
  expect(f.file.some(Boolean)).toBe(true);
  service.dispose();
  expect(
    (await Effect.runPromise(f.make().list({ file: f.file }))).passkeys.map((row) => row.label)
  ).toEqual(['iPad']);
});
it('UV refusal and native cancellation are not promoted to a mobile vault unlock', async () => {
  const f = await fixture();
  const service = f.make();
  await Effect.runPromise(service.add(f.file, 'iPhone'));
  f.verified(false);
  await expect(Effect.runPromise(service.list('passkey'))).rejects.toThrow(
    'e2ee_recovery_prf-unavailable'
  );
  f.native(async () => {
    throw new E2eePasskeyCancelled('cancelled');
  });
  await expect(Effect.runPromise(service.list('passkey'))).rejects.toThrow(
    'e2ee_recovery_cancelled'
  );
});
it('switching account while a native prompt is open prevents its result and later vault writes', async () => {
  const f = await fixture();
  const service = f.make();
  await Effect.runPromise(service.add(f.file, 'iPhone'));
  let entered!: () => void, settle!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.native(() => {
    entered();
    return new Promise<void>((resolve) => {
      settle = resolve;
    });
  });
  const pending = Effect.runPromise(service.list('passkey'));
  await ready;
  const calls = [...f.paths];
  f.session({ accountId: 'account-b', sessionId: 'login-b' });
  settle();
  await expect(pending).rejects.toThrow('e2ee_recovery_cancelled');
  expect(f.paths).toEqual(calls);
  expect(f.prfOutputs.at(-1)?.every((value) => value === 0)).toBe(true);
});
it('account security events are filtered on the real cloud-client boundary and disposed readers cannot publish', async () => {
  const f = await fixture();
  const service = f.make();
  expect(await Effect.runPromise(service.events())).toEqual([
    { kind: 'personal_device_recovered', occurredAt: 10 },
  ]);
  service.dispose();
  await expect(Effect.runPromise(service.events())).rejects.toThrow('e2ee_recovery_cancelled');
});

it('a failed wrap deletion never claims that the passkey was removed', async () => {
  const f = await fixture();
  const service = f.make();
  await Effect.runPromise(service.add(f.file, 'iPhone'));
  const added = await Effect.runPromise(service.list({ file: f.file }));
  f.failDelete(true);
  await expect(
    Effect.runPromise(service.remove({ file: f.file }, added.passkeys[0]!.entryId))
  ).rejects.toThrow('e2ee_recovery_failed');
  expect(f.entries.has(added.passkeys[0]!.entryId)).toBe(true);
});

it.each(['rejects', 'ignores'] as const)(
  'mobile rollback pins refuse storage that %s strict durability instead of weakening it',
  async (behavior) => {
    const transaction = IDBDatabase.prototype.transaction;
    const patch = vi
      .spyOn(IDBDatabase.prototype, 'transaction')
      .mockImplementation(function (this: IDBDatabase, stores, mode, options) {
        if (options?.durability === 'strict') {
          if (behavior === 'rejects')
            throw new DOMException('synthetic unavailable durability', 'NotSupportedError');
          return transaction.call(this, stores, mode);
        }
        return transaction.call(this, stores, mode, options);
      });
    try {
      await expect(
        Effect.runPromise(
          Effect.scoped(
            Effect.gen(function* () {
              const local = yield* mobileRecoveryJournal('durable-account', () => {});
              return yield* local.compareAndSwap(
                'vault-v1/rollback-pin',
                null,
                new Uint8Array([1])
              );
            })
          )
        )
      ).rejects.toThrow();
    } finally {
      patch.mockRestore();
    }
    const value = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const local = yield* mobileRecoveryJournal('durable-account', () => {});
          return yield* local.read('vault-v1/rollback-pin');
        })
      )
    );
    expect(value).toBeNull();
  }
);

it('a stalled account security feed does not block opening the recovery vault', async () => {
  const f = await fixture();
  const service = f.make();
  let entered!: () => void, settle!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.pauseEvents(() => {
    entered();
    return new Promise<void>((resolve) => {
      settle = resolve;
    });
  });
  const events = Effect.runPromise(service.events());
  await ready;
  try {
    const opened = await Effect.runPromise(service.list({ file: f.file }));
    expect(opened).toEqual({ workspaces: 0, passkeys: [] });
  } finally {
    settle();
    await events;
  }
});
it('disabling recovery during a native prompt refuses late writes and wipes its PRF output', async () => {
  const f = await fixture();
  const service = f.make();
  await Effect.runPromise(service.add(f.file, 'iPhone'));
  let entered!: () => void, settle!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.native(() => {
    entered();
    return new Promise<void>((resolve) => {
      settle = resolve;
    });
  });
  const pending = Effect.runPromise(service.list('passkey'));
  await ready;
  const before = [...f.paths];
  f.enabled(false);
  settle();
  await expect(pending).rejects.toThrow('e2ee_recovery_disabled');
  expect(f.paths).toEqual(before);
  expect(f.prfOutputs.at(-1)?.every((value) => value === 0)).toBe(true);
});

it.each([null, new Uint8Array([1])])(
  'a rejected discoverable handle %s still wipes every borrowed PRF output',
  async (handle) => {
    const f = await fixture();
    const service = f.make();
    await Effect.runPromise(service.add(f.file, 'iPhone'));
    f.handle(handle);
    const before = [...f.paths];
    await expect(Effect.runPromise(service.list('passkey'))).rejects.toThrow(
      'e2ee_recovery_prf-unavailable'
    );
    expect(f.paths).toEqual(before);
    expect(f.prfOutputs.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
  }
);

it('completed passkey enrollment succeeds without a follow-up list read; retrying the list never registers another credential', async () => {
  const f = await fixture();
  const service = f.make();
  f.failRefreshAfter('add');
  await expect(Effect.runPromise(service.add(f.file, 'iPhone'))).resolves.toBeUndefined();
  await expect(Effect.runPromise(service.list({ file: f.file }))).rejects.toThrow();
  f.failRefreshAfter(undefined);
  expect(
    (await Effect.runPromise(service.list('passkey'))).passkeys.map((row) => row.label)
  ).toEqual(['iPhone']);
  expect(f.paths.filter((path) => path === 'e2eeRecoveryVault:compareAndSwapIndex')).toHaveLength(
    1
  );
  expect(f.prfOutputs.every((bytes) => bytes.every((value) => value === 0))).toBe(true);
});
it('confirmed wrap deletion succeeds even when the next list refresh fails', async () => {
  const f = await fixture();
  const service = f.make();
  await Effect.runPromise(service.add(f.file, 'iPhone'));
  const entryId = (await Effect.runPromise(service.list({ file: f.file }))).passkeys[0]!.entryId;
  f.failRefreshAfter('remove');
  await expect(
    Effect.runPromise(service.remove({ file: f.file }, entryId))
  ).resolves.toBeUndefined();
  expect(f.entries.has(entryId)).toBe(false);
  await expect(Effect.runPromise(service.list({ file: f.file }))).rejects.toThrow();
  f.failRefreshAfter(undefined);
  expect((await Effect.runPromise(service.list({ file: f.file }))).passkeys).toEqual([]);
  await expect(Effect.runPromise(service.list('passkey'))).rejects.toThrow(
    'e2ee_recovery_prf-unavailable'
  );
});

/** The console's mobile port over this fixture. Each file prompt hands out a fresh copy
 * of the recovery file and keeps it, so a test can see what the port left behind. */
function consolePort(f: Awaited<ReturnType<typeof fixture>>, answers: ('file' | 'dismiss')[]) {
  const handed: Uint8Array[] = [];
  const owned = mobileRecoveryPort({
    config: {
      ...f.options,
      run: Effect.runPromise,
      defaultLabel: async () => 'iPhone',
      runtime: () => undefined,
    },
    accountId: 'account-a',
    sessionId: 'login-a',
    currentSession: f.options.currentSession,
    chooseFile: async () => {
      if (answers.shift() !== 'file') return null;
      const copy = f.file.slice();
      handed.push(copy);
      return copy;
    },
  });
  return { ...owned, handed };
}
/** Every value a port result carries, walked to its leaves. */
function leaves(value: unknown): unknown[] {
  if (value === null || typeof value !== 'object') return [value];
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return [value];
  return Object.values(value).flatMap(leaves);
}

it('the mobile console port offers file, passkey and password creation while leaving replacement unsupported', async () => {
  const f = await fixture();
  const { port, dispose } = consolePort(f, []);
  expect(port.create).toBeTypeOf('function');
  expect(port.createWithPasskey).toBeTypeOf('function');
  expect(port.createWithPassword).toBeTypeOf('function');
  expect(port.saveFile).toBeTypeOf('function');
  expect(port.replacement).toBeNull();
  // A replacement started elsewhere is not one this host can continue.
  expect(await port.plan()).toMatchObject({ hasVault: true, replacing: false });
  dispose();
});

it('one recovery-file prompt sets up every selected workspace and reports each on its own', async () => {
  const f = await fixture();
  const { port, handed, dispose } = consolePort(f, ['file']);
  const plan = await port.plan();
  // Neither workspace has an identity on this phone yet, so both are restore targets.
  expect(plan.uncovered.map((row) => row.id)).toEqual(['ws-a', 'ws-b']);
  const settled = await port.setupWorkspaces(['ws-a', 'ws-b', 'ws-gone'], 'file');
  expect(handed).toHaveLength(1);
  // Not admitted here and no longer visible: none of them is a finished, verified setup.
  expect(settled).toEqual({
    outcome: 'settled',
    results: [
      { workspaceId: 'ws-a', outcome: 'not-admitted', recoverable: false },
      { workspaceId: 'ws-b', outcome: 'not-admitted', recoverable: false },
      { workspaceId: 'ws-gone', outcome: 'Failed', recoverable: false },
    ],
  });
  dispose();
});

it('no recovery file, vault handle or PRF output crosses the mobile console port', async () => {
  const f = await fixture();
  await Effect.runPromise(f.make().add(f.file, 'iPhone'));
  const { port, handed, dispose } = consolePort(f, ['file', 'file', 'file', 'dismiss']);
  const outcomes: unknown[] = [
    await port.plan(),
    await port.securityEvents(),
    await port.checkFile!(),
    await port.listPasskeys(),
  ];
  const listed = outcomes[3] as { passkeys: { entryId: string }[] };
  outcomes.push(await port.removePasskey(listed.passkeys[0]!.entryId));
  const paths = f.paths.length;
  // A dismissed chooser is a choice, not a failure, and reaches no service.
  outcomes.push(await port.addPasskey('iPad'));
  expect(outcomes.at(-1)).toEqual({ outcome: 'cancelled' });
  expect(f.paths).toHaveLength(paths);
  expect(outcomes[2]).toEqual({ outcome: 'opened', vaultId: f.vaultId, workspaces: 0 });
  expect(outcomes[4]).toMatchObject({ outcome: 'removed', passkeys: [], pending: [] });
  const fileHex = Buffer.from(f.file).toString('hex');
  const fileB64 = Buffer.from(f.file).toString('base64');
  for (const leaf of leaves(outcomes)) {
    expect(typeof leaf === 'object' && leaf !== null).toBe(false);
    expect(String(leaf)).not.toContain(fileHex);
    expect(String(leaf)).not.toContain(fileB64);
  }
  // The security feed keeps known kinds and times only; its IDs never become navigation.
  expect(outcomes[1]).toEqual([
    { id: 'personal_device_recovered:10:0', kind: 'personal_device_recovered', occurredAt: 10 },
  ]);
  // Each chosen file is wiped once its command settles.
  expect(handed).toHaveLength(3);
  for (const bytes of handed) expect(bytes.every((value) => value === 0)).toBe(true);
  dispose();
  // After logout or account change the port refuses further work.
  await expect(port.plan()).rejects.toThrow();
});

it('a confirmed passkey removal through the console port stands when the list cannot be read again', async () => {
  const f = await fixture();
  await Effect.runPromise(f.make().add(f.file, 'iPhone'));
  const { port, dispose } = consolePort(f, ['file', 'file', 'file']);
  const listed = await port.listPasskeys();
  const entryId = (listed as { passkeys: { entryId: string }[] }).passkeys[0]!.entryId;
  f.failRefreshAfter('remove');
  // The removal is reported without a stale list, so the section drops its old one.
  expect(await port.removePasskey(entryId)).toEqual({ outcome: 'removed' });
  expect(f.entries.has(entryId)).toBe(false);
  // Only the read is retried, with a fresh unlock.
  f.failRefreshAfter(undefined);
  expect(await port.listPasskeys()).toEqual({ outcome: 'listed', passkeys: [], pending: [] });
  dispose();
});

it.each(['file', 'password', 'passkey'] as const)(
  'iOS creates a %s vault, verifies its exported file and reopens the backup without exposing bytes',
  async (method) => {
    const f = await fixture();
    f.empty();
    let saved = new Uint8Array();
    const owned = mobileRecoveryPort({
      config: {
        ...f.options,
        run: Effect.runPromise,
        defaultLabel: async () => 'iPhone',
        runtime: () => undefined,
      },
      accountId: 'account-a',
      sessionId: 'login-a',
      currentSession: f.options.currentSession,
      exportFile: async (bytes) => {
        saved = bytes.slice();
        return true;
      },
      chooseFile: async () => saved.slice(),
    });
    try {
      const created =
        method === 'file'
          ? await owned.port.create!()
          : method === 'password'
            ? await owned.port.createWithPassword!('a strong synthetic recovery password')
            : await owned.port.createWithPasskey!();
      expect(created).toEqual({ outcome: 'created', vaultId: expect.any(String) });
      expect(await owned.port.plan()).toMatchObject({
        hasVault: true,
        methods: {
          hasFile: method === 'file',
          hasPassword: method === 'password',
          hasPasskey: method === 'passkey',
        },
      });
      if (method !== 'file') {
        expect(
          await owned.port.saveFile!(method, { password: 'a strong synthetic recovery password' })
        ).toMatchObject({ outcome: 'saved', vaultId: expect.any(String) });
        expect(await owned.port.plan()).toMatchObject({ methods: { hasFile: true } });
      }
      expect(await owned.port.checkFile!()).toMatchObject({ outcome: 'opened', workspaces: 0 });
      expect(await owned.port.restore('file')).toEqual({
        outcome: 'restored',
        results: [
          { workspaceId: 'ws-a', name: 'Alpha', outcome: 'not-backed-up' },
          { workspaceId: 'ws-b', name: 'Beta', outcome: 'not-backed-up' },
        ],
      });
      for (const bytes of f.prfOutputs) expect(bytes.every((byte) => byte === 0)).toBe(true);
    } finally {
      saved.fill(0);
      owned.dispose();
    }
  },
  30_000
);

it.each(['dismiss', 'mismatch', 'logout'] as const)(
  'iOS never uploads a vault after %s during file export verification',
  async (reason) => {
    const f = await fixture();
    f.empty();
    let saved = new Uint8Array();
    let read: Uint8Array | null = null;
    const owned = mobileRecoveryPort({
      config: {
        ...f.options,
        run: Effect.runPromise,
        defaultLabel: async () => 'iPhone',
        runtime: () => undefined,
      },
      accountId: 'account-a',
      sessionId: 'login-a',
      currentSession: f.options.currentSession,
      exportFile: async (bytes) => {
        saved = bytes.slice();
        return true;
      },
      chooseFile: async () => {
        if (reason === 'dismiss') return null;
        read = saved.slice();
        if (reason === 'mismatch') read[0] ^= 1;
        if (reason === 'logout') f.session(null);
        return read;
      },
    });
    try {
      if (reason === 'dismiss')
        expect(await owned.port.create!()).toEqual({ outcome: 'cancelled' });
      else await expect(owned.port.create!()).rejects.toThrow();
      expect(f.paths).not.toContain('e2eeRecoveryVault:putImmutable');
      if (read) expect((read as Uint8Array).every((byte) => byte === 0)).toBe(true);
    } finally {
      saved.fill(0);
      owned.dispose();
    }
  }
);

it('cancelling an offline-file backup preserves the passkey vault and allows a verified retry', async () => {
  const f = await fixture();
  f.empty();
  let cancelled = true;
  let saved = new Uint8Array();
  const owned = mobileRecoveryPort({
    config: {
      ...f.options,
      run: Effect.runPromise,
      defaultLabel: async () => 'iPhone',
      runtime: () => undefined,
    },
    accountId: 'account-a',
    sessionId: 'login-a',
    currentSession: f.options.currentSession,
    exportFile: async (bytes) => {
      saved = bytes.slice();
      return !cancelled;
    },
    chooseFile: async () => saved.slice(),
  });
  try {
    await owned.port.createWithPasskey!();
    const puts = f.paths.filter((path) => path === 'e2eeRecoveryVault:putImmutable').length;
    expect(await owned.port.saveFile!('passkey')).toEqual({ outcome: 'cancelled' });
    expect(f.paths.filter((path) => path === 'e2eeRecoveryVault:putImmutable')).toHaveLength(puts);
    expect(await owned.port.plan()).toMatchObject({
      methods: { hasFile: false, hasPasskey: true },
    });
    saved.fill(0);
    cancelled = false;
    expect(await owned.port.saveFile!('passkey')).toMatchObject({ outcome: 'saved' });
    expect(await owned.port.checkFile!()).toMatchObject({ outcome: 'opened' });
  } finally {
    saved.fill(0);
    owned.dispose();
  }
});

it('passkey vault creation refuses unavailable PRF before any cloud write', async () => {
  const f = await fixture();
  f.empty();
  f.supported(false);
  const { port, dispose } = consolePort(f, []);
  try {
    await expect(port.createWithPasskey!()).rejects.toThrow();
    expect(f.paths).not.toContain('e2eeRecoveryVault:putImmutable');
  } finally {
    dispose();
  }
});

it('mobile opens Lody Cloud files from desktop and Web, and its own files name the same origin', async () => {
  expect(mobileRecoverySite({})).toBe(LODY_CLOUD_RECOVERY_SERVICE_LOCATOR);
  const f = await fixture('https://lody.ai');
  expect(await Effect.runPromise(f.make().list({ file: f.file }))).toEqual({
    workspaces: 0,
    passkeys: [],
  });
  f.empty();
  let saved = new Uint8Array();
  await Effect.runPromise(
    f.make().create(async (bytes) => {
      saved = bytes.slice();
      return bytes.slice();
    })
  );
  const written = parseRecoveryFile(saved);
  written.unlock.fill(0);
  saved.fill(0);
  expect(written.locator).toBe('https://lody.ai');
});
it.each([
  ['another service', 'https://staging.example'],
  ['the earlier mobile account-ID locator', 'account-a'],
  ['the earlier desktop Convex locator', 'https://synthetic.convex.cloud'],
])('mobile rejects a recovery file from %s before any vault read', async (_name, locator) => {
  const f = await fixture(locator);
  await expect(Effect.runPromise(f.make().list({ file: f.file }))).rejects.toThrow(
    'e2ee_recovery_authentication'
  );
  expect(f.paths).toEqual([]);
});
it('a staging build binds the origin of its VITE_SITE_URL instead of Lody Cloud', async () => {
  vi.stubEnv('VITE_SITE_URL', ' https://Staging.example/app ');
  const staging = await fixture('https://staging.example');
  expect(await Effect.runPromise(staging.make().list({ file: staging.file }))).toEqual({
    workspaces: 0,
    passkeys: [],
  });
  const cloud = await fixture('https://lody.ai');
  await expect(Effect.runPromise(cloud.make().list({ file: cloud.file }))).rejects.toThrow(
    'e2ee_recovery_authentication'
  );
});
