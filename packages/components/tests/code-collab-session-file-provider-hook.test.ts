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
  type LocalLoroDataPlaneClientMessage,
  type LocalLoroDataPlaneServerMessage,
  getSessionRoomId,
  getMachineRoomId,
  type MachineMeta,
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
import { openNativeCodeCollabFileIndexResource } from '../src/lib/code-collab-native-file-index-resource';
import type { LocalLoroDataPlaneConnection } from '@lody/shared/local-loro-transport';
import { openCloudCodeCollabFileIndexResource } from '../src/lib/code-collab-cloud-file-index-resource';
import {
  CloudFileIndexMainLegacy,
  type CloudFileIndexMainGrant,
} from '../../../apps/electron/src/main/services/cloud-file-index';
import {
  type CloudFileIndexEvent,
  cloudFileIndexRequestSchema,
  cloudFileIndexReleaseSchema,
  parseCloudFileIndexInput,
} from '@lody/shared/cloud-file-index-ipc';
import { readCodeCollabFileIndexSnapshotFromFlock } from '@lody/shared';
import { SessionAgentFileLinkMenuProvider } from '../src/components/sessions/session-agent-file-link-menu';
import { useSessionDiffSummary } from '../src/components/sessions/use-session-diff-summary';
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

describe('materializeCodeCollabV2FileIndexForFileProvider', () => {
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

describe('file-index generation replication', () => {
  it('publishes generation-only updates without replacing legacy file rows', async () => {
    const flock = new Flock('generation-only');
    flock.set(['a.ts'], { kind: 'text', change: { diff: [1, 1] } });
    flock.set(['a.ts', 'v'], { g: 'epoch.1' });
    flock.commit();
    const runtime = createRuntime({
      repo: { openFlockDoc: async () => ({ flock, joinRoom: async () => makeSyncedFlockRoom() }) },
    });
    const lease = await runtime.codeCollabFileIndexCache!.acquire('workspace:fi:owner');
    try {
      await flushMicrotasks(8);
      const first = lease.resource.getSnapshot();
      if (first.status !== 'ready') throw new Error('Index not ready.');
      expect(first.snapshot.generations).toEqual({ 'a.ts': 'epoch.1' });
      flock.set(['a.ts', 'v'], { g: 'epoch.2' });
      flock.commit();
      const second = lease.resource.getSnapshot();
      if (second.status !== 'ready') throw new Error('Index not ready.');
      expect(second.snapshot.generations).toEqual({ 'a.ts': 'epoch.2' });
      expect(second.snapshot.fileIndex).toBe(first.snapshot.fileIndex);
      expect(second.snapshot.revision).toBeGreaterThan(first.snapshot.revision);
    } finally {
      await lease.release();
    }
  });
});

describe('useCodeCollabSessionFileProvider', () => {
  it.each([
    ['local', true],
    ['cloud', true],
    ['local', false],
    ['cloud', false],
  ] as const)(
    'opens a full Changes list through the %s provider with blob transport %s and leaves bodies deferred',
    async (plane, blobs) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const store = createStore();
      const sessionId = `changes-${plane}` as SessionId;
      const machineId = `machine-${plane}` as MachineId;
      const flock = new Flock(`changes-${plane}`);
      flock.set(['indexed.ts'], { kind: 'file', change: { diff: [1, 0] } });
      flock.commit();
      let bodyBytes = 0;
      let rootUnavailable = false;
      store.set(
        runtimeAtom,
        createRuntime({
          prepareSessionTarget: async () => plane,
          repo: {
            openFlockDoc: async () => ({ flock, joinRoom: async () => makeSyncedFlockRoom() }),
          },
          acquireSessionStore: () => new Promise(() => undefined),
          requestLocalCodeCollabFileIndex: async () => ({
            status: 'ok',
            ownerSessionId: sessionId,
            fileIndex: { 'indexed.ts': { kind: 'file', change: { diff: [1, 0] } } },
            updatedAtMs: 1,
          }),
          getDiffBlobTransportOptions: async () => ({
            supported: blobs,
            scope: plane,
            persist: false,
          }),
          requestCodeCollabInitDirectory: async () => ({ status: 'ok' }),
          requestCodeCollabOpenDiffManifest: async (
            _machine: MachineId,
            request: { cursor?: string }
          ) => ({
            status: 'ok',
            base: 'base',
            entries: [
              {
                path: request.cursor ? '\0lody-root:member:docs/unindexed.ts' : 'indexed.ts',
                status: 'ok',
                base: null,
                head: {
                  key: `sha256:${'1'.repeat(64)}`,
                  rawBytes: 6,
                  format: { encoding: 'utf8' },
                },
                add: 1,
                del: 0,
              },
            ],
            nextCursor: request.cursor ? null : 'page-2',
          }),
          requestCodeCollabOpenAllChangesDiff: async (
            _machine: MachineId,
            request: { rootId?: string; scope?: string }
          ) => {
            if (request.rootId && rootUnavailable)
              return { status: 'unavailable', reason: 'transient_io' };
            if (request.rootId && request.scope === 'uncommitted')
              return { status: 'unavailable', reason: 'not_a_git_worktree' };
            return {
              status: 'ok',
              base: 'base',
              entries: [
                {
                  status: 'deferred',
                  path: request.rootId ? 'unindexed.ts' : 'indexed.ts',
                  add: 1,
                  del: 0,
                },
              ],
              truncated: true,
            };
          },
          requestCodeCollabReadBlob: async () => {
            bodyBytes++;
            throw new Error('List reads must not load file bodies.');
          },
        })
      );
      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(sessionId)]: {
          id: sessionId,
          machineId,
          userId: 'user-1',
          projectRun: { members: { docs: { access: 'additional', path: 'docs' } } },
        } as SessionMeta,
      });
      let state: ReturnType<typeof useSessionDiffSummary> | undefined;
      let provider: UseCodeCollabSessionFileProviderResult['provider'] = null;
      function Harness() {
        const files = useCodeCollabSessionFileProvider({
          workspaceId: 'workspace-1',
          sessionId,
          enabled: true,
          machineId,
          requestedByUserId: 'user-1',
        });
        provider = files.provider;
        state = useSessionDiffSummary(sessionId, {
          fileProvider: files.provider,
          fileProviderPending: files.status === 'loading' || files.status === 'checking',
          refreshChanges: true,
        });
        return null;
      }
      render(createElement(Provider, { store }, createElement(Harness)));
      await flushMicrotasks(12);
      expect(state?.summary.changeFilePaths).toEqual(['docs/unindexed.ts', 'indexed.ts']);
      expect(state?.liveDiffStat).toEqual({ add: 2, del: 0, files: 2 });
      expect(bodyBytes).toBe(0);
      if (!blobs) {
        await act(async () => {
          expect(await provider?.getAllChangesDiff?.(undefined, 'uncommitted')).toMatchObject({
            status: 'ready',
            entries: [{ path: 'indexed.ts' }],
          });
        });
        expect(state?.summary.changeFilePaths).toEqual(['docs/unindexed.ts', 'indexed.ts']);
        rootUnavailable = true;
        await act(async () => {
          expect(await provider?.refreshChangedFiles?.()).toMatchObject({ status: 'unavailable' });
        });
        expect(await provider?.listChangedFiles()).toMatchObject({
          files: [{ path: 'docs/unindexed.ts' }, { path: 'indexed.ts' }],
        });
      }
    }
  );

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
        expect.objectContaining({
          error: expect.objectContaining({ message: originalError.message }),
        }),
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

  it.each(['write', 'read'] as const)(
    'keeps %s diff reads available while writer index activation is independent',
    async (role) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      const store = createStore();
      const sessionId = `diff-activation-${role}` as SessionId;
      const machineId = 'machine-1' as MachineId;
      const flock = {
        scan: () => [{ key: ['a.ts'], value: { kind: 'text', change: { diff: [1, 1] } } }],
        subscribe: () => () => undefined,
      };
      let watching = false;
      let releaseActivation!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const runtime = createRuntime({
        repo: {
          openFlockDoc: async () => ({ flock, joinRoom: async () => makeSyncedFlockRoom() }),
        },
        getDiffBlobTransportOptions: async () => ({
          supported: true,
          scope: 'synthetic',
          persist: false,
        }),
        requestCodeCollabInitDirectory: async () => {
          watching = true;
          await held;
          throw new Error('Synthetic index publication unavailable');
        },
        requestCodeCollabOpenDiffManifest: async () => ({
          status: 'ok',
          entries: [
            {
              path: 'a.ts',
              status: 'ok',
              base: null,
              head: { key: `sha256:${'1'.repeat(64)}`, rawBytes: 1, format: { encoding: 'utf8' } },
            },
          ],
          nextCursor: null,
        }),
      });
      store.set(runtimeAtom, runtime);
      store.set(sessionMetaCacheAtom, {
        [getSessionRoomId(sessionId)]: {
          id: sessionId,
          machineId,
          userId: 'user-1',
        } as SessionMeta,
      });
      let latest: UseCodeCollabSessionFileProviderResult | undefined;
      function Harness() {
        const result = useCodeCollabSessionFileProvider({
          workspaceId: 'workspace-1',
          sessionId,
          machineId,
          requestedRole: role,
        });
        useEffect(() => {
          latest = result;
        }, [result]);
        return null;
      }
      render(createElement(Provider, { store }, createElement(Harness)));
      await flushMicrotasks();
      const result = await latest!.provider!.getAllChangesDiff!();
      expect(result).toMatchObject({
        status: 'ready',
        entries: [{ path: 'a.ts', diff: { status: 'deferred' } }],
      });
      expect(watching).toBe(role === 'write');
      releaseActivation();
      await flushMicrotasks();
      // Failure of the optional publisher leaves exact content reads usable.
      expect(await latest!.provider!.getAllChangesDiff!()).toMatchObject({ status: 'ready' });
      await flushMicrotasks();
    }
  );

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
    expect(updates.at(-1)).toMatchObject({
      status: 'ready',
      role: 'write',
    });
    await expect(updates.at(-1)?.provider?.listFiles()).resolves.toEqual([
      expect.objectContaining({ path: 'README.md' }),
    ]);
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
    expect(updates.at(-1)?.status).toBe('empty');
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

