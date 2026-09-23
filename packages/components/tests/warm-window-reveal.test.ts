// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { observePreparedTarget, waitForTargetContentPainted } from '../../../apps/electron/src/renderer/src/warm-window-reveal';

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
  root.innerHTML = '<span data-window-session-ready="a" data-window-requires-stream="true"></span><div data-window-session-stream-ready="a"></div>';
  let ready = false;
  const stop = observePreparedTarget(root, { workspace: 'local', sessionId: 'a' }, state => { ready = state; });
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
