/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  listPendingE2eeWorkspaces,
  readE2eeGenesisPin,
  readObservedLedgerCheckpoint,
  readWorkspaceModeProof,
  retainWorkspaceModeProof,
  saveE2eeGenesisPin,
  savePendingE2eeWorkspace,
} from '../src/lib/e2ee-workspace-storage';
import {
  createSessionInputStorage,
  SESSION_INPUT_DATABASE,
} from '../src/lib/session-input-storage';
import type { PendingSessionSend } from '../src/lib/session-pending-sends';

import {
  LOCAL_CLEAR_RECORD_RELEVANCE_MS,
  markCacheClearPending,
  maybeClearLodyCacheOnBoot,
  readLastLocalClear,
  readRecentLocalClear,
  readPendingLocalClearMode,
  resetBootClearMemoForTests,
  restartIntoCacheClear,
  startHardReset,
} from '../src/lib/clear-local-cache';
import { registerAuthClient } from '../src/lib/auth-client-singleton';
import type { LodyAuthClient } from '../src/lib/auth';

const CACHE_CLEAR_FLAG = 'lody:clearCacheOnBoot';

let deletedDatabases: string[];
let deletedCaches: string[];
let presentDatabases: string[];
let presentCaches: string[];
/** Databases whose delete request errors, as on a storage backend that cannot open them. */
let failingDatabases: Set<string>;

type Listener = () => void;

function installFakeIndexedDb() {
  const fake = {
    databases: async () => presentDatabases.map((name) => ({ name, version: 1 })),
    deleteDatabase: (name: string) => {
      deletedDatabases.push(name);
      const listeners = new Map<string, Listener>();
      const failing = failingDatabases.has(name);
      // Resolve on the microtask queue: the helper races a 3s timeout, so this
      // keeps the test off real timers.
      void Promise.resolve().then(() => {
        if (failing) {
          listeners.get('error')?.();
          return;
        }
        presentDatabases = presentDatabases.filter((present) => present !== name);
        listeners.get('success')?.();
      });
      return {
        error: failing ? new DOMException('backing store', 'UnknownError') : null,
        addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      };
    },
  };
  Object.defineProperty(globalThis, 'indexedDB', { value: fake, configurable: true });
}

function installFakeCacheStorage() {
  const fake = {
    keys: async () => [...presentCaches],
    delete: async (key: string) => {
      deletedCaches.push(key);
      return true;
    },
  };
  Object.defineProperty(globalThis, 'caches', { value: fake, configurable: true });
}

