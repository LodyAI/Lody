import { describe, expect, it } from 'vitest';
import {
  readPastedSessionLink,
  resolveSessionLinkWorkspace,
  watchSessionLinkRequest,
  pendingSessionLinkAtom,
  SESSION_LINK_LOAD_TIMEOUT_MS,
  isSessionLinkDestination,
} from '../src/lib/session-deep-link';
import { createStore } from 'jotai';
import { vi } from 'vitest';
import {
  buildAppSessionUrl,
  getAppSessionUrlOrigins,
  isPlainLinkPasteShortcut,
  parseAppSessionUrl,
} from '../src/lib/session-app-url';

describe('workspace-scoped resource links', () => {
  it('pastes compound links as the exact child, never as the parent', () => {
    expect(readPastedSessionLink('lody://session/root?workspace=ws&tab=child', 'ws')).toEqual({
      sessionId: 'child',
      workspaceId: 'ws',
    });
    expect(readPastedSessionLink('lody://session/root?workspace=other&tab=child', 'ws')).toBeNull();
  });
  it('expires missing resources and does not let old timers cancel newer requests', () => {
    vi.useFakeTimers();
    try {
      const store = createStore();
      const failures: string[] = [];
      const first = { sessionId: 'missing' };
      const second = { sessionId: 'waiting-child' };
      store.set(pendingSessionLinkAtom, first);
      const cancelFirst = watchSessionLinkRequest(store, first, () => failures.push('first'));
      vi.advanceTimersByTime(100);
      store.set(pendingSessionLinkAtom, second);
      const cancelSecond = watchSessionLinkRequest(store, second, () => failures.push('second'));
      vi.advanceTimersByTime(SESSION_LINK_LOAD_TIMEOUT_MS - 100);
      expect(store.get(pendingSessionLinkAtom)).toBe(second);
      expect(failures).toEqual([]);
      vi.advanceTimersByTime(100);
      expect(store.get(pendingSessionLinkAtom)).toBeNull();
      expect(failures).toEqual(['second']);
      cancelFirst();
      cancelSecond();
      store.set(pendingSessionLinkAtom, first);
      const cancel = watchSessionLinkRequest(store, first, () => failures.push('late'));
      store.set(pendingSessionLinkAtom, null); // Hydration succeeded or user left.
      cancel();
      vi.runAllTimers();
      expect(failures).toEqual(['second']);
    } finally {
      vi.useRealTimers();
    }
  });
  it('retains child-parent redirects but abandons a different tab or workspace', () => {
    const child = { sessionId: 'child' };
    expect(isSessionLinkDestination(child, 'ws', '/ws/sessions/parent', 'session:child')).toBe(
      true
    );
    expect(isSessionLinkDestination(child, 'ws', '/ws/sessions/parent', 'session:other')).toBe(
      false
    );
    expect(
      isSessionLinkDestination(child, 'ws', '/elsewhere/sessions/parent', 'session:child')
    ).toBe(false);
  });
  const target = { sessionId: 'session_1', workspaceId: 'workspace_1' };
  const directory = {
    status: 'ready' as const,
    activeWorkspaceId: 'workspace_2',
    workspaces: [
      { id: 'workspace_1', slug: 'renamed', name: 'One', role: 'owner' },
      { id: 'workspace_2', slug: 'other', name: 'Two', role: 'owner' },
    ],
  };
  it('waits for startup and resolves the explicit ID even when another workspace is active', () => {
    expect(resolveSessionLinkWorkspace(target, { status: 'loading' }, 'workspace_2')).toEqual({
      kind: 'wait',
    });
    expect(resolveSessionLinkWorkspace(target, directory, null)).toEqual({ kind: 'wait' });
    expect(resolveSessionLinkWorkspace(target, directory, 'workspace_2')).toEqual({
      kind: 'open',
      workspaceId: 'workspace_1',
      slug: 'renamed',
    });
  });
  it('never falls back to the current workspace when the link belongs elsewhere', () => {
    expect(
      resolveSessionLinkWorkspace({ ...target, workspaceId: 'missing' }, directory, 'workspace_2')
    ).toEqual({ kind: 'unavailable', workspaceId: 'missing' });
    expect(
      readPastedSessionLink('lody://session/session_1?workspace=workspace_1', 'workspace_2')
    ).toBeNull();
    expect(
      readPastedSessionLink('lody://session/session_1?workspace=workspace_1', 'workspace_1')
    ).toEqual(target);
  });
});

describe('parseAppSessionUrl', () => {
  const allowedOrigins = ['https://lody.ai', 'http://localhost:5173'];

  it('accepts a session URL on an allowed app origin', () => {
    expect(
      parseAppSessionUrl('https://lody.ai/acme/sessions/ses_abc123', { allowedOrigins })
    ).toEqual({
      url: 'https://lody.ai/acme/sessions/ses_abc123',
      workspaceSlug: 'acme',
      sessionId: 'ses_abc123',
    });
  });

  it('keeps search and hash on the normalized url', () => {
    expect(
      parseAppSessionUrl('http://localhost:5173/acme/sessions/ses_1?tab=session:ses_1#top', {
        allowedOrigins,
      })
    ).toEqual({
      url: 'http://localhost:5173/acme/sessions/ses_1?tab=session:ses_1#top',
      workspaceSlug: 'acme',
      sessionId: 'ses_1',
    });
  });

  it('rejects a foreign host even when the path looks like a session', () => {
    expect(
      parseAppSessionUrl('https://evil.example/acme/sessions/ses_abc123', { allowedOrigins })
    ).toBeNull();
  });

  it('rejects text that is not a lone URL', () => {
    expect(
      parseAppSessionUrl('see https://lody.ai/acme/sessions/ses_abc123 please', {
        allowedOrigins,
      })
    ).toBeNull();
  });

  it('rejects non-session app paths', () => {
    expect(parseAppSessionUrl('https://lody.ai/acme/settings', { allowedOrigins })).toBeNull();
  });
});

describe('isPlainLinkPasteShortcut', () => {
  it('detects Cmd/Ctrl+Shift+V', () => {
    expect(isPlainLinkPasteShortcut({ shiftKey: true, metaKey: true, ctrlKey: false })).toBe(true);
    expect(isPlainLinkPasteShortcut({ shiftKey: true, metaKey: false, ctrlKey: true })).toBe(true);
    expect(isPlainLinkPasteShortcut({ shiftKey: false, metaKey: true, ctrlKey: false })).toBe(
      false
    );
  });
});

describe('getAppSessionUrlOrigins / buildAppSessionUrl', () => {
  it('dedupes page and share origins', () => {
    expect(
      getAppSessionUrlOrigins({
        pageOrigin: 'http://localhost:5173/',
        shareOrigin: 'http://localhost:5173',
      })
    ).toEqual(['http://localhost:5173']);
  });

  it('builds a share URL for a workspace session', () => {
    expect(buildAppSessionUrl('acme', 'ses_1')).toMatch(/\/acme\/sessions\/ses_1$/);
  });
});
