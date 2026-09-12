import { describe, expect, it } from 'vitest';
import { conversationCopyRange } from '../src/lib/conversation-copy-range';

describe('conversationCopyRange', () => {
  const history = [{ id: 'user' }, { id: 'assistant' }, { id: 'later' }];
  it('includes the selected user or assistant and excludes all later messages', () => {
    expect(conversationCopyRange(history, 'user')).toEqual([history[0]]);
    expect(conversationCopyRange(history, 'assistant')).toEqual(history.slice(0, 2));
    expect(conversationCopyRange(history)).toEqual(history);
  });
  it('does not silently copy everything when the boundary is missing', () => {
    expect(() => conversationCopyRange(history, 'deleted')).toThrow();
  });
});
