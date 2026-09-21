import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  enterStorageCrisis,
  resetStorageCrisisForTests,
  StorageCrisisError,
} from '../src/lib/storage-crisis';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc } from 'loro-crdt';
import {
  createPreviewVisualComment,
  createPreviewVisualCommentDoc,
  createSessionMirror,
  type SessionHistory,
  type MinimalVisualAnnotationAnchor,
  type PreviewVisualCommentDocInput,
} from '@lody/shared';
import { createLoroSessionData } from '@lody/shared/session-data';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';
import { persistReconciledAgentRole } from '../src/lib/agent-role-schema-reconciliation';
import {
  AGENT_ROLE_VERSION,
  workspaceFlockKeys,
  type AgentRole,
  type AcpCapabilityCacheEntry,
} from '@lody/shared';

const anchor: MinimalVisualAnnotationAnchor = {
  version: 1,
  page: {
    url: 'http://localhost:5173',
    pathname: '/',
    viewport: { width: 800, height: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1 },
  },
  click: {
    clientX: 10,
    clientY: 20,
    pageX: 10,
    pageY: 20,
    viewportXRatio: 0.1,
    viewportYRatio: 0.2,
  },
  target: {
    tag: 'button',
    attributes: {},
    rect: { x: 0, y: 0, width: 100, height: 30 },
    rectRatio: { x: 0, y: 0, width: 0.1, height: 0.05 },
    selector: 'button',
  },
  context: { ancestors: [] },
};

