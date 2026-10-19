import { describe, expect, it } from 'vitest';
import { fromApplicationJson, type HistoryProjectedMessage } from '@loro-dev/roost/lody-history';
import { adaptRoostProjectedMessage } from '../src/session/roost-history-port';

describe('local Roost release-candidate binding', () => {
  it('converts Roost lossless JSON into the Lody port DTO', () => {
    const row: HistoryProjectedMessage = {
      businessId: 'assistant-1',
      segmentId: 'primary',
      turnId: new Uint8Array(16),
      content: fromApplicationJson({
        id: 'storage-id-must-not-win',
        role: 'assistant',
        timestamp: '2026-10-03T00:00:01.000Z',
        items: [{ type: 'text', text: 'hello' }],
      }),
      nextSeq: 1n,
      sealed: true,
    };

    expect(adaptRoostProjectedMessage(row)).toEqual({
      businessId: 'assistant-1',
      segmentId: 'primary',
      content: {
        id: 'storage-id-must-not-win',
        role: 'assistant',
        timestamp: '2026-10-03T00:00:01.000Z',
        items: [{ type: 'text', text: 'hello' }],
      },
      nextSeq: 1n,
      sealed: true,
    });
  });
});
