// @vitest-environment jsdom

import { Provider, createStore } from 'jotai';
import { act, Profiler, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MachineId, SessionId, SessionMeta } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SessionTabBar } from '../src/components/sessions/session-tab-bar';
import { allocateAdaptiveTabStripLayout } from '../src/components/sessions/adaptive-tab-strip';
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
    onTabClose = vi.fn()
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
                archivedChildSessions={[]}
                activeTabSessionId={parentSession.id}
                onTabSelect={vi.fn()}
                onNewTab={vi.fn()}
                onTabClose={onTabClose}
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

  it('creates one default draft after hydration, including Strict Mode effect replay', async () => {
    function Harness({ ready }: { ready: boolean }) {
      const [drafts, setDrafts] = useState<DraftSessionTab[]>([]);
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
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness ready={false} />
        </StrictMode>
      )
    );
    expect(JSON.parse(container.textContent!)).toEqual({ selected: 'empty', drafts: [] });
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness ready />
        </StrictMode>
      )
    );
    const result = JSON.parse(container.textContent!);
    expect(result.drafts).toHaveLength(1);
    expect(result.selected).toBe(result.drafts[0].id);
    expect(result.drafts[0].prompt).toBe('');
    await act(async () =>
      root.render(
        <StrictMode>
          <Harness key="fresh" ready />
        </StrictMode>
      )
    );
    const fresh = JSON.parse(container.textContent!);
    expect(fresh.drafts).toHaveLength(1);
    expect(fresh.selected).toBe(fresh.drafts[0].id);
  });

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

