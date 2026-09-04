import { describe, expect, it, vi } from 'vitest';
import { Flock } from '@loro-dev/flock-wasm';
import {
  createPreviewVisualComment,
  createPreviewVisualCommentDoc,
  type MinimalVisualAnnotationAnchor,
  type PreviewVisualCommentDocInput,
} from '@lody/shared';
import { LoroDoc } from 'loro-crdt';
import { Mirror } from 'loro-mirror';
import { sessionDocSchema, type SessionHistoryInput, type SessionId } from '@lody/shared';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';
import { createSessionDocStateSource } from '../src/providers/session-doc-state-source';

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

    await expect(writer.appendSessionTurn('session-1', { id: 'turn-1' })).rejects.toThrow(
      'store unavailable'
    );
  });
});

describe('createDirectWorkspaceWriter history writes with a ConversationView', () => {
  const sessionId = 'session-writer-view' as SessionId;
  const userTurn = (id: string): SessionHistoryInput => ({
    id,
    role: 'user',
    timestamp: '2026-01-01T00:00:00.000Z',
    status: 'pending',
    read: false,
    finished: true,
    fileDiff: [],
    items: [{ type: 'text', text: `prompt ${id}` }] as never,
    inputConfig: { prompt: `prompt ${id}`, cliType: 'builtin', agentType: 'claude' } as never,
  });
  const assistantTurn = (id: string, items: unknown[]): SessionHistoryInput => ({
    id,
    role: 'assistant',
    timestamp: '2026-01-01T00:01:00.000Z',
    finished: false,
    fileDiff: [],
    items: items as never,
  });
  const permissionItem = {
    type: 'tool_call',
    toolCallId: 'tc1',
    title: 'Run',
    kind: 'execute',
    status: 'pending',
    permissionRequest: { requestId: 'req-1', options: [] },
  };

  const viaMirror = (apply: (mirror: Mirror<typeof sessionDocSchema>) => void): unknown => {
    const doc = new LoroDoc();
    const mirror = new Mirror({
      doc,
      schema: sessionDocSchema,
      ignoreUnknownProperties: true,
      initialState: { session: { id: sessionId }, history: [] },
    });
    apply(mirror);
    doc.commit();
    return JSON.parse(JSON.stringify(mirror.getState().history));
  };

  const storeWithView = () => {
    const doc = new LoroDoc();
    const source = createSessionDocStateSource({ doc, sessionId, conversationViewEnabled: true });
    const setState = vi.fn(source.setState);
    const store = {
      sessionId,
      roomId: `session:${sessionId}`,
      doc,
      firstSynced: Promise.resolve(),
      acquireSync: () => () => {},
      getSyncState: () => 'synced' as const,
      subscribeSyncState: () => () => {},
      getState: source.getState,
      setState,
      subscribe: source.subscribe,
      conversationView: source.conversationView,
      dispose: source.dispose,
      waitUntilSynced: async () => {},
    };
    const writer = createDirectWorkspaceWriter({
      repo: { upsertDocMeta: vi.fn(async () => {}) } as never,
      acquireSessionStore: vi.fn(async () => store),
      releaseSessionStoreRef: vi.fn(),
      acquirePreviewVisualCommentStore: vi.fn(async () => {
        throw new Error('not used');
      }),
      releasePreviewVisualCommentStoreRef: vi.fn(),
    });
    return {
      writer,
      store,
      setState,
      history: () => JSON.parse(JSON.stringify(source.getState().history)) as unknown,
    };
  };

  it('appends, replaces and answers permissions through the history writer, never setState', async () => {
    const { writer, store, setState, history } = storeWithView();

    await writer.startSession(
      sessionId,
      { title: 'x' } as never,
      userTurn('u1') as never,
      {} as never
    );
    await writer.appendSessionTurn(
      sessionId,
      assistantTurn('a1', [permissionItem]) as never,
      {} as never
    );
    await writer.appendSessionHistory(sessionId, userTurn('u2') as never);
    await writer.updateSessionHistory(sessionId, 'u2', {
      ...userTurn('u2'),
      status: 'seen',
    } as never);
    await writer.updateSessionHistory(sessionId, 'missing', userTurn('nope') as never);
    await writer.respondSessionPermission(sessionId, 'req-1', { type: 'selected', optionId: 'allow' });

    expect(setState).not.toHaveBeenCalled();
    expect(store.conversationView?.turnCount).toBe(3);
    expect(history()).toEqual(
      viaMirror((mirror) => {
        mirror.setState((prev) => ({ ...prev, history: [userTurn('u1')] as never }));
        mirror.setState((prev) => ({
          ...prev,
          history: [...prev.history, assistantTurn('a1', [permissionItem])] as never,
        }));
        mirror.setState((prev) => ({ ...prev, history: [...prev.history, userTurn('u2')] as never }));
        mirror.setState((draft) => {
          const entry = draft.history.find((item) => item.id === 'u2');
          if (entry) entry.status = 'seen';
        });
        mirror.setState((draft) => {
          const entry = draft.history.find((item) => item.id === 'a1');
          const item = entry?.items?.[0] as
            | { permissionRequest?: { outcome?: unknown } }
            | undefined;
          if (item?.permissionRequest) {
            item.permissionRequest.outcome = { type: 'selected', optionId: 'allow' };
          }
        });
      })
    );
  });
});
