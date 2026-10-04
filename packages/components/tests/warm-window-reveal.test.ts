// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  observePreparedTarget,
  waitForTargetContentPainted,
} from '../../../apps/electron/src/renderer/src/warm-window-reveal';

afterEach(() => vi.useRealTimers());

describe('warm window reveal', () => {
  it('waits for the matching stream to finish hydration and initial scroll restoration', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML =
      '<span data-window-session-ready="target" data-window-requires-stream="true"></span><div data-window-session-stream-ready="other"></div>';
    let revealed = false;
    waitForTargetContentPainted(root, { workspace: 'work', sessionId: 'target' }, () => {
      revealed = true;
    });
    vi.advanceTimersByTime(100);
    expect(revealed).toBe(false);
    root.lastElementChild!.setAttribute('data-window-session-stream-ready', 'target');
    vi.advanceTimersToNextFrame();
    expect(revealed).toBe(false);
    vi.advanceTimersToNextFrame();
    expect(revealed).toBe(true);
  });

  it('ignores loading, sidebar text, and other sessions until the target commits twice', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML =
      '<div>Loading session</div><aside>Workspace</aside><span data-window-session-ready="other"></span>';
    let revealed = false;
    waitForTargetContentPainted(root, { workspace: 'work', sessionId: 'target' }, () => {
      revealed = true;
    });
    vi.advanceTimersByTime(100);
    expect(revealed).toBe(false);
    root.innerHTML = '<span hidden data-window-session-ready="target"></span>';
    vi.advanceTimersToNextFrame();
    expect(revealed).toBe(false);
    root.innerHTML = '<div>Loading session</div>';
    vi.advanceTimersToNextFrame();
    root.innerHTML = '<span hidden data-window-session-ready="target"></span>';
    vi.advanceTimersToNextFrame();
    expect(revealed).toBe(false);
    vi.advanceTimersToNextFrame();
    expect(revealed).toBe(true);
  });

  it('signals the matching workspace but never labels a timeout as ready', () => {
    vi.useFakeTimers();
    const root = document.createElement('div');
    root.innerHTML = '<div data-window-workspace-ready="work"></div>';
    let revealed = false;
    waitForTargetContentPainted(root, { workspace: 'work' }, () => {
      revealed = true;
    });
    vi.advanceTimersToNextFrame();
    vi.advanceTimersToNextFrame();
    expect(revealed).toBe(true);
    root.innerHTML = '<div>Connection failed</div>';
    revealed = false;
    waitForTargetContentPainted(root, { workspace: 'work' }, () => {
      revealed = true;
    });
    vi.advanceTimersByTime(4992);
    expect(revealed).toBe(false);
    vi.advanceTimersByTime(32);
    expect(revealed).toBe(false);
  });
});

it('revokes prepared readiness when its stream disappears, and stops after disposal', async () => {
  vi.useFakeTimers();
  const root = document.createElement('div');
  root.innerHTML =
    '<span data-window-session-ready="a" data-window-requires-stream="true"></span><div data-window-session-stream-ready="a"></div>';
  let ready = false;
  const stop = observePreparedTarget(root, { workspace: 'local', sessionId: 'a' }, (state) => {
    ready = state;
  });
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(ready).toBe(true);
  root.lastElementChild!.remove();
  await Promise.resolve();
  expect(ready).toBe(false);
  root.insertAdjacentHTML('beforeend', '<div data-window-session-stream-ready="a"></div>');
  await Promise.resolve();
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(ready).toBe(true);
  window.dispatchEvent(new Event('resize'));
  expect(ready).toBe(false);
  vi.advanceTimersToNextFrame();
  vi.advanceTimersToNextFrame();
  expect(ready).toBe(true);
  stop();
  root.innerHTML = '';
  await Promise.resolve();
  expect(ready).toBe(true);
});

// Data handoff runs after a concrete open request, before mounting the target route.
describe('window target data handoff', () => {
  it('uses the acquired store before routing and releases its temporary reference', async () => {
    const { createWindowTargetNavigator } =
      await import('../../../apps/electron/src/renderer/src/window-target-navigation');
    vi.useFakeTimers();
    let resolve!: (store: never) => void;
    const loading = new Promise<never>((done) => {
      resolve = done;
    });
    const borrowed = new Set<string>();
    let route = '';
    let ready = false;
    const navigate = createWindowTargetNavigator({
      getRuntime: () => ({
        workspaceSlug: 'local',
        acquireSessionStore: async (id) => {
          const store = await loading;
          borrowed.add(id);
          return store;
        },
        releaseSessionStoreRef: (id) => {
          borrowed.delete(id);
        },
      }),
      applyRoute: async (target) => {
        route = target.sessionId!;
      },
      reportError: (error) => {
        throw error;
      },
    });
    const pending = navigate({ workspace: 'local', sessionId: 'a' }, () => {
      ready = true;
    });
    expect(route).toBe('');
    resolve({} as never);
    await pending;
    expect(route).toBe('a');
    expect(ready).toBe(true);
    expect(borrowed.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets a slow open reach loading UI and releases a late store without changing the route', async () => {
    const { createWindowTargetNavigator } =
      await import('../../../apps/electron/src/renderer/src/window-target-navigation');
    vi.useFakeTimers();
    let resolve!: (store: never) => void;
    const loading = new Promise<never>((done) => {
      resolve = done;
    });
    const borrowed = new Set<string>();
    let route = '';
    const navigate = createWindowTargetNavigator({
      getRuntime: () => ({
        workspaceSlug: 'local',
        acquireSessionStore: async (id) => {
          const store = await loading;
          borrowed.add(id);
          return store;
        },
        releaseSessionStoreRef: (id) => {
          borrowed.delete(id);
        },
      }),
      applyRoute: async (target) => {
        route = target.sessionId!;
      },
      reportError: (error) => {
        throw error;
      },
    });
    const pending = navigate({ workspace: 'local', sessionId: 'slow' }, () => {});
    await vi.advanceTimersByTimeAsync(50);
    await pending;
    expect(route).toBe('slow');
    resolve({} as never);
    await loading;
    await Promise.resolve();
    expect(borrowed.size).toBe(0);
    expect(route).toBe('slow');
  });

  it('fences an older acquisition when a later target wins, and routes failures to the normal UI', async () => {
    const { createWindowTargetNavigator } =
      await import('../../../apps/electron/src/renderer/src/window-target-navigation');
    vi.useFakeTimers();
    let resolve!: (store: never) => void;
    const loading = new Promise<never>((done) => {
      resolve = done;
    });
    let route = '';
    const completed: string[] = [];
    const errors: unknown[] = [];
    const navigate = createWindowTargetNavigator({
      getRuntime: () => ({
        workspaceSlug: 'local',
        acquireSessionStore: (id) =>
          id === 'old' ? loading : Promise.reject(new Error('storage unavailable')),
        releaseSessionStoreRef: () => {},
      }),
      applyRoute: async (target) => {
        route = target.sessionId!;
      },
      reportError: (error) => {
        errors.push(error);
      },
    });
    const old = navigate({ workspace: 'local', sessionId: 'old' }, () => {
      completed.push('old');
    });
    await navigate({ workspace: 'local', sessionId: 'new' }, () => {
      completed.push('new');
    });
    resolve({} as never);
    await old;
    expect(route).toBe('new');
    expect(completed).toEqual(['new']);
    expect(errors).toHaveLength(1);
    await navigate({ workspace: 'other', sessionId: 'elsewhere' }, () => {});
    expect(route).toBe('elsewhere');
    expect(errors).toHaveLength(1);
  });
});
