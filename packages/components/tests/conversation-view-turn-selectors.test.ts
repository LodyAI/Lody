import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import {
  resolveActiveAssistantTurnId,
  type SessionHistoryInput,
  type SessionId,
} from '@lody/shared';
import {
  appendHistoryEntry,
  createConversationViewFromDoc,
  ensureTurnById,
  findPermissionRequestTurnIndex,
  findSystemNotice,
  patchHistoryEntry,
  readDiffInputsFromView,
  resolveActiveAssistantTurnIdFromView,
} from '../src/lib/conversation-view';

const sessionId = 'session-selectors' as SessionId;

const user = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  status: 'seen',
  read: true,
  finished: true,
  fileDiff: [],
  items: [{ type: 'text', text: `prompt ${id}` }] as never,
  inputConfig: { prompt: `prompt ${id}`, cliType: 'builtin', agentType: 'claude' } as never,
});

const assistant = (
  id: string,
  overrides: Partial<SessionHistoryInput> = {}
): SessionHistoryInput => ({
  id,
  role: 'assistant',
  timestamp: '2026-01-01T00:01:00.000Z',
  finished: true,
  endedAt: 1_700_000_000_000,
  fileDiff: [{ filePath: `src/${id}.ts`, add: 3, del: 1 }] as never,
  items: [{ type: 'text', text: `answer ${id}` }] as never,
  ...overrides,
});

const system = (id: string, name: string): SessionHistoryInput => ({
  id,
  role: 'system',
  timestamp: '2026-01-01T00:02:00.000Z',
  finished: true,
  read: true,
  fileDiff: [],
  items: [{ type: 'system_notice', name, meta: {} }] as never,
});

const docOf = (entries: SessionHistoryInput[]): LoroDoc => {
  const doc = new LoroDoc();
  for (const entry of entries) appendHistoryEntry(doc, entry);
  return doc;
};

describe('resolveActiveAssistantTurnIdFromView', () => {
  it('matches the shared array rule over index rows, including the open-turn case', () => {
    const shapes: SessionHistoryInput[][] = [
      [],
      [user('u1')],
      [user('u1'), assistant('a1')],
      [user('u1'), assistant('a1', { finished: false, endedAt: undefined })],
      [user('u1'), assistant('a1', { finished: undefined, endedAt: undefined }), user('u2')],
      [user('u1'), assistant('a1', { finished: false, endedAt: 5 })],
    ];
    for (const shape of shapes) {
      const doc = docOf(shape);
      const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 1 });
      expect(resolveActiveAssistantTurnIdFromView(view)).toBe(
        resolveActiveAssistantTurnId(view.readAll())
      );
      view.dispose();
    }
  });

  it('tracks a status flip written through patchHistoryEntry without hydration', () => {
    const doc = docOf([user('u1'), assistant('a1', { finished: false, endedAt: undefined })]);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 0 });
    expect(resolveActiveAssistantTurnIdFromView(view)).toBe('a1');
    expect(patchHistoryEntry(doc, 'a1', { finished: true, endedAt: 42 }, 1)).toBe(true);
    expect(resolveActiveAssistantTurnIdFromView(view)).toBeUndefined();
    expect(view.isHydrated(1)).toBe(false);
    // The patch left the items container alone.
    expect(view.readAll()[1]).toMatchObject({ id: 'a1', finished: true, endedAt: 42 });
    expect(view.readAll()[1]?.items).toHaveLength(1);
    view.dispose();
  });
});

describe('ensureTurnById', () => {
  it('hydrates exactly the requested turn', async () => {
    const doc = docOf([user('u1'), assistant('a1'), user('u2'), assistant('a2')]);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 1 });
    expect(view.isHydrated(1)).toBe(false);
    expect(await ensureTurnById(view, 'a1')).toMatchObject({ id: 'a1' });
    expect(view.isHydrated(1)).toBe(true);
    expect(view.isHydrated(0)).toBe(false);
    expect(await ensureTurnById(view, 'missing')).toBeUndefined();
    view.dispose();
  });
});

describe('findPermissionRequestTurnIndex', () => {
  it('finds the request on a hydrated tail turn and reports -1 otherwise', () => {
    const permission = {
      type: 'tool_call',
      toolCallId: 'tc1',
      title: 'Run',
      kind: 'execute',
      status: 'pending',
      permissionRequest: { requestId: 'req-1', options: [] },
    };
    const doc = docOf([
      user('u1'),
      assistant('a1', { items: [permission] as never, finished: false, endedAt: undefined }),
      user('u2'),
      assistant('a2', { items: [permission] as never }),
    ]);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 1 });
    expect(findPermissionRequestTurnIndex(view, 'req-1')).toBe(3);
    expect(findPermissionRequestTurnIndex(view, 'req-none')).toBe(-1);
    view.dispose();
  });
});

describe('findSystemNotice', () => {
  it('skips non-system turns and reports an unhydrated system turn to hydrate', async () => {
    const doc = docOf([
      user('u1'),
      assistant('a1'),
      system('s1', 'session_fork_origin'),
      user('u2'),
      assistant('a2'),
    ]);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 1 });
    expect(findSystemNotice(view, 'session_fork_origin')).toEqual({
      found: false,
      unhydratedSystemTurnIndex: 2,
    });
    await view.ensureRange(2, 3);
    expect(findSystemNotice(view, 'session_fork_origin')).toEqual({ found: true });
    expect(findSystemNotice(view, 'other')).toEqual({
      found: false,
      unhydratedSystemTurnIndex: null,
    });
    expect(view.isHydrated(0)).toBe(false);
    view.dispose();
  });
});

describe('readDiffInputsFromView', () => {
  it('reads every turn fileDiff from its own container and follows updates', () => {
    const doc = docOf([user('u1'), assistant('a1'), user('u2'), assistant('a2')]);
    const view = createConversationViewFromDoc(doc, { sessionId, tailKeep: 1 });
    expect(readDiffInputsFromView(view)).toEqual([
      { id: 'u1', role: 'user', fileDiff: [] },
      { id: 'a1', role: 'assistant', fileDiff: [{ filePath: 'src/a1.ts', add: 3, del: 1 }] },
      { id: 'u2', role: 'user', fileDiff: [] },
      { id: 'a2', role: 'assistant', fileDiff: [{ filePath: 'src/a2.ts', add: 3, del: 1 }] },
    ]);
    expect(view.isHydrated(1)).toBe(false);
    const first = view.fileDiff(1);
    expect(view.fileDiff(1)).toBe(first);

    patchHistoryEntry(doc, 'a1', { fileDiff: [{ filePath: 'src/x.ts', add: 1, del: 0 }] as never });
    expect(view.fileDiff(1)).toEqual([{ filePath: 'src/x.ts', add: 1, del: 0 }]);
    expect(view.isHydrated(1)).toBe(false);
    view.dispose();
  });
});
