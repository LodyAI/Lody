/**
 * Web tabs (and a reloaded primary window) of one workspace open the same repo
 * IndexedDB and the same LoroDoc cursor database, each with its own in-memory
 * replica. Meta/Flock Streams progress must belong to the replica that loaded
 * it: a tab that hydrated before another tab advanced data and cursor has to
 * bootstrap, not resume at that tail.
 *
 * Drives the real renderer composition (`IndexedDBStorageAdaptor` + resilient
 * LoroDoc cursor store + `createWorkspaceStreamsTransport`) on fake-indexeddb
 * against a scripted Streams server.
 */
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import type { WorkspaceId } from '@lody/shared';
import { LoroRepo } from 'loro-repo';
import { IndexedDBStorageAdaptor } from 'loro-repo/storage/indexeddb';
import { createResilientRemoteCursorStore } from '../src/providers/resilient-remote-cursor-store';
import { resolveWorkspaceRuntimeCacheIdentity } from '../src/providers/create-workspace-runtime';
import {
  createWorkspaceStreamsTransport,
  getWorkspaceMetaStreamUrl,
} from '../src/providers/workspace-streams-transport';

const streamsBaseUrl = 'https://streams.checkpoint.invalid';
const tail100 = '00000000000000000100';
const keyA = ['m', 'doc-a', 'title'];
let sequence = 0;

const toArrayBuffer = (value: Uint8Array): ArrayBuffer => value.slice().buffer as ArrayBuffer;

/** Meta stream holding `A` at offset 100; catch-up from 100 has nothing new. */
function createMetaServer() {
  const server = new Flock('server');
  server.put(keyA, 'A');
  const snapshot = server.exportFile();
  const requests: URL[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      requests.push(url);
      if (init?.method === 'POST') {
        const headers = new Headers(init.headers);
        return new Response(null, {
          headers: {
            'Producer-Epoch': headers.get('Producer-Epoch') ?? '0',
            'Producer-Seq': headers.get('Producer-Seq') ?? '0',
            'Stream-Next-Offset': tail100,
            'Stream-Up-To-Date': 'true',
          },
        });
      }
      if (url.pathname.endsWith('/bootstrap')) {
        return new Response(
          new Blob([
            '--cp\r\nContent-Type: application/octet-stream\r\n\r\n',
            toArrayBuffer(snapshot),
            '\r\n--cp--\r\n',
          ]),
          {
            headers: {
              'Content-Type': 'multipart/mixed; boundary=cp',
              'Stream-Snapshot-Offset': tail100,
              'Stream-Next-Offset': tail100,
              'Stream-Up-To-Date': 'true',
            },
          }
        );
      }
      return new Response(null, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Stream-Next-Offset': url.searchParams.get('offset') ?? tail100,
          'Stream-Up-To-Date': 'true',
        },
      });
    })
  );
  const bootstraps = () => requests.filter((url) => url.pathname.endsWith('/bootstrap')).length;
  return { bootstraps };
}

type Tab = { repo: LoroRepo; workspaceId: WorkspaceId; cursorDbName: string };
const openTabs = new Set<Tab>();

/** One tab of the workspace: same databases as its siblings, its own replica. */
async function openTab(workspaceId: WorkspaceId): Promise<Tab> {
  const identity = resolveWorkspaceRuntimeCacheIdentity(workspaceId, '');
  const repo = await LoroRepo.create({
    storageAdapter: new IndexedDBStorageAdaptor({ dbName: identity.repoDbName }),
    metaDebounceCommitMs: 0,
  });
  const tab = { repo, workspaceId, cursorDbName: identity.remoteCursorDbName };
  openTabs.add(tab);
  return tab;
}

async function syncMeta(tab: Tab) {
  const transport = createWorkspaceStreamsTransport({
    repo: tab.repo,
    workspaceId: tab.workspaceId,
    documentRemoteCursorStore: createResilientRemoteCursorStore({ dbName: tab.cursorDbName }),
    auth: async () => 'streams-jwt',
    streamsBaseUrl,
    shardHostSuffix: undefined,
  });
  try {
    return await transport.syncMeta(tab.repo.getMeta());
  } finally {
    await transport.close();
  }
}

afterEach(async () => {
  for (const tab of openTabs) await tab.repo.destroy();
  openTabs.clear();
  vi.unstubAllGlobals();
});

describe('renderer Streams checkpoints are bound to the replica that loaded them', () => {
  it('bootstraps a tab that hydrated before a sibling tab advanced the shared databases', async () => {
    const workspaceId = `ws-tabs-${++sequence}` as WorkspaceId;
    const server = createMetaServer();
    const staleTab = await openTab(workspaceId);
    const activeTab = await openTab(workspaceId);

    expect((await syncMeta(activeTab)).ok).toBe(true);
    expect(activeTab.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(1);

    // Both databases now hold A and offset 100, but the stale tab never
    // loaded A: resuming at 100 would skip it for the rest of its life.
    expect((await syncMeta(staleTab)).ok).toBe(true);
    expect(staleTab.repo.getMeta().get(keyA)).toBe('A');
    expect(server.bootstraps()).toBe(2);
  });

  it('bootstraps again after the runtime deletes the Meta checkpoint it recovers from', async () => {
    const workspaceId = `ws-recover-${++sequence}` as WorkspaceId;
    const server = createMetaServer();
    const tab = await openTab(workspaceId);
    expect((await syncMeta(tab)).ok).toBe(true);
    expect((await syncMeta(tab)).ok).toBe(true);
    expect(server.bootstraps()).toBe(1);

    // What invalidateMetaRemoteCursor / the startup bypass marker do.
    await tab.repo
      .getReplicaCheckpointStore({ kind: 'meta', flock: tab.repo.getMeta() })
      .delete?.(getWorkspaceMetaStreamUrl(workspaceId, streamsBaseUrl));

    expect((await syncMeta(tab)).ok).toBe(true);
    expect(server.bootstraps()).toBe(2);
  });
});
