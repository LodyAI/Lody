import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createSessionMirror, parseSessionNotification, type SessionId } from '@lody/shared';
import { SessionDocument } from '../src/lib/loro/doc';
import { appendACPNotificationsToAssistantEntry } from '../src/lib/acp/history';

describe('targeted history writes', () => {
  it('limits targeted callbacks, preserves old tool ownership, and creates missing targets', async () => {
    const id = 'synthetic-targeted' as SessionId;
    const loro = new LoroDoc();
    const doc = new SessionDocument({} as never, id, async () => {}, {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never);
    const mirror = createSessionMirror({
      doc: loro,
      initialState: { session: { id }, history: [] },
    });
    doc.mirror = mirror;
    try {
      mirror.historyWriter.append({
        id: 'older',
        role: 'assistant',
        timestamp: 'synthetic',
        items: [{ type: 'tool_call', toolCallId: 'old-tool', status: 'in_progress' }],
      });
      mirror.historyWriter.append({
        id: 'target',
        role: 'assistant',
        timestamp: 'synthetic',
        items: [],
      });
      await doc.updateHistory(
        (history) => {
          expect(history.map((entry) => entry.id)).toEqual(['target']);
          history[0]!.items = [{ type: 'text', text: 'start' }];
          return history;
        },
        { onlyEntryId: 'target' }
      );
      const notify = (update: unknown) =>
        parseSessionNotification({ sessionId: 'synthetic-acp', update });
      await appendACPNotificationsToAssistantEntry(
        doc,
        notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' next' } }),
        'target'
      );
      expect(mirror.historyWriter.read('target')?.items).toEqual([
        { type: 'text', text: 'start next' },
      ]);
      await appendACPNotificationsToAssistantEntry(
        doc,
        notify({ sessionUpdate: 'tool_call_update', toolCallId: 'old-tool', status: 'completed' }),
        'target'
      );
      expect(mirror.historyWriter.read('older')?.items?.[0]).toMatchObject({
        toolCallId: 'old-tool',
        status: 'completed',
      });
      expect(mirror.historyWriter.read('target')?.items).toHaveLength(1);
      await appendACPNotificationsToAssistantEntry(
        doc,
        notify({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'created' },
        }),
        'new-target'
      );
      expect(mirror.historyWriter.read('new-target')?.items).toEqual([
        { type: 'text', text: 'created' },
      ]);
      const version = loro.version().toJSON();
      await expect(doc.updateHistory(() => [], { onlyEntryId: 'target' })).rejects.toThrow(
        'invalid_targeted_update'
      );
      expect(loro.version().toJSON()).toEqual(version);
    } finally {
      mirror.dispose();
    }
  });
});