beforeEach(() => {
  resetBootClearMemoForTests();
  deletedDatabases = [];
  deletedCaches = [];
  presentDatabases = ['lody:repo-file-paths', 'lody-loro-repo-db-ws1', 'someone-elses-db'];
  presentCaches = ['lody-avatars', 'unrelated-cache'];
  failingDatabases = new Set();
  localStorage.clear();
  sessionStorage.clear();
  installFakeIndexedDb();
  installFakeCacheStorage();
  // jsdom logs "Not implemented: navigation" for reload/replace.
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('maybeClearLodyCacheOnBoot', () => {
  it('preserves encrypted creation intents, genesis pins and authenticated mode evidence during ordinary cache clear', async () => {
    const hash = '12'.repeat(32);
    const intent = {
      accountId: 'account',
      requestId: 'request',
      name: 'Synthetic',
      slug: 'synthetic',
    };
    savePendingE2eeWorkspace(localStorage, intent);
    saveE2eeGenesisPin(localStorage, 'account', 'encrypted', hash);
    const observed = { genesisHash: hash, headHash: hash, length: 1 };
    localStorage.setItem(
      `lody-e2ee-observed-ledger:account:encrypted:1:${hash}`,
      JSON.stringify(observed)
    );
    retainWorkspaceModeProof(localStorage, 'account', 'synthetic', {
      workspaceId: 'encrypted',
      contentMode: 'e2ee',
      contentModeVersion: 1,
      genesisHash: hash,
      cryptoOrgId: hash,
      activation: 'control-only',
    });
    retainWorkspaceModeProof(localStorage, 'account', 'plain', {
      workspaceId: 'plain',
      contentMode: 'plaintext',
      contentModeVersion: 1,
    });
    markCacheClearPending();
    await maybeClearLodyCacheOnBoot();
    expect(listPendingE2eeWorkspaces(localStorage, 'account')).toEqual([intent]);
    expect(readE2eeGenesisPin(localStorage, 'account', 'encrypted')).toBe(hash);
    expect(readObservedLedgerCheckpoint(localStorage, 'account', 'encrypted')).toEqual(observed);
    expect(readWorkspaceModeProof(localStorage, 'account', 'encrypted', 'synthetic')).toMatchObject(
      { contentMode: 'e2ee' }
    );
    expect(readWorkspaceModeProof(localStorage, 'account', 'plain', 'plain')).toMatchObject({
      contentMode: 'plaintext',
    });
  });
  it('does nothing when no clear was requested', async () => {
    localStorage.setItem('lody:auth-token', 'token');

    await maybeClearLodyCacheOnBoot(['lody-loro-repo-db-ws1']);

    expect(deletedDatabases).toEqual([]);
    expect(deletedCaches).toEqual([]);
    expect(localStorage.getItem('lody:auth-token')).toBe('token');
  });

  it('clears only lody caches for a cache clear, and keeps the user signed in', async () => {
    localStorage.setItem('lody:auth-token', 'token');
    markCacheClearPending();

    await maybeClearLodyCacheOnBoot();

    expect(deletedDatabases).toContain('lody:repo-file-paths');
    expect(deletedDatabases).toContain('lody-loro-repo-db-ws1');
    expect(deletedDatabases).not.toContain('someone-elses-db');
    expect(deletedCaches).toEqual(['lody-avatars']);
    expect(localStorage.getItem('lody:auth-token')).toBe('token');
    expect(readPendingLocalClearMode()).toBeNull();
  });

  it('keeps the only saved input through cache recovery, and erases it only on explicit full reset', async () => {
    const factory = new IDBFactory();
    const original = globalThis.indexedDB;
    Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true });
    const input = {
      id: 'cache-protected-input',
      sessionId: 'cache-session',
      workspaceId: 'cache-workspace',
      sequence: 1,
      historyBackend: 'roost',
      targetMachineId: 'original-machine',
      delivery: { kind: 'dispatch' },
      attachments: [],
      entry: {
        id: 'cache-protected-input',
        role: 'user',
        userId: 'cache-account',
        timestamp: '2026-10-13T00:00:00.000Z',
        items: [{ type: 'text', text: 'only-local-copy' }],
        status: 'pending',
      },
    } as PendingSessionSend;
    let storage = createSessionInputStorage('cache-account', 'cache-workspace', factory);
    try {
      await storage.save(input);
      await storage.close();
      markCacheClearPending();
      await maybeClearLodyCacheOnBoot([SESSION_INPUT_DATABASE]);
      storage = createSessionInputStorage('cache-account', 'cache-workspace', factory);
      expect((await storage.get(input.id))?.send.entry.items).toEqual([
        { type: 'text', text: 'only-local-copy' },
      ]);
      await storage.close();
      resetBootClearMemoForTests();
      await startHardReset();
      await maybeClearLodyCacheOnBoot();
      storage = createSessionInputStorage('cache-account', 'cache-workspace', factory);
      expect(await storage.list()).toEqual([]);
    } finally {
      await storage.close();
      Object.defineProperty(globalThis, 'indexedDB', { value: original, configurable: true });
    }
  });

  it('wipes everything for a hard reset, including storage and unrelated stores', async () => {
    localStorage.setItem('lody:auth-token', 'token');
    sessionStorage.setItem('draft', 'unsent');
    await startHardReset();
    // The flag has to outlive the synchronous wipe, otherwise boot skips the
    // asynchronous IndexedDB pass and the reset is only half done.
    expect(readPendingLocalClearMode()).toBe('hard');
    expect(localStorage.getItem('lody:auth-token')).toBeNull();
    expect(sessionStorage.getItem('draft')).toBeNull();

    await maybeClearLodyCacheOnBoot();

    expect(deletedDatabases).toContain('lody-loro-repo-db-ws1');
    expect(deletedDatabases).toContain('someone-elses-db');
    expect(deletedCaches).toEqual(expect.arrayContaining(['lody-avatars', 'unrelated-cache']));
    expect(localStorage.getItem(CACHE_CLEAR_FLAG)).toBeNull();
  });

  it('drops connection-state localStorage caches but keeps auth token and preferences', async () => {
    localStorage.setItem('lody_auth_token', 'token');
    localStorage.setItem('lody:idePreference', '"vscode"');
    localStorage.setItem('lody:agentSessionDefaults', '{}');
    localStorage.setItem('lody:loroStreamsToken:ws1', '{"version":2}');
    localStorage.setItem('lody:loroStreamsMetaCursorBypass:ws1', 'marker');
    localStorage.setItem(
      'lody:workspaceInfo',
      JSON.stringify({ slug: { workspaceId: 'ws-cached', workspaceName: 'W', updatedAt: 1 } })
    );
    localStorage.setItem('lody:githubReposCache', '{}');
    localStorage.setItem('lody:githubBranchesCache', '{}');
    localStorage.setItem('lody:usageDayDetails', '{}');
    localStorage.setItem('lody:auth-bootstrap', '{}');
    markCacheClearPending();

    await maybeClearLodyCacheOnBoot();

    expect(localStorage.getItem('lody:loroStreamsToken:ws1')).toBeNull();
    expect(localStorage.getItem('lody:loroStreamsMetaCursorBypass:ws1')).toBeNull();
    expect(localStorage.getItem('lody:workspaceInfo')).toBeNull();
    expect(localStorage.getItem('lody:githubReposCache')).toBeNull();
    expect(localStorage.getItem('lody:githubBranchesCache')).toBeNull();
    expect(localStorage.getItem('lody:usageDayDetails')).toBeNull();
    expect(localStorage.getItem('lody:auth-bootstrap')).toBeNull();
    // The user stays signed in and keeps preferences.
    expect(localStorage.getItem('lody_auth_token')).toBe('token');
    expect(localStorage.getItem('lody:idePreference')).toBe('"vscode"');
    expect(localStorage.getItem('lody:agentSessionDefaults')).toBe('{}');
    // The workspace-info map must be read for database names BEFORE it is
    // removed — the cached workspace's databases still get deleted.
    expect(deletedDatabases).toContain('lody-loro-repo-db-ws-cached');
    expect(deletedDatabases).toContain('lody-loro-stream-cursors-ws-cached');
  });

  it('runs one clear per page load no matter how many callers await it', async () => {
    markCacheClearPending();

    await Promise.all([
      maybeClearLodyCacheOnBoot(),
      maybeClearLodyCacheOnBoot(),
      maybeClearLodyCacheOnBoot(),
    ]);

    const repoFilePathsDeletes = deletedDatabases.filter((name) => name === 'lody:repo-file-paths');
    expect(repoFilePathsDeletes).toHaveLength(1);
  });

  it('still deletes a caller-supplied database name that enumeration missed', async () => {
    presentDatabases = [];
    markCacheClearPending();

    await maybeClearLodyCacheOnBoot(['lody-loro-repo-db-ws-uncached']);

    expect(deletedDatabases).toContain('lody-loro-repo-db-ws-uncached');
  });

  it('ignores caller-supplied names when nothing was pending', async () => {
    await maybeClearLodyCacheOnBoot(['lody-loro-repo-db-ws-uncached']);

    expect(deletedDatabases).toEqual([]);
  });

  it.each([
    ['enumerated', ['lody-session-send-v1']],
    ['not enumerable', []],
  ])('removes the retired session-send journal database (%s)', async (_label, present) => {
    presentDatabases = present;
    localStorage.setItem('lody_auth_token', 'token');
    markCacheClearPending();

    await maybeClearLodyCacheOnBoot();

    expect(deletedDatabases).toContain('lody-session-send-v1');
    expect(localStorage.getItem('lody_auth_token')).toBe('token');
    expect(readPendingLocalClearMode()).toBeNull();
  });

  it.each([
    ['force-cache', 'cache'],
    ['force-all', 'hard'],
  ] as const)(
    'completes a %s clear armed by a build that had the send journal',
    async (flag, mode) => {
      presentDatabases = ['lody-session-send-v1', 'lody-loro-repo-db-ws1', 'someone-elses-db'];
      localStorage.setItem('lody_auth_token', 'token');
      localStorage.setItem(CACHE_CLEAR_FLAG, flag);
      expect(readPendingLocalClearMode()).toBe(mode);

      await maybeClearLodyCacheOnBoot();

      expect(deletedDatabases).toEqual(
        expect.arrayContaining(['lody-session-send-v1', 'lody-loro-repo-db-ws1'])
      );
      expect(deletedDatabases.includes('someone-elses-db')).toBe(mode === 'hard');
      expect(localStorage.getItem('lody_auth_token')).toBe(mode === 'hard' ? null : 'token');
      expect(localStorage.getItem(CACHE_CLEAR_FLAG)).toBeNull();
    }
  );
});