describe('native local file-index cache resource', () => {
  it('shares a read-only projection, fences disconnects and stale resets, and never acquires legacy Flock', async () => {
    const messages = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    const statuses = new Set<(connected: boolean) => void>();
    const sent: LocalLoroDataPlaneClientMessage[] = [];
    let connected = true;
    let started!: () => void;
    const observing = new Promise<void>((resolve) => {
      started = resolve;
    });
    const connection: LocalLoroDataPlaneConnection = {
      send(message) {
        sent.push(message);
        if (message.type === 'ping') {
          for (const listener of messages)
            listener({
              type: 'pong',
              protocolVersion: message.protocolVersion,
              nativeFileIndexSnapshots: true,
            });
        }
        if (message.type === 'file-index-observe') started();
      },
      onMessage(listener) {
        messages.add(listener);
        return () => messages.delete(listener);
      },
      onStatusChange(listener) {
        statuses.add(listener);
        return () => statuses.delete(listener);
      },
      isConnected: () => connected,
    };
    const deliver = (message: LocalLoroDataPlaneServerMessage) => {
      for (const listener of messages) listener(message);
    };
    const cache = createCodeCollabFileIndexCache(
      {
        acquireFlockDoc: async () => {
          throw new Error('Native index must not acquire old Flock/IDB');
        },
        joinFlockDocRoom: async () => {
          throw new Error('Native index must not join old room');
        },
        unloadFlockDoc: async () => {
          throw new Error('Native index must not own old replica');
        },
      },
      {
        openLocalResource: async (_room, onFailure) =>
          openNativeCodeCollabFileIndexResource({
            connection,
            workspaceId: 'workspace',
            ownerSessionId: 'owner',
            onFailure,
          }),
      }
    );
    fileIndexCaches.push(cache);
    const firstPending = cache.acquire('workspace:fi:owner', 'local');
    await observing;
    const firstRequest = sent.find((message) => message.type === 'file-index-observe');
    if (!firstRequest || firstRequest.type !== 'file-index-observe')
      throw new Error('Observation missing');
    deliver({ ...firstRequest, type: 'file-index-observed', backend: 'native' });
    deliver({
      ...firstRequest,
      type: 'file-index-snapshot',
      state: {
        status: 'ready',
        fileIndex: { 'old.ts': true },
        generations: { 'old.ts': 'old' },
        updatedAtMs: 1,
      },
    });
    const first = await firstPending;
    const second = await cache.acquire('workspace:fi:owner', 'local');
    expect(second.resource).toBe(first.resource);
    expect(second.resource.getSnapshot()).toMatchObject({
      status: 'ready',
      snapshot: { fileIndex: { 'old.ts': true } },
    });
    const originalSnapshot = second.resource.getSnapshot();
    deliver({
      ...firstRequest,
      type: 'file-index-snapshot',
      state: {
        status: 'ready',
        fileIndex: { 'old.ts': true },
        generations: { 'old.ts': 'old' },
        updatedAtMs: 2,
      },
    });
    expect(second.resource.getSnapshot()).toBe(originalSnapshot);
    deliver({
      ...firstRequest,
      type: 'file-index-snapshot',
      state: {
        status: 'ready',
        fileIndex: { 'old.ts': true },
        generations: { 'old.ts': 'new-generation' },
        updatedAtMs: 2,
      },
    });
    expect(second.resource.getSnapshot()).toMatchObject({
      status: 'ready',
      snapshot: {
        generations: { 'old.ts': 'new-generation' },
      },
    });
    await first.release();
    connected = false;
    for (const listener of statuses) listener(false);
    expect(second.resource.getSnapshot()).toEqual({ status: 'loading' });
    deliver({
      ...firstRequest,
      type: 'file-index-snapshot',
      state: { status: 'ready', fileIndex: { 'late.ts': true }, updatedAtMs: 2 },
    });
    expect(second.resource.getSnapshot()).toEqual({ status: 'loading' });
    connected = true;
    for (const listener of statuses) listener(true);
    const nextRequest = sent.filter((message) => message.type === 'file-index-observe').at(-1);
    if (!nextRequest || nextRequest.type !== 'file-index-observe')
      throw new Error('Reconnect missing');
    expect(nextRequest.requestId).not.toBe(firstRequest.requestId);
    deliver({
      ...firstRequest,
      type: 'file-index-snapshot',
      state: { status: 'ready', fileIndex: { 'stale.ts': true }, updatedAtMs: 2 },
    });
    expect(second.resource.getSnapshot()).toEqual({ status: 'loading' });
    deliver({ ...nextRequest, type: 'file-index-observed', backend: 'native' });
    deliver({
      ...nextRequest,
      type: 'file-index-snapshot',
      state: {
        status: 'ready',
        fileIndex: { 'new.ts': true },
        generations: { 'new.ts': 'new' },
        updatedAtMs: 3,
      },
    });
    expect(second.resource.getSnapshot()).toMatchObject({
      status: 'ready',
      snapshot: {
        fileIndex: { 'new.ts': true },
        generations: { 'new.ts': 'new' },
      },
    });
    await second.release();
    await cache.dispose();
    expect(messages.size).toBe(0);
    expect(statuses.size).toBe(0);
    expect(sent.at(-1)).toMatchObject({ type: 'detach', peerId: firstRequest.peerId });
  });

  it.each(['access_denied', 'retired', 'restart_required', 'unrecognized'])(
    'keeps a trusted filesystem seed through loading and explicit transient errors, but clears it for %s',
    async (code) => {
      const messages = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
      let request:
        | Extract<LocalLoroDataPlaneClientMessage, { type: 'file-index-observe' }>
        | undefined;
      const deliver = (message: LocalLoroDataPlaneServerMessage) => {
        for (const listener of messages) listener(message);
      };
      const connection: LocalLoroDataPlaneConnection = {
        send(message) {
          if (message.type === 'ping')
            deliver({
              type: 'pong',
              protocolVersion: message.protocolVersion,
              nativeFileIndexSnapshots: true,
            });
          if (message.type === 'file-index-observe') {
            request = message;
            deliver({ ...message, type: 'file-index-observed', backend: 'native' });
          }
        },
        onMessage(listener) {
          messages.add(listener);
          return () => messages.delete(listener);
        },
        onStatusChange: () => () => {},
        isConnected: () => true,
      };
      let failures = 0;
      const resource = await openNativeCodeCollabFileIndexResource({
        connection,
        workspaceId: 'workspace',
        ownerSessionId: 'owner',
        onFailure: () => {
          failures++;
        },
      });
      if (!resource || !request) throw new Error('Missing native file-index observation');
      const snapshot = (
        state: Extract<LocalLoroDataPlaneServerMessage, { type: 'file-index-snapshot' }>['state']
      ) => deliver({ ...request!, type: 'file-index-snapshot', state });
      try {
        snapshot({ status: 'ready', fileIndex: { 'cached.ts': true }, updatedAtMs: 1 });
        resource.seed({ 'actual-filesystem.ts': true }, 2);
        const trusted = resource.getSnapshot();
        expect(trusted).toMatchObject({
          status: 'ready',
          snapshot: { fileIndex: { 'actual-filesystem.ts': true } },
        });
        snapshot({ status: 'loading' });
        expect(resource.getSnapshot()).toBe(trusted);
        snapshot({ status: 'error', code: 'native_file_index_unavailable' });
        expect(resource.getSnapshot()).toBe(trusted);
        expect(failures).toBe(1);
        snapshot({
          status: 'ready',
          fileIndex: { 'actual-filesystem.ts': true },
          generations: { 'actual-filesystem.ts': 'current-publication' },
          updatedAtMs: 2,
        });
        resource.seed({ 'actual-filesystem.ts': true }, 2);
        snapshot({ status: 'loading' });
        expect(resource.getSnapshot()).toMatchObject({
          status: 'ready',
          snapshot: {
            generations: { 'actual-filesystem.ts': 'current-publication' },
          },
        });
        snapshot({ status: 'error', code });
        expect(resource.getSnapshot()).toMatchObject({ status: 'error' });
        resource.seed({ 'late-filesystem.ts': true }, 3);
        expect(resource.getSnapshot()).toMatchObject({ status: 'error' });
        snapshot({ status: 'loading' });
        snapshot({ status: 'ready', fileIndex: { 'late-native.ts': true }, updatedAtMs: 3 });
        if (code === 'access_denied' || code === 'retired') {
          expect(resource.getSnapshot()).toMatchObject({ status: 'error' });
        } else {
          // The same trusted Node observer can recover after validating its
          // current grant. The outstanding old filesystem response still cannot.
          expect(resource.getSnapshot()).toMatchObject({
            status: 'ready',
            snapshot: {
              fileIndex: { 'late-native.ts': true },
            },
          });
          resource.seed({ 'late-filesystem.ts': true }, 4);
          expect(resource.getSnapshot()).toMatchObject({
            status: 'ready',
            snapshot: {
              fileIndex: { 'late-native.ts': true },
            },
          });
        }
      } finally {
        await resource.dispose();
      }
      expect(messages.size).toBe(0);
    }
  );

  it('continues live legacy Flock reads when an old daemon pong has no native capability', async () => {
    const flock = new Flock('old-daemon-compatibility');
    flock.set(['old.ts'], true);
    flock.commit();
    const messages = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    const cache = createCodeCollabFileIndexCache(
      {
        acquireFlockDoc: async () => ({ flock, release: async () => undefined }),
        joinFlockDocRoom: async () => makeSyncedFlockRoom(),
        unloadFlockDoc: async () => undefined,
      },
      {
        openLocalResource: async (_room, onFailure) =>
          openNativeCodeCollabFileIndexResource({
            workspaceId: 'workspace',
            ownerSessionId: 'owner',
            onFailure,
            connection: {
              send(message) {
                if (message.type !== 'ping')
                  throw new Error('Old daemon only supports ping negotiation');
                for (const listener of messages)
                  listener({ type: 'pong', protocolVersion: message.protocolVersion });
              },
              onMessage(listener) {
                messages.add(listener);
                return () => messages.delete(listener);
              },
              onStatusChange(listener) {
                listener(true);
                return () => undefined;
              },
              isConnected: () => true,
            },
          }),
      }
    );
    fileIndexCaches.push(cache);
    const lease = await cache.acquire('workspace:fi:owner', 'local');
    await flushMicrotasks(8);
    expect(lease.resource.backend).not.toBe('native');
    expect(lease.resource.getSnapshot()).toMatchObject({
      status: 'ready',
      snapshot: { fileIndex: { 'old.ts': true } },
    });
    flock.set(['new.ts'], true);
    flock.commit();
    await flushMicrotasks(8);
    expect(lease.resource.getSnapshot()).toMatchObject({
      status: 'ready',
      snapshot: {
        fileIndex: { 'old.ts': true, 'new.ts': true },
      },
    });
    await lease.release();
  });

  it('keeps old-daemon legacy subscription available without sending an unsupported observation', async () => {
    const sent: LocalLoroDataPlaneClientMessage[] = [];
    const messages = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    const statuses = new Set<(connected: boolean) => void>();
    const resource = await openNativeCodeCollabFileIndexResource({
      workspaceId: 'workspace',
      ownerSessionId: 'owner',
      onFailure: () => {
        throw new Error('Not a failure');
      },
      connection: {
        send(message) {
          sent.push(message);
          if (message.type === 'ping') {
            for (const listener of messages)
              listener({ type: 'pong', protocolVersion: message.protocolVersion });
          }
        },
        onMessage(listener) {
          messages.add(listener);
          return () => messages.delete(listener);
        },
        onStatusChange(listener) {
          statuses.add(listener);
          listener(true);
          return () => statuses.delete(listener);
        },
        isConnected: () => true,
      },
    });
    expect(resource).toBe(null);
    expect(sent.map((message) => message.type)).toEqual(['ping']);
    expect(messages.size).toBe(0);
    expect(statuses.size).toBe(0);
  });
});

