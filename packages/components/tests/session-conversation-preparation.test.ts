import { describe, expect, it } from 'vitest';
import { resolveSessionConversationPreparationState } from '../src/lib/session-conversation-preparation';

describe('resolveSessionConversationPreparationState', () => {
  it('allows the prepared surface to open as soon as fork history is locally available', () => {
    expect(
      resolveSessionConversationPreparationState({
        docReady: true,
        historyLength: 4,
        syncState: 'syncing',
      })
    ).toBe('ready');
  });

  it('keeps waiting when the first sync completes before fork history propagates', () => {
    expect(
      resolveSessionConversationPreparationState({
        docReady: true,
        historyLength: 0,
        syncState: 'synced',
      })
    ).toBe('waiting');
  });
});
