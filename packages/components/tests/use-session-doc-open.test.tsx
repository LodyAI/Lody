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
import { useSessionDoc } from '../src/hooks/use-session-doc';
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

async function openStore(turns = 3): Promise<SessionDocStore> {
  const view = await openReaderView(reimport(buildSessionDoc(buildFixtureHistory(turns))), {
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

function renderSessionDoc(runtime: Partial<WorkspaceRuntime>) {
  const store = createStore();
  store.set(runtimeAtom, {
    workspaceId: 'workspace-id',
    workspaceSlug: 'workspace-slug',
    ...runtime,
  } as WorkspaceRuntime);
  expect(store.get(activeWorkspaceRuntimeAtom)).not.toBeNull();
  const commits: { ready: boolean; turns: number }[] = [];
  function Probe() {
    const { ready, history } = useSessionDoc(FIXTURE_SESSION_ID);
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
  it('reacquires the published body owner and does not replace it with a late legacy acquisition', async () => {
    const legacy = await openStore(3);
    const native = await openStore(1);
    let current = legacy;
    let epoch = 0;
    let releaseLegacy!: (store: SessionDocStore) => void;
    const pendingLegacy = new Promise<SessionDocStore>((resolve) => {
      releaseLegacy = resolve;
    });
    const listeners = new Set<() => void>();
    const released: SessionDocStore[] = [];
    const commits = renderSessionDoc({
      peekSessionStore: () => current,
      acquireSessionStore: () => (current === legacy ? pendingLegacy : Promise.resolve(current)),
      releaseSessionStoreRef: (_id, store) => {
        if (store) released.push(store);
      },
      getSessionStoreEpoch: () => epoch,
      subscribeSessionStoreEpoch: (_id, listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    expect(commits.at(-1)).toEqual({ ready: true, turns: legacy.history.turnCount });
    await act(async () => {
      current = native;
      epoch++;
      for (const listener of listeners) listener();
    });
    expect(commits.at(-1)).toEqual({ ready: true, turns: native.history.turnCount });
    await act(async () => releaseLegacy(legacy));
    expect(commits.at(-1)).toEqual({ ready: true, turns: native.history.turnCount });
    expect(released).toEqual([legacy]);
  });

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
