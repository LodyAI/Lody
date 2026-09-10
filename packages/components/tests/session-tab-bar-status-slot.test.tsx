// @vitest-environment jsdom

import { Provider, createStore } from 'jotai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  getLodySessionPresenceKey,
  getServerNow,
  type LodyPresenceInstanceId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { lodyPresenceStatesAtom } from '../src/atoms/presence';
import { SessionTabBar } from '../src/components/sessions/session-tab-bar';
import { TooltipProvider } from '../src/ui/tooltip';
import { FocusScope } from '../src/ui/focus-scope';
import { WORKSPACE_FOCUS_SCOPES } from '../src/atoms/focus-layer';

/**
 * A sub-session tab is the ONLY place its own unread state can surface: child
 * tabs get no sidebar row of their own. The tab bar's single status slot is
 * priority-ordered `waiting > working > unread > agent icon`, matching the
 * sidebar row and the mobile tab sheet.
 */

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
const NOW = 1_800_000_000_000;

const parentSession: SessionMeta = {
  id: 'session-parent' as SessionId,
  machineId,
  createdAt: '2026-08-26T00:00:00.000Z',
  title: 'Main session',
  userId: 'user-1',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
};

function child(id: string, overrides: Partial<SessionMeta> = {}): SessionMeta {
  return {
    ...parentSession,
    id: id as SessionId,
    title: `Child ${id}`,
    ...overrides,
  };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'checkVisibility', {
    configurable: true,
    value: () => true,
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: vi.fn(),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

async function renderTabBar(
  childSessions: SessionMeta[],
  {
    activeTabSessionId = parentSession.id,
    parent = parentSession,
    presence = {},
  }: {
    activeTabSessionId?: string;
    parent?: SessionMeta;
    presence?: Record<string, 'running' | 'requestPermission'>;
  } = {}
) {
  const store = createStore();
  store.set(
    lodyPresenceStatesAtom,
    Object.fromEntries(
      Object.entries(presence).map(([sessionId, type]) => [
        getLodySessionPresenceKey(
          sessionId as SessionId,
          `p-${sessionId}` as LodyPresenceInstanceId
        ),
        {
          kind: 'session' as const,
          sessionId: sessionId as SessionId,
          machineId,
          instanceId: `p-${sessionId}` as LodyPresenceInstanceId,
          status: { type },
          updatedAt: getServerNow(),
        },
      ])
    )
  );
  await act(async () => {
    root.render(
      <Provider store={store}>
        <TooltipProvider>
          <FocusScope id={WORKSPACE_FOCUS_SCOPES.sessionConversation}>
            <SessionTabBar
              variant="session"
              parentSession={parent}
              childSessions={childSessions}
              draftTabs={[]}
              archivedChildSessions={[]}
              activeTabSessionId={activeTabSessionId}
              onTabSelect={vi.fn()}
              onNewTab={vi.fn()}
            />
          </FocusScope>
        </TooltipProvider>
      </Provider>
    );
  });
}

function unreadDot(sessionId: string): Element | null {
  return container.querySelector(`#session-tab-${sessionId} [data-session-tab-unread]`);
}

describe('SessionTabBar status slot', () => {
  it('marks a background child tab whose last message arrived after the last read', async () => {
    await renderTabBar([child('session-child', { lastMessageAt: NOW, lastReadAt: NOW - 1_000 })]);

    expect(unreadDot('session-child')).not.toBeNull();
  });

  it('marks a never-read child tab that has produced output', async () => {
    await renderTabBar([child('session-child', { lastMessageAt: NOW })]);

    expect(unreadDot('session-child')).not.toBeNull();
  });

  it('leaves a caught-up child tab unmarked', async () => {
    await renderTabBar([child('session-child', { lastMessageAt: NOW, lastReadAt: NOW })]);

    expect(unreadDot('session-child')).toBeNull();
  });

  it('marks the parent tab when the main thread moved while a child tab is open', async () => {
    await renderTabBar([child('session-child')], {
      activeTabSessionId: 'session-child',
      parent: { ...parentSession, lastMessageAt: NOW, lastReadAt: NOW - 1_000 },
    });

    expect(unreadDot('session-parent')).not.toBeNull();
  });

  it('does not mark the tab the user is currently reading', async () => {
    await renderTabBar([child('session-child', { lastMessageAt: NOW, lastReadAt: NOW - 1_000 })], {
      activeTabSessionId: 'session-child',
    });

    expect(unreadDot('session-child')).toBeNull();
  });

  it('lets a working child tab show its spinner instead of the unread dot', async () => {
    await renderTabBar([child('session-child', { lastMessageAt: NOW, lastReadAt: NOW - 1_000 })], {
      presence: { 'session-child': 'running' },
    });

    expect(unreadDot('session-child')).toBeNull();
    expect(container.querySelector('#session-tab-session-child .animate-spin')).not.toBeNull();
  });

  it('shows the waiting-permission marker instead of the busy spinner', async () => {
    await renderTabBar([child('session-child', { lastMessageAt: NOW, lastReadAt: NOW - 1_000 })], {
      presence: { 'session-child': 'requestPermission' },
    });

    expect(container.querySelector('#session-tab-session-child .animate-spin')).toBeNull();
    expect(unreadDot('session-child')).toBeNull();
    expect(
      container.querySelector('#session-tab-session-child .text-status-warning')
    ).not.toBeNull();
  });
});