describe('createDirectWorkspaceWriter', () => {
  afterEach(resetStorageCrisisForTests);

  it.each(['put', 'update', 'insert', 'delete'] as const)(
    'rejects cached Flock %s without changing memory when storage fails during acquisition',
    async (operation) => {
      const flock = new Flock('crisis');
      flock.set(['key'], 'before');
      flock.commit();
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      const writer = createDirectWorkspaceWriter({
        repo: {
          openFlockDoc: async () => {
            await gate;
            return { flock };
          },
        },
      } as never);
      const mutate = () =>
        operation === 'put'
          ? writer.flockRowPut('catalog', ['key'], 'after')
          : operation === 'update'
            ? writer.flockRowUpdate('catalog', ['key'], () => 'after')
            : operation === 'insert'
              ? writer.flockRowPutIfAbsent('catalog', ['new'], 'after')
              : writer.flockRowDelete('catalog', ['key']);
      const pending = mutate();
      enterStorageCrisis({ kind: 'quota', operation: 'save', detail: 'synthetic quota' });
      resume();
      await expect(pending).rejects.toBeInstanceOf(StorageCrisisError);
      await expect(mutate()).rejects.toBeInstanceOf(StorageCrisisError);
      expect(flock.get(['key'])).toBe('before');
      expect(flock.get(['new'])).toBeUndefined();
    }
  );

  it.each(['session', 'preview'] as const)(
    'rejects %s mutation and releases its store if storage fails while acquiring',
    async (kind) => {
      let resume!: () => void;
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let references = 0;
      const state = { mq: [] };
      const store = { setState: (update: (draft: typeof state) => void) => update(state) };
      const acquire = async () => {
        references++;
        await gate;
        return store;
      };
      const release = () => {
        references--;
      };
      const writer = createDirectWorkspaceWriter({
        acquireSessionStore: acquire,
        releaseSessionStoreRef: release,
        acquirePreviewVisualCommentStore: acquire,
        releasePreviewVisualCommentStoreRef: release,
      } as never);
      const pending =
        kind === 'session'
          ? writer.enqueueSessionMessage('session', { $cid: 'message' })
          : writer.mutatePreviewVisualComments('session' as never, {} as never);
      enterStorageCrisis({
        kind: 'unavailable',
        operation: 'loadDoc',
        detail: 'synthetic closing connection',
      });
      resume();
      await expect(pending).rejects.toBeInstanceOf(StorageCrisisError);
      expect(state).toEqual({ mq: [] });
      expect(references).toBe(0);
    }
  );
  it.each(['unchanged', 'edited', 'deleted', 'cancelled', 'other-owner', 'write-failure'] as const)(
    'reconciles the durable role without overwriting intervening changes: %s',
    async (scenario) => {
      const flock = new Flock('role-reconciliation');
      const role: AgentRole = {
        v: AGENT_ROLE_VERSION,
        id: 'role' as never,
        machineId: 'machine' as never,
        agentConfigId: 'config' as never,
        ownerUserId: 'owner',
        visibility: 'private',
        name: 'Reviewer',
        runConfig: { configOptionValues: { retired: 'value' } },
        revision: 1,
        createdAt: 1,
        updatedAt: 1,
      };
      const key = workspaceFlockKeys.agentRole(role.id);
      flock.set(key, role as never);
      flock.commit();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const repo = {
        openFlockDoc: async () => {
          await gate;
          if (scenario === 'write-failure') throw new Error('storage unavailable');
          return { flock, syncOnce: async () => {} };
        },
      };
      const writer = createDirectWorkspaceWriter({ repo } as never);
      const runtime = { repo, writer, workspaceId: 'workspace' } as never;
      const capability: AcpCapabilityCacheEntry = {
        cliType: 'builtin',
        agentType: 'codex',
        provenance: 'runtime',
        fetchedAt: 2,
        modes: [],
        models: [],
        configOptions: [],
      };
      const pending = persistReconciledAgentRole(
        runtime,
        role,
        capability,
        scenario === 'other-owner' ? 'someone-else' : 'owner',
        3,
        () => scenario !== 'cancelled'
      );
      if (scenario === 'edited')
        flock.set(key, { ...role, name: 'New name', revision: 2 } as never);
      if (scenario === 'deleted') flock.delete(key);
      flock.commit();
      const before = flock.get(key);
      release();
      if (scenario === 'write-failure')
        await expect(pending).rejects.toThrow('storage unavailable');
      else await pending;
      if (scenario === 'unchanged') {
        expect(flock.get(key)).toEqual({
          ...role,
          runConfig: { configOptionValues: {} },
          revision: 2,
          updatedAt: 3,
        });
        await persistReconciledAgentRole(runtime, role, capability, 'owner', 4, () => true);
        expect(flock.get(key)).toMatchObject({ revision: 2, updatedAt: 3 });
      } else expect(flock.get(key)).toEqual(before);
    }
  );
  it('routes renderer history writes through the real shared boundary', async () => {
    const doc = new LoroDoc();
    const mirror = createSessionMirror({
      doc,
      initialState: { session: { id: 'session-1' as never }, history: [] },
    });
    const writer = createDirectWorkspaceWriter({
      repo: {} as never,
      acquireSessionStore: async () =>
        ({
          ...mirror,
          sessionData: createLoroSessionData({
            sessionId: 'session-1' as never,
            doc,
            writer: mirror.historyWriter,
          }),
        }) as never,
      releaseSessionStoreRef: () => {},
      acquirePreviewVisualCommentStore: async () => {
        throw new Error('not used');
      },
      releasePreviewVisualCommentStoreRef: () => {},
    });
    const entry: SessionHistory = {
      id: 'turn',
      role: 'user',
      timestamp: 'synthetic',
      items: [{ type: 'text', text: 'hello' }],
      fileDiff: [],
    };
    const version = doc.version().toJSON();
    await expect(
      writer.appendSessionTurn('session-1', {
        ...entry,
        items: [{ type: 'text' }],
      } as SessionHistory)
    ).rejects.toThrow('Invalid history write');
    expect(doc.version().toJSON()).toEqual(version);
    await writer.appendSessionTurn('session-1', entry);
    await writer.updateSessionHistory('session-1', 'turn', {
      ...entry,
      items: [{ type: 'text', text: 'updated' }],
    });
    expect(doc.toJSON().history[0].items).toEqual([{ type: 'text', text: 'updated' }]);
    mirror.dispose();
  });

  it('puts a Flock row only when the key is absent in the same synchronous transaction', async () => {
    const flock = new Flock('workspace-writer-test');
    const writer = createDirectWorkspaceWriter({
      repo: {
        openFlockDoc: vi.fn(async () => ({ flock })),
      } as never,
      acquireSessionStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releaseSessionStoreRef: vi.fn(),
      acquirePreviewVisualCommentStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releasePreviewVisualCommentStoreRef: vi.fn(),
    });

    const results = await Promise.all([
      writer.flockRowPutIfAbsent('flock-1', ['localProject', 'project-1'], { name: 'first' }),
      writer.flockRowPutIfAbsent('flock-1', ['localProject', 'project-1'], { name: 'second' }),
    ]);
    expect(results).toEqual([
      { inserted: true, value: { name: 'first' } },
      { inserted: false, value: { name: 'first' } },
    ]);
    expect(flock.get(['localProject', 'project-1'])).toEqual({ name: 'first' });
  });

  it('applies the shared preview-comment mutation to the renderer store', async () => {
    const state = createPreviewVisualCommentDoc(
      'session-1' as never
    ) as PreviewVisualCommentDocInput;
    const setState = vi.fn((updater: (draft: PreviewVisualCommentDocInput) => void) => {
      updater(state);
    });
    const writer = createDirectWorkspaceWriter({
      repo: {} as never,
      acquireSessionStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releaseSessionStoreRef: vi.fn(),
      acquirePreviewVisualCommentStore: vi.fn(async () => ({ setState }) as never),
      releasePreviewVisualCommentStoreRef: vi.fn(),
    });
    const comment = createPreviewVisualComment({
      id: 'comment-1',
      turnId: 'turn-1',
      body: 'Persist me',
      anchor,
      authorId: 'user-1',
      createdAt: 1_000,
    });

    await writer.mutatePreviewVisualComments('session-1' as never, { kind: 'create', comment });
    expect(state.turns['turn-1']).toMatchObject({
      comments: [expect.objectContaining({ id: 'comment-1', body: 'Persist me' })],
    });
  });

  it('rejects when the underlying store write fails so send paths surface the error', async () => {
    const writer = createDirectWorkspaceWriter({
      repo: {} as never,
      acquireSessionStore: vi.fn(async () => {
        throw new Error('store unavailable');
      }),
      releaseSessionStoreRef: vi.fn(),
      acquirePreviewVisualCommentStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releasePreviewVisualCommentStoreRef: vi.fn(),
    });

    await expect(
      writer.appendSessionTurn('session-1', {
        id: 'turn-1',
        role: 'user',
        timestamp: '2026-01-01',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
      })
    ).rejects.toThrow('store unavailable');
  });
});