describe('restartIntoCacheClear', () => {
  afterEach(() => {
    delete (window as { ipc?: unknown }).ipc;
  });

  /** The desktop bridge; `relaunchIntoLocalReset` answers with `outcome`. */
  function installDesktop(outcome: 'quitting' | 'cancelled') {
    const relaunches: unknown[] = [];
    (window as unknown as { ipc: unknown }).ipc = {
      invoke: async (channel: string, ...args: unknown[]) => {
        if (channel !== 'app.relaunchIntoLocalReset') return null;
        relaunches.push(args[0]);
        return outcome;
      },
    };
    return relaunches;
  }

  it('reloads this window by default, even on the desktop', async () => {
    const relaunches = installDesktop('quitting');

    expect(await restartIntoCacheClear()).toBe(true);

    // Relaunching would quit the whole app and stop the embedded CLI's agents.
    expect(relaunches).toEqual([]);
    expect(readPendingLocalClearMode()).toBe('cache');
  });

  it('relaunches into the clear only when asked to', async () => {
    const relaunches = installDesktop('quitting');

    expect(await restartIntoCacheClear({ relaunch: true })).toBe(true);

    expect(relaunches).toEqual(['cache']);
    expect(readPendingLocalClearMode()).toBeNull();
  });

  it('reports a relaunch the person cancelled, and arms nothing', async () => {
    installDesktop('cancelled');

    expect(await restartIntoCacheClear({ relaunch: true })).toBe(false);

    expect(readPendingLocalClearMode()).toBeNull();
  });
});

