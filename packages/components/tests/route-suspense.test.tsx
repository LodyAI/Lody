// @vitest-environment jsdom

import { act, lazy } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RouteSuspense } from '../src/components/route-suspense';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

it('renders a themed surface while a lazy route chunk loads', () => {
  const NeverLoads = lazy(() => new Promise<never>(() => {}));

  act(() => {
    root.render(
      <RouteSuspense>
        <NeverLoads />
      </RouteSuspense>
    );
  });

  // `fallback={null}` here is what left the window on the bare `<body>` canvas
  // for the length of the fetch, which is the white flash after signing in.
  expect(container.querySelector('[data-loading-placeholder-scope]')).not.toBeNull();
});