describe('SessionTabBar rapid-close tab widths', () => {
  let root: Root;
  let container: HTMLDivElement;

  const childA: SessionMeta = { ...childSession, id: 'session-child-a' as SessionId };
  const childB: SessionMeta = { ...childSession, id: 'session-child-b' as SessionId };
  const childC: SessionMeta = { ...childSession, id: 'session-child-c' as SessionId };
  const childD: SessionMeta = { ...childSession, id: 'session-child-d' as SessionId };
  const childE: SessionMeta = { ...childSession, id: 'session-child-e' as SessionId };

  let mockViewportWidth = 800;
  let commits = 0;
  let nextFrameId = 0;
  let itemIds = ['session-parent'] as string[];
  let resizeCallback: ResizeObserverCallback | null = null;
  const pendingFrames = new Map<number, FrameRequestCallback>();

  beforeEach(() => {
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
    mockViewportWidth = 800;
    commits = 0;
    nextFrameId = 0;
    itemIds = ['session-parent'];
    resizeCallback = null;
    pendingFrames.clear();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = ++nextFrameId;
      pendingFrames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => pendingFrames.delete(id));
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get() {
        return mockViewportWidth;
      },
    });
    vi.stubGlobal(
      'ResizeObserver',
      class FakeResizeObserver {
        constructor(callback: ResizeObserverCallback) {
          resizeCallback = callback;
        }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    // The resting layout belongs to the browser (flex), which jsdom does not
    // implement. Stand in for it with the integer allocation the strip used to
    // compute itself, so close-mode geometry has real numbers to freeze.
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value(this: HTMLElement) {
        const id = this.getAttribute?.('data-adaptive-tab-strip-item');
        if (!id) return { width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 } as DOMRect;
        // A frozen item carries an explicit width; everything else is flex.
        const pinned = parseInt(this.style?.width ?? '', 10);
        if (Number.isFinite(pinned)) {
          return {
            width: pinned,
            height: 32,
            top: 0,
            left: 0,
            right: pinned,
            bottom: 32,
          } as DOMRect;
        }
        const layout = allocateAdaptiveTabStripLayout({
          viewportWidth: mockViewportWidth,
          itemIds,
          activeItemId: standInActiveItemId(),
          gap: 6,
          paddingLeft: 8,
          paddingRight: 8,
          activeMinWidth: 180,
        });
        const width = layout.items.find((item) => item.id === id)?.width ?? 0;
        return {
          width,
          height: 32,
          top: 0,
          left: 0,
          right: width,
          bottom: 32,
        } as DOMRect;
      },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  /**
   * The active item, read from the pinned-min property the renderer sets on
   * it. The strip marks the active tab by setting
   * `--tab-active-min-width`, which is also what the stand-in layout needs in
   * order to mirror the browser's minimum.
   */
  function standInActiveItemId(): string | null {
    for (const item of container.querySelectorAll<HTMLElement>('[data-adaptive-tab-strip-item]')) {
      if (item.style.getPropertyValue('--tab-active-min-width')) {
        return item.getAttribute('data-adaptive-tab-strip-item');
      }
    }
    return null;
  }

  /** Refresh the ids and the stand-in flex layout after a commit. */
  async function syncLayout() {
    itemIds = Array.from(
      container.querySelectorAll<HTMLElement>('[data-adaptive-tab-strip-item]')
    ).map((item) => item.getAttribute('data-adaptive-tab-strip-item')!);
    await act(async () => {});
  }

  /**
   * Effective item width: the browser's flex result, or — while frozen — the
   * explicit width the strip pins. jsdom gives every element the same
   * `mockViewportWidth`, so the stand-in layout is the integer allocation
   * shared with `captureStripGeometry`.
   */
  function tabWidths(): number[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-adaptive-tab-strip-item]')
    ).map((item) => {
      const frozen = parseInt(item.style.width, 10);
      return Number.isFinite(frozen) ? frozen : Math.round(item.getBoundingClientRect().width);
    });
  }

  function itemMargins(): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>('[data-adaptive-tab-strip-item]')
    ).map((item) => item.style.marginInlineStart);
  }

  function viewport(): HTMLElement {
    return container.querySelector<HTMLElement>('[data-adaptive-tab-strip-viewport]')!;
  }

  // Callbacks scheduled during a frame belong to the next frame.
  async function flushFrame() {
    const callbacks = [...pendingFrames.values()];
    pendingFrames.clear();
    await act(async () => {
      callbacks.forEach((callback) => callback(0));
    });
  }

  // jsdom reports a zero rect for the viewport, so the expanded Chromium
  // MouseWatcher region is x∈[0,60], y∈[0,40].
  async function movePointer(clientX: number, clientY: number) {
    await act(async () =>
      document.body.dispatchEvent(new TestPointerEvent('pointermove', { clientX, clientY }))
    );
  }

  async function leaveStrip() {
    await act(async () =>
      viewport().dispatchEvent(
        new TestPointerEvent('pointerout', { bubbles: true, relatedTarget: document.body })
      )
    );
    await movePointer(500, 500);
  }

  async function resizeTo(width: number) {
    mockViewportWidth = width;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));
    await syncLayout();
  }

  async function renderHarness(
    initial: SessionMeta[],
    activeId = parentSession.id as string,
    parentInitiallyClosed = false
  ) {
    function Harness() {
      const [children, setChildren] = useState<SessionMeta[]>(initial);
      const [selected, setSelected] = useState<string>(activeId);
      const [parentClosed, setParentClosed] = useState(parentInitiallyClosed);
      return (
        <>
          <SessionTabBar
            variant="session"
            parentSession={{ ...parentSession, isTabClosed: parentClosed }}
            childSessions={children}
            draftTabs={[]}
            archivedChildSessions={[]}
            activeTabSessionId={selected}
            onTabSelect={(id) => setSelected(id)}
            onNewTab={vi.fn()}
            onTabClose={(id) => {
              if (id === parentSession.id) {
                setParentClosed(true);
                if (selected === id) setSelected(children[0]?.id ?? id);
                return;
              }
              setChildren((prev) => {
                const closedIndex = prev.findIndex((session) => session.id === id);
                const next = prev.filter((session) => session.id !== id);
                if (id === selected) {
                  // Same neighbour rule as getSessionTabFallback.
                  setSelected(
                    next[closedIndex]?.id ?? next[closedIndex - 1]?.id ?? parentSession.id
                  );
                }
                return next;
              });
            }}
          />
          <button id="add-child" onClick={() => setChildren((prev) => [...prev, childC])} />
          <button
            id="replace-child"
            onClick={() => {
              // One commit swaps childB for childE and moves the selection to
              // childC — the shape of a draft promoting to a session.
              setChildren((prev) => prev.map((s) => (s.id === childB.id ? childE : s)));
              setSelected(childC.id);
            }}
          />
          <button id="open-parent" onClick={() => setParentClosed(false)} />
          <button
            id="close-two-phase"
            onClick={() => {
              // The real app commits the removal first (await setSessionTabClosed)
              // and the neighbour selection in a later commit (navigateToSessionTab).
              setChildren((prev) => prev.filter((session) => session.id !== childA.id));
            }}
          />
          <button id="select-b" onClick={() => setSelected(childB.id)} />
        </>
      );
    }
    await act(async () =>
      root.render(
        <Provider store={createStore()}>
          <Tooltip.Provider>
            <FocusScope id={WORKSPACE_FOCUS_SCOPES.sessionConversation}>
              <Profiler id="rapid-close" onRender={() => commits++}>
                <Harness />
              </Profiler>
            </FocusScope>
          </Tooltip.Provider>
        </Provider>
      )
    );
    await syncLayout();
  }

  async function clickClose(sessionId: string) {
    const button = container.querySelector<HTMLButtonElement>(`#session-tab-${sessionId} button`)!;
    await act(async () => {
      // Rapid-close mode only arms on a real pointer gesture inside the strip,
      // which is also when the strip snapshots its painted geometry.
      button.dispatchEvent(new TestPointerEvent('pointerdown', { bubbles: true }));
      button.click();
    });
    await syncLayout();
  }

  async function programmaticClose(sessionId: string) {
    await act(async () =>
      container.querySelector<HTMLButtonElement>(`#session-tab-${sessionId} button`)!.click()
    );
    await syncLayout();
  }

  // Arms the rapid-close gesture without closing anything — the pointerdown on
  // the viewport is what puts the strip into close mode.
  async function armPointer() {
    await act(async () => {
      viewport().dispatchEvent(new TestPointerEvent('pointerdown', { bubbles: true }));
    });
    await syncLayout();
  }

  it('keeps surviving tab widths after closing a middle tab while hovered', async () => {
    await renderHarness([childA, childB]);
    // 800px viewport, 8px/8px padding, 6px gaps: [258, 257, 257].
    expect(tabWidths()).toEqual([258, 257, 257]);

    await clickClose(childA.id);

    expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
    // Frozen: the survivors keep their widths instead of re-expanding.
    expect(tabWidths()).toEqual([258, 257]);
  });

  it('re-expands to the full width once the pointer leaves the slop region', async () => {
    await renderHarness([childA, childB]);
    await clickClose(childA.id);
    expect(tabWidths()).toEqual([258, 257]);

    // Inside the expanded region (x∈[0,60], y∈[0,40] under the zero jsdom
    // rect) the freeze survives, like drifting toward the new-tab button.
    await movePointer(30, 20);
    expect(tabWidths()).toEqual([258, 257]);
    await movePointer(59, 39);
    expect(tabWidths()).toEqual([258, 257]);

    await movePointer(500, 500);
    expect(tabWidths()).toEqual([389, 389]);
  });

  it('stays frozen across consecutive closes while hovered', async () => {
    await renderHarness([childA, childB, childC]);
    // [parent, A, B, C] in a 766px budget: [192, 192, 191, 191].
    expect(tabWidths()).toEqual([192, 192, 191, 191]);

    await clickClose(childA.id);
    expect(tabWidths()).toEqual([192, 191, 191]);
    await clickClose(childB.id);
    expect(tabWidths()).toEqual([192, 191]);

    await leaveStrip();
    expect(tabWidths()).toEqual([389, 389]);
  });

  it('slides the freed space closed over the surviving tab', async () => {
    await renderHarness([childA, childB]);
    await clickClose(childA.id);

    // The survivor moving into the removed slot starts with the freed
    // width+gap as its inline-start margin, then eases it back to zero.
    expect(itemMargins()).toEqual(['0', '263px']);
    await flushFrame();
    expect(itemMargins()).toEqual(['0', '0']);
    expect(tabWidths()).toEqual([258, 257]);
    const settledCommits = commits;
    await flushFrame();
    await flushFrame();
    expect(commits).toBe(settledCommits);
    expect(pendingFrames.size).toBe(0);
  });

  it('relayouts immediately when only the last tab is closed', async () => {
    await renderHarness([childA, childB]);
    await clickClose(childB.id);

    // The new last tab already ends at the right edge, so no freeze is needed.
    expect(tabWidths()).toEqual([389, 389]);
  });

  it('re-spreads survivors over the occupied width when the trailing tab closes while frozen', async () => {
    await renderHarness([childA, childB, childC, childD], childA.id);
    // [parent 146, A 180, B 146, C 146, D 146].
    expect(tabWidths()).toEqual([145, 180, 145, 145, 145]);

    await clickClose(childB.id);

    expect(tabWidths()).toEqual([145, 180, 145, 145]);

    // Closing the last tab while frozen does not shrink the budget: survivors
    // re-spread over the occupied 648px so the new last tab's right edge —
    // and its close button — stays under the cursor.

    await clickClose(childD.id);

    expect(tabWidths()).toEqual([207, 207, 207]);

    await leaveStrip();
    expect(tabWidths()).toEqual([258, 257, 257]);
  });

  it('relayouts immediately when a close leaves a single tab', async () => {
    await renderHarness([childA, childB]);
    await clickClose(childA.id);
    expect(tabWidths()).toEqual([258, 257]);

    // Closing the parent leaves one tab; Chromium exits close mode outright.
    await clickClose(parentSession.id);
    expect(tabWidths()).toEqual([784]);
  });

  it('keeps the freeze when the viewport grows and releases when it shrinks', async () => {
    await renderHarness([childA, childB]);
    await clickClose(childA.id);
    expect(tabWidths()).toEqual([258, 257]);

    await resizeTo(1000);
    expect(tabWidths()).toEqual([258, 257]);

    await resizeTo(700);
    // 700 - 16px padding - 6px gap = 678, split evenly.
    expect(tabWidths()).toEqual([339, 339]);
  });

  it('leaves the resting row to flex, with the active minimum pinned', async () => {
    // The strip paints no widths at rest: `flex: 1 1 0` lets the browser size
    // the tabs in the same style recalculation as the panel around them, so a
    // sidebar toggle needs no measurement loop. Only the frozen state pins an
    // explicit width.
    await renderHarness([childA, childB, childC], childB.id);

    const items = Array.from(
      container.querySelectorAll<HTMLElement>('[data-adaptive-tab-strip-item]')
    );
    expect(items.every((item) => !item.style.width)).toBe(true);
    expect(items.every((item) => item.style.flex === '1 1 0px')).toBe(true);
    // The active tab carries the pinned minimum; the container query on the
    // viewport decides whether it applies.
    expect(items[2].style.getPropertyValue('--tab-active-min-width')).toBe('180px');
    expect(items[0].style.getPropertyValue('--tab-active-min-width')).toBe('');
    expect(viewport().className).toContain('@container');
  });

  it('does not freeze for a programmatic close without a pointer gesture', async () => {
    await renderHarness([childA, childB]);
    await programmaticClose(childA.id);

    // No pointerdown armed the gesture, so the survivors relayout immediately.
    expect(tabWidths()).toEqual([389, 389]);
  });

  it('promotes the newly active tab to the frozen active width after closing the active tab', async () => {
    await renderHarness([childA, childB, childC, childD], childA.id);
    // Below ACTIVE_TAB_MIN_WIDTH the active tab gets 180, inactives split the
    // rest: [parent 146, A 180, B 146, C 146, D 146].
    expect(tabWidths()).toEqual([145, 180, 145, 145, 145]);

    // Closing active A selects B; B takes the captured active width while the
    // rest keep their inactive widths.
    await clickClose(childA.id);
    expect(tabWidths()).toEqual([145, 180, 145, 145]);

    // The promoted survivor widens in place — no slide margin, so it cannot
    // read as unfolding out of the emptied slot.
    expect(itemMargins()).toEqual(['0', '0', '0', '0']);

    await leaveStrip();
    // Released: four tabs split the full row evenly again.
    expect(tabWidths()).toEqual([192, 192, 191, 191]);
  });

  it('releases the freeze when a tab is added and lets flex take the row', async () => {
    await renderHarness([childA, childB]);
    await clickClose(childA.id);
    expect(tabWidths()).toEqual([258, 257]);

    await act(async () => container.querySelector<HTMLButtonElement>('#add-child')!.click());
    await syncLayout();

    // An add is not a close gesture: the frozen widths are released and the
    // row goes back to flex, with no item pinned.
    expect(tabWidths()).toEqual([258, 257, 257]);
    expect(
      Array.from(container.querySelectorAll<HTMLElement>('[data-adaptive-tab-strip-item]')).every(
        (item) => item.style.width === ''
      )
    ).toBe(true);
  });

  it('holds survivor geometry while the active selection moves in a later commit', async () => {
    await renderHarness([childA, childB, childC, childD], childA.id);
    expect(tabWidths()).toEqual([145, 180, 145, 145, 145]);

    await armPointer();
    // Phase 1 — the removal commits while the selection still names the dead
    // tab (the real app navigates after setSessionTabClosed resolves). The
    // survivor slides like any other neighbour for now.
    await act(async () => container.querySelector<HTMLButtonElement>('#close-two-phase')!.click());
    expect(tabWidths()).toEqual([145, 145, 145, 145]);
    expect(itemMargins()).toEqual(['0', '186px', '0', '0']);

    // Phase 2 — the neighbour selection lands and promotes to the captured
    // active width; the slide drops so it widens in place rather than
    // unfolding out of the emptied slot, and it must never pass through zero.
    await act(async () => container.querySelector<HTMLButtonElement>('#select-b')!.click());
    expect(tabWidths()).toEqual([145, 180, 145, 145]);
    expect(itemMargins()).toEqual(['0', '0', '0', '0']);
  });

  it('does not grow a lone tab into an empty strip', async () => {
    await renderHarness([], parentSession.id, true);
    expect(container.querySelectorAll('[data-adaptive-tab-strip-item]')).toHaveLength(0);

    await act(async () => container.querySelector<HTMLButtonElement>('#open-parent')!.click());
    await syncLayout();

    // A lone tab materializing in an empty strip renders at its final width
    // directly — there is nothing for a grow-in to read against — and flex
    // owns that width.
    const item = container.querySelector<HTMLElement>(
      '[data-adaptive-tab-strip-item="session-parent"]'
    )!;
    expect(item.style.width).toBe('');
    expect(tabWidths()).toEqual([784]);
  });
});
