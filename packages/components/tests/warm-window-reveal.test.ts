// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForTargetContentPainted } from '../../../apps/electron/src/renderer/src/warm-window-reveal';

afterEach(() => vi.useRealTimers());

describe('warm window reveal', () => {
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

  it('reveals the matching workspace and leaves recovery reachable after the deadline', () => {
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
    expect(revealed).toBe(true);
  });
});
