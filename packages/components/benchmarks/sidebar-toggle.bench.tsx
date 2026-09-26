// @vitest-environment jsdom

// JS comparison of the old remount path and the retained desktop toggle, not
// Chromium paint, WAAPI, or the full LoroAppSidebar data/subscription path.

import React from 'react';
import { bench, beforeAll, afterAll } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { LoroSidebar, type LoroSidebarProps } from '../src/components/loro-sidebar';
import { initI18n } from '../src/i18n';
import type { SessionListRow } from '../src/components/session-list';
import { ONLY_CHATS_KEY, sidebarShowFullListAtom } from '../src/atoms/focus-layer';

const repositories = Array.from({ length: 8 }, (_, index) => `lody/project-${index + 1}`);
const fullListStore = createStore();
const previewStore = createStore();
fullListStore.set(sidebarShowFullListAtom, {
  [ONLY_CHATS_KEY]: true,
  ...Object.fromEntries(repositories.map((name) => [name, true])),
});
const sessions: SessionListRow[] = Array.from({ length: 180 }, (_, index) => ({
  sessionId: `bench-${index + 1}`,
  title: `Conversation ${index + 1}`,
  repoFullName: index < 24 ? null : repositories[index % repositories.length]!,
  branchName: `feat/sidebar-${index + 1}`,
  latestMessageAt: new Date('2026-09-26T00:00:00.000Z'),
  addedLines: index % 4 === 0 ? index * 3 : 0,
  deletedLines: index % 5 === 0 ? index * 2 : 0,
  isWorking: index % 3 === 0,
  isWaitingPermission: index % 7 === 0 && index % 3 !== 0,
  hasUnreadMessages: index % 11 === 0,
  isOffline: index % 13 === 0,
  isPinned: index === 3 || index === 48 || index === 96,
}));

const props: LoroSidebarProps = {
  workspaceName: 'Lody',
  userEmail: 'bench@lody.invalid',
  workspaces: [{ id: 'workspace', name: 'Lody' }],
  currentWorkspaceId: 'workspace',
  repoSections: [],
  chats: [],
  sessionListProps: {
    sessions,
    repos: repositories.map((repoFullName) => ({ repoFullName, collapsed: false })),
  },
};

let retainedContainer: HTMLDivElement;
let retainedRoot: ReturnType<typeof createRoot>;
let retainedVisible = true;
let retainedFirstRow: Element;

function renderRetainedSidebar() {
  flushSync(() =>
    retainedRoot.render(
      <Provider store={fullListStore}>
        <div
          aria-hidden={!retainedVisible}
          inert={!retainedVisible}
          style={{ marginRight: retainedVisible ? 0 : -280 }}
        >
          <LoroSidebar {...props} />
        </div>
      </Provider>
    )
  );
}

beforeAll(async () => {
  await initI18n('en');
  window.matchMedia = (media) => ({
    media,
    matches: false,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver;
  // The first five running marks stand in for marks intersecting the viewport.
  // Delivery is deferred until React has mounted the list, like the browser API.
  globalThis.IntersectionObserver = class {
    private observed = 0;
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) {
      const visible = this.observed++ < 5;
      queueMicrotask(() =>
        this.callback([{ target, isIntersecting: visible } as IntersectionObserverEntry], this)
      );
    }
    unobserve() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  Element.prototype.animate = function () {
    return { cancel() {}, finished: Promise.resolve(), startTime: 0 } as unknown as Animation;
  };
  retainedContainer = document.createElement('div');
  document.body.appendChild(retainedContainer);
  retainedRoot = createRoot(retainedContainer);
  renderRetainedSidebar();
  const firstRow = retainedContainer.querySelector('[data-sidebar-session-id]');
  if (!firstRow || retainedContainer.querySelectorAll('[data-sidebar-session-id]').length !== 180) {
    throw new Error('Retained benchmark must render all 180 sessions');
  }
  retainedFirstRow = firstRow;
});

afterAll(() => {
  flushSync(() => retainedRoot.unmount());
  retainedContainer.remove();
});

async function mountAndUnmount(store: ReturnType<typeof createStore>, expectedRows: number) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <Provider store={store}>
        <LoroSidebar {...props} />
      </Provider>
    )
  );
  if (container.querySelectorAll('[data-sidebar-session-id]').length !== expectedRows) {
    throw new Error(`Sidebar benchmark must render ${expectedRows} sessions`);
  }
  await Promise.resolve();
  flushSync(() => root.unmount());
  container.remove();
}

bench(
  'mount and unmount 180 mixed-state sessions, 45-row preview',
  async () => {
    await mountAndUnmount(previewStore, 45);
  },
  { iterations: 16, time: 1200 }
);

bench(
  'mount and unmount 180 mixed-state sessions, all 180 rows shown',
  async () => {
    await mountAndUnmount(fullListStore, 180);
  },
  { iterations: 16, time: 1200 }
);

bench(
  'retain 180 mixed-state rows across a desktop sidebar toggle',
  () => {
    retainedVisible = !retainedVisible;
    renderRetainedSidebar();
    if (retainedContainer.querySelector('[data-sidebar-session-id]') !== retainedFirstRow) {
      throw new Error('Desktop toggle remounted the first sidebar row');
    }
  },
  { iterations: 32, time: 1200 }
);
