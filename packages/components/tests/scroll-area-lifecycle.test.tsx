// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root as ReactRoot } from 'react-dom/client';
import { ScrollArea } from '@lody/ui/scroll-area';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('ScrollArea lifecycle', () => {
  let root: ReactRoot | undefined;
  let host: HTMLDivElement;
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    root = undefined;
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
    await act(async () => {
      root = createRoot(host);
      root.render(
        <ScrollArea visibility="always">
          <div>Synthetic scroll content</div>
        </ScrollArea>
      );
    });
    const viewport = host.querySelector<HTMLDivElement>('[data-scroll-area-viewport]')!;
    viewport.getAnimations = () => [];
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

  it('samples scroll events without polling the viewport between them', async () => {
    const { viewport, readCount } = await mount();
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    const before = readCount();
    await advanceFrames(3);
    expect(readCount()).toBe(before);
    await act(async () => vi.advanceTimersByTime(100));
    const stopped = readCount();
    await advanceFrames(3);
    expect(readCount()).toBe(stopped);
    expect(frames.size).toBe(0);
    await act(async () => viewport.dispatchEvent(new Event('scroll')));
    await advanceFrames(3);
    expect(readCount()).toBeGreaterThan(stopped);
  });

  it('keeps the viewport node and its ref stable when content updates', async () => {
    const render = async (text: string) => {
      await act(async () => {
        root ??= createRoot(host);
        root.render(<ScrollArea>{text}</ScrollArea>);
      });
    };
    await render('Initial content');
    const viewport = host.querySelector('[data-scroll-area-viewport]');

    await render('Updated content');

    expect(host.querySelector('[data-scroll-area-viewport]')?.textContent).toBe('Updated content');
    expect(host.querySelector('[data-scroll-area-viewport]')).toBe(viewport);
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
