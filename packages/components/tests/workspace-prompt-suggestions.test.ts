import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EphemeralRoomTransportLike } from '../src/providers/ephemeral-room-transport';
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T00:00:00Z'));
  });
  afterEach(() => vi.useRealTimers());
  it('delivers the cloud bootstrap snapshot and never falls back across target planes', async () => {
    const source = new PromptSuggestionStore();
    source.publish('machine', {
      sessionId: 'session',
      result: { type: 'completed', text: 'Cloud hint' },
    });
    class CloudSuggestions extends WorkspacePromptSuggestions {
      protected override createStore() {
        const store = super.createStore();
        store.apply(source.encode());
        return store;
      }
      protected override createTransport(): EphemeralRoomTransportLike {
        return {
          join: async (options) => {
            options?.onStatusChange?.('joined');
            return { ok: true, value: { unsubscribe: () => {} } } as Awaited<
              ReturnType<EphemeralRoomTransportLike['join']>
            >;
          },
          close: async () => {},
        };
      }
    }
    let plane: 'local' | 'cloud' | null = 'cloud';
    const suggestions = new CloudSuggestions({
      workspaceId: 'workspace' as WorkspaceId,
      resolvePlane: () => plane,
    });
    const seen: (string | null)[] = [];
    const release = suggestions.subscribeSession(
      'machine' as MachineId,
      'session' as SessionId,
      (text) => seen.push(text)
    );
    try {
      expect(seen.at(-1)).toBeNull();
      suggestions.start({ baseUrl: 'https://example.test', auth: async () => 'test' });
      expect(seen.at(-1)).toBe('Cloud hint');
      plane = 'local';
      suggestions.refreshRoutes();
      expect(seen.at(-1)).toBeNull();
      plane = null;
      suggestions.refreshRoutes();
      expect(seen.at(-1)).toBeNull();
      plane = 'cloud';
      suggestions.refreshRoutes();
      expect(seen.at(-1)).toBe('Cloud hint');
    } finally {
      release();
      await suggestions.stop();
      source.destroy();
    }
  });

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
      vi.setSystemTime(new Date('2026-10-28T00:00:01Z'));
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
