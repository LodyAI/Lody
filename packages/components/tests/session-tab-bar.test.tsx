// @vitest-environment jsdom

import { Provider, createStore } from 'jotai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTabBar } from '../src/components/sessions/session-tab-bar';
import { TooltipProvider } from '../src/ui/tooltip';
import { FocusScope } from '../src/ui/focus-scope';
import { WORKSPACE_FOCUS_SCOPES } from '../src/atoms/focus-layer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-1' as MachineId;
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
const childSession: SessionMeta = {
  ...parentSession,
  id: 'session-child' as SessionId,
  title: 'Child session',
};

describe('SessionTabBar drag sources', () => {
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

  async function renderTabBar(childSessions: SessionMeta[]) {
    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <TooltipProvider>
            <FocusScope id={WORKSPACE_FOCUS_SCOPES.sessionConversation}>
              <SessionTabBar
                variant="session"
                parentSession={parentSession}
                childSessions={childSessions}
                draftTabs={[]}
                archivedChildSessions={[]}
                activeTabSessionId={parentSession.id}
                onTabSelect={vi.fn()}
                onNewTab={vi.fn()}
              />
            </FocusScope>
          </TooltipProvider>
        </Provider>
      );
    });
  }

  it('does not mark a solo tab title as a window-drag hole', async () => {
    await renderTabBar([]);
    const tab = container.querySelector<HTMLElement>('#session-tab-session-parent')!;
    expect(tab.className).not.toContain('app-region-no-drag');
  });

  it('marks each tab as a click target when more than one is open', async () => {
    await renderTabBar([childSession]);
    const parent = container.querySelector<HTMLElement>('#session-tab-session-parent')!;
    const child = container.querySelector<HTMLElement>('#session-tab-session-child')!;
    expect(parent.className).toContain('app-region-no-drag');
    expect(child.className).toContain('app-region-no-drag');
  });

  it('disables dragging when only the parent Session tab is visible', async () => {
    await renderTabBar([]);

    expect(container.querySelector<HTMLElement>('#session-tab-session-parent')?.draggable).toBe(
      false
    );
  });

  it('enables dragging after a second tab becomes visible', async () => {
    await renderTabBar([childSession]);

    expect(container.querySelector<HTMLElement>('#session-tab-session-parent')?.draggable).toBe(
      true
    );
  });

  it('moves focus through visible tabs with the shared list navigation', async () => {
    await renderTabBar([childSession]);
    const parent = container.querySelector<HTMLElement>('#session-tab-session-parent')!;
    const child = container.querySelector<HTMLElement>('#session-tab-session-child')!;

    await act(async () => parent.focus());
    await act(async () =>
      parent.dispatchEvent(
        new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'ArrowDown' })
      )
    );

    expect(document.activeElement).toBe(child);
  });
});
