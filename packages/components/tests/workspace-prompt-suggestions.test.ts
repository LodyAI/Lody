import { describe, expect, it } from 'vitest';
import {
  PromptSuggestionStore,
  bytesToBase64,
  type MachineId,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import type { LocalLoroDataPlaneServerMessage } from '@lody/shared';
import { WorkspacePromptSuggestions } from '../src/providers/workspace-prompt-suggestions';

describe('workspace prompt suggestions', () => {
  it('routes by machine, retains the latest text across subscriptions, and ignores other workspaces', async () => {
    const listeners = new Set<(message: LocalLoroDataPlaneServerMessage) => void>();
    const source = new PromptSuggestionStore();
    const suggestions = new WorkspacePromptSuggestions({
      workspaceId: 'workspace' as WorkspaceId,
      resolvePlane: () => 'local',
    });
    suggestions.attachLocal({
      onMessage: (fn) => {
        listeners.add(fn);
        return () => listeners.delete(fn);
      },
    } as never);
    const seen: (string | null)[] = [];
    const unsubscribe = suggestions.subscribeSession(
      'machine' as MachineId,
      'session' as SessionId,
      (text) => seen.push(text)
    );
    const send = (workspaceId = 'workspace') => {
      for (const listener of listeners)
        listener({
          type: 'prompt-suggestions',
          protocolVersion: 7,
          workspaceId,
          dataBase64: bytesToBase64(source.encode()),
        });
    };
    try {
      source.publish('machine', {
        sessionId: 'session',
        result: { type: 'completed', text: 'Try tests' },
      });
      send('elsewhere');
      expect(seen).toEqual([null]);
      send();
      expect(seen.at(-1)).toBe('Try tests');
      unsubscribe();
      const late: (string | null)[] = [];
      const release = suggestions.subscribeSession(
        'machine' as MachineId,
        'session' as SessionId,
        (text) => late.push(text)
      );
      expect(late).toEqual(['Try tests']);
      source.publish('machine', { sessionId: 'session', result: { type: 'failed' } });
      send();
      expect(late.at(-1)).toBeNull();
      release();
    } finally {
      unsubscribe();
      suggestions.detachLocal();
      await suggestions.stop();
      source.destroy();
    }
    expect(listeners.size).toBe(0);
  });
});
