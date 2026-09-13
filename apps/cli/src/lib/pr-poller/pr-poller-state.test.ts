import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@/utils/logger';
import { emptyPrPollerState, PrPollerStateStore } from './pr-poller-state';

function createTestLogger(): Logger {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    setDebug: vi.fn(),
    child: vi.fn(() => logger),
    close: vi.fn(async () => {}),
  };
  return logger;
}

let tempDir: string | null = null;
const openStores: PrPollerStateStore[] = [];

function makeStore(): PrPollerStateStore {
  if (!tempDir) {
    throw new Error('tempDir not initialized');
  }
  const store = new PrPollerStateStore({
    logger: createTestLogger(),
    dbPath: path.join(tempDir, 'pr-poller-state.sqlite3'),
    legacyJsonPath: path.join(tempDir, 'pr-poller-state.json'),
  });
  openStores.push(store);
  return store;
}

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pr-poller-state-test-'));
});

afterEach(async () => {
  for (const store of openStores.splice(0)) {
    store.close();
  }
  if (tempDir) {
    await fs.rm(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe('PrPollerStateStore', () => {
  it('returns an empty state when the database does not exist yet', () => {
    expect(makeStore().load()).toEqual(emptyPrPollerState());
  });

  it('round-trips write-through rows across store instances', () => {
    const store = makeStore();
    store.load();
    store.upsertScope('managed:abc', {
      tokens: 12.5,
      updatedAtMs: 1_720_000_000_000,
      frozenUntilMs: 1_720_000_600_000,
    });
    store.upsertRepoCooldown('managed:abc:owner/repo', {
      consecutiveFailures: 2,
      nextRetryAtMs: 1_720_000_900_000,
      lastErrorKind: 'repo-not-found-or-forbidden',
    });
    store.upsertTarget('ws1|s1|owner/repo|status|11', { lastSuccessAtMs: 1_720_000_000_000 });
    store.upsertDiscoveryFingerprint('ws1:s1', 'owner/repo|feat/x');
    store.close();

    const reloaded = makeStore().load();
    expect(reloaded).toEqual({
      scopes: {
        'managed:abc': {
          tokens: 12.5,
          updatedAtMs: 1_720_000_000_000,
          frozenUntilMs: 1_720_000_600_000,
        },
      },
      repoCooldowns: {
        'managed:abc:owner/repo': {
          consecutiveFailures: 2,
          nextRetryAtMs: 1_720_000_900_000,
          lastErrorKind: 'repo-not-found-or-forbidden',
        },
      },
      targets: { 'ws1|s1|owner/repo|status|11': { lastSuccessAtMs: 1_720_000_000_000 } },
      discoveryFingerprints: { 'ws1:s1': 'owner/repo|feat/x' },
    });
  });

  it('upserts overwrite and deletes remove rows', () => {
    const store = makeStore();
    store.load();
    store.upsertScope('s', { tokens: 5, updatedAtMs: 1 });
    store.upsertScope('s', { tokens: 3, updatedAtMs: 2 });
    store.upsertTarget('t1', { lastSuccessAtMs: 1 });
    store.deleteTarget('t1');
    store.upsertRepoCooldown('c1', {
      consecutiveFailures: 1,
      nextRetryAtMs: 9,
      lastErrorKind: 'token-invalid',
    });
    store.deleteRepoCooldown('c1');
    store.upsertDiscoveryFingerprint('f1', 'r|b');
    store.deleteDiscoveryFingerprint('f1');

    expect(store.load()).toEqual({
      ...emptyPrPollerState(),
      scopes: { s: { tokens: 3, updatedAtMs: 2 } },
    });
  });

  it('imports the legacy JSON state once (quota/cooldowns survive; file deleted)', async () => {
    if (!tempDir) throw new Error('tempDir not initialized');
    const legacyPath = path.join(tempDir, 'pr-poller-state.json');
    await fs.writeFile(
      legacyPath,
      JSON.stringify({
        version: 2,
        scopes: { 'managed:abc': { tokens: 0.5, updatedAtMs: 1_720_000_000_000 } },
        repoCooldowns: {
          'managed:abc:owner/repo': {
            consecutiveFailures: 1,
            nextRetryAtMs: 1_720_000_900_000,
            lastErrorKind: 'token-invalid',
          },
        },
        targets: { 'ws1|s1|owner/repo|status|11': { lastSuccessAtMs: 7 } },
        discoveryFingerprints: { 'ws1:s1': 'owner/repo|feat/x' },
      })
    );

    const state = makeStore().load();
    expect(state.scopes['managed:abc']).toEqual({ tokens: 0.5, updatedAtMs: 1_720_000_000_000 });
    expect(state.repoCooldowns['managed:abc:owner/repo']?.consecutiveFailures).toBe(1);
    expect(state.targets['ws1|s1|owner/repo|status|11']).toEqual({ lastSuccessAtMs: 7 });
    expect(state.discoveryFingerprints['ws1:s1']).toBe('owner/repo|feat/x');
    // The JSON file is consumed — no double import, no stale duplicate store.
    await expect(fs.access(legacyPath)).rejects.toThrow();
  });

  it('tolerates a corrupt legacy JSON file (deleted, fresh state)', async () => {
    if (!tempDir) throw new Error('tempDir not initialized');
    const legacyPath = path.join(tempDir, 'pr-poller-state.json');
    await fs.writeFile(legacyPath, '{not json');

    expect(makeStore().load()).toEqual(emptyPrPollerState());
    await expect(fs.access(legacyPath)).rejects.toThrow();
  });

  it('recreates a corrupt database instead of crashing (state is disposable)', async () => {
    if (!tempDir) throw new Error('tempDir not initialized');
    const dbPath = path.join(tempDir, 'pr-poller-state.sqlite3');
    await fs.writeFile(dbPath, 'this is not a sqlite database, definitely');

    const store = makeStore();
    expect(store.load()).toEqual(emptyPrPollerState());
    store.upsertTarget('t1', { lastSuccessAtMs: 1 });
    expect(store.load().targets['t1']).toEqual({ lastSuccessAtMs: 1 });
  });

  it('close() is idempotent and the store reopens lazily afterwards', () => {
    const store = makeStore();
    store.load();
    store.upsertScope('s', { tokens: 1, updatedAtMs: 1 });
    store.close();
    store.close();
    expect(store.load().scopes['s']).toEqual({ tokens: 1, updatedAtMs: 1 });
  });
});
