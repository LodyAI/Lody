// @vitest-environment jsdom

// Regression coverage for the file-tree virtualization perf bugs: an empty
// virtual range must never fall back to mounting every visible row, the
// scrollport must get measured once it is actually attached, and icon component
// identity must survive a tree rebuild so row memoization can hold.

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileTreeProviderView } from '../src/components/sessions/components/file-tree-view';
import {
  createFileIconComponent,
  createFolderIconComponent,
} from '../src/components/icons/file-icons';
import type { FileWorkspaceProvider } from '../src/lib/file-workspace-provider';
import { initI18n } from '../src/i18n';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ROW_HEIGHT_PX = 22;
const VIEWPORT_HEIGHT_PX = 220;
const OVERSCAN = 12;
const FILE_COUNT = 400;

// jsdom reports every element as 0x0, so the virtualizer would measure an empty
// viewport forever. Give the ScrollArea viewport a real height the way the
// browser would. `viewportHeightPx` is per-test so we can also reproduce the
// scrollport that measures 0, which is what produced the empty virtual range.
let viewportHeightPx = VIEWPORT_HEIGHT_PX;

function installLayoutStubs(): void {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.hasAttribute('data-radix-scroll-area-viewport') ? viewportHeightPx : 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get: () => 320,
  });
}

function createReadyProvider(paths: readonly string[]): FileWorkspaceProvider {
  return {
    kind: 'code-collab',
    getState: () => ({ kind: 'code-collab', ready: true, sourceState: 'live-readonly' }),
    listFiles: async () =>
      paths.map((path) => ({ path, kind: 'text' as const, sourceState: 'live-readonly' as const })),
  } as unknown as FileWorkspaceProvider;
}

describe('VirtualFileTree row mounting', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    await initI18n('en');
    viewportHeightPx = VIEWPORT_HEIGHT_PX;
    installLayoutStubs();
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  async function render(node: ReactNode): Promise<HTMLDivElement> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(node);
    });
    return container;
  }

  function countRows(host: HTMLElement): number {
    return host.querySelectorAll('[role="treeitem"]').length;
  }

  it('mounts only a viewport-sized window of rows instead of the whole tree', async () => {
    // Flat root-level files, so every file is a visible row with no expansion.
    const paths = Array.from({ length: FILE_COUNT }, (_, index) => `file-${index}.ts`);
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createReadyProvider(paths),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
      })
    );

    const rowCount = countRows(host);
    // The bug rendered all FILE_COUNT rows whenever the virtual range came back
    // empty. Assert the real virtualization bound instead of "fewer than all".
    const expectedCeiling = Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX) + 2 * OVERSCAN + 2;
    expect(rowCount).toBeGreaterThan(0);
    expect(rowCount).toBeLessThanOrEqual(expectedCeiling);
    expect(rowCount).toBeLessThan(FILE_COUNT);

    // The spacer must carry the full scrollable height even though only a
    // window is mounted, otherwise the scrollport can never resolve a range.
    const tree = host.querySelector('[role="tree"]') as HTMLElement | null;
    expect(tree?.style.height).toBe(`${FILE_COUNT * ROW_HEIGHT_PX}px`);
  });

  // The original bug: whenever the virtual range came back empty — a viewport
  // that still measures 0 being the common cause — the component rendered the
  // full `rows.map`, mounting the entire expanded tree at the exact moment
  // virtualization was needed. An unresolved range must mount no rows and keep
  // the spacer, so a later measure can still resolve one.
  it('mounts no rows rather than the whole tree while the scrollport measures 0', async () => {
    viewportHeightPx = 0;
    const paths = Array.from({ length: FILE_COUNT }, (_, index) => `file-${index}.ts`);
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createReadyProvider(paths),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
      })
    );

    expect(countRows(host)).toBe(0);
    const tree = host.querySelector('[role="tree"]') as HTMLElement | null;
    expect(tree?.style.height).toBe(`${FILE_COUNT * ROW_HEIGHT_PX}px`);
  });

  // Scrolling must move the mounted window rather than grow it. This is the
  // acceptance criterion the row memoization exists to serve: the committed row
  // set stays viewport-sized for the whole gesture.
  it('shifts the mounted window on scroll without growing it', async () => {
    const paths = Array.from({ length: FILE_COUNT }, (_, index) => `file-${index}.ts`);
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createReadyProvider(paths),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
      })
    );

    const viewport = host.querySelector('[data-radix-scroll-area-viewport]') as HTMLElement;
    const ceiling = Math.ceil(VIEWPORT_HEIGHT_PX / ROW_HEIGHT_PX) + 2 * OVERSCAN + 2;
    const firstLabel = () => host.querySelector('[role="treeitem"] span')?.textContent;

    expect(firstLabel()).toBe('file-0.ts');

    for (const scrollTop of [ROW_HEIGHT_PX * 40, ROW_HEIGHT_PX * 120, ROW_HEIGHT_PX * 300]) {
      viewport.scrollTop = scrollTop;
      await act(async () => {
        viewport.dispatchEvent(new Event('scroll'));
      });
      expect(countRows(host)).toBeLessThanOrEqual(ceiling);
    }

    // The window actually followed the scroll instead of staying pinned at the top.
    expect(firstLabel()).not.toBe('file-0.ts');
  });

  it('renders every row without a spacer for a small tree', async () => {
    const paths = Array.from({ length: 5 }, (_, index) => `file-${index}.ts`);
    const host = await render(
      createElement(FileTreeProviderView, {
        fileProvider: createReadyProvider(paths),
        fileProviderPending: false,
        handleOpenFile: () => undefined,
      })
    );

    expect(countRows(host)).toBe(5);
    const tree = host.querySelector('[role="tree"]') as HTMLElement | null;
    expect(tree?.style.height).toBe('');
  });
});

describe('file icon component identity', () => {
  // A fresh component type per call made React unmount and remount every icon
  // whenever the parent rebuilt tree data for the same paths, which also
  // defeated row memoization.
  it('returns a stable component for repeated calls on the same path', () => {
    expect(createFileIconComponent('src/index.ts')).toBe(createFileIconComponent('src/index.ts'));
    expect(createFolderIconComponent('src/components')).toBe(
      createFolderIconComponent('src/components')
    );
  });

  it('shares one component across paths that resolve to the same icon', () => {
    expect(createFileIconComponent('a/one.ts')).toBe(createFileIconComponent('b/two.ts'));
  });

  it('still distinguishes paths that resolve to different icons', () => {
    expect(createFileIconComponent('src/index.ts')).not.toBe(createFileIconComponent('README.md'));
  });
});
