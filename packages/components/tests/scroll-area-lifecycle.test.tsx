// @vitest-environment jsdom

import { createRequire } from 'node:module';
import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import * as ScrollArea from '@radix-ui/react-scroll-area';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const commonJS = require('@radix-ui/react-scroll-area') as typeof ScrollArea;

describe.each([
  ['ESM', ScrollArea],
  ['CommonJS', commonJS],
] as const)('ScrollArea lifecycle (%s)', (_entry, primitive) => {
  let root: ReactRoot | undefined;
  let host: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    vi.useFakeTimers();
    frames = new Map();
    nextFrame = 0;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.set(++nextFrame, callback);
      return nextFrame;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
    host = document.createElement('div');
    document.body.append(host);
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    host.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function mount() {
    const { Root, Viewport, Scrollbar, Thumb } = primitive;
    await act(async () => {
      root = createRoot(host);
      root.render(
        <Root type="always">
          <Viewport>
            <div>Synthetic scroll content</div>
          </Viewport>
          <Scrollbar orientation="vertical" forceMount>
            <Thumb forceMount />
          </Scrollbar>
        </Root>
      );
    });
    const viewport = host.querySelector<HTMLDivElement>('[data-radix-scroll-area-viewport]')!;
    let reads = 0;
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => {
        reads++;
        return 1;
      },
    });
    return { viewport, readCount: () => reads };
  }

  async function advanceFrames(count: number) {
    await act(async () => {
      for (let frame = 0; frame < count; frame++) {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach((callback) => callback(frame * 16));
      }
    });
  }

  it('stops polling after scroll end and restarts on the next scroll', async () => {
    const { viewport, readCount } = await mount();
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    const before = readCount();
    await advanceFrames(3);
    expect(readCount()).toBeGreaterThan(before);
    await act(async () => vi.advanceTimersByTime(100));
    const stopped = readCount();
    await advanceFrames(3);
    expect(readCount()).toBe(stopped);
    expect(frames.size).toBe(0);
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    await advanceFrames(3);
    expect(readCount()).toBeGreaterThan(stopped);
  });

  it('releases polling during scroll without accumulating detached viewport reads', async () => {
    const removed: Array<{ viewport: HTMLDivElement; readCount: () => number; stopped: number }> =
      [];
    for (let cycle = 0; cycle < 10; cycle++) {
      const target = await mount();
      await act(async () => target.viewport.dispatchEvent(new Event('scroll')));
      await advanceFrames(1);
      await act(async () => root!.unmount());
      root = undefined;
      removed.push({ ...target, stopped: target.readCount() });
    }
    await act(async () => vi.advanceTimersByTime(100));
    await advanceFrames(120);
    expect(removed.every(({ viewport }) => !viewport.isConnected)).toBe(true);
    expect(removed.map(({ readCount }) => readCount())).toEqual(
      removed.map(({ stopped }) => stopped)
    );
    expect(frames.size).toBe(0);
  });
});
