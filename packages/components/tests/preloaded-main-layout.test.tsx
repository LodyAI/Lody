// @vitest-environment jsdom
import React, { act, Suspense, useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';

const moduleGate = vi.hoisted(() => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve, mounted: false };
});
vi.mock('../src/components/main-layout', async () => {
  await moduleGate.promise;
  return {
    MainLayout: ({ children }: { children: React.ReactNode }) => {
      const [value, setValue] = useState(0);
      useEffect(() => {
        moduleGate.mounted = true;
      }, []);
      return (
        <button onClick={() => setValue(value + 1)}>
          {value}:{children}
        </button>
      );
    },
  };
});
import { PreloadedMainLayout, preloadMainLayout } from '../src/components/preloaded-main-layout';

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('prepares without mounting, renders ready code immediately, and retains cold layout state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const coldContainer = document.createElement('div');
  const coldRoot = createRoot(coldContainer);
  roots.push(coldRoot);
  const tree = (label: string) => (
    <Suspense fallback={<span>Loading</span>}>
      <PreloadedMainLayout>{label}</PreloadedMainLayout>
    </Suspense>
  );
  await act(async () => coldRoot.render(tree('cold')));
  expect(coldContainer.textContent).toBe('Loading');
  const loading = preloadMainLayout();
  expect(moduleGate.mounted).toBe(false);
  await act(async () => {
    moduleGate.resolve();
    await loading;
  });
  await act(async () => coldContainer.querySelector('button')!.click());
  await act(async () => coldRoot.render(tree('updated')));
  expect(coldContainer.textContent).toBe('1:updated');

  const warmContainer = document.createElement('div');
  const warmRoot = createRoot(warmContainer);
  roots.push(warmRoot);
  // A synchronous commit must contain the prepared content, without a fallback.
  act(() => warmRoot.render(tree('warm')));
  expect(warmContainer.textContent).toBe('0:warm');
});
