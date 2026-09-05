/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  markCacheClearPending,
  maybeClearLodyCacheOnBoot,
  readPendingLocalClearMode,
  resetBootClearMemoForTests,
  startHardReset,
} from '../src/lib/clear-local-cache';
import { registerAuthClient } from '../src/lib/auth-client-singleton';
import type { LodyAuthClient } from '../src/lib/auth';

const CACHE_CLEAR_FLAG = 'lody:clearCacheOnBoot';

let deletedDatabases: string[];
let deletedCaches: string[];
let presentDatabases: string[];
let presentCaches: string[];

type Listener = () => void;

function installFakeIndexedDb() {
  const fake = {
    databases: async () => presentDatabases.map((name) => ({ name, version: 1 })),
    deleteDatabase: (name: string) => {
      deletedDatabases.push(name);
      const listeners = new Map<string, Listener>();
      // Resolve on the microtask queue: the helper races a 3s timeout, so this
      // keeps the test off real timers.
      void Promise.resolve().then(() => listeners.get('success')?.());
      return {
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
  it('preserves durable Shortcut outboxes on cache clear, including explicitly supplied names', async () => {
    presentDatabases.push('lody-shortcut-data-ws1:alice');
    markCacheClearPending();
    await maybeClearLodyCacheOnBoot(['lody-shortcut-data-ws1:alice']);
    expect(deletedDatabases).toContain('lody-loro-repo-db-ws1');
    expect(deletedDatabases).not.toContain('lody-shortcut-data-ws1:alice');
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
    localStorage.setItem('lody:auth-bootstrap', '{}');
    markCacheClearPending();

    await maybeClearLodyCacheOnBoot();

    expect(localStorage.getItem('lody:loroStreamsToken:ws1')).toBeNull();
    expect(localStorage.getItem('lody:loroStreamsMetaCursorBypass:ws1')).toBeNull();
    expect(localStorage.getItem('lody:workspaceInfo')).toBeNull();
    expect(localStorage.getItem('lody:githubReposCache')).toBeNull();
    expect(localStorage.getItem('lody:githubBranchesCache')).toBeNull();
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
});

describe('startHardReset sign-out', () => {
  afterEach(() => {
    registerAuthClient(null as unknown as LodyAuthClient);
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
