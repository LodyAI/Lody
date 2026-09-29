// @vitest-environment jsdom

// The host is the only workspace surface of held (in-memory) sends: a new
// conversation's placeholder must survive until its written metadata is in the
// cache, a canceled one must vanish, and leaving the page must ask first while
// anything is held — that confirmation is the only protection held sends have.

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  getSessionRoomId,
  type SessionHistory,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import { SessionPendingSendsHost } from '../src/components/chat/session-pending-sends-host';
import { pendingSendSessionMetasAtom, sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import type { WorkspaceRuntime } from '../src/atoms/runtime';
import { sessionSendStatusesAtom } from '../src/atoms/session-send-status';
import { createPendingSessionSends } from '../src/lib/session-pending-sends';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'held-conversation' as SessionId;
const roomId = getSessionRoomId(sessionId);
const creation = {
  id: sessionId,
  machineId: 'machine-1',
  userId: 'user-1',
  createdAt: '2026-09-29T00:00:00.000Z',
  isArchived: false,
} as unknown as SessionMeta;
const entry = {
  id: 'held-turn',
  role: 'user',
  userId: 'user-1',
  timestamp: '2026-09-29T00:00:00.000Z',
  status: 'pending',
  items: [],
  fileDiff: [],
} as unknown as SessionHistory;

function harness() {
  const metas = new Map<string, SessionMeta>();
  const preparation = Promise.withResolvers<void>();
  const pendingSends = createPendingSessionSends({
    prepare: async (send, signal) => {
      await new Promise<void>((resolve, reject) => {
        preparation.promise.then(resolve, reject);
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });
      return { entry: send.entry, queue: send.queue, attachments: [] };
    },
    // The write this host observes is the creation metadata reaching the repo.
    write: async (send) => {
      if (send.creation) metas.set(getSessionRoomId(send.sessionId), send.creation);
    },
    deliver: async () => {},
  });
  const runtime = {
    workspaceId: 'workspace-1' as WorkspaceId,
    pendingSends,
    repo: { getDocMeta: async (id: string) => (metas.has(id) ? { meta: metas.get(id) } : undefined) },
  } as unknown as WorkspaceRuntime;
  const hold = () =>
    pendingSends.enqueue({
      id: entry.id,
      sessionId,
      workspaceId: 'workspace-1',
      entry,
      delivery: { kind: 'dispatch' },
      creation,
      attachments: [
        { id: 'a', kind: 'image', source: new Blob(['x']), name: 'a.png', mimeType: 'image/png', lastModified: 0 },
      ],
    });
  return { runtime, pendingSends, preparation, hold };
}

/** Resolves once the store holds no send for the conversation. */
const drained = (pendingSends: ReturnType<typeof harness>['pendingSends']) =>
  new Promise<void>((resolve) => {
    if (!pendingSends.hasSession(sessionId)) return resolve();
    const stop = pendingSends.subscribe(() => {
      if (pendingSends.hasSession(sessionId)) return;
      stop();
      resolve();
    });
  });

describe('SessionPendingSendsHost', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;
  const store = createStore();

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    store.set(pendingSendSessionMetasAtom, {});
    store.set(sessionMetaCacheAtom, {});
    store.set(sessionSendStatusesAtom, {});
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  const mount = async (runtime: WorkspaceRuntime) =>
    act(async () => {
      root?.render(
        createElement(Provider, { store }, createElement(SessionPendingSendsHost, { runtime }))
      );
    });

  const leaving = () => {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  };

  it('shows a held creation as a placeholder and hands it to written metadata', async () => {
    const h = harness();
    await mount(h.runtime);
    await act(async () => h.hold());

    expect(store.get(pendingSendSessionMetasAtom)[roomId]).toMatchObject({ id: sessionId });
    expect(store.get(sessionSendStatusesAtom)[sessionId]).toMatchObject({
      state: 'sending',
      unsentNewConversation: true,
    });
    expect(leaving()).toBe(true);

    await act(async () => {
      h.preparation.resolve();
      await drained(h.pendingSends);
    });

    // The written meta is in the cache before the placeholder is dropped.
    expect(store.get(sessionMetaCacheAtom)[roomId]).toMatchObject({ id: sessionId });
    expect(store.get(pendingSendSessionMetasAtom)).toEqual({});
    expect(store.get(sessionSendStatusesAtom)).toEqual({});
    expect(leaving()).toBe(false);
  });

  it('drops a canceled creation without inventing metadata', async () => {
    const h = harness();
    await mount(h.runtime);
    await act(async () => h.hold());

    await act(async () => {
      await h.pendingSends.cancel(entry.id);
    });

    expect(store.get(pendingSendSessionMetasAtom)).toEqual({});
    expect(store.get(sessionMetaCacheAtom)[roomId]).toBeUndefined();
    expect(leaving()).toBe(false);
  });
});
