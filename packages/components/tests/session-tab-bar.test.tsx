// @vitest-environment jsdom

import { Provider, createStore } from 'jotai';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTabBar } from '../src/components/sessions/session-tab-bar';
import { TooltipProvider } from '../src/ui/tooltip';

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

describe('SessionTabBar', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
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
    onTabRename?: (sessionId: SessionId, title: string) => void
  ) {
    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <TooltipProvider>
            <SessionTabBar
              variant="session"
              parentSession={parentSession}
              childSessions={childSessions}
              draftTabs={[]}
              archivedChildSessions={[]}
              activeTabSessionId={parentSession.id}
              onTabSelect={vi.fn()}
              onNewTab={vi.fn()}
              onTabRename={onTabRename}
            />
          </TooltipProvider>
        </Provider>
      );
    });
  }

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

  it('ignores Enter while the IME is composing an inline rename', async () => {
    const onTabRename = vi.fn();
    await renderTabBar([], onTabRename);

    await act(async () => {
      container
        .querySelector<HTMLElement>('#session-tab-session-parent')
        ?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });

    const input = container.querySelector<HTMLInputElement>('input');
    expect(input).toBeInstanceOf(HTMLInputElement);

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        })
      );
    });

    expect(onTabRename).not.toHaveBeenCalled();
    expect(container.querySelector('input')).toBe(input);

    await act(async () => {
      input?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      );
    });

    expect(onTabRename).toHaveBeenCalledWith(parentSession.id, parentSession.title);
  });
});
