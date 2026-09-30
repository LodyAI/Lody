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

  it('starts unready when the store must still be opened', async () => {
    const open = await openStore();
    let finish!: (store: SessionDocStore) => void;
    const commits = renderSessionDoc({
      peekSessionStore: () => undefined,
      acquireSessionStore: () => new Promise<SessionDocStore>((resolve) => (finish = resolve)),
      releaseSessionStoreRef: () => {},
    });

    expect(commits.at(-1)).toEqual({ ready: false, turns: 0 });
    await act(async () => finish(open));
    expect(commits.at(-1)).toEqual({ ready: true, turns: open.history.turnCount });
  });
});
