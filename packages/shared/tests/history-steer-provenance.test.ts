import { describe, expect, it } from 'vitest';
import { LoroDoc } from 'loro-crdt';
import { createSessionMirror } from '../src/session-mirror';
import { normalizeSessionTurnInputConfig } from '../src/message-schemas';
import type { SessionHistoryInput } from '../src/schema';
import type { SessionId } from '../src/ids';

const entry = (): SessionHistoryInput => ({
  id: 'guide',
  role: 'user',
  timestamp: '2026-01-01',
  status: 'processing',
  read: true,
  items: [{ type: 'text', text: 'synthetic guide' }],
  inputConfig: { prompt: 'synthetic guide', _lodyDeliveryKind: 'steer' },
});

describe('stored steer provenance', () => {
  it('persists new provenance and keeps it readable after peer import', () => {
    const doc = new LoroDoc();
    const mirror = createSessionMirror({
      doc,
      initialState: { session: { id: 'synthetic' as SessionId }, history: [] },
    });
    try {
      mirror.historyWriter.append(entry());
      const peer = new LoroDoc();
      peer.import(doc.export({ mode: 'snapshot' }));
      const stored = peer.getList('history').toJSON()[0];
      expect(stored.inputConfig._lodyDeliveryKind).toBe('steer');
      expect(normalizeSessionTurnInputConfig(stored.inputConfig)?._lodyDeliveryKind).toBe('steer');
    } finally {
      mirror.dispose();
    }
  });
});