describe('ordinary Cloud file-index cache selection', () => {
  it('uses explicit Cloud selection, keeps local routing separate, and never falls back after selected failure', async () => {
    const legacy = new Flock('cloud-positive-legacy');
    legacy.set(['legacy.ts'], true);
    legacy.commit();
    const denied = new Error('Selected Cloud index unavailable');
    const cache = createCodeCollabFileIndexCache(
      {
        acquireFlockDoc: async (room) => {
          if (room !== 'workspace:fi:legacy')
            throw new Error('Selected Cloud room reopened old IDB');
          return { flock: legacy, release: async () => undefined };
        },
        joinFlockDocRoom: async () => makeSyncedFlockRoom(),
        unloadFlockDoc: async () => undefined,
      },
      {
        openCloudResource: async (room) => {
          if (room === 'workspace:fi:legacy') return null;
          throw denied;
        },
        openLocalResource: async () => ({
          backend: 'native',
          getSnapshot: () => ({ status: 'loading' }),
          subscribe: () => () => undefined,
          seed: () => undefined,
          dispose: async () => undefined,
        }),
      }
    );
    fileIndexCaches.push(cache);
    const old = await cache.acquire('workspace:fi:legacy', 'cloud');
    const local = await cache.acquire('workspace:fi:selected', 'local');
    try {
      expect(old.resource.getSnapshot()).toMatchObject({
        status: 'ready',
        snapshot: { fileIndex: { 'legacy.ts': true } },
      });
      legacy.set(['next.ts'], true);
      legacy.commit();
      expect(old.resource.getSnapshot()).toMatchObject({
        status: 'ready',
        snapshot: { fileIndex: { 'next.ts': true } },
      });
      expect(local.resource.backend).toBe('native');
      await expect(cache.acquire('workspace:fi:selected', 'cloud')).rejects.toThrow(denied.message);
      expect(local.resource.getSnapshot()).toEqual({ status: 'loading' });
      expect(old.resource.getSnapshot()).toMatchObject({ status: 'ready' });
    } finally {
      await old.release();
      await local.release();
    }
  });

  it('recovers only the failed Cloud actor after its borrowers leave, preserving another live original source', async () => {
    const actors = new Map<
      string,
      {
        flock: Flock;
        fail?: () => void;
        rejectSync?: (reason: unknown) => void;
      }
    >();
    for (const actor of ['a', 'b']) {
      const flock = new Flock(`cloud-actor-${actor}`);
      flock.set([`${actor}.ts`], true);
      flock.commit();
      actors.set(`workspace:fi:${actor}`, { flock });
    }
    const cache = createCodeCollabFileIndexCache(
      {
        acquireFlockDoc: async (room) => ({
          flock: actors.get(room)!.flock,
          release: async () => undefined,
        }),
        joinFlockDocRoom: async (room) => {
          const actor = actors.get(room)!;
          const synced = new Promise<void>((_resolve, reject) => {
            actor.rejectSync = reject;
          });
          return makeSyncedFlockRoom(synced);
        },
        unloadFlockDoc: async () => undefined,
      },
      { openCloudResource: async () => null }
    );
    fileIndexCaches.push(cache);
    const a = await cache.acquire('workspace:fi:a', 'cloud');
    const b = await cache.acquire('workspace:fi:b', 'cloud');
    await flushMicrotasks();
    actors.get('workspace:fi:a')!.rejectSync!(new Error('Actor A sync failed'));
    await flushMicrotasks();
    expect(a.resource.getSnapshot().status).toBe('error');
    const sameB = await cache.acquire('workspace:fi:b', 'cloud');
    expect(sameB.resource).toBe(b.resource);
    actors.get('workspace:fi:b')!.flock.set(['b-next.ts'], true);
    actors.get('workspace:fi:b')!.flock.commit();
    expect(b.resource.getSnapshot()).toMatchObject({
      status: 'ready',
      snapshot: { fileIndex: { 'b-next.ts': true } },
    });
    await a.release();
    const recoveredA = await cache.acquire('workspace:fi:a', 'cloud');
    expect(recoveredA.resource).not.toBe(a.resource);
    expect(recoveredA.resource.getSnapshot()).toMatchObject({
      status: 'ready',
      snapshot: { fileIndex: { 'a.ts': true } },
    });
    expect(b.resource).toBe(sameB.resource);
    await Promise.all([recoveredA.release(), b.release(), sameB.release()]);
  });
});

