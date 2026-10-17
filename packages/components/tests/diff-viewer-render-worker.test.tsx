// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDiffFromFile, type FileDiffMetadata } from '@pierre/diffs';

const workerMocks = vi.hoisted(() => {
  const pool = { kind: 'shared-diff-render-worker' };
  return {
    pool,
    configurePool: vi.fn(() => Promise.resolve()),
    createPool: vi.fn(() => pool),
    parse: vi.fn<(input: { path: string }) => Promise<FileDiffMetadata | undefined>>(),
  };
});

vi.mock('../src/lib/diff-parse-worker', () => ({
  parseDiffInWorker: workerMocks.parse,
  parseDiffTextSourceInWorker: workerMocks.parse,
}));

vi.mock('../src/ui/diff-viewer/diff-render-worker', () => ({
  configureDiffRenderWorkerPool: workerMocks.configurePool,
  createDiffRenderWorkerPool: workerMocks.createPool,
}));

vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react');
  const WorkerPoolContext = React.createContext<unknown>(undefined);
  return {
    FileDiff: ({ fileDiff }: { fileDiff: FileDiffMetadata }) => {
      const workerPool = React.useContext(WorkerPoolContext);
      return React.createElement(
        'div',
        {
          'data-testid': 'file-diff',
          'data-render-worker': workerPool === workerMocks.pool ? 'shared' : 'main-thread',
        },
        fileDiff.newLines?.join(''),
        React.createElement('textarea', { 'aria-label': 'Comment' })
      );
    },
    WorkerPoolContext,
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

vi.mock('../src/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}));

vi.mock('../src/theme-provider', () => ({
  useActiveVSCodeDiffThemeName: () => undefined,
  useResolvedTheme: () => 'dark',
}));

import { DiffViewer } from '../src/ui/diff-viewer/diff-viewer';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('DiffViewer render worker routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    workerMocks.configurePool.mockClear();
    workerMocks.createPool.mockClear();
    workerMocks.createPool.mockReturnValue(workerMocks.pool);
    workerMocks.parse.mockReset();
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('keeps a sub-threshold syntax diff off the main-thread highlighter', async () => {
    const oldText = 'export const mode = "old";\n';
    const newText = 'export const mode = "new";\n';
    expect(oldText.length + newText.length).toBeLessThan(200_000);

    await act(async () => {
      root.render(
        createElement(DiffViewer, {
          path: 'src/config.ts',
          oldText,
          newText,
          showHeader: false,
        })
      );
    });

    expect(
      container.querySelector('[data-testid="file-diff"]')?.getAttribute('data-render-worker')
    ).toBe('shared');
  });

  it('retains the main-thread fallback when the runtime cannot create a worker pool', async () => {
    workerMocks.createPool.mockReturnValue(undefined);

    await act(async () => {
      root.render(
        createElement(DiffViewer, {
          path: 'README.md',
          oldText: 'before\n',
          newText: 'after\n',
          showHeader: false,
        })
      );
    });

    expect(
      container.querySelector('[data-testid="file-diff"]')?.getAttribute('data-render-worker')
    ).toBe('main-thread');
  });

  it('shows loading for a short worker-parsed diff, then suspends and restores its code', async () => {
    let finish!: (diff: FileDiffMetadata) => void;
    workerMocks.parse.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const props = {
      path: 'short.ts',
      oldText: 'old\n',
      newText: 'new\n',
      showHeader: false,
      preferParseWorker: true,
    };
    await act(async () => root.render(createElement(DiffViewer, props)));
    expect(container.textContent).toContain('Preparing diff');
    expect(container.querySelector('[data-testid="file-diff"]')).toBeNull();
    await act(async () =>
      finish(
        parseDiffFromFile(
          { name: props.path, contents: props.oldText },
          { name: props.path, contents: props.newText }
        )
      )
    );
    expect(container.querySelector('[data-testid="file-diff"]')?.textContent).toBe('new\n');
    await act(async () =>
      root.render(createElement(DiffViewer, { ...props, renderContent: false }))
    );
    expect(container.querySelector('[data-testid="file-diff"]')).toBeNull();
    await act(async () => root.render(createElement(DiffViewer, props)));
    expect(container.querySelector('[data-testid="file-diff"]')?.textContent).toBe('new\n');
  });

  it('retains an unsent form when its code scrolls out of view', async () => {
    const props = { path: 'draft.ts', oldText: 'old\n', newText: 'new\n', showHeader: false };
    await act(async () => root.render(createElement(DiffViewer, props)));
    const input = container.querySelector('textarea')!;
    await act(async () => {
      input.focus();
      input.value = 'Keep this reply';
    });
    await act(async () =>
      root.render(createElement(DiffViewer, { ...props, renderContent: false }))
    );
    expect(container.querySelector('textarea')).toBe(input);
    expect(input.value).toBe('Keep this reply');
  });

  it('serializes worker jobs and discards a queued body that is no longer visible', async () => {
    let active = false;
    let allowSecond = false;
    const finish = new Map<string, () => void>();
    workerMocks.parse.mockImplementation(({ path }) => {
      if (active) throw new Error('Concurrent parse started in a single worker');
      if (path === 'second.ts' && !allowSecond) throw new Error('Invisible queued parse started');
      active = true;
      return new Promise((resolve) =>
        finish.set(path, () => {
          active = false;
          resolve(
            parseDiffFromFile(
              { name: path, contents: 'old\n' },
              { name: path, contents: `${path}-output\n` }
            )
          );
        })
      );
    });
    const viewers = (secondVisible: boolean) =>
      createElement(
        'div',
        null,
        ...['first.ts', 'second.ts'].map((path, index) =>
          createElement(DiffViewer, {
            key: path,
            path,
            oldText: 'old\n',
            newText: `${path}-output\n`,
            showHeader: false,
            preferParseWorker: true,
            renderContent: index === 0 || secondVisible,
          })
        )
      );
    await act(async () => root.render(viewers(true)));
    await act(async () => root.render(viewers(false)));
    await act(async () => finish.get('first.ts')!());
    expect(container.querySelectorAll('[data-testid="file-diff"]')).toHaveLength(1);
    allowSecond = true;
    await act(async () => root.render(viewers(true)));
    await act(async () => finish.get('second.ts')!());
    expect(container.textContent).toContain('first.ts-output');
    expect(container.textContent).toContain('second.ts-output');
  });

  it('does not reuse parsed output after an equal-length edit outside sampled text', async () => {
    const before = 'a'.repeat(1000) + '\n';
    const first = before.slice(0, 200) + '1' + before.slice(201);
    const second = before.slice(0, 200) + '2' + before.slice(201);
    const props = {
      path: 'live.txt',
      oldText: before,
      newText: first,
      showHeader: false,
      preferParseWorker: true,
    };
    workerMocks.parse.mockResolvedValue(
      parseDiffFromFile(
        { name: props.path, contents: before },
        { name: props.path, contents: first }
      )
    );
    await act(async () => root.render(createElement(DiffViewer, props)));
    expect(container.querySelector('[data-testid="file-diff"]')?.textContent).toBe(first);
    let finish!: (diff: FileDiffMetadata) => void;
    workerMocks.parse.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    await act(async () => root.render(createElement(DiffViewer, { ...props, newText: second })));
    expect(container.querySelector('[data-testid="file-diff"]')).toBeNull();
    await act(async () =>
      finish(
        parseDiffFromFile(
          { name: props.path, contents: before },
          { name: props.path, contents: second }
        )
      )
    );
    expect(container.querySelector('[data-testid="file-diff"]')?.textContent).toBe(second);
  });

  it('shows worker failures without synchronously parsing a multi-file cache miss', async () => {
    workerMocks.parse.mockRejectedValue(new Error('parse worker failed'));
    await act(async () =>
      root.render(
        createElement(DiffViewer, {
          path: 'error.ts',
          oldText: 'old\n',
          newText: 'new\n',
          showHeader: false,
          preferParseWorker: true,
        })
      )
    );
    expect(container.textContent).toContain('parse worker failed');
    expect(container.querySelector('[data-testid="file-diff"]')).toBeNull();
  });
});
