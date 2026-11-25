/** @vitest-environment jsdom */
// Contract tests for the single useSyncExternalStore adapter. These pin the
// behaviors business modules rely on so no call site needs to hand-wire the
// primitive again: lease lifecycle keyed on the room, no re-render for
// same-identity publishes, the render/effect gap closed by the adapter, and
// StrictMode effect replay not corrupting lease counts.
import { act, StrictMode, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  constantSnapshotSource,
  useExternalSnapshot,
  type SnapshotSource,
} from '../src/lib/external-snapshot';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function makeSource(initial = 0) {
  let value = { n: initial };
  const listeners = new Set<() => void>();
  const source: SnapshotSource<{ n: number }> = {
    getSnapshot: () => value,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    source,
    listenerCount: () => listeners.size,
    publish(next: { n: number }) {
      value = next;
      for (const listener of [...listeners]) listener();
    },
    mutateSilent(next: { n: number }) {
      value = next;
    },
  };
}

describe('useExternalSnapshot', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('reads the room snapshot and re-renders on publish', async () => {
    const room = makeSource();
    function Consumer() {
      const v = useExternalSnapshot(room.source);
      return <output>{v.n}</output>;
    }
    await act(async () => root.render(<Consumer />));
    expect(container.querySelector('output')!.textContent).toBe('0');
    await act(async () => room.publish({ n: 7 }));
    expect(container.querySelector('output')!.textContent).toBe('7');
  });

  it('does not re-render when a publish keeps the same snapshot identity', async () => {
    const room = makeSource();
    let renders = 0;
    function Consumer() {
      renders += 1;
      const v = useExternalSnapshot(room.source);
      return <output>{v.n}</output>;
    }
    await act(async () => root.render(<Consumer />));
    const baseline = renders;
    // The room notifies listeners but the object identity is unchanged:
    // the adapter must not schedule a re-render.
    await act(async () => room.publish(room.source.getSnapshot()));
    expect(renders).toBe(baseline);
  });

  it('reads through to the room: silent mutations surface on the next render', async () => {
    const room = makeSource();
    function Consumer() {
      const v = useExternalSnapshot(room.source);
      return <output>{v.n}</output>;
    }
    await act(async () => root.render(<Consumer />));
    // Mutate without notifying, then publish the already-current object: the
    // publish signal alone must surface the room's latest value, because
    // reads always go to getSnapshot rather than a cached copy.
    room.mutateSilent({ n: 3 });
    await act(async () => room.publish(room.source.getSnapshot()));
    expect(container.querySelector('output')!.textContent).toBe('3');
  });

  it('acquires exactly one lease per mount and releases on unmount', async () => {
    const room = makeSource();
    let acquires = 0;
    let releases = 0;
    const acquire = vi.fn(() => {
      acquires += 1;
      return {
        release: () => {
          releases += 1;
        },
      };
    });
    function Consumer() {
      useExternalSnapshot(room.source, acquire);
      return null;
    }
    await act(async () => root.render(<Consumer />));
    expect(acquires).toBe(1);
    await act(async () => root.unmount());
    expect(releases).toBe(1);
  });

  it('a fresh inline acquire closure per render does not release/re-acquire', async () => {
    const room = makeSource();
    let acquires = 0;
    let releases = 0;
    function Consumer() {
      const [tick, force] = useState(0);
      useExternalSnapshot(room.source, () => {
        acquires += 1;
        return {
          release: () => {
            releases += 1;
          },
        };
      });
      return <button onClick={() => force((n) => n + 1)}>{tick}</button>;
    }
    await act(async () => root.render(<Consumer />));
    // Re-render with a brand-new inline acquire closure identity.
    await act(async () => {
      container.querySelector('button')!.click();
    });
    await act(async () => {
      container.querySelector('button')!.click();
    });
    expect(acquires).toBe(1);
    expect(releases).toBe(0);
  });

  it('re-acquires when the source (room) itself changes', async () => {
    const roomA = makeSource(1);
    const roomB = makeSource(100);
    let releases = 0;
    const acquire = vi.fn(() => ({
      release: () => {
        releases += 1;
      },
    }));
    function Consumer({ second }: { second: boolean }) {
      const v = useExternalSnapshot(second ? roomB.source : roomA.source, acquire);
      return <output>{v.n}</output>;
    }
    const { rerender } = await act(async () => {
      root.render(<Consumer second={false} />);
      return { rerender: (el: React.ReactElement) => root.render(el) };
    });
    expect(container.querySelector('output')!.textContent).toBe('1');
    await act(async () => rerender(<Consumer second={true} />));
    expect(container.querySelector('output')!.textContent).toBe('100');
    expect(releases).toBe(1);
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it('StrictMode effect replay keeps the lease balanced and subscribed once settled', async () => {
    const room = makeSource();
    let acquires = 0;
    let releases = 0;
    function Consumer() {
      useExternalSnapshot(room.source, () => {
        acquires += 1;
        return {
          release: () => {
            releases += 1;
          },
        };
      });
      return null;
    }
    await act(async () =>
      root.render(
        <StrictMode>
          <Consumer />
        </StrictMode>
      )
    );
    // StrictMode replays setup/cleanup once: acquires may exceed releases by
    // exactly the one live lease, and the subscription must be live.
    expect(acquires - releases).toBe(1);
    expect(room.listenerCount()).toBe(1);
    await act(async () => room.publish({ n: 5 }));
    await act(async () => root.unmount());
    expect(acquires).toBe(releases);
    expect(room.listenerCount()).toBe(0);
  });

  it('constantSnapshotSource never notifies and always reads the same value', async () => {
    const constant = constantSnapshotSource({ n: 42 });
    let renders = 0;
    function Consumer() {
      renders += 1;
      const v = useExternalSnapshot(constant);
      return <output>{v.n}</output>;
    }
    await act(async () => root.render(<Consumer />));
    expect(container.querySelector('output')!.textContent).toBe('42');
    expect(renders).toBe(1);
  });

  it('unsubscribes the room when the component unmounts', async () => {
    const room = makeSource();
    function Consumer() {
      useExternalSnapshot(room.source);
      return null;
    }
    await act(async () => root.render(<Consumer />));
    expect(room.listenerCount()).toBe(1);
    await act(async () => root.unmount());
    expect(room.listenerCount()).toBe(0);
  });
});
