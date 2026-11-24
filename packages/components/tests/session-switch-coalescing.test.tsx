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
import {
  SIDEBAR_SHORTCUT_HOLD_DELAY_MS,
  sidebarShortcutOverlayActiveAtom,
  sidebarShortcutPlatformOverrideAtom,
} from '../src/atoms/sidebar-shortcuts';
import { SidebarRowEndSlot } from '../src/components/sidebar-row-shared';
import { SidebarBindingPill } from '../src/components/sidebar-shortcut-pill';
import { useKeyboardNavigation } from '../src/hooks/use-keyboard-navigation';
import { __resetPlatformCacheForTests } from '../src/lib/commands/platform';
import { commands } from '../src/lib/commands/registry';
import { createTestI18n, withTestI18n } from './test-i18n';

const testI18n = createTestI18n();

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
  act(() => root.render(withTestI18n(createElement(Provider, { store }, children), testI18n)));
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
  vi.useRealTimers();
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
});

describe('sidebar visible session 1-9 shortcuts and pills', () => {
  it('switches to the 1st-9th visible session across section headers and abandons pending bursts', () => {
    act(() => {
      store.set(sidebarNavItemsAtom, [
        { kind: 'group-header', groupKey: 'pinned', collapsed: false },
        { kind: 'session', sessionId: 's1', groupKey: 'pinned' },
        { kind: 'local-project', machineId: 'm1', localProjectId: 'p1', collapsed: false },
        { kind: 'session', sessionId: 's2', groupKey: 'local-project:m1:p1' },
        { kind: 'session', sessionId: 's3', groupKey: 'local-project:m1:p1' },
        { kind: 'show-more', groupKey: 'local-project:m1:p1' },
        ...SESSION_IDS.slice(3).map((sessionId) => ({
          kind: 'session' as const,
          sessionId,
          groupKey: 'chats',
        })),
      ]);
    });

    pressNext();
    expect(navigations).toEqual(['s2']);
    pressNext();
    expect(frames.pending).toBe(1);

    let executed = false;
    act(() => {
      executed = commands.execute('session.switchToVisible9');
    });
    expect(executed).toBe(true);
    expect(navigations).toEqual(['s2', 's9']);

    // Stale queued burst frame must not overwrite the direct 1-9 jump.
    frames.paint();
    expect(navigations).toEqual(['s2', 's9']);

    // Out-of-range slot when fewer than 9 visible sessions exist is disabled.
    act(() => {
      store.set(sidebarNavItemsAtom, [
        { kind: 'session', sessionId: 's1', groupKey: 'chats' },
        { kind: 'session', sessionId: 's2', groupKey: 'chats' },
      ]);
    });
    expect(commands.execute('session.switchToVisible3')).toBe(false);
    expect(commands.execute('session.switchToVisible1')).toBe(true);
    expect(navigations).toEqual(['s2', 's9', 's1']);
  });

  it('reveals 1-9 pills only after holding the platform modifier and avoids quick-chord flash', () => {
    vi.useFakeTimers();
    act(() => {
      store.set(sidebarShortcutPlatformOverrideAtom, 'mac');
    });

    // Quick Cmd+K before hold delay must not flash the overlay.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }));
      vi.advanceTimersByTime(SIDEBAR_SHORTCUT_HOLD_DELAY_MS + 50);
    });
    expect(store.get(sidebarShortcutOverlayActiveAtom)).toBe(false);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', metaKey: false }));
    });

    // Holding Meta cleanly past the delay reveals the overlay and keeps it
    // open while pressing digits 1-9, then hides on release.
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', metaKey: true }));
      vi.advanceTimersByTime(SIDEBAR_SHORTCUT_HOLD_DELAY_MS - 1);
    });
    expect(store.get(sidebarShortcutOverlayActiveAtom)).toBe(false);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(store.get(sidebarShortcutOverlayActiveAtom)).toBe(true);

    act(() => {
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '2', code: 'Digit2', metaKey: true })
      );
    });
    expect(store.get(sidebarShortcutOverlayActiveAtom)).toBe(true);

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Meta', metaKey: false }));
    });
    expect(store.get(sidebarShortcutOverlayActiveAtom)).toBe(false);

    // Windows mode responds to Control and hides on window blur.
    act(() => {
      store.set(sidebarShortcutPlatformOverrideAtom, 'windows');
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Control', ctrlKey: true }));
      vi.advanceTimersByTime(SIDEBAR_SHORTCUT_HOLD_DELAY_MS);
    });
    expect(store.get(sidebarShortcutOverlayActiveAtom)).toBe(true);

    act(() => {
      window.dispatchEvent(new Event('blur'));
    });
    expect(store.get(sidebarShortcutOverlayActiveAtom)).toBe(false);
  });

  it('renders macOS icon pills and Windows Control pills only on the first 9 rows', () => {
    renderWith(
      createElement(
        'div',
        null,
        createElement(Harness),
        createElement(SidebarRowEndSlot, { sessionId: 's1', selected: true }),
        createElement(SidebarRowEndSlot, { sessionId: 's9' }),
        createElement(SidebarRowEndSlot, { sessionId: 's10' })
      )
    );

    act(() => {
      store.set(sidebarShortcutPlatformOverrideAtom, 'mac');
      store.set(sidebarShortcutOverlayActiveAtom, true);
    });

    const pill1 = container.querySelector('[data-sidebar-shortcut-pill="1"]');
    const pill9 = container.querySelector('[data-sidebar-shortcut-pill="9"]');
    const pill10 = container.querySelector('[data-sidebar-shortcut-pill="10"]');
    expect(pill1?.getAttribute('data-sidebar-shortcut-platform')).toBe('mac');
    expect(pill1?.querySelector('svg')).not.toBeNull();
    expect(pill1?.textContent).toBe('1');
    expect(pill9?.textContent).toBe('9');
    expect(pill10).toBeNull();

    act(() => {
      store.set(sidebarShortcutPlatformOverrideAtom, 'windows');
    });
    const winPill1 = container.querySelector('[data-sidebar-shortcut-pill="1"]');
    expect(winPill1?.getAttribute('data-sidebar-shortcut-platform')).toBe('windows');
    expect(winPill1?.querySelector('svg')).toBeNull();
    expect(winPill1?.textContent).toBe('Control1');
  });

  it('grows the ⇧ glyph inside a macOS binding pill to match ⌘ ink', () => {
    (window as { __LODY_PLATFORM__?: { os?: string } }).__LODY_PLATFORM__ = { os: 'darwin' };
    __resetPlatformCacheForTests();
    try {
      renderWith(createElement(SidebarBindingPill, { binding: 'Mod+Shift+D' }));

      const pill = container.querySelector('[data-sidebar-binding-pill="Mod+Shift+D"]');
      expect(pill).not.toBeNull();
      const [commandGlyph, shiftGlyph] = pill!.querySelectorAll('svg');
      expect(pill!.querySelectorAll('svg')).toHaveLength(2);
      expect(shiftGlyph.getAttribute('stroke-width')).toBe('1.5');
      expect(commandGlyph.getAttribute('stroke-width')).toBe('2');
      const commandClasses = new Set((commandGlyph.getAttribute('class') ?? '').split(' '));
      const grownClasses = (shiftGlyph.getAttribute('class') ?? '')
        .split(' ')
        .filter((name) => !commandClasses.has(name) && !name.startsWith('lucide'));
      expect(grownClasses).toHaveLength(1);
      expect(pill!.textContent).toBe('D');
    } finally {
      delete (window as { __LODY_PLATFORM__?: { os?: string } }).__LODY_PLATFORM__;
      __resetPlatformCacheForTests();
    }
  });
});
