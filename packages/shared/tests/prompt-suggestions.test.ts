import { describe, expect, it } from 'vitest';
import { EphemeralStore } from 'loro-crdt';
import {
  PromptSuggestionStore,
  readPromptSuggestion,
  PROMPT_SUGGESTION_TTL_MS,
} from '../src/prompt-suggestions';

describe('session prompt suggestion state', () => {
  it('isolates machine/session identity and replaces text with explicit empty or failed results', () => {
    const source = new PromptSuggestionStore();
    const peer = new EphemeralStore(PROMPT_SUGGESTION_TTL_MS);
    try {
      source.publish('machine-a', {
        sessionId: 'session-a',
        result: { type: 'completed', text: '  hello\nworld ' },
      });
      source.publish('machine-a', {
        sessionId: 'session-b',
        result: { type: 'completed', text: 'other' },
      });
      peer.apply(source.encode());
      expect(readPromptSuggestion(peer.getAllStates(), 'machine-a', 'session-a')).toBe(
        '  hello\nworld '
      );
      expect(readPromptSuggestion(peer.getAllStates(), 'machine-b', 'session-a')).toBeNull();
      for (const result of [
        { type: 'completed', text: null },
        { type: 'completed', text: '' },
        { type: 'failed' },
      ] as const) {
        source.publish('machine-a', { sessionId: 'session-a', result });
        peer.apply(source.encode());
        expect(readPromptSuggestion(peer.getAllStates(), 'machine-a', 'session-a')).toBeNull();
        expect(readPromptSuggestion(peer.getAllStates(), 'machine-a', 'session-b')).toBe('other');
      }
    } finally {
      source.destroy();
      peer.destroy();
    }
  });
  it('drops malformed or oversized payloads without replacing a good suggestion', () => {
    const source = new PromptSuggestionStore();
    try {
      source.publish('machine', { sessionId: 's', result: { type: 'completed', text: 'good' } });
      source.publish('machine', {
        sessionId: 's',
        result: { type: 'completed', text: 'x'.repeat(20000) },
      });
      expect(readPromptSuggestion(source.store.getAllStates(), 'machine', 's')).toBe('good');
      expect(
        readPromptSuggestion({ broken: { sessionId: 's', machineId: 'machine' } }, 'machine', 's')
      ).toBeNull();
    } finally {
      source.destroy();
    }
  });
});
