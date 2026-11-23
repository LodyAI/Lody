// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomSyncState } from '../src/lib/room-sync-state';
import {
  runtimeAtom,
  type SessionDocState,
  type SessionDocStore,
  type WorkspaceRuntime,
} from '../src/atoms/runtime';
import { activeWorkspaceRuntimeAtom } from '../src/atoms/runtime';
import {
  SESSION_RECEIVE_REVALIDATE_DEBOUNCE_MS,
  useSessionDoc,
  type UseSessionDocOptions,
} from '../src/hooks/use-session-doc';
import type { ConversationView } from '../src/lib/conversation-view';
import {
  FIXTURE_SESSION_ID,
  buildFixtureHistory,
  buildSessionDoc,
  reimport,
} from './conversation-view-fixtures';
import { openReaderView } from './conversation-view-fixtures';

let root: Root;
let container: HTMLDivElement;
const views: ConversationView[] = [];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  for (const view of views.splice(0)) view.dispose();
  container.remove();
  vi.unstubAllGlobals();
});

async function openStore(): Promise<SessionDocStore> {
  const view = await openReaderView(reimport(buildSessionDoc(buildFixtureHistory(3))), {
    sessionId: FIXTURE_SESSION_ID,
  });
  views.push(view);
  const state = { session: { id: FIXTURE_SESSION_ID }, mq: [] } as unknown as SessionDocState;
  return {
    sessionId: FIXTURE_SESSION_ID,
    history: view,
    getState: () => state,
    getSyncState: (): RoomSyncState => 'synced',
    subscribe: () => () => {},
    subscribeSyncState: () => () => {},
    acquireSync: () => () => {},
  } as unknown as SessionDocStore;
}

function renderSessionDoc(runtime: Partial<WorkspaceRuntime>, options: UseSessionDocOptions = {}) {
  const store = createStore();
  store.set(runtimeAtom, {
    workspaceId: 'workspace-id',
    workspaceSlug: 'workspace-slug',
    ...runtime,
  } as WorkspaceRuntime);
  expect(store.get(activeWorkspaceRuntimeAtom)).not.toBeNull();
  const commits: { ready: boolean; turns: number }[] = [];
  function Probe() {
    const { ready, history } = useSessionDoc(FIXTURE_SESSION_ID, options);
    commits.push({ ready, turns: history?.turnCount ?? 0 });
    return null;
  }
  act(() => {
    root.render(
      <Provider store={store}>
        <Probe />
      </Provider>
    );
  });
  return commits;
}

describe('useSessionDoc opening', () => {
  it('renders an already-open store in its first commit', async () => {
    const open = await openStore();
    let acquired = 0;
    const commits = renderSessionDoc({
      peekSessionStore: (id) => (id === FIXTURE_SESSION_ID ? open : undefined),
      acquireSessionStore: async () => {
        acquired += 1;
        return open;
      },
      releaseSessionStoreRef: () => {},
    });

    expect(commits[0]).toEqual({ ready: true, turns: open.history.turnCount });
    expect(commits.every((commit) => commit.ready)).toBe(true);
    // The first render only reads; the effect still takes the reference.
    await act(async () => {});
    expect(acquired).toBe(1);
  });
});

describe('useSessionDoc wake revalidation', () => {
  const setVisibility = (state: DocumentVisibilityState) => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
    document.dispatchEvent(new Event('visibilitychange'));
  };

  afterEach(() => {
    Reflect.deleteProperty(document, 'visibilityState');
    vi.useRealTimers();
  });

  it('revalidates the conversation on screen once per wake burst and never while hidden', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const open = await openStore();
    const revalidations: string[] = [];
    const store = {
      ...open,
      revalidateReceive: () => revalidations.push(open.sessionId),
    } as SessionDocStore;
    const runtime: Partial<WorkspaceRuntime> = {
      peekSessionStore: () => store,
      acquireSessionStore: async () => store,
      releaseSessionStoreRef: () => {},
    };
    renderSessionDoc(runtime, { revalidateOnWake: true });
    await act(async () => {});

    setVisibility('hidden');
    setVisibility('visible');
    setVisibility('hidden');
    setVisibility('visible');
    vi.advanceTimersByTime(SESSION_RECEIVE_REVALIDATE_DEBOUNCE_MS - 1);
    expect(revalidations).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(revalidations).toEqual([FIXTURE_SESSION_ID]);

    setVisibility('visible');
    setVisibility('hidden');
    vi.advanceTimersByTime(SESSION_RECEIVE_REVALIDATE_DEBOUNCE_MS);
    expect(revalidations).toEqual([FIXTURE_SESSION_ID]);
  });

  it('leaves conversations that are not on screen alone on wake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const open = await openStore();
    const revalidations: string[] = [];
    const store = {
      ...open,
      revalidateReceive: () => revalidations.push(open.sessionId),
    } as SessionDocStore;
    renderSessionDoc({
      peekSessionStore: () => store,
      acquireSessionStore: async () => store,
      releaseSessionStoreRef: () => {},
    });
    await act(async () => {});

    setVisibility('visible');
    vi.advanceTimersByTime(SESSION_RECEIVE_REVALIDATE_DEBOUNCE_MS);
    expect(revalidations).toEqual([]);
  });
});
