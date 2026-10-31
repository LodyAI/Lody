// @vitest-environment jsdom
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { localProbeResultAtom } from '../src/atoms/local-probe';

import { createElement, useEffect, type ReactNode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  getSessionRoomId,
  getMachineRoomId,
  type MachineMeta,
  readCodeCollabFileIndexFromFlock,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import {
  materializeCodeCollabV2FileIndexForFileProvider,
  useCodeCollabSessionFileProvider,
  type UseCodeCollabSessionFileProviderResult,
} from '../src/hooks/use-code-collab-session-file-provider';
import { sessionMetaCacheAtom, machineMetaCacheAtom } from '../src/atoms/doc-meta';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import {
  createCodeCollabFileIndexCache,
  type CodeCollabFileIndexCache,
} from '../src/lib/code-collab-file-index-cache';
import { SessionAgentFileLinkMenuProvider } from '../src/components/sessions/session-agent-file-link-menu';
import { useAgentFileLinkMatch } from '../src/components/ai-gui/agent-file-link-context';

vi.mock('../src/hooks/use-session-file-actions', () => ({
  useSessionFileActions: () => ({ buildMarkdownLinkMenuItems: () => [] }),
}));
vi.mock('../src/hooks/use-code-collab-requested-role', () => ({
  useCodeCollabRequestedRole: () => 'read',
}));
vi.mock('../src/components/ai-gui/markdown-renderer', async () => ({
  AgentFileLinkContextMenuItemsContext: (await import('react')).createContext(undefined),
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const fileIndexCaches: CodeCollabFileIndexCache[] = [];

afterEach(async () => {
  if (root && container) {
    act(() => {
      root?.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  await Promise.all(fileIndexCaches.splice(0).map((cache) => cache.dispose()));
  vi.unstubAllGlobals();
});

const makeSyncedFlockRoom = (firstSyncedWithRemote: Promise<void> = Promise.resolve()) => {
  // The hook selects the readiness BINDING's first-sync promise (selection,
  // not merging), so the injected promise must live on the binding too.
  const binding = {
    transportId: 'cloud',
    status: 'joined' as const,
    onStatusChange: vi.fn(() => vi.fn()),
    firstSyncedWithRemote,
    waitUntilSynced: vi.fn(async () => undefined),
    rejoin: vi.fn(async () => undefined),
  };
  return {
    unsubscribe: vi.fn(),
    firstSyncedWithRemote,
    waitUntilSynced: vi.fn(async () => undefined),
    transportIds: () => ['cloud'],
    subscription: vi.fn(() => binding),
    subscriptions: () => [binding],
  };
};

const createRuntime = (overrides: Record<string, unknown>): WorkspaceRuntime => {
  const runtime = {
    workspaceId: 'workspace-1',
    workspaceSlug: 'workspace',
    prepareSessionTarget: vi.fn(async () => 'cloud' as const),
    ...overrides,
  } as unknown as WorkspaceRuntime;
  const fileIndexHandles = new Map<
    string,
    Promise<Awaited<ReturnType<WorkspaceRuntime['repo']['openFlockDoc']>>>
  >();
  const getFileIndexHandle = (
    flockDocId: string
  ): Promise<Awaited<ReturnType<WorkspaceRuntime['repo']['openFlockDoc']>>> => {
    let handlePromise = fileIndexHandles.get(flockDocId);
    if (!handlePromise) {
      handlePromise = runtime.repo.openFlockDoc(flockDocId);
      fileIndexHandles.set(flockDocId, handlePromise);
      void handlePromise.catch(() => {
        if (fileIndexHandles.get(flockDocId) === handlePromise) {
          fileIndexHandles.delete(flockDocId);
        }
      });
    }
    return handlePromise;
  };
  const cache = createCodeCollabFileIndexCache({
    acquireFlockDoc: async (flockDocId) => ({
      flock: (await getFileIndexHandle(flockDocId)).flock,
      release: async () => undefined,
    }),
    joinFlockDocRoom: async (flockDocId) => (await getFileIndexHandle(flockDocId)).joinRoom(),
    unloadFlockDoc: async (flockDocId) => {
      fileIndexHandles.delete(flockDocId);
    },
  });
  fileIndexCaches.push(cache);
  return { ...runtime, codeCollabFileIndexCache: cache };
};

describe('readCodeCollabFileIndexFromFlock', () => {
  it('reads path-keyed file index rows and skips invalid rows', () => {
    const flock = new Flock('test-peer');
    flock.set(['README.md'], { kind: 'text', change: { diff: [1, 0] } });
    flock.set(['assets/logo.png'], { kind: 'binary' });
    flock.set(['nested', 'bad'], { kind: 'text' });
    flock.set(['bad.txt'], { kind: 'unknown' });
    flock.commit();

    expect(readCodeCollabFileIndexFromFlock(flock)).toEqual({
      'README.md': { kind: 'text', change: { diff: [1, 0] } },
      'assets/logo.png': { kind: 'binary' },
    });
  });
});

describe('materializeCodeCollabV2FileIndexForFileProvider', () => {
  it('waits for file-index loading before creating a provider state', () => {
    expect(
      materializeCodeCollabV2FileIndexForFileProvider({
        fileIndex: null,
        revision: 0,
        sourceState: 'live-collaborative',
      })
    ).toBeNull();
  });

  it('accepts an explicitly empty file index', () => {
    const state = materializeCodeCollabV2FileIndexForFileProvider({
      fileIndex: {},
      revision: 1,
      updatedAtMs: 123,
      sourceState: 'live-collaborative',
    });

    expect(state).toMatchObject({
      fileTree: {},
      allChanges: {},
      updatedAtMs: 123,
    });
    expect(state?.files).toEqual([]);
  });

  it('builds file tree entries and All Changes from one path-keyed table', () => {
    const state = materializeCodeCollabV2FileIndexForFileProvider({
      fileIndex: {
        '.git': { kind: 'skipped', reason: 'ignored_directory' },
        'README.md': { kind: 'file', change: { diff: [1, 0] } },
        docs: { kind: 'lazy' },
        'docs/deleted.md': { kind: 'deleted', change: { del: true, diff: [0, 3] } },
        large: true,
      },
      revision: 2,
      sourceState: 'live-collaborative',
    });

    expect(state?.fileTree).toEqual({
      '.git': { kind: 'skipped', reason: 'ignored_directory' },
      'README.md': true,
      docs: { kind: 'lazy' },
      large: true,
    });
    expect(state?.allChanges).toEqual({
      'README.md': { diff: [1, 0] },
      'docs/deleted.md': { del: true, diff: [0, 3] },
    });
    expect(state?.files.map((entry) => entry.path)).toEqual(['.git', 'docs', 'large', 'README.md']);
  });

  it('shows a member root at its directory and rebuilds when the mounts change', () => {
    const fileIndex = {
      'api/main.go': true as const,
      '\0lody-root:member:docs/guide.md': {
        kind: 'file' as const,
        change: { diff: [2, 0] as [number, number] },
      },
    };
    const mounts = [{ rootId: 'member:docs', memberId: 'docs', mountPath: 'docs' }] as never;
    const state = materializeCodeCollabV2FileIndexForFileProvider({
      fileIndex,
      revision: 1,
      sourceState: 'live-collaborative',
      mounts,
    });
    expect(state?.files.map((entry) => entry.path)).toEqual(['api/main.go', 'docs/guide.md']);
    expect(state?.allChanges).toEqual({ 'docs/guide.md': { diff: [2, 0] } });
    // Same revision, new mounts: the display paths must not be reused.
    const renamed = materializeCodeCollabV2FileIndexForFileProvider({
      fileIndex,
      revision: 1,
      sourceState: 'live-collaborative',
      previous: state,
      mounts: [{ rootId: 'member:docs', memberId: 'docs', mountPath: 'notes' }] as never,
    });
    expect(renamed?.files.map((entry) => entry.path)).toContain('notes/guide.md');
  });
});

describe('useCodeCollabSessionFileProvider', () => {
  it('releases a failed conversation borrower so the next Files open can recover', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'conversation-index-recovery' as SessionId;
    const machineId = 'machine-remote' as MachineId;
    const session = { id: sessionId, machineId, userId: 'user-1' } as SessionMeta;
    const flock = new Flock('conversation-index-recovery');
    flock.set(['README.md'], { kind: 'text' });
    flock.commit();
    let rejectSync!: (error: unknown) => void;
    const firstSync = new Promise<void>((_, reject) => {
      rejectSync = reject;
    });
    let firstJoin = true;
    const originalError = new Error('file-index catchup failed');
    store.set(
      runtimeAtom,
      createRuntime({
        repo: {
          openFlockDoc: async () => ({
            flock,
            joinRoom: async () => {
              const pending = firstJoin;
              firstJoin = false;
              return makeSyncedFlockRoom(pending ? firstSync : Promise.resolve());
            },
          }),
        },
      })
    );
    store.set(sessionMetaCacheAtom, { [getSessionRoomId(sessionId)]: session });
    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    const onUpdate = (result: UseCodeCollabSessionFileProviderResult) => updates.push(result);
    function Candidate() {
      const { matched } = useAgentFileLinkMatch('README.md');
      return createElement('span', { 'data-matched': matched }, 'README.md');
    }
    const surface = (filesOpen: boolean, visible = true) =>
      createElement(
        Provider,
        { store },
        createElement(
          SessionAgentFileLinkMenuProvider,
          { session, workspaceId: 'workspace-1', isVisible: visible },
          createElement(Candidate)
        ),
        filesOpen ? createElement(ProviderHarness, { sessionId, machineId, onUpdate }) : null
      );
    render(surface(false));
    await flushMicrotasks(8);
    // A pending catchup does not discard an already-confirmed cached snapshot.
    expect(container?.querySelector('span')?.dataset.matched).toBe('true');
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      rejectSync(originalError);
      await flushMicrotasks(8);
      expect(container?.querySelector('span')?.dataset.matched).toBe('false');
      // Leave the conversation visible: its optional borrower must no longer pin the error.
      act(() => root?.render(surface(true)));
      await flushMicrotasks(8);
      expect(updates.at(-1)?.status).toBe('ready');
      await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
        expect.objectContaining({ path: 'README.md' }),
      ]);
      expect(warning.mock.calls).toContainEqual([
        '[Code Collab] conversation file-link index unavailable',
        expect.objectContaining({ error: expect.objectContaining({ message: originalError.message }) }),
      ]);
      expect(container?.querySelector('span')?.dataset.matched).toBe('false');

      // Re-entering the conversation resumes confirmation against the recovered index.
      act(() => root?.render(surface(true, false)));
      await flushMicrotasks(8);
      act(() => root?.render(surface(true)));
      await flushMicrotasks(8);
      expect(container?.querySelector('span')?.dataset.matched).toBe('true');
      expect(updates.at(-1)?.status).toBe('ready');
    } finally {
      warning.mockRestore();
    }
  });

  it.each([
    [null, false],
    ['/original/workspace', false],
    [null, true],
    ['/original/workspace', true],
  ] as const)(
    'opens a desktop file while the daemon index is unavailable (root %s, encrypted %s)',
    async (workspaceRoot, encrypted) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      vi.stubGlobal('window', Object.assign(window, { __LODY_ELECTRON__: true }));
      const store = createStore();
      const sessionId = 'offline-session' as SessionId;
      const machineId = 'offline-machine' as MachineId;
      if (encrypted) {
        store.set(localProbeResultAtom, { ok: true, machineId });
        store.set(workspaceContentModeAtom, {
          accountId: 'user',
          workspaceSlug: 'encrypted',
          workspaceId: 'workspace-1',
          descriptor: { contentMode: 'e2ee', contentModeVersion: 1 },
        } as never);
      }
      const ownerSessionId = 'offline-parent' as SessionId;
      store.set(
        runtimeAtom,
        createRuntime({
          prepareSessionTarget: async () => {
            throw new Error('daemon offline');
          },
          repo: {
            openFlockDoc: async () => {
              throw new Error('metadata unavailable');
            },
          },
          requestFilePreview: async (
            _machine: MachineId,
            request: { path: string },
            options: unknown
          ) => {
            expect(options).toMatchObject({ ownerSessionId, workspaceRoot });
            return {
              status: 'ok',
              v: 3,
              path: request.path,
              external: true,
              digest: `sha256:${'0'.repeat(64)}`,
              kind: 'text',
              sizeBytes: 7,
              readonly: true,
              content: { encoding: 'utf8-plain', text: 'offline', rawBytes: 7 },
            };
          },
        })
      );
      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(sessionId)]: {
          id: sessionId,
          machineId,
          parentSessionId: ownerSessionId,
          userId: 'user-1',
        } as SessionMeta,
        [getSessionRoomId(ownerSessionId)]: {
          id: ownerSessionId,
          machineId,
          project: { kind: 'local', localProjectId: 'project-1' },
        } as SessionMeta,
      });
      if (workspaceRoot)
        store.set(machineMetaCacheAtom, {
          [getMachineRoomId(machineId)]: {
            id: machineId,
            localProjects: { 'project-1': { rootPath: workspaceRoot } },
          } as unknown as MachineMeta,
        });
      const updates: UseCodeCollabSessionFileProviderResult[] = [];
      render(
        createElement(
          Provider,
          { store },
          createElement(ProviderHarness, {
            sessionId,
            machineId,
            onUpdate: (result) => updates.push(result),
          })
        )
      );
      await flushMicrotasks(8);
      expect(updates.at(-1)?.status).toBe('error');
      await expect(updates.at(-1)?.provider?.openFile('/absolute/notes.md')).resolves.toMatchObject(
        {
          status: 'ready',
          snapshot: { kind: 'text', text: 'offline' },
          entry: { readonly: true },
        }
      );
      delete window.__LODY_ELECTRON__;
    }
  );

  it('uses the local IPC snapshot before subscribing to Flock updates', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-local-file-index' as SessionId;
    const machineId = 'machine-local' as MachineId;
    let fileIndexListener:
      | ((batch: { events: readonly { key: readonly unknown[]; value?: unknown }[] }) => void)
      | null = null;
    const fileIndexFlock = {
      scan: vi.fn(() => []),
      subscribe: vi.fn((listener) => {
        fileIndexListener = listener;
        return vi.fn();
      }),
    };
    const firstSyncedWithRemote = new Promise<void>(() => undefined);
    const joinFileIndexRoom = vi.fn(async () => makeSyncedFlockRoom(firstSyncedWithRemote));
    const requestLocalCodeCollabFileIndex = vi.fn(async () => ({
      status: 'ok' as const,
      ownerSessionId: sessionId,
      fileIndex: {
        'src/local.ts': { kind: 'file' as const, change: { diff: [2, 1] as [number, number] } },
      },
      updatedAtMs: 123,
    }));
    const openFlockDoc = vi.fn(async (flockDocId: string) => {
      if (flockDocId !== 'workspace-1:fi:session-local-file-index') {
        throw new Error(`Unexpected Flock doc: ${flockDocId}`);
      }
      return {
        flock: fileIndexFlock,
        joinRoom: joinFileIndexRoom,
      };
    });
    const prepareSessionTarget = vi.fn(async () => 'local' as const);
    store.set(
      runtimeAtom,
      createRuntime({
        prepareSessionTarget,
        repo: { openFlockDoc },
        requestLocalCodeCollabFileIndex,
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks(8);

    expect(prepareSessionTarget).toHaveBeenCalledWith(sessionId, machineId);
    expect(requestLocalCodeCollabFileIndex).toHaveBeenCalledWith(
      machineId,
      { sessionId },
      { ownerSessionId: sessionId }
    );
    expect(openFlockDoc).toHaveBeenCalledWith('workspace-1:fi:session-local-file-index');
    expect(joinFileIndexRoom).toHaveBeenCalledTimes(1);
    expect(fileIndexListener).not.toBeNull();
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'src/local.ts' }),
    ]);
    await expect(updates.at(-1)?.provider?.listChangedFiles()).resolves.toMatchObject({
      status: 'ready',
      files: [expect.objectContaining({ path: 'src/local.ts', add: 2, del: 1 })],
    });

    await act(async () => {
      // Joining an old local Flock can momentarily import rows from before the
      // CLI's fresh IPC scan. The background CLI reconcile must later restore
      // the authoritative state through the same event subscription.
      fileIndexListener?.({
        events: [
          {
            key: ['src/stale.ts'],
            value: { kind: 'text', change: { diff: [1, 0] as [number, number] } },
          },
        ],
      });
    });
    await flushMicrotasks(8);

    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'src/local.ts' }),
        expect.objectContaining({ path: 'src/stale.ts' }),
      ])
    );
    await expect(updates.at(-1)?.provider?.listChangedFiles()).resolves.toMatchObject({
      status: 'ready',
      files: expect.arrayContaining([
        expect.objectContaining({ path: 'src/local.ts', add: 2, del: 1 }),
        expect.objectContaining({ path: 'src/stale.ts', add: 1, del: 0 }),
      ]),
    });

    await act(async () => {
      fileIndexListener?.({
        events: [{ key: ['src/stale.ts'] }],
      });
    });
    await flushMicrotasks(8);

    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'src/local.ts' }),
    ]);
    await expect(updates.at(-1)?.provider?.listChangedFiles()).resolves.toMatchObject({
      status: 'ready',
      files: [expect.objectContaining({ path: 'src/local.ts', add: 2, del: 1 })],
    });
  });

  it('publishes the remote file index after a read-only Flock catchup', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-remote-first-sync' as SessionId;
    const machineId = 'machine-1' as MachineId;
    let remoteVisible = false;
    const scan = vi.fn(() =>
      remoteVisible
        ? [{ key: ['README.md'], value: { kind: 'text', change: { diff: [1, 0] } } }]
        : []
    );
    const fakeFlock = {
      scan,
      subscribe: vi.fn(() => vi.fn()),
    };
    const initDirectory = vi.fn(
      () => new Promise<{ status: 'ok'; path: string; publishedEntries: number }>(() => undefined)
    );
    const syncOnce = vi.fn(async () => {
      remoteVisible = true;
    });
    const joinRoom = vi.fn(async () => {
      remoteVisible = true;
      return makeSyncedFlockRoom();
    });
    const openFlockDoc = vi.fn(async () => ({
      flock: fakeFlock,
      syncOnce,
      joinRoom,
    }));
    store.set(
      runtimeAtom,
      createRuntime({
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: initDirectory,
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks();
    expect(openFlockDoc).toHaveBeenCalledWith('workspace-1:fi:session-remote-first-sync');
    expect(syncOnce).not.toHaveBeenCalled();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(initDirectory).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(updates.at(-1)).toMatchObject({
      status: 'ready',
      role: 'write',
    });
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'README.md' }),
    ]);
  });

  it('prepares the remote target and reads the shared file-index Flock', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-remote-file-index' as SessionId;
    const machineId = 'machine-remote' as MachineId;
    const signalFlock = {
      scan: vi.fn(() => [
        {
          key: ['remote.ts'],
          value: { kind: 'text', change: { diff: [2, 0] as [number, number] } },
        },
      ]),
      subscribe: vi.fn(() => vi.fn()),
    };
    const syncSignalOnce = vi.fn(async () => undefined);
    const joinSignalRoom = vi.fn(async () => makeSyncedFlockRoom());
    const openFlockDoc = vi.fn(async (flockDocId: string) => {
      if (flockDocId !== 'workspace-1:fi:session-remote-file-index') {
        throw new Error(`Unexpected Flock doc: ${flockDocId}`);
      }
      return {
        flock: signalFlock,
        syncOnce: syncSignalOnce,
        joinRoom: joinSignalRoom,
      };
    });
    const prepareSessionTarget = vi.fn(async () => 'cloud' as const);
    store.set(
      runtimeAtom,
      createRuntime({
        prepareSessionTarget,
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: vi.fn(),
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks(8);

    expect(prepareSessionTarget).toHaveBeenCalledWith(sessionId, machineId);
    expect(openFlockDoc).toHaveBeenCalledWith('workspace-1:fi:session-remote-file-index');
    expect(syncSignalOnce).not.toHaveBeenCalled();
    expect(joinSignalRoom).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({
      status: 'ready',
      role: 'write',
    });
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'remote.ts' }),
    ]);
    await expect(updates.at(-1)?.provider?.listChangedFiles()).resolves.toMatchObject({
      status: 'ready',
      files: [expect.objectContaining({ path: 'remote.ts', add: 2, del: 0 })],
    });
  });

  it('applies remote file-index Flock events without Machine RPC snapshots', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-remote-events' as SessionId;
    const machineId = 'machine-remote' as MachineId;
    let signalListener:
      | ((batch: { events: readonly { key: readonly unknown[]; value?: unknown }[] }) => void)
      | null = null;
    const signalFlock = {
      scan: vi.fn(() => [
        {
          key: ['before.ts'],
          value: { kind: 'text', change: { diff: [1, 0] as [number, number] } },
        },
      ]),
      subscribe: vi.fn((listener) => {
        signalListener = listener;
        return vi.fn();
      }),
    };
    const syncSignalOnce = vi.fn(async () => undefined);
    const joinSignalRoom = vi.fn(async () => makeSyncedFlockRoom());
    const openFlockDoc = vi.fn(async (flockDocId: string) => {
      if (flockDocId !== 'workspace-1:fi:session-remote-events') {
        throw new Error(`Unexpected Flock doc: ${flockDocId}`);
      }
      return {
        flock: signalFlock,
        syncOnce: syncSignalOnce,
        joinRoom: joinSignalRoom,
      };
    });
    store.set(
      runtimeAtom,
      createRuntime({
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: vi.fn(),
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks(8);

    expect(signalListener).not.toBeNull();
    expect(syncSignalOnce).not.toHaveBeenCalled();
    expect(joinSignalRoom).toHaveBeenCalledTimes(1);
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'before.ts' }),
    ]);

    await act(async () => {
      signalListener?.({
        events: [
          { key: ['before.ts'] },
          {
            key: ['after.ts'],
            value: { kind: 'text', change: { diff: [2, 0] as [number, number] } },
          },
        ],
      });
    });
    await flushMicrotasks(8);

    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'after.ts' }),
    ]);
    await expect(updates.at(-1)?.provider?.listChangedFiles()).resolves.toMatchObject({
      status: 'ready',
      files: [expect.objectContaining({ path: 'after.ts', add: 2, del: 0 })],
    });
  });

  it('surfaces target resolution failures before opening a Flock room', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-target-unavailable' as SessionId;
    const machineId = 'machine-remote' as MachineId;
    const signalFlock = {
      scan: vi.fn(() => []),
      subscribe: vi.fn(() => vi.fn()),
    };
    const syncSignalOnce = vi.fn(async () => undefined);
    const joinSignalRoom = vi.fn(async () => makeSyncedFlockRoom());
    const openFlockDoc = vi.fn(async (flockDocId: string) => {
      if (flockDocId !== 'workspace-1:fi:session-target-unavailable') {
        throw new Error(`Unexpected Flock doc: ${flockDocId}`);
      }
      return {
        flock: signalFlock,
        syncOnce: syncSignalOnce,
        joinRoom: joinSignalRoom,
      };
    });
    const prepareSessionTarget = vi.fn(async () => {
      throw new Error('remote target unavailable');
    });
    store.set(
      runtimeAtom,
      createRuntime({
        prepareSessionTarget,
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: vi.fn(),
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks(8);

    expect(prepareSessionTarget).toHaveBeenCalledWith(sessionId, machineId);
    expect(openFlockDoc).not.toHaveBeenCalled();
    expect(syncSignalOnce).not.toHaveBeenCalled();
    expect(joinSignalRoom).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      status: 'error',
      message: 'remote target unavailable',
    });
  });

  it('surfaces remote-machine file-index Flock sync failures', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-remote-sync-failed' as SessionId;
    const machineId = 'machine-remote' as MachineId;
    const signalFlock = {
      scan: vi.fn(() => []),
      subscribe: vi.fn(() => vi.fn()),
    };
    const syncSignalOnce = vi.fn(async () => undefined);
    const joinSignalRoom = vi.fn(async () => {
      throw new Error('file-index sync failed');
    });
    const openFlockDoc = vi.fn(async (flockDocId: string) => {
      if (flockDocId !== 'workspace-1:fi:session-remote-sync-failed') {
        throw new Error(`Unexpected Flock doc: ${flockDocId}`);
      }
      return {
        flock: signalFlock,
        syncOnce: syncSignalOnce,
        joinRoom: joinSignalRoom,
      };
    });
    store.set(
      runtimeAtom,
      createRuntime({
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: vi.fn(),
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks(8);

    expect(syncSignalOnce).not.toHaveBeenCalled();
    expect(joinSignalRoom).toHaveBeenCalledTimes(1);
    expect(updates.at(-1)).toMatchObject({
      status: 'error',
      message: 'file-index sync failed',
    });
  });

  it('publishes an empty file index after read-only catchup without initializing directories', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-empty-catchup' as SessionId;
    const machineId = 'machine-1' as MachineId;
    const scan = vi.fn(() => []);
    const fakeFlock = {
      scan,
      subscribe: vi.fn(() => vi.fn()),
    };
    const initDirectory = vi.fn(async () => ({
      status: 'ok' as const,
      path: '.',
      publishedEntries: 1,
    }));
    const syncOnce = vi.fn(async () => undefined);
    const joinRoom = vi.fn(async () => makeSyncedFlockRoom());
    const openFlockDoc = vi.fn(async () => ({
      flock: fakeFlock,
      syncOnce,
      joinRoom,
    }));
    store.set(
      runtimeAtom,
      createRuntime({
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: initDirectory,
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks();
    expect(syncOnce).not.toHaveBeenCalled();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(initDirectory).not.toHaveBeenCalled();
    expect(scan).toHaveBeenCalledTimes(2);
    expect(updates.at(-1)?.status).toBe('empty');
  });

  it('keeps read-only catchup pending until the Flock handle is ready', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-catchup-before-open' as SessionId;
    const machineId = 'machine-1' as MachineId;
    let remoteVisible = false;
    const scan = vi.fn(() =>
      remoteVisible
        ? [{ key: ['package.json'], value: { kind: 'text', change: { diff: [1, 1] } } }]
        : []
    );
    const fakeFlock = {
      scan,
      subscribe: vi.fn(() => vi.fn()),
    };
    let resolveOpenFlockDoc:
      | ((value: {
          flock: typeof fakeFlock;
          syncOnce: () => Promise<void>;
          joinRoom: () => Promise<ReturnType<typeof makeSyncedFlockRoom>>;
        }) => void)
      | null = null;
    const syncOnce = vi.fn(async () => {
      remoteVisible = true;
    });
    const initDirectory = vi.fn(async () => ({
      status: 'ok' as const,
      path: '.',
      publishedEntries: 1,
    }));
    const openFlockDoc = vi.fn(
      () =>
        new Promise<{
          flock: typeof fakeFlock;
          syncOnce: () => Promise<void>;
          joinRoom: () => Promise<ReturnType<typeof makeSyncedFlockRoom>>;
        }>((resolve) => {
          resolveOpenFlockDoc = resolve;
        })
    );
    store.set(
      runtimeAtom,
      createRuntime({
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: initDirectory,
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks();
    expect(initDirectory).not.toHaveBeenCalled();
    expect(syncOnce).not.toHaveBeenCalled();

    await act(async () => {
      resolveOpenFlockDoc?.({
        flock: fakeFlock,
        syncOnce,
        joinRoom: async () => {
          remoteVisible = true;
          return makeSyncedFlockRoom();
        },
      });
    });
    await flushMicrotasks();

    expect(scan).toHaveBeenCalledTimes(2);
    expect(syncOnce).not.toHaveBeenCalled();
    expect(updates.at(-1)).toMatchObject({
      status: 'ready',
      role: 'write',
    });
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'package.json' }),
    ]);
  });

  it('applies subscribed file-index events without rescanning the full Flock table', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-incremental' as SessionId;
    const machineId = 'machine-1' as MachineId;
    let listener:
      | ((batch: { events: readonly { key: readonly unknown[]; value?: unknown }[] }) => void)
      | null = null;
    const firstSyncedWithRemote = new Promise<void>(() => undefined);
    const scan = vi.fn(() => [
      { key: ['README.md'], value: { kind: 'text', change: { diff: [1, 0] } } },
    ]);
    const fakeFlock = {
      scan,
      subscribe: vi.fn((nextListener) => {
        listener = nextListener;
        return vi.fn();
      }),
    };
    const initDirectory = vi.fn(async () => ({
      status: 'ok' as const,
      path: '.',
      publishedEntries: 1,
    }));
    const syncOnce = vi.fn(async () => undefined);
    const joinRoom = vi.fn(async () => makeSyncedFlockRoom(firstSyncedWithRemote));
    const openFlockDoc = vi.fn(async () => ({
      flock: fakeFlock,
      syncOnce,
      joinRoom,
    }));
    store.set(
      runtimeAtom,
      createRuntime({
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: initDirectory,
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(syncOnce).not.toHaveBeenCalled();
    expect(joinRoom).toHaveBeenCalledTimes(1);
    expect(initDirectory).not.toHaveBeenCalled();
    expect(listener).not.toBeNull();

    await act(async () => {
      listener?.({
        events: [{ key: ['CHANGELOG.md'], value: { kind: 'text', change: { diff: [2, 0] } } }],
      });
    });

    expect(scan).toHaveBeenCalledTimes(1);
    expect(syncOnce).not.toHaveBeenCalled();
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'CHANGELOG.md' }),
        expect.objectContaining({ path: 'README.md' }),
      ])
    );
  });

  it('renders published v2 file state without root directory activation', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-ready' as SessionId;
    const machineId = 'machine-1' as MachineId;
    const initDirectory = vi.fn(async () => ({
      status: 'error' as const,
      code: 'activation_failed',
      message: 'root activation failed',
    }));
    const flock = new Flock('test-peer');
    flock.set(['README.md'], { kind: 'text', change: { diff: [1, 0] } });
    flock.commit();
    const openFlockDoc = vi.fn(async () => ({
      flock,
      syncOnce: async () => undefined,
      joinRoom: async () => makeSyncedFlockRoom(),
    }));
    store.set(
      runtimeAtom,
      createRuntime({
        repo: { openFlockDoc },
        requestCodeCollabInitDirectory: initDirectory,
      })
    );
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );

    await flushMicrotasks();

    expect(initDirectory).not.toHaveBeenCalled();
    expect(openFlockDoc).toHaveBeenCalledWith('workspace-1:fi:session-ready');
    expect(updates.at(-1)).toMatchObject({
      status: 'ready',
      role: 'write',
    });
    expect(updates.at(-1)?.provider).not.toBeNull();
    const providers = updates
      .map((update) => update.provider)
      .filter((provider): provider is NonNullable<typeof provider> => provider !== null);
    expect(new Set(providers).size).toBe(1);
  });

  it('stops exposing the old file index while the same workspace runtime is replaced', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const store = createStore();
    const sessionId = 'session-runtime-replaced' as SessionId;
    const machineId = 'machine-runtime-replaced' as MachineId;
    const makeFlock = (path: string) => ({
      scan: vi.fn(() => [{ key: [path], value: { kind: 'text' } }]),
      version: vi.fn(() => ({
        'test-peer': { physicalTime: 1, logicalCounter: 0 },
      })),
      subscribe: vi.fn(() => vi.fn()),
    });
    const makeHandle = (path: string) => ({
      flock: makeFlock(path),
      syncOnce: vi.fn(),
      joinRoom: vi.fn(async () => makeSyncedFlockRoom()),
    });
    const firstRuntime = createRuntime({
      repo: { openFlockDoc: vi.fn(async () => makeHandle('old.ts')) },
    });
    let resolveSecondHandle!: (handle: ReturnType<typeof makeHandle>) => void;
    const secondHandle = new Promise<ReturnType<typeof makeHandle>>((resolve) => {
      resolveSecondHandle = resolve;
    });
    const secondRuntime = createRuntime({
      repo: { openFlockDoc: vi.fn(async () => await secondHandle) },
    });
    store.set(runtimeAtom, firstRuntime);
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(sessionId)]: {
        id: sessionId,
        machineId,
        userId: 'user-1',
      } as SessionMeta,
    });

    const updates: UseCodeCollabSessionFileProviderResult[] = [];
    render(
      createElement(
        Provider,
        { store },
        createElement(ProviderHarness, {
          sessionId,
          machineId,
          onUpdate: (result) => updates.push(result),
        })
      )
    );
    await flushMicrotasks();
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'old.ts' }),
    ]);

    act(() => {
      store.set(runtimeAtom, secondRuntime);
    });
    await flushMicrotasks(2);
    expect(updates.at(-1)).toMatchObject({ status: 'loading', provider: null });

    resolveSecondHandle(makeHandle('new.ts'));
    await flushMicrotasks();
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'new.ts' }),
    ]);
  });
});

function ProviderHarness({
  sessionId,
  machineId,
  onUpdate,
}: {
  readonly sessionId: SessionId;
  readonly machineId: MachineId;
  readonly onUpdate: (result: UseCodeCollabSessionFileProviderResult) => void;
}) {
  const result = useCodeCollabSessionFileProvider({
    workspaceId: 'workspace-1',
    sessionId,
    enabled: true,
    machineId,
    requestedByUserId: 'user-1',
  });
  useEffect(() => {
    onUpdate(result);
  }, [onUpdate, result]);
  return null;
}

function render(node: ReactNode): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(node);
  });
}

async function flushMicrotasks(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}
