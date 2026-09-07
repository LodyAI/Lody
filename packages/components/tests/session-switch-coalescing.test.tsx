// @vitest-environment jsdom

import { act, createElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import {
  sidebarNavCallbacksAtom,
  sidebarNavItemsAtom,
  type SidebarNavCallbacks,
  type SidebarNavItem,
} from '../src/atoms/focus-layer';
import { useKeyboardNavigation } from '../src/hooks/use-keyboard-navigation';
import { commands } from '../src/lib/commands/registry';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback?: string) => fallback ?? _key }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const SESSION_IDS = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8', 's9', 's10'];

/** Frames only run when the test says so, standing in for "the browser painted". */
class ManualFrames {
  private callbacks = new Map<number, FrameRequestCallback>();
  private nextHandle = 1;
  private readonly originalRequest = window.requestAnimationFrame;
  private readonly originalCancel = window.cancelAnimationFrame;

  install(): void {
    window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
      const handle = this.nextHandle++;
      this.callbacks.set(handle, callback);
      return handle;
    }) as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = ((handle: number) => {
      this.callbacks.delete(handle);
    }) as typeof window.cancelAnimationFrame;
  }

  restore(): void {
    window.requestAnimationFrame = this.originalRequest;
    window.cancelAnimationFrame = this.originalCancel;
  }

  get pending(): number {
    return this.callbacks.size;
  }

  /** Runs exactly the frames queued right now, not the ones they queue. */
  paint(): void {
    const due = [...this.callbacks.entries()];
    this.callbacks.clear();
    act(() => {
      for (const [, callback] of due) callback(performance.now());
    });
  }
}

let container: HTMLDivElement;
let root: Root;
let frames: ManualFrames;
let store: ReturnType<typeof createStore>;
let mounted: boolean;
let navigations: string[];
let routeSessionId: string;

function Harness() {
  useKeyboardNavigation();
  return null;
}

function renderWith(children: ReactNode) {
  act(() => root.render(createElement(Provider, { store }, children)));
  mounted = true;
}

function unmount() {
  if (!mounted) return;
  mounted = false;
  act(() => root.unmount());
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  frames = new ManualFrames();
  frames.install();
  store = createStore();
  navigations = [];
  routeSessionId = 's1';

  const callbacks: SidebarNavCallbacks = {
    // The real router commits before the next frame, so the route follows every
    // navigation we issue. Tests that model an outside selection overwrite
    // `routeSessionId` afterwards.
    onNavigateToSession: (id) => {
      navigations.push(id);
      routeSessionId = id;
    },
    onNavigateToNewSession: () => {},
    onToggleRepoCollapsed: () => {},
    onToggleChatsCollapsed: () => {},
    getSelectedSessionId: () => routeSessionId,
    isChatLanding: () => false,
  };
  const items: SidebarNavItem[] = SESSION_IDS.map((sessionId) => ({
    kind: 'session',
    sessionId,
    groupKey: 'g',
  }));
  store.set(sidebarNavItemsAtom, items);
  store.set(sidebarNavCallbacksAtom, callbacks);

  renderWith(createElement(Harness));
});

afterEach(() => {
  unmount();
  container.remove();
  frames.restore();
  for (const cmd of commands.list()) commands.unregister(cmd.id);
});

function pressNext() {
  act(() => {
    commands.execute('session.nextVisible');
  });
}

describe('session switch coalescing', () => {
  it('navigates immediately for a single press', () => {
    pressNext();
    expect(navigations).toEqual(['s2']);
  });

  it('collapses presses that arrive before the last one painted', () => {
    pressNext();
    expect(navigations).toEqual(['s2']);

    // The conversation is still rendering, so these two presses must not each
    // pay for a navigation nobody sees — they only move the target.
    pressNext();
    pressNext();
    expect(navigations).toEqual(['s2']);

    frames.paint();
    expect(navigations).toEqual(['s2', 's4']);

    // Nothing is outstanding, so the follow-up frame issues no further work.
    frames.paint();
    expect(navigations).toEqual(['s2', 's4']);
    expect(frames.pending).toBe(0);
  });

  it('resumes immediately once a press lands after a paint', () => {
    pressNext();
    frames.paint();

    pressNext();
    expect(navigations).toEqual(['s2', 's3']);
  });

  it('re-anchors on the route when the selection changed between bursts', () => {
    pressNext();
    frames.paint();

    // The user clicked a different session in the sidebar instead.
    routeSessionId = 's5';
    pressNext();
    expect(navigations).toEqual(['s2', 's6']);
  });

  it('drops a queued navigation when a click claims the selection first', () => {
    pressNext();
    pressNext();
    expect(navigations).toEqual(['s2']);
    expect(frames.pending).toBe(1);

    // The click lands inside the very window the queued frame was waiting on.
    routeSessionId = 's9';

    frames.paint();
    expect(navigations).toEqual(['s2']);
    expect(frames.pending).toBe(0);

    // The next press continues from the click, not from the dead burst.
    pressNext();
    expect(navigations).toEqual(['s2', 's10']);
  });

  it('never carries a stale session across a workspace switch', () => {
    pressNext();
    pressNext();
    expect(frames.pending).toBe(1);

    // The workspace switched: different rows, and the route no longer points at
    // anything this burst navigated to.
    act(() => {
      store.set(
        sidebarNavItemsAtom,
        ['w2-a', 'w2-b', 'w2-c'].map((sessionId) => ({
          kind: 'session' as const,
          sessionId,
          groupKey: 'g2',
        }))
      );
    });
    routeSessionId = 'w2-a';

    frames.paint();
    // Anything here would be an old-workspace id resolved against the new
    // workspace slug — a route with no such session.
    expect(navigations).toEqual(['s2']);

    pressNext();
    expect(navigations).toEqual(['s2', 'w2-b']);
  });

  it('abandons a queued burst when a press follows an outside selection', () => {
    pressNext();
    expect(frames.pending).toBe(1);

    routeSessionId = 's9';
    // Pressing before the queued frame runs must not advance from the dead
    // burst, and must not leave its frame able to fire later.
    pressNext();
    expect(navigations).toEqual(['s2', 's10']);

    frames.paint();
    expect(navigations).toEqual(['s2', 's10']);
  });

  it('drops a queued navigation when its target leaves the list', () => {
    pressNext();
    pressNext();
    expect(navigations).toEqual(['s2']);

    // Two presses put the pending target on s3; it is archived while the frame
    // is still owed.
    act(() => {
      store.set(
        sidebarNavItemsAtom,
        SESSION_IDS.filter((id) => id !== 's3').map((sessionId) => ({
          kind: 'session' as const,
          sessionId,
          groupKey: 'g',
        }))
      );
    });

    frames.paint();
    expect(navigations).toEqual(['s2']);
    expect(frames.pending).toBe(0);
  });

  it('stops at the last session instead of wrapping', () => {
    routeSessionId = 's10';
    pressNext();
    expect(navigations).toEqual([]);
    expect(frames.pending).toBe(0);
  });

  it('drops a queued frame when the surface unmounts mid-burst', () => {
    pressNext();
    pressNext();
    expect(frames.pending).toBe(1);

    unmount();
    expect(frames.pending).toBe(0);
    expect(navigations).toEqual(['s2']);
  });
});
