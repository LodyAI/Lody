// @vitest-environment jsdom
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForTargetContentPainted } from '../../../apps/electron/src/renderer/src/warm-window-reveal';

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