describe('a boot clear that cannot delete everything', () => {
  it('records a complete clear and consumes the flag', async () => {
    markCacheClearPending();

    await maybeClearLodyCacheOnBoot();

    expect(readLastLocalClear()).toMatchObject({ mode: 'cache', ok: true });
    expect(readPendingLocalClearMode()).toBeNull();
  });

  it('records a clear that left databases behind, and does not run it again', async () => {
    failingDatabases.add('lody-loro-repo-db-ws1');
    markCacheClearPending();

    await maybeClearLodyCacheOnBoot();

    expect(readLastLocalClear()).toMatchObject({ mode: 'cache', ok: false, failedCount: 1 });
    // A re-run deletes everything again (after a hard reset, the next sign-in
    // too); whether to retry is the person's choice on the recovery page.
    expect(readPendingLocalClearMode()).toBeNull();
    resetBootClearMemoForTests();
    deletedDatabases = [];
    await maybeClearLodyCacheOnBoot();
    expect(deletedDatabases).toEqual([]);
  });

  it('treats a clear older than a day as no longer relevant', async () => {
    markCacheClearPending();
    await maybeClearLodyCacheOnBoot();
    const { atMs } = readLastLocalClear()!;

    expect(readRecentLocalClear(atMs + LOCAL_CLEAR_RECORD_RELEVANCE_MS - 1)).not.toBeNull();
    expect(readRecentLocalClear(atMs + LOCAL_CLEAR_RECORD_RELEVANCE_MS)).toBeNull();
    // A clock that moved backwards cannot make a record look current either.
    expect(readRecentLocalClear(atMs - 1)).toBeNull();
  });

  it('counts a database that still exists after a reported success as not cleared', async () => {
    const deleteDatabase = indexedDB.deleteDatabase.bind(indexedDB);
    const stubborn = 'lody-loro-repo-db-ws1';
    (indexedDB as unknown as { deleteDatabase: (name: string) => unknown }).deleteDatabase = (
      name: string
    ) => {
      const request = deleteDatabase(name);
      if (name === stubborn) void Promise.resolve().then(() => presentDatabases.push(stubborn));
      return request;
    };
    markCacheClearPending();

    await maybeClearLodyCacheOnBoot();

    expect(readLastLocalClear()).toMatchObject({ ok: false, failedCount: 1 });
  });

  it('keeps the record of a failed hard wipe through the wipe itself', async () => {
    failingDatabases.add('someone-elses-db');
    localStorage.setItem(CACHE_CLEAR_FLAG, 'all');

    await maybeClearLodyCacheOnBoot();

    expect(readLastLocalClear()).toMatchObject({ mode: 'hard', ok: false });
    // Re-arming a hard wipe would sign the person out again after they sign in.
    expect(readPendingLocalClearMode()).toBeNull();
  });
});

