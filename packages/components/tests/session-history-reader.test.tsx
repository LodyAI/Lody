// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStaticStore, type PlatformProvider } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  getSessionRoomId,
  type SessionHistory,
  type SessionId,
  type WorkspaceId,
} from '@lody/shared';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { userAtom } from '../src/atoms';
import { currentWorkspaceIdAtom, currentWorkspaceSlugAtom } from '../src/atoms/workspace-context';
import { workspaceContentModeAtom } from '../src/atoms/workspace-content-mode';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { createConversationViewFromHistory } from '../src/lib/conversation-view/create-conversation-view-from-history';
import { SessionHistoryReader } from '../src/components/sessions/session-history-reader';
import { initI18n } from '../src/i18n';
import { TEST_CLOUD_PLATFORM } from './test-platform';

vi.mock('@tanstack/react-router', () => ({ useRouter: () => ({ navigate: async () => {} }) }));
// The browser story exercises the real windowed renderer; these tests exercise the
// connected reader and real C1 export gate without a jsdom virtual viewport.
vi.mock('../src/components/ai-gui', () => ({
  default: ({ sessionId }: { sessionId: string }) => <div data-history-stream={sessionId} />,
}));
vi.mock('../src/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'owner-history' as SessionId;
const workspaceId = 'encrypted-team' as WorkspaceId;
const history: SessionHistory[] = [
  {
    id: 'question',
    role: 'user',
    timestamp: '2026-10-01T00:00:00Z',
    fileDiff: [],
    items: [{ type: 'text', text: 'Original historical question.' }],
  },
  {
    id: 'answer',
    role: 'assistant',
    timestamp: '2026-10-01T00:00:01Z',
    fileDiff: [],
    finished: true,
    items: [{ type: 'text', text: 'The complete historical answer.' }],
  },
];
let root: Root, container: HTMLDivElement;
let store: ReturnType<typeof createStore>;
let view: ReturnType<typeof createConversationViewFromHistory>;
const writes: string[] = [];
let machineOperations = 0;
let activeReaders = 0;
let documentAcquisitions = 0;
let syncState: 'syncing' | 'synced' = 'synced';
const syncListeners = new Set<(state: typeof syncState) => void>();
const platform: PlatformProvider = {
  ...TEST_CLOUD_PLATFORM,
  identity: {
    ...TEST_CLOUD_PLATFORM.identity,
    session: createStaticStore({ status: 'authenticated', user: { id: 'member' } }),
  },
};
beforeEach(async () => {
  await initI18n('en');
  writes.length = 0;
  machineOperations = 0;
  activeReaders = 0;
  documentAcquisitions = 0;
  syncState = 'synced';
  syncListeners.clear();
  view = createConversationViewFromHistory({
    sessionId,
    getHistory: () => history,
    subscribe: () => () => {},
  });
  const state = { session: { id: sessionId }, mq: [] };
  const sessionStore = {
    doc: {},
    get history() {
      return view;
    },
    getState: () => state,
    getSyncState: () => syncState,
    subscribe: () => () => {},
    subscribeSyncState: (listener: (next: typeof syncState) => void) => {
      syncListeners.add(listener);
      return () => {
        syncListeners.delete(listener);
      };
    },
    acquireSync: () => () => {},
  };
  store = createStore();
  store.set(userAtom, { id: 'member' } as never);
  store.set(currentWorkspaceIdAtom, workspaceId);
  store.set(currentWorkspaceSlugAtom, 'encrypted-team');
  store.set(workspaceContentModeAtom, {
    accountId: 'member',
    workspaceId,
    workspaceSlug: 'encrypted-team',
    descriptor: {
      workspaceId,
      contentMode: 'e2ee',
      contentModeVersion: 1,
      genesisHash: '11'.repeat(32),
    },
  } as never);
  store.set(runtimeAtom, {
    workspaceId,
    workspaceSlug: 'encrypted-team',
    accountId: 'member',
    contentMode: 'e2ee',
    peekSessionStore: () => sessionStore,
    acquireSessionStore: async () => {
      activeReaders++;
      documentAcquisitions++;
      return sessionStore;
    },
    releaseSessionStoreRef: () => {
      activeReaders--;
    },
    withSessionStore: async (_id: SessionId, read: (source: typeof sessionStore) => unknown) => {
      activeReaders++;
      try {
        return await read(sessionStore);
      } finally {
        activeReaders--;
      }
    },
    waitForContentAdmission: async () => {},
    rpc: {
      call: () => {
        machineOperations++;
        throw new Error('History must not send a machine RPC');
      },
    },
  } as unknown as WorkspaceRuntime);
  store.set(sessionMetaCacheAtom, {
    [getSessionRoomId(sessionId)]: {
      id: sessionId,
      machineId: 'unshared-owner-machine',
      userId: 'owner',
      title: 'Prior conversation',
      cliType: 'builtin',
      agentType: 'codex',
      createdAt: '2026-10-01T00:00:00Z',
    } as never,
  });
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text: string) => {
        writes.push(text);
      },
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  expect(activeReaders).toBe(0);
  container.remove();
  view.dispose();
  delete window.__LODY_ELECTRON__;
  delete window.__LODY_PLATFORM__;
});
async function render(onBack?: () => void) {
  await act(async () =>
    root.render(
      <PlatformContext.Provider value={platform}>
        <Provider store={store}>
          <SessionHistoryReader
            rootSessionId={sessionId}
            sessionId={sessionId}
            onMobileBack={onBack}
          />
        </Provider>
      </PlatformContext.Provider>
    )
  );
}
async function selectCopy() {
  await act(async () =>
    document.querySelector<HTMLButtonElement>('button[aria-label="More actions"]')!.click()
  );
  const trigger = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (x) => x.textContent === 'Copy'
  )!;
  await act(async () => {
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await act(async () =>
    [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .find((x) => x.textContent === 'Copy as Markdown')!
      .click()
  );
}

it('reads history without a composer or machine operation and requires explicit consent for copying', async () => {
  await render();
  expect(container.textContent).toContain('Prior conversation');
  expect(container.querySelector('[role="status"]')?.textContent).toContain('Read-only history');
  expect(container.querySelector('textarea, input, [contenteditable="true"]')).toBeNull();
  expect(
    container
      .querySelector('[data-window-session-ready]')
      ?.getAttribute('data-window-session-ready')
  ).toBe(sessionId);
  await selectCopy();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(writes).toEqual([]);
  await act(async () =>
    [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find((x) => x.textContent === 'Create decrypted copy')!
      .click()
  );
  expect(writes).toHaveLength(1);
  expect(writes[0]).toContain('Original historical question.');
  expect(writes[0]).toContain('The complete historical answer.');
  expect(machineOperations).toBe(0);
});

it('keeps the history menu, export consent and back navigation working in an Electron window', async () => {
  window.__LODY_ELECTRON__ = true;
  window.__LODY_PLATFORM__ = { os: 'darwin', homeDir: '/Users/test' };
  let returned = false;
  await render(() => {
    returned = true;
  });
  await selectCopy();
  expect(document.querySelector('[role="alertdialog"]')).not.toBeNull();
  expect(writes).toEqual([]); // Opening the menu still grants no decrypted export.
  const cancel = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (button) => button.textContent === 'Cancel'
  )!;
  await act(async () => cancel.click());
  await act(async () =>
    container.querySelector<HTMLButtonElement>('button[aria-label="Back"]')!.click()
  );
  expect(returned).toBe(true);
  expect(container.textContent).toContain('Prior conversation');
  expect(machineOperations).toBe(0);
});

it('does not display a view retained from another runtime or export after an account change', async () => {
  await render();
  await selectCopy();
  await act(async () => {
    store.set(userAtom, { id: 'other-member' } as never);
  });
  const confirm = [...document.querySelectorAll<HTMLButtonElement>('button')].find(
    (x) => x.textContent === 'Create decrypted copy'
  );
  if (confirm) await act(async () => confirm.click());
  expect(writes).toEqual([]);
  await act(async () => {
    const host = store.get(runtimeAtom)!;
    store.set(runtimeAtom, { ...host, peekSessionStore: () => undefined } as WorkspaceRuntime);
  });
  expect(container.querySelector('[data-window-session-ready]')).toBeNull();
  expect(machineOperations).toBe(0);
});

it('does not announce an empty cold replica as ready before its first remote sync', async () => {
  view.dispose();
  view = createConversationViewFromHistory({
    sessionId,
    getHistory: () => [],
    subscribe: () => () => {},
  });
  syncState = 'syncing';
  await render();
  expect(container.querySelector('[data-window-session-ready]')).toBeNull();
  await selectCopy();
  expect(document.querySelector('[role="alertdialog"]')).toBeNull();
  expect(writes).toEqual([]);
  await act(async () => {
    syncState = 'synced';
    for (const listener of syncListeners) listener(syncState);
  });
  expect(container.querySelector('[data-window-session-ready]')).not.toBeNull();
  expect(machineOperations).toBe(0);
});

it('never opens a machine-owned history backend on an unavailable target', async () => {
  const cached = store.get(sessionMetaCacheAtom);
  store.set(sessionMetaCacheAtom, {
    [getSessionRoomId(sessionId)]: {
      ...cached[getSessionRoomId(sessionId)]!,
      historyBackend: 'roost',
    },
  });
  await render();
  expect(container.textContent).toContain('This history format requires machine access');
  expect(container.querySelector('[data-window-session-ready]')).toBeNull();
  expect(container.querySelector('textarea, [contenteditable="true"]')).toBeNull();
  expect(documentAcquisitions).toBe(0);
  expect(machineOperations).toBe(0);
  expect(writes).toEqual([]);
});