describe('ordinary Cloud FI/FIS main-to-renderer projection', () => {
  it('streams real Flock projections without renderer persistence, isolates failed cleanup and clears revoked snapshots', async () => {
    const events = new Set<(event: CloudFileIndexEvent) => void>();
    const borrows = new Set<object>();
    const sources = new Map(
      ['a', 'b'].map((actor) => {
        const flock = new Flock(`cloud-native-${actor}`);
        flock.set([`${actor}.ts`], true);
        flock.set([`${actor}.ts`, 'v'], { g: 'generation.1' });
        flock.commit();
        return [actor, flock] as const;
      })
    );
    let authorized = true;
    let failReleaseA = false;
    const bridge = new CloudFileIndexMainLegacy({
      acquire: async (_windowId, workspaceId) => {
        const borrow = {};
        borrows.add(borrow);
        return {
          workspaceId,
          generation: 'authenticated-generation-1',
          assertCurrent() {
            if (!authorized) throw new Error('Synthetic revoked authority');
          },
          release: async () => {
            borrows.delete(borrow);
          },
          source: {
            async subscribe(owner, listener) {
              const flock = sources.get(owner);
              if (!flock) return null;
              const publish = () =>
                listener({
                  status: 'ready',
                  ...readCodeCollabFileIndexSnapshotFromFlock(flock),
                  updatedAtMs: 1,
                });
              const stop = flock.subscribe(publish);
              publish(); // Before IPC observe resolves: the client must retain the initial push.
              return {
                release: async () => {
                  if (owner === 'a' && failReleaseA)
                    throw new Error('Synthetic unknown unsubscribe acknowledgement');
                  stop();
                },
              };
            },
          },
        };
      },
      send: (_window, event) => {
        for (const listener of events) listener(event);
      },
    });
    const transport = {
      observe: (value: unknown) =>
        bridge.observe(7, parseCloudFileIndexInput(cloudFileIndexRequestSchema, value)),
      cancel: (value: unknown) =>
        bridge.cancel(7, parseCloudFileIndexInput(cloudFileIndexRequestSchema, value)),
      unobserve: (value: unknown) =>
        bridge.unobserve(7, parseCloudFileIndexInput(cloudFileIndexReleaseSchema, value)),
      onSnapshot: (listener: (event: CloudFileIndexEvent) => void) => {
        events.add(listener);
        return () => events.delete(listener);
      },
    };
    expect(() =>
      transport.observe({
        workspaceId: 'workspace',
        ownerSessionId: 'a',
        requestId: crypto.randomUUID(),
        namespace: 'foreign',
      })
    ).toThrow('cloud_file_index_invalid_request');
    const cache = createCodeCollabFileIndexCache(
      {
        acquireFlockDoc: async () => {
          throw new Error('Cloud selected pair reopened renderer IDB');
        },
        joinFlockDocRoom: async () => {
          throw new Error('Cloud selected pair joined old transport');
        },
        unloadFlockDoc: async () => {
          throw new Error('Cloud selected pair created old replica');
        },
      },
      {
        openCloudResource: (room, onFailure) =>
          openCloudCodeCollabFileIndexResource({
            workspaceId: 'workspace',
            ownerSessionId: room.slice('workspace:fi:'.length),
            onFailure,
            transport,
          }),
      }
    );
    fileIndexCaches.push(cache);
    const a = await cache.acquire('workspace:fi:a', 'cloud');
    const b = await cache.acquire('workspace:fi:b', 'cloud');
    try {
      expect(a.resource.getSnapshot()).toMatchObject({
        status: 'ready',
        snapshot: {
          fileIndex: { 'a.ts': true },
          generations: { 'a.ts': 'generation.1' },
        },
      });
      expect(borrows.size).toBe(2);
      failReleaseA = true;
      // Unknown release must remain owned by the main bridge, without retiring B's source.
      await a.release();
      sources.get('b')!.set(['b.ts', 'v'], { g: 'generation.2' });
      sources.get('b')!.commit();
      expect(b.resource.getSnapshot()).toMatchObject({
        status: 'ready',
        snapshot: {
          generations: { 'b.ts': 'generation.2' },
        },
      });
      await expect(bridge.retire(7)).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      expect(borrows.size).toBe(1); // Failed A is still retained; B was actually released.
      expect(b.resource.getSnapshot()).toMatchObject({
        status: 'error',
        error: { code: 'access_denied' },
      });
      failReleaseA = false;
      await bridge.retire(7);
      expect(borrows.size).toBe(0);
      authorized = false;
    } finally {
      failReleaseA = false;
      await bridge.close();
      await b.release();
    }
  });

  it('reopens the same window only after the old frame releases, and fences late old requests and callbacks', async () => {
    let releaseOld!: () => void;
    const oldReleased = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    let releasing!: () => void;
    const releaseStarted = new Promise<void>((resolve) => {
      releasing = resolve;
    });
    let frame = 1;
    const borrows = new Set<object>();
    const events = new Set<(event: CloudFileIndexEvent) => void>();
    const delivered: CloudFileIndexEvent[] = [];
    const callbacks: Array<() => void> = [];
    const flock = new Flock('cloud-reload-frame');
    flock.set(['current.ts'], true);
    flock.commit();
    const bridge = new CloudFileIndexMainLegacy({
      acquire: async (_window, workspaceId) => {
        const acquiredFrame = frame;
        const borrow = {};
        borrows.add(borrow);
        return {
          workspaceId,
          generation: `frame-${acquiredFrame}`,
          assertCurrent: () => undefined,
          release: async () => {
            borrows.delete(borrow);
          },
          source: {
            subscribe: async (_owner, listener) => {
              const publish = () =>
                listener({
                  status: 'ready',
                  ...readCodeCollabFileIndexSnapshotFromFlock(flock),
                  updatedAtMs: acquiredFrame,
                });
              const stop = flock.subscribe(publish);
              callbacks.push(publish);
              publish();
              return {
                release: async () => {
                  if (acquiredFrame === 1) {
                    releasing();
                    await oldReleased;
                  }
                  stop();
                },
              };
            },
          },
        };
      },
      send: (_window, event) => {
        delivered.push(event);
        for (const listener of events) listener(event);
      },
    });
    const transport = {
      observe: (value: unknown) =>
        bridge.observe(7, parseCloudFileIndexInput(cloudFileIndexRequestSchema, value)),
      cancel: (value: unknown) =>
        bridge.cancel(7, parseCloudFileIndexInput(cloudFileIndexRequestSchema, value)),
      unobserve: (value: unknown) =>
        bridge.unobserve(7, parseCloudFileIndexInput(cloudFileIndexReleaseSchema, value)),
      onSnapshot: (listener: (event: CloudFileIndexEvent) => void) => {
        events.add(listener);
        return () => events.delete(listener);
      },
    };
    const open = () =>
      openCloudCodeCollabFileIndexResource({
        workspaceId: 'workspace',
        ownerSessionId: 'owner',
        onFailure: () => undefined,
        transport,
      });
    const first = await open();
    if (!first) throw new Error('First frame missing native source');
    const oldRequest = parseCloudFileIndexInput(cloudFileIndexRequestSchema, {
      workspaceId: delivered[0]!.workspaceId,
      ownerSessionId: delivered[0]!.ownerSessionId,
      requestId: delivered[0]!.requestId,
    });
    const retire = bridge.retire(7);
    expect(bridge.retire(7)).toBe(retire);
    await releaseStarted;
    frame = 2;
    await expect(open()).rejects.toMatchObject({ code: 'restart_required' });
    expect(borrows.size).toBe(1);
    releaseOld();
    await retire;
    expect(borrows.size).toBe(0);
    const second = await open();
    if (!second) throw new Error('Reload lost its native source');
    try {
      expect(second.getSnapshot()).toMatchObject({
        status: 'ready',
        snapshot: { fileIndex: { 'current.ts': true } },
      });
      await expect(bridge.observe(7, oldRequest)).rejects.toMatchObject({
        code: 'restart_required',
      });
      callbacks[0]!(); // A queued old SDK frame cannot replace the new frame's projection.
      flock.set(['next.ts'], true);
      flock.commit();
      expect(second.getSnapshot()).toMatchObject({
        status: 'ready',
        snapshot: { fileIndex: { 'next.ts': true } },
      });
      expect(first.getSnapshot()).toMatchObject({
        status: 'error',
        error: { code: 'access_denied' },
      });
      expect(borrows.size).toBe(1);
    } finally {
      await second.dispose();
      await first.dispose();
      await bridge.close();
    }
    expect(borrows.size).toBe(0);
  });

  it('retains an exact cleanup retry when the unobserve acknowledgement is missing', async () => {
    let confirmRelease = false;
    let subscriptionActive = true;
    const resource = await openCloudCodeCollabFileIndexResource({
      workspaceId: 'workspace',
      ownerSessionId: 'owner',
      onFailure: () => undefined,
      transport: {
        observe: async (value) => ({
          ...parseCloudFileIndexInput(cloudFileIndexRequestSchema, value),
          backend: 'native',
          leaseId: crypto.randomUUID(),
          generation: 'generation',
        }),
        cancel: async () => ({ canceled: true }),
        unobserve: async () => {
          if (!confirmRelease) return undefined as unknown as { released: true };
          subscriptionActive = false;
          return { released: true };
        },
        onSnapshot: () => () => undefined,
      },
    });
    if (!resource) throw new Error('Native observation was not selected');
    let retry: (() => Promise<void>) | undefined;
    try {
      await resource.dispose();
    } catch (error) {
      expect(error).toMatchObject({ code: 'cleanup_unconfirmed' });
      retry = (error as { retryCleanup(): Promise<void> }).retryCleanup;
    }
    expect(subscriptionActive).toBe(true);
    if (!retry) throw new Error('Missing acknowledgement lost its cleanup owner');
    confirmRelease = true;
    await retry();
    expect(subscriptionActive).toBe(false);
  });

  it('returns positive legacy without a source, while selected acquisition failure stays unavailable', async () => {
    const bridge = new CloudFileIndexMainLegacy({
      acquire: async (_window, workspaceId) => {
        if (workspaceId === 'legacy') return null;
        throw new Error('Selected native authority unavailable');
      },
      send: () => {
        throw new Error('Legacy request must not publish a snapshot');
      },
    });
    try {
      expect(
        await bridge.observe(7, {
          workspaceId: 'legacy',
          ownerSessionId: 'owner',
          requestId: crypto.randomUUID(),
        })
      ).toEqual({ backend: 'legacy' });
      await expect(
        bridge.observe(7, {
          workspaceId: 'selected',
          ownerSessionId: 'owner',
          requestId: crypto.randomUUID(),
        })
      ).rejects.toMatchObject({ code: 'unavailable' });
    } finally {
      await bridge.close();
    }
  });

  it('fences cancellation before and during acquisition, releasing a late source without publishing its index', async () => {
    let resolveGrant!: (value: CloudFileIndexMainGrant) => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const lateGrant = new Promise<CloudFileIndexMainGrant>((resolve) => {
      resolveGrant = resolve;
    });
    const events: CloudFileIndexEvent[] = [];
    const borrows = new Set<object>();
    const bridge = new CloudFileIndexMainLegacy({
      acquire: async () => {
        started();
        return lateGrant;
      },
      send: (_window, event) => events.push(event),
    });
    const request = {
      workspaceId: 'workspace',
      ownerSessionId: 'a',
      requestId: crypto.randomUUID(),
    };
    const pending = bridge.observe(7, request);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'restart_required' });
    await startedPromise;
    const cancel = bridge.cancel(7, request);
    const borrow = {};
    borrows.add(borrow);
    resolveGrant({
      workspaceId: 'workspace',
      generation: 'generation',
      assertCurrent: () => undefined,
      release: async () => {
        borrows.delete(borrow);
      },
      source: {
        subscribe: async () => {
          throw new Error('Canceled source reached subscription');
        },
      },
    });
    await rejected;
    await cancel;
    expect(borrows.size).toBe(0);
    expect(events).toEqual([]);
    await expect(bridge.observe(7, request)).rejects.toMatchObject({ code: 'restart_required' });
    const before = { ...request, requestId: crypto.randomUUID() };
    await bridge.cancel(7, before);
    await expect(bridge.observe(7, before)).rejects.toMatchObject({ code: 'restart_required' });
    await bridge.close();
  });
});
