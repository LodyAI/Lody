// @vitest-environment jsdom

// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseDiffFromFile as parseDiff, type FileDiffMetadata } from '@pierre/diffs';

const parseDiffFromFile: typeof parseDiff = (...args) => {
  const result = parseDiff(...args);
  result.lang ??= args[0]?.name.split('.').at(-1) as FileDiffMetadata['lang'];
  return JSON.parse(JSON.stringify(result));
};

const workerMocks = vi.hoisted(() => {
  const pool = { kind: 'shared-diff-render-worker' };
  return {
    pool,
    configurePool: vi.fn(() => Promise.resolve()),
    createPool: vi.fn(() => pool),
    parse:
      vi.fn<
        (input: {
          path: string;
          oldText: string;
          newText: string;
        }) => Promise<FileDiffMetadata | undefined>
      >(),
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
          'data-diff-metadata': JSON.stringify(fileDiff),
        },
        fileDiff.additionLines?.join(''),
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
    workerMocks.parse.mockImplementation(async ({ path, oldText, newText }) =>
      parseDiffFromFile({ name: path, contents: oldText }, { name: path, contents: newText })
    );
    vi.stubGlobal('Worker', class Worker {});
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
    vi.unstubAllGlobals();
  });

  it('does not publish an obsolete default parse when another file is selected', async () => {
    const jobs = new Map<string, (diff: FileDiffMetadata) => void>();
    workerMocks.parse.mockImplementation(
      ({ path }) => new Promise((resolve) => jobs.set(path, resolve))
    );
    const oldText = 'x'.repeat(5000) + '\n';
    const props = (path: string) => ({
      path,
      oldText,
      newText: `${oldText}${path}\n`,
      showHeader: false,
    });
    await act(async () => root.render(createElement(DiffViewer, props('obsolete.ts'))));
    await act(async () => root.render(createElement(DiffViewer, props('selected.ts'))));
    const diff = (path: string) =>
      parseDiffFromFile(
        { name: path, contents: oldText },
        { name: path, contents: `${oldText}${path}\n` }
      );
    await act(async () => jobs.get('obsolete.ts')!(diff('obsolete.ts')));
    expect(container.querySelector('[data-testid="file-diff"]')).toBeNull();
    await act(async () => jobs.get('selected.ts')!(diff('selected.ts')));
    expect(readRenderedDiff(container)).toEqual(diff('selected.ts'));
    expect(container.textContent).not.toContain('obsolete.ts');
  });

  it.each(['unavailable', 'failed'] as const)(
    'keeps a formerly inline diff readable when its worker is %s',
    async (outcome) => {
      if (outcome === 'unavailable') workerMocks.parse.mockResolvedValue(undefined);
      else workerMocks.parse.mockRejectedValue(new Error('Worker startup failed'));
      const path = `fallback-${outcome}.txt`;
      const oldText = Array.from({ length: 160 }, (_, index) => `line ${index}`).join('\r\n');
      const newText = oldText.replace('line 15', 'updated');
      await act(async () =>
        root.render(createElement(DiffViewer, { path, oldText, newText, showHeader: false }))
      );
      expect(readRenderedDiff(container)).toEqual(
        parseDiffFromFile({ name: path, contents: oldText }, { name: path, contents: newText })
      );
    }
  );

  it('retains synchronous standalone availability in runtimes without Workers', async () => {
    vi.stubGlobal('Worker', undefined);
    workerMocks.parse.mockRejectedValue(new Error('Workers do not exist'));
    const path = 'without-workers.txt';
    const oldText = 'old';
    const newText = 'new';
    await act(async () =>
      root.render(createElement(DiffViewer, { path, oldText, newText, showHeader: false }))
    );
    expect(readRenderedDiff(container)).toEqual(
      parseDiffFromFile({ name: path, contents: oldText }, { name: path, contents: newText })
    );
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
});

function readRenderedDiff(container: HTMLElement): FileDiffMetadata {
  const metadata = container
    .querySelector('[data-testid="file-diff"]')
    ?.getAttribute('data-diff-metadata');
  if (!metadata) throw new Error('Expected rendered diff metadata');
  return JSON.parse(metadata) as FileDiffMetadata;
}
