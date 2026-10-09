// @vitest-environment jsdom
import React, { act, useState, useEffect } from 'react';
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
    MainLayout: ({
      children,
      workspaceReady = true,
    }: {
      children: React.ReactNode;
      workspaceReady?: boolean;
    }) => {
      const [value, setValue] = useState(0);
      useEffect(() => {
        moduleGate.mounted = true;
      }, []);
      return (
        <button data-ready={workspaceReady} onClick={() => setValue(value + 1)}>
          {value}:{children}
        </button>
      );
    },
  };
});
import { PreloadedMainLayout, preloadMainLayout } from '../src/components/preloaded-main-layout';
import { BOOT_SHELL_MARKUP } from '../src/lib/boot-shell';

const roots: ReturnType<typeof createRoot>[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

it('prepares without mounting, renders ready code immediately, and retains cold layout state', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const coldContainer = document.createElement('div');
  coldContainer.innerHTML = BOOT_SHELL_MARKUP;
  const coldRoot = createRoot(coldContainer);
  roots.push(coldRoot);
  const tree = (label: string, workspaceReady = true) => (
    <PreloadedMainLayout workspaceReady={workspaceReady}>{label}</PreloadedMainLayout>
  );
  await act(async () => coldRoot.render(tree('cold', false)));
  expect(coldContainer.querySelector('[data-lody-boot-shell]')).not.toBeNull();
  expect(coldContainer.querySelector('button')).toBeNull();
  const loading = preloadMainLayout();
  expect(moduleGate.mounted).toBe(false);
  await act(async () => {
    moduleGate.resolve();
    await loading;
  });
  expect(coldContainer.querySelector('[data-lody-boot-shell]')).toBeNull();
  expect(coldContainer.querySelector('button')?.textContent).toBe('0:cold');
  expect(coldContainer.querySelector('button')?.getAttribute('data-ready')).toBe('false');
  await act(async () => coldContainer.querySelector('button')!.click());
  await act(async () => coldRoot.render(tree('updated')));
  expect(coldContainer.querySelector('button')?.textContent).toBe('1:updated');
  expect(coldContainer.querySelector('button')?.getAttribute('data-ready')).toBe('true');

  const warmContainer = document.createElement('div');
  const warmRoot = createRoot(warmContainer);
  roots.push(warmRoot);
  // A synchronous commit must contain the prepared content, without a fallback.
  act(() => warmRoot.render(tree('warm')));
  expect(warmContainer.textContent).toBe('0:warm');
});
