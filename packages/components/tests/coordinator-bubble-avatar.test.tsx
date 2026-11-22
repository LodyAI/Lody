/** @vitest-environment jsdom */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import angryJson from '../src/assets/coordinator-avatar/angry.json';
import confusedJson from '../src/assets/coordinator-avatar/confused.json';
import happyJson from '../src/assets/coordinator-avatar/happy.json';
import sadJson from '../src/assets/coordinator-avatar/sad.json';
import thinkingJson from '../src/assets/coordinator-avatar/thinking.json';
import {
  resetCoordinatorAvatarPlaybackForTest,
  seedCoordinatorAvatarStreamSnapshot,
} from '../src/components/project-mode/coordinator-avatar-mood';
import {
  CoordinatorBubbleAvatar,
  loadCoordinatorAvatarMoodData,
} from '../src/components/project-mode/coordinator-bubble-avatar';
import {
  mountCoordinatorLottieOnce,
  type CoordinatorLottieData,
} from '../src/components/project-mode/coordinator-lottie-player';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('CoordinatorBubbleAvatar and vector Lottie player', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    resetCoordinatorAvatarPlaybackForTest();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it.each([
    ['thinking', thinkingJson],
    ['happy', happyJson],
    ['confused', confusedJson],
    ['sad', sadJson],
    ['angry', angryJson],
  ] as const)('renders %s vector Lottie frames at 32x32 and fires onComplete once', (_mood, raw) => {
    const host = document.createElement('div');
    let currentMs = 1000;
    let pendingFrame: ((ts: number) => void) | null = null;
    let completed = 0;

    const dispose = mountCoordinatorLottieOnce({
      container: host,
      data: raw as unknown as CoordinatorLottieData,
      size: 32,
      now: () => currentMs,
      requestFrame: (cb) => {
        pendingFrame = cb;
        return 1;
      },
      cancelFrame: () => {
        pendingFrame = null;
      },
      onComplete: () => {
        completed += 1;
      },
    });

    const svg = host.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('32');
    expect(svg?.getAttribute('height')).toBe('32');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 160 160');
    expect(svg?.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(svg?.querySelectorAll('linearGradient').length).toBeGreaterThan(0);

    currentMs = 1400;
    pendingFrame?.(currentMs);
    expect(completed).toBe(0);

    currentMs = 4000;
    pendingFrame?.(currentMs);
    expect(completed).toBe(1);

    dispose();
    expect(host.querySelector('svg')).toBeNull();
  });

  it('plays once on a fresh message event, returns to idle.png on completion, and stays idle on remount', async () => {
    const rafQueue: Array<(ts: number) => void> = [];
    let clockMs = 10_000;
    vi.spyOn(performance, 'now').mockImplementation(() => clockMs);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);

    await loadCoordinatorAvatarMoodData('happy');
    const scopeKey = 'coord-dom-test:main';
    const createdAt = Date.now();
    seedCoordinatorAvatarStreamSnapshot(scopeKey, [], true, createdAt - 100);

    await act(async () => {
      root!.render(
        React.createElement(CoordinatorBubbleAvatar, {
          scopeKey,
          bubbleKey: 'assistant:turn-1:b-happy',
          entry: { body: '测试全部通过，PR 已合并完成！' },
          createdAt,
        })
      );
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const avatarEl = container!.querySelector('[data-coordinator-bubble-avatar]');
    expect(avatarEl?.getAttribute('data-avatar-mood')).toBe('happy');
    expect(avatarEl?.getAttribute('data-avatar-state')).toBe('playing');
    expect(avatarEl?.querySelector('svg')).not.toBeNull();

    await act(async () => {
      clockMs += 2000;
      const next = rafQueue.pop();
      next?.(clockMs);
    });

    expect(avatarEl?.getAttribute('data-avatar-state')).toBe('idle');
    expect(avatarEl?.querySelector('svg')).toBeNull();
    const idleImg = avatarEl?.querySelector('img');
    expect(idleImg).not.toBeNull();
    expect(idleImg?.getAttribute('width')).toBe('32');
    expect(idleImg?.getAttribute('height')).toBe('32');

    await act(async () => {
      root!.unmount();
    });
    root = createRoot(container!);
    await act(async () => {
      root!.render(
        React.createElement(CoordinatorBubbleAvatar, {
          scopeKey,
          bubbleKey: 'assistant:turn-1:b-happy',
          entry: { body: '测试全部通过，PR 已合并完成！' },
          createdAt,
        })
      );
    });

    const remounted = container!.querySelector('[data-coordinator-bubble-avatar]');
    expect(remounted?.getAttribute('data-avatar-state')).toBe('idle');
    expect(remounted?.querySelector('svg')).toBeNull();
  });
});
