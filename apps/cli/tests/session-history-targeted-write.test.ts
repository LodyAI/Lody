import { describe, expect, it, vi } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createHistoryWriter, parseSessionNotification, type SessionId } from '@lody/shared';
import { SessionDocument } from '../src/lib/loro/doc';
import { composeTestSessionDoc } from './session-doc-fixture';
import { appendACPNotificationsToAssistantEntry } from '../src/lib/acp/history';
import { createSessionBackend } from '../src/session/session-backend';

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
