// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { describe, expect, it } from 'vitest';
import { getSessionRoomId, type SessionId, type SessionMeta, type WorkspaceId } from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { setWorkspaceContextAtom } from '../src/atoms/workspace-context';
import { useSessionPromptSuggestion } from '../src/hooks/use-session-prompt-suggestion';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('session prompt suggestion subscription', () => {
  it('never renders the previous session or workspace suggestion while subscriptions change', async () => {
    const store = createStore();
    const callbacks = new Map<string, (value: string | null) => void>();
    const runtime = { workspaceSlug: 'workspace', workspaceId: 'workspace' as WorkspaceId,
      subscribePromptSuggestion: (_machine: string, session: string, listener: (value: string | null) => void) => {
        callbacks.set(session, listener);
        listener(session === 'first' ? 'First hint' : null);
        return () => { callbacks.delete(session); };
      },
    } as WorkspaceRuntime;
    store.set(runtimeAtom, runtime);
    store.set(setWorkspaceContextAtom, { slug: 'workspace', workspaceId: runtime.workspaceId });
    store.set(sessionMetaCacheAtom, Object.fromEntries(['first', 'second'].map((id) => [getSessionRoomId(id as SessionId), { machineId: 'machine' } as SessionMeta])));
    const host = document.createElement('div');
    const root = createRoot(host);
    function Probe({ sessionId }: { sessionId: SessionId }) {
      const suggestion = useSessionPromptSuggestion(sessionId);
      return createElement('span', null, suggestion ?? 'none');
    }
    const render = (sessionId: string) => act(async () => root.render(createElement(Provider, { store }, createElement(Probe, { sessionId: sessionId as SessionId }))));
    try {
      await render('first');
      expect(host.textContent).toBe('First hint');
      await render('second');
      expect(host.textContent).toBe('none');
      expect(callbacks.has('first')).toBe(false);
      await act(async () => callbacks.get('second')?.('Second hint'));
      expect(host.textContent).toBe('Second hint');
      await act(async () => store.set(setWorkspaceContextAtom, { slug: 'different', workspaceId: 'different' as WorkspaceId }));
      expect(host.textContent).toBe('none');
      expect(callbacks.size).toBe(0);
    } finally { await act(async () => root.unmount()); }
  });
});
