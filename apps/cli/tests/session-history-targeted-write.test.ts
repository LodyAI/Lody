import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createHistoryWriter, parseSessionNotification, type SessionId } from '@lody/shared';
import { SessionDocument } from '../src/lib/loro/doc';
import { composeTestSessionDoc } from './session-doc-fixture';
import { appendACPNotificationsToAssistantEntry } from '../src/lib/acp/history';
import { createSessionBackend } from '../src/session/session-backend';
import { MessageHandler } from '../src/lib/message-handler';

describe('targeted history writes', () => {
  it('uses the local Loro goal query for GC and observes in-place goal clearing', async () => {
    const id = 'synthetic-goal-query' as SessionId;
    const loro = new LoroDoc();
    const doc = new SessionDocument({} as never, id, async () => {});
    composeTestSessionDoc(doc, { doc: loro });
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    const writer = doc.sessionData.writer;
    writer.append({
      id: 'goal-owner',
      role: 'assistant',
      timestamp: 'synthetic',
      items: [{ type: 'goal', threadId: 'g', objective: 'Retain', status: 'active' }],
    });
    for (let i = 0; i < 85; i++)
      writer.append({
        id: `plain-${i}`,
        role: 'assistant',
        timestamp: 'synthetic',
        items: [{ type: 'text', text: 'ordinary' }],
      });
    const receiver = {
      workspaceDocument: {
        getOrCreateSessionDoc: async () => ({ getMetaState: async () => undefined }),
      },
      getSessionBackend: async () => backend,
    } as unknown as MessageHandler;
    const full = vi
      .spyOn(backend, 'readHistory')
      .mockRejectedValue(new Error('whole read forbidden'));
    try {
      expect(await MessageHandler.prototype.hasActiveGoal.call(receiver, id)).toBe(true);
      await backend.applyHistoryAction({ kind: 'clear-goal', threadId: 'g', updatedAt: 1 });
      expect(await MessageHandler.prototype.hasActiveGoal.call(receiver, id)).toBe(false);
      expect(await backend.readLatestGoal?.()).toMatchObject({ threadId: 'g', status: 'cleared' });
    } finally {
      full.mockRestore();
      doc.mirror?.dispose();
    }
  });

  it('limits targeted callbacks, preserves old tool ownership, and creates missing targets', async () => {
    const id = 'synthetic-targeted' as SessionId;
    const loro = new LoroDoc();
    const doc = new SessionDocument({} as never, id, async () => {}, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    // The production storage entry (control-plane Mirror + one shared writer).
    composeTestSessionDoc(doc, { doc: loro });
    const backend = await createSessionBackend(doc, { historyBackend: 'loro' });
    const writer = createHistoryWriter(loro);
    try {
      writer.append({
        id: 'older',
        role: 'assistant',
        timestamp: 'synthetic',
        items: [{ type: 'tool_call', toolCallId: 'old-tool', status: 'in_progress' }],
      });
      writer.append({
        id: 'target',
        role: 'assistant',
        timestamp: 'synthetic',
        items: [],
      });
      await doc.sessionData.commands.applyHistoryAction({
        kind: 'assistant-items',
        mode: 'replace',
        turnId: 'target',
        items: [{ type: 'text', text: 'start' }],
      });
      const notify = (update: unknown) =>
        parseSessionNotification({ sessionId: 'synthetic-acp', update });
      await appendACPNotificationsToAssistantEntry(
        doc,
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' next' } }),
        'target',
        { backend }
      );
      expect(writer.read('target')?.items).toEqual([{ type: 'text', text: 'start next' }]);
      await appendACPNotificationsToAssistantEntry(
        doc,
        notify({ sessionUpdate: 'tool_call_update', toolCallId: 'old-tool', status: 'completed' }),
        'target',
        { backend }
      );
      expect(writer.read('older')?.items?.[0]).toMatchObject({
        toolCallId: 'old-tool',
        status: 'completed',
      });
      expect(writer.read('target')?.items).toHaveLength(1);
      await appendACPNotificationsToAssistantEntry(
        doc,
        notify({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'created' },
        }),
        'new-target',
        { backend }
      );
      expect(writer.read('new-target')?.items).toEqual([{ type: 'text', text: 'created' }]);
      const version = loro.version().toJSON();
      await expect(
        doc.sessionData.commands.applyHistoryAction({
          kind: 'assistant-items',
          mode: 'replace',
          turnId: 'target',
          items: [{ type: 'text', text: 42 } as never],
        })
      ).rejects.toThrow('Invalid history write');
      expect(loro.version().toJSON()).toEqual(version);
    } finally {
      doc.mirror?.dispose();
    }
  });
});
