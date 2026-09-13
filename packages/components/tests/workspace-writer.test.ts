import { describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import { LoroDoc, LoroList } from 'loro-crdt';
import {
  createPreviewVisualComment,
  createPreviewVisualCommentDoc,
  createSessionMirror,
  createHistoryWriter,
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
  it.each([
    ['before acquisition', 'created'],
    ['before acquisition', 'dismissed'],
    ['offline concurrent', 'created'],
    ['offline concurrent', 'dismissed'],
  ] as const)(
    'resolves only the proposal decision while retaining peer edits: %s / %s',
    async (mode, outcome) => {
      const doc = new LoroDoc();
      const mirror = createSessionMirror({ doc, initialState: { history: [] } });
      mirror.historyWriter.append({
        id: 'proposal-turn',
        role: 'system',
        timestamp: 'synthetic',
        items: [
          {
            type: 'system_notice',
            name: 'task_proposal',
            meta: { proposalId: 'proposal', title: 'Initial', body: 'Initial body' },
          },
        ],
      });
      const peer = new LoroDoc();
      peer.import(doc.export({ mode: 'snapshot' }));
      const peerMirror = createSessionMirror({ doc: peer, initialState: { history: [] } });
      let release!: () => void;
      const acquired = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writer = createDirectWorkspaceWriter({
        repo: {} as never,
        acquireSessionStore: async () => {
          await acquired;
          // Windowed composition has no full-history Mirror callback.
          const historyWriter = createHistoryWriter(doc);
          return {
            historyWriter,
            sessionData: createLoroSessionData({
              sessionId: 'session' as never,
              doc,
              writer: historyWriter,
            }),
          } as never;
        },
        releaseSessionStoreRef: () => {},
        acquirePreviewVisualCommentStore: async () => {
          throw new Error('not used');
        },
        releasePreviewVisualCommentStoreRef: () => {},
      });
      const pending = writer.resolveSessionTaskProposal('session', 'proposal-turn', 'proposal', {
        outcome,
        ...(outcome === 'created' ? { taskId: 'task-1' } : {}),
      });
      peerMirror.historyWriter.update((history) => {
        const entry = history[0]!;
        const notice = entry.items![0]!;
        if (notice.type === 'system_notice' && notice.name === 'task_proposal') {
          notice.meta.title = 'Peer title';
          notice.meta.body = 'Peer body';
        }
        if (mode === 'before acquisition') {
          entry.items!.unshift({ type: 'text', text: 'Peer inserted before proposal' });
        }
        entry.read = true;
        return history;
      });
      if (mode === 'before acquisition')
        doc.import(peer.export({ mode: 'update', from: doc.version() }));
      release();
      const listToJSON = LoroList.prototype.toJSON;
      const guard = vi.spyOn(LoroList.prototype, 'toJSON').mockImplementation(function () {
        if (this.id === doc.getList('history').id) throw new Error('Full history body read');
        return listToJSON.call(this);
      });
      try {
        await pending;
      } finally {
        guard.mockRestore();
      }
      const localUpdate = doc.export({ mode: 'update', from: peer.version() });
      const peerUpdate = peer.export({ mode: 'update', from: doc.version() });
      doc.import(peerUpdate);
      peer.import(localUpdate);
      expect(doc.getList('history').toJSON()).toEqual(peer.getList('history').toJSON());
      expect(doc.getList('history').toJSON()[0]).toMatchObject({
        read: true,
        items: [
          ...(mode === 'before acquisition'
            ? [{ type: 'text', text: 'Peer inserted before proposal' }]
            : []),
          {
            type: 'system_notice',
            name: 'task_proposal',
            meta: {
              proposalId: 'proposal',
              title: 'Peer title',
              body: 'Peer body',
              outcome,
              ...(outcome === 'created' ? { taskId: 'task-1' } : {}),
            },
          },
        ],
      });
      const version = doc.version().toJSON();
      await writer.resolveSessionTaskProposal('session', 'proposal-turn', 'removed-proposal', {
        outcome: 'dismissed',
      });
      expect(doc.version().toJSON()).toEqual(version);
      await expect(
        writer.resolveSessionTaskProposal('session', 'proposal-turn', 'proposal', {
          outcome: 'invalid' as never,
        })
      ).rejects.toThrow('Invalid history write');
      expect(doc.version().toJSON()).toEqual(version);
      mirror.dispose();
      peerMirror.dispose();
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
