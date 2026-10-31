// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WorkspaceKeyReceptionNotice,
  type KeyReceptionNoticeClock,
  type KeyReceptionWait,
} from '../src/components/workspace-key-reception-notice';
import { initI18n } from '../src/i18n';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const clock: KeyReceptionNoticeClock = {
  now: () => Date.now(),
  setTimeout: (callback, delay) => setTimeout(callback, delay),
  clearTimeout: (timer) => clearTimeout(timer),
};

describe('workspace key reception notice', () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    await initI18n('en');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });
  const render = (waiting: KeyReceptionWait | null, workspaceId = 'A') =>
    act(async () => {
      root.render(
        <>
          <WorkspaceKeyReceptionNotice workspaceId={workspaceId} waiting={waiting} clock={clock} />
          <input aria-label="Local draft" defaultValue="local edit" />
        </>
      );
    });
  const advance = (ms: number) =>
    act(async () => {
      vi.advanceTimersByTime(ms);
    });

  it.each([
    ['en', 'Receiving a new encryption key…'],
    ['zh_CN', '正在接收新的加密密钥…'],
  ])(
    'waits 30 seconds, stays nonblocking, and clears on installation (%s)',
    async (language, copy) => {
      await initI18n(language);
      const waiting = { workspaceId: 'A' };
      await render(waiting);
      const input = container.querySelector('input')!;
      input.value = 'still editing locally';
      input.focus();
      await advance(29_999);
      expect(container.querySelector('[role="status"]')).toBeNull();
      await render(waiting); // Repeated failure in the same episode must not reset its timer.
      await advance(2);
      expect(container.querySelector('[role="status"]')?.textContent).toBe(copy);
      expect(container.querySelector('[role="alert"], [aria-modal="true"], [inert]')).toBeNull();
      expect(input.disabled).toBe(false);
      expect(document.activeElement).toBe(input);
      await render(null);
      expect(container.querySelector('[role="status"]')).toBeNull();
      expect(container.querySelector('input')).toBe(input);
      expect(input.value).toBe('still editing locally');
      expect(document.activeElement).toBe(input);
    }
  );

  it('never shows another workspace’s wait and gives a new episode its own delay', async () => {
    const waiting = { workspaceId: 'A' };
    await render(waiting);
    await advance(20_000);
    await render(waiting, 'B');
    await advance(40_000);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await render({ workspaceId: 'B' }, 'B');
    await advance(29_999);
    expect(container.querySelector('[role="status"]')).toBeNull();
    await advance(2);
    expect(container.querySelector('[role="status"]')).not.toBeNull();
    await render(null, 'B');
    await render({ workspaceId: 'B' }, 'B');
    expect(container.querySelector('[role="status"]')).toBeNull();
    await advance(29_999);
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('cleans up a short wait before the threshold', async () => {
    await render({ workspaceId: 'A' });
    await advance(5_000);
    await render(null);
    await advance(60_000);
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
});
