// @vitest-environment jsdom

// @vitest-environment jsdom
import { Provider, createStore } from 'jotai';
import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTabBar } from '../src/components/sessions/session-tab-bar';

import { useEmptySessionDraft } from '../src/hooks/use-empty-session-draft';
import { createDraftSessionTab, type DraftSessionTab } from '../src/lib/session-draft-tabs';
import { Tooltip } from '@lody/ui/tooltip';
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

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

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

  async function renderTabBar(
    childSessions: SessionMeta[],
    parent = parentSession,
    onTabClose = vi.fn(),
    closedSessions: SessionMeta[] = []
  ) {
    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <Tooltip.Provider>
            <FocusScope id={WORKSPACE_FOCUS_SCOPES.sessionConversation}>
              <SessionTabBar
                variant="session"
                parentSession={parent}
                childSessions={childSessions}
                draftTabs={[]}
                archivedChildSessions={closedSessions}
                activeTabSessionId={parentSession.id}
                onTabSelect={vi.fn()}
                onNewTab={vi.fn()}
                onTabClose={onTabClose}
                onTabRestore={vi.fn()}
              />
            </FocusScope>
          </Tooltip.Provider>
        </Provider>
      );
    });
  }

  it('closes the last main tab to one local draft and retains the closed-list reopen action', async () => {
    function Harness() {
      const [parent, setParent] = useState({
        ...parentSession,
        lastMessageAt: 200,
        lastReadAt: 100,
      });
      const [drafts, setDrafts] = useState<DraftSessionTab[]>([]);
      const [selected, setSelected] = useState<string>(parent.id);
      const closed = parent.isTabClosed === true;
      useEmptySessionDraft({
        enabled: selected === 'empty',
        parent,
        drafts,
        onCreate: (draft) => setDrafts((prev) => [...prev, draft]),
        onSelect: setSelected,
      });
      const closeParent = () => {
        setParent({ ...parent, isTabClosed: true });
        setSelected('empty');
      };
      const reopen = (id: SessionId) => {
        if (id === parent.id) {
          setParent({ ...parent, isTabClosed: false });
          setSelected(id);
        }
      };
      return (
        <>
          <SessionTabBar
            parentSession={parent}
            childSessions={[]}
            draftTabs={drafts}
            archivedChildSessions={closed ? [parent] : []}
            activeTabSessionId={selected}
            onTabSelect={() => {}}
            onNewTab={() => {}}
            onTabClose={(id) => {
              if (id === parent.id) closeParent();
            }}
            onTabRestore={reopen}
          />
          <output>{selected}</output>
          {/* The lone tab shows no close button; close it the way a shortcut
              or another client would. */}
          <button type="button" data-close-parent onClick={() => closeParent()}>
            close
          </button>
        </>
      );
    }
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <Tooltip.Provider>
            <StrictMode>
              <Harness />
            </StrictMode>
          </Tooltip.Provider>
        </Provider>
      )
    );
    expect(container.querySelector('#session-tab-session-parent button')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[data-close-parent]')!.click()
    );
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
    // The draft that replaces it is also alone, so it has no close button either.
    expect(container.querySelector('[role="tab"] button[aria-label^="Close"]')).toBeNull();
    expect(container.querySelector('output')?.textContent).toMatch(/^draft:/);
    // Output the user has not read stays discoverable through the closed list.
    const closedTabs = container.querySelector<HTMLButtonElement>(
      '[aria-label="Closed conversations: Unread messages"]'
    )!;
    expect(closedTabs.querySelector('[data-closed-tabs-unread]')).not.toBeNull();
    await act(async () => closedTabs.click());
    expect(document.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[aria-label="Reopen conversation: Main session"]')!
        .click()
    );
    expect(container.querySelector('#session-tab-session-parent')).not.toBeNull();
    expect(container.querySelector('output')?.textContent).toBe(parentSession.id);
  });

  it('removes closed and archived conversations from the visible strip', async () => {
    await renderTabBar([{ ...childSession, isArchived: true }], {
      ...parentSession,
      isTabClosed: true,
    });
    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(container.querySelector('[aria-label="New tab"]')).not.toBeNull();
  });

  it('keeps the open tabs of an archived workspace visible for review', async () => {
    const closedChild = {
      ...childSession,
      id: 'session-closed-child' as SessionId,
      isArchived: true,
      isTabClosed: true,
    };
    await renderTabBar(
      [{ ...childSession, isArchived: true }, closedChild],
      { ...parentSession, isArchived: true },
      vi.fn(),
      [closedChild]
    );
    expect(
      Array.from(container.querySelectorAll('[role="tab"]'), (tab) => tab.textContent)
    ).toEqual(['Main session', 'Child session']);
    // Review-only: no new conversation can start until the workspace is restored.
    expect(container.querySelector('[aria-label="New tab"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Closed conversations"]')!.click()
    );
    // Reopening a closed tab of an archived workspace does not restore it.
    expect(
      document.querySelector('[aria-label="Reopen conversation: Child session"]')
    ).not.toBeNull();
    expect(document.querySelector('[aria-label^="Restore session"]')).toBeNull();
  });

  it('offers Restore only for an archived child of a live workspace', async () => {
    const archivedChild = { ...childSession, isArchived: true };
    const closedChild = {
      ...childSession,
      id: 'session-closed-child' as SessionId,
      title: 'Closed child',
      isTabClosed: true,
    };
    await renderTabBar([], parentSession, vi.fn(), [archivedChild, closedChild]);
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Closed conversations"]')!.click()
    );
    expect(document.querySelector('[aria-label="Restore session: Child session"]')).not.toBeNull();
    expect(
      document.querySelector('[aria-label="Reopen conversation: Closed child"]')
    ).not.toBeNull();
  });

  it('waits for hydration and reuses an existing draft without replacing its input', async () => {
    const existing = {
      ...createDraftSessionTab({
        cliType: 'builtin',
        agentType: 'codex',
        modeId: null,
        modelId: null,
      }),
      prompt: 'Keep my input',
    };
    function Harness({ ready }: { ready: boolean }) {
      const [drafts, setDrafts] = useState([existing]);
      const [selected, setSelected] = useState<string>('empty');
      useEmptySessionDraft({
        enabled: ready && selected === 'empty',
        parent: parentSession,
        drafts,
        onCreate: (draft) => setDrafts((prev) => [...prev, draft]),
        onSelect: setSelected,
      });
      return <output>{JSON.stringify({ selected, drafts })}</output>;
    }
    await act(async () => root.render(<Harness ready={false} />));
    expect(JSON.parse(container.textContent!).selected).toBe('empty');
    await act(async () => root.render(<Harness ready />));
    expect(JSON.parse(container.textContent!)).toEqual({
      selected: existing.id,
      drafts: [existing],
    });
  });
});
