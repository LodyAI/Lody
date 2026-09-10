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

  it('rejects invalid new or updated provenance without changing stored values', () => {
    const doc = new LoroDoc();
    const mirror = createSessionMirror({
      doc,
      initialState: { session: { id: 'synthetic' as SessionId }, history: [] },
    });
    try {
      mirror.historyWriter.append(entry());
      const before = doc.getList('history').toJSON();
      const version = doc.version().toJSON();
      for (const marker of ['normal', 42, null]) {
        const malformed = {
          ...entry(),
          inputConfig: { prompt: 'must not land', _lodyDeliveryKind: marker },
        } as unknown as SessionHistoryInput;
        expect(() => mirror.historyWriter.replace('guide', malformed)).toThrow(
          'Invalid history write'
        );
        expect(() => mirror.historyWriter.append({ ...malformed, id: 'new' })).toThrow(
          'Invalid history write'
        );
        expect(doc.getList('history').toJSON()).toEqual(before);
        expect(doc.version().toJSON()).toEqual(version);
      }
    } finally {
      mirror.dispose();
    }
  });

  it('only projects the known marker from historical configs', () => {
    expect(normalizeSessionTurnInputConfig({ _lodyDeliveryKind: 'steer' })).toEqual({
      _lodyDeliveryKind: 'steer',
    });
    for (const marker of ['normal', 42, null])
      expect(
        normalizeSessionTurnInputConfig({ prompt: 'valid', _lodyDeliveryKind: marker })
      ).toEqual({
        prompt: 'valid',
      });
  });
});
