import { describe, expect, it } from 'vitest';
import type { SessionHistory, SessionId } from '@lody/shared';
import { createMemorySessionData } from '@lody/shared/session-data';
import { createDirectWorkspaceWriter } from '../src/providers/workspace-writer-impl';

// The renderer's real writer runs against the independent in-memory
// `SessionData`: no Loro, Mirror, CID or storage offset. This is what proves the
// UI consumer depends on the port contract, not on the Loro adapter.

const sessionId = 'session-1' as SessionId;

const userTurn = (turnId: string): SessionHistory => ({
  id: turnId,
  role: 'user',
  timestamp: '2026-01-01T00:00:00.000Z',
  items: [{ type: 'text', text: 'hello' }],
  fileDiff: [],
});

const permissionTurn = (): SessionHistory => ({
  id: 'assistant-1',
  role: 'assistant',
  timestamp: '2026-01-01T00:00:01.000Z',
  items: [
    {
      type: 'tool_call',
      toolCallId: 'call',
      status: 'pending',
      permissionRequest: { requestId: 'req-1', options: [] },
    },
  ],
  fileDiff: [],
});

const proposalTurn = (): SessionHistory => ({
  id: 'proposal-1',
  role: 'system',
  timestamp: '2026-01-01T00:00:02.000Z',
  items: [
    {
      type: 'system_notice',
      name: 'task_proposal',
      meta: { proposalId: 'proposal-1', title: 'Ship it' },
    },
  ],
  fileDiff: [],
});

describe('renderer session writer over the in-memory SessionData', () => {
  const createWriter = (memory: ReturnType<typeof createMemorySessionData>) =>
    createDirectWorkspaceWriter({
      repo: { upsertDocMeta: async () => {} } as never,
      acquireSessionStore: async () => ({ sessionData: memory }) as never,
      releaseSessionStoreRef: () => {},
      acquirePreviewVisualCommentStore: async () => {
        throw new Error('not used');
      },
      releasePreviewVisualCommentStoreRef: () => {},
    });

  it('appends, replaces and answers domain commands through the port', async () => {
    const memory = createMemorySessionData({
      sessionId,
      initialTurns: [permissionTurn(), proposalTurn()],
    });
    const writer = createWriter(memory);

    await writer.appendSessionTurn(sessionId, userTurn('user-1'));
    await writer.appendSessionHistory(sessionId, userTurn('user-2'));
    await writer.updateSessionHistory(sessionId, 'user-2', {
      ...userTurn('user-2'),
      items: [{ type: 'text', text: 'edited' }],
    });
    await writer.respondSessionPermission(
      sessionId,
      'req-1',
      { outcome: 'cancelled' },
      { turnId: 'assistant-1' }
    );
    await writer.resolveSessionTaskProposal(sessionId, 'proposal-1', 'proposal-1', {
      outcome: 'created',
      taskId: 'task-1',
    });

    const stored = memory.readStored();
    expect(stored.map((turn) => turn.id)).toEqual([
      'assistant-1',
      'proposal-1',
      'user-1',
      'user-2',
    ]);
    const edited = stored.find((turn) => turn.id === 'user-2')!;
    expect(edited.items?.[0]?.text).toBe('edited');
    const answered = stored.find((turn) => turn.id === 'assistant-1')!.items?.[0];
    expect(answered?.type === 'tool_call' && answered.permissionRequest?.outcome?.outcome).toBe(
      'cancelled'
    );
    const proposal = stored.find((turn) => turn.id === 'proposal-1')!.items?.[0];
    expect(proposal?.type === 'system_notice' && proposal.meta?.outcome).toBe('created');
    expect(proposal?.type === 'system_notice' && proposal.meta?.taskId).toBe('task-1');
  });

  it('surfaces a rejected domain command instead of silently dropping the write', async () => {
    const memory = createMemorySessionData({ sessionId, initialTurns: [] });
    const writer = createWriter(memory);

    await expect(
      writer.appendSessionTurn(sessionId, {
        ...userTurn('bad'),
        items: [{ type: 'text' }],
      } as SessionHistory)
    ).rejects.toThrow('Invalid history write');
    expect(memory.readStored()).toEqual([]);

    // A proposal a peer removed is a best-effort no-op, not a failure.
    await expect(
      writer.resolveSessionTaskProposal(sessionId, 'missing-entry', 'proposal-1', {
        outcome: 'dismissed',
      })
    ).resolves.toBeUndefined();
  });
});