describe('a clear armed from the CLI', () => {
  afterEach(() => {
    delete (window as { ipc?: unknown }).ipc;
  });

  /** Stands in for the Electron preload bridge; `getIpcServices` needs only `invoke`. */
  function installFakeIpcBridge(invoke: (channel: string) => Promise<unknown>) {
    const channels: string[] = [];
    (window as unknown as { ipc: { invoke: (channel: string) => Promise<unknown> } }).ipc = {
      invoke: (channel: string) => {
        channels.push(channel);
        return invoke(channel);
      },
    };
    return channels;
  }

  it('runs the precise cache clear the desktop armed, with no flag in localStorage', async () => {
    localStorage.setItem('lody_auth_token', 'token');
    localStorage.setItem('lody:githubReposCache', '{}');
    const channels = installFakeIpcBridge(async (channel) =>
      channel === 'app.consumePendingLocalClear' ? 'cache' : undefined
    );

    await maybeClearLodyCacheOnBoot();

    expect(channels).toContain('app.consumePendingLocalClear');
    expect(deletedDatabases).toContain('lody-loro-repo-db-ws1');
    expect(deletedDatabases).not.toContain('someone-elses-db');
    expect(localStorage.getItem('lody:githubReposCache')).toBeNull();
    // A cache reset keeps the session; only `--hard` signs the user out.
    expect(localStorage.getItem('lody_auth_token')).toBe('token');
  });

  it('does not ask the desktop when the in-app flag already answered', async () => {
    markCacheClearPending();
    const channels = installFakeIpcBridge(async () => 'hard');

    await maybeClearLodyCacheOnBoot();

    expect(channels).not.toContain('app.consumePendingLocalClear');
    // The flag said `cache`, so the unrelated database survives.
    expect(deletedDatabases).not.toContain('someone-elses-db');
  });

  it('clears nothing when the desktop reports no armed reset', async () => {
    installFakeIpcBridge(async () => null);

    await maybeClearLodyCacheOnBoot(['lody-loro-repo-db-ws1']);

    expect(deletedDatabases).toEqual([]);
    expect(deletedCaches).toEqual([]);
  });

  it('gives up on a desktop that never answers instead of holding up boot', async () => {
    vi.useFakeTimers();
    try {
      installFakeIpcBridge(() => new Promise(() => {}));

      const booting = maybeClearLodyCacheOnBoot(['lody-loro-repo-db-ws1']);
      await vi.advanceTimersByTimeAsync(2000);
      await booting;

      expect(deletedDatabases).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('startHardReset sign-out', () => {
  afterEach(() => {
    registerAuthClient(null as unknown as LodyAuthClient);
    delete (window as { __LODY_NATIVE_RESET__?: unknown }).__LODY_NATIVE_RESET__;
    delete (window as { ipc?: unknown }).ipc;
  });

  it('hands the wipe to a native shell that can delete at the file level', async () => {
    localStorage.setItem('lody:auth-token', 'token');
    const resets: string[] = [];
    (window as { __LODY_NATIVE_RESET__?: unknown }).__LODY_NATIVE_RESET__ = {
      version: 1,
      resetAllData: async () => {
        resets.push(localStorage.getItem('lody:auth-token') ?? 'gone');
      },
    };

    await startHardReset();

    expect(resets).toEqual(['token']);
    // The shell owns the wipe and the reload; nothing was armed for a web wipe.
    expect(readPendingLocalClearMode()).toBeNull();
  });

  it('falls back to the web wipe when the native shell refuses', async () => {
    localStorage.setItem('lody:auth-token', 'token');
    (window as { __LODY_NATIVE_RESET__?: unknown }).__LODY_NATIVE_RESET__ = {
      version: 1,
      resetAllData: async () => {
        throw new Error('not now');
      },
    };

    await startHardReset();

    expect(localStorage.getItem('lody:auth-token')).toBeNull();
    expect(readPendingLocalClearMode()).toBe('hard');
  });

  it('relaunches the desktop into its native wipe instead of wiping from the page', async () => {
    localStorage.setItem('lody:auth-token', 'token');
    const calls: Array<[string, unknown[]]> = [];
    (window as unknown as { ipc: unknown }).ipc = {
      invoke: async (channel: string, ...args: unknown[]) => {
        calls.push([channel, args]);
        return 'quitting';
      },
    };

    expect(await startHardReset()).toBe(true);

    expect(calls).toContainEqual(['app.relaunchIntoLocalReset', ['hard']]);
    expect(readPendingLocalClearMode()).toBeNull();
  });

  it('wipes nothing when the desktop quit for the native wipe is answered Stay', async () => {
    localStorage.setItem('lody:auth-token', 'token');
    (window as unknown as { ipc: unknown }).ipc = {
      invoke: async () => 'cancelled',
    };

    expect(await startHardReset()).toBe(false);

    expect(localStorage.getItem('lody:auth-token')).toBe('token');
    expect(readPendingLocalClearMode()).toBeNull();
  });

  it('revokes the server session before deleting the local token', async () => {
    localStorage.setItem('lody:auth-token', 'token');
    const tokenAtSignOut: Array<string | null> = [];
    registerAuthClient({
      signOut: async () => {
        // The revoke needs the credential, so it has to run first.
        tokenAtSignOut.push(localStorage.getItem('lody:auth-token'));
      },
    } as unknown as LodyAuthClient);

    await startHardReset();

    expect(tokenAtSignOut).toEqual(['token']);
    expect(localStorage.getItem('lody:auth-token')).toBeNull();
  });

  it('wipes local state even when the sign-out request fails', async () => {
    localStorage.setItem('lody:auth-token', 'token');
    registerAuthClient({
      signOut: async () => {
        throw new Error('offline');
      },
    } as unknown as LodyAuthClient);

    await startHardReset();

    expect(localStorage.getItem('lody:auth-token')).toBeNull();
    expect(readPendingLocalClearMode()).toBe('hard');
  });
});
