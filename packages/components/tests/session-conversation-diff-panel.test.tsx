/** @vitest-environment jsdom */

import { act, createElement, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Provider, createStore } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiff, SessionId } from '@lody/shared';
import { initI18n } from '../src/i18n';
import type { SessionFileProvider } from '../src/lib/session-file-provider';

// PR review threads are a separate, cloud-backed surface; these sessions have no PR.
vi.mock('../src/hooks/use-github-review-comments', () => ({
  useGitHubReviewComments: () => ({
    threads: [],
    error: null,
    refresh: async () => {},
    runWithToken: async () => undefined,
  }),
}));
import { TestCloudPlatformProvider } from './test-platform';
import {
  areFileDiffListsEqual,
  MAX_DIFF_SKELETON_BODIES,
  SessionConversationDiffPanel,
  areSessionConversationDiffPanelPropsEqual,
  createConversationDiffViewerParseCacheKey,
  shouldOpenDiffFileByDefault,
  type SessionConversationDiffPanelProps,
} from '../src/components/sessions/session-conversation-diff-panel';
import { useDiffViewport } from '../src/components/sessions/use-diff-viewport';

const checkpointFileDiff = (overrides: Partial<FileDiff> = {}): FileDiff => ({
  filePath: 'docs/README.md',
  add: 1,
  del: 0,
  cc: {
    v: 1,
    fileId: 't:000066',
    opId: '1:89',
    baseOpId: '2:89',
  },
  ...overrides,
});

describe('areFileDiffListsEqual', () => {
  it('compares by content so rebuilt arrays with identical checkpoints stay equal', () => {
    expect(areFileDiffListsEqual([checkpointFileDiff()], [checkpointFileDiff()])).toBe(true);
    expect(areFileDiffListsEqual([], [])).toBe(true);
    expect(areFileDiffListsEqual(undefined, undefined)).toBe(true);
  });

  it('detects checkpoint hydration and frontier changes', () => {
    expect(areFileDiffListsEqual([], [checkpointFileDiff()])).toBe(false);
    expect(areFileDiffListsEqual(undefined, [])).toBe(false);
    expect(
      areFileDiffListsEqual(
        [checkpointFileDiff()],
        [checkpointFileDiff({ cc: { v: 1, fileId: 't:000066', opId: '1:99', baseOpId: '2:89' } })]
      )
    ).toBe(false);
    expect(
      areFileDiffListsEqual([checkpointFileDiff()], [checkpointFileDiff({ cc: undefined })])
    ).toBe(false);
  });
});

describe('areSessionConversationDiffPanelPropsEqual', () => {
  const baseProps: SessionConversationDiffPanelProps = {
    sessionId: 'session-1' as SessionId,
    turnId: 'turn-1',
    filePaths: ['docs/README.md'],
    fileDiffs: [checkpointFileDiff()],
    fileDiffsPending: false,
  };

  it('treats content-equal rebuilt fileDiffs as equal', () => {
    expect(
      areSessionConversationDiffPanelPropsEqual(baseProps, {
        ...baseProps,
        filePaths: ['docs/README.md'],
        fileDiffs: [checkpointFileDiff()],
      })
    ).toBe(true);
  });

  it('re-renders when the open-file handler identity changes', () => {
    const onOpenFile = () => undefined;
    expect(areSessionConversationDiffPanelPropsEqual(baseProps, { ...baseProps, onOpenFile })).toBe(
      false
    );
    expect(
      areSessionConversationDiffPanelPropsEqual(
        { ...baseProps, onOpenFile },
        { ...baseProps, onOpenFile }
      )
    ).toBe(true);
  });

  it('re-renders when fileDiffs hydrate after the summary resolves', () => {
    // Regression: the comparator skipped fileDiffs, freezing a mount-time empty
    // checkpoint list (and its "requires a session-history fileDiff checkpoint"
    // error) inside the memoized panel.
    expect(
      areSessionConversationDiffPanelPropsEqual(
        { ...baseProps, fileDiffs: [] },
        { ...baseProps, fileDiffs: [checkpointFileDiff()] }
      )
    ).toBe(false);
    expect(
      areSessionConversationDiffPanelPropsEqual(
        { ...baseProps, fileDiffsPending: true },
        { ...baseProps, fileDiffsPending: false }
      )
    ).toBe(false);
  });
});

describe('createConversationDiffViewerParseCacheKey', () => {
  it('includes the file path so same-turn text-source diffs cannot share parsed output', () => {
    expect(
      createConversationDiffViewerParseCacheKey({
        mode: 'conversation',
        cacheKey: 'session:conversation:turn-1',
        filePath: 'src/a.ts',
      })
    ).toBe('session:conversation:turn-1:src/a.ts');
    expect(
      createConversationDiffViewerParseCacheKey({
        mode: 'conversation',
        cacheKey: 'session:conversation:turn-1',
        filePath: 'src/b.ts',
      })
    ).toBe('session:conversation:turn-1:src/b.ts');
    expect(
      createConversationDiffViewerParseCacheKey({
        mode: 'base',
        cacheKey: 'session:base:turn-1',
        filePath: 'src/a.ts',
      })
    ).toBeUndefined();
  });
});

describe('shouldOpenDiffFileByDefault', () => {
  it('opens only the focused file in both All Changes and turn diff modes', () => {
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'base',
        filePath: 'src/target.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(true);
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'base',
        filePath: 'src/other.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(false);
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'conversation',
        filePath: 'src/target.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(true);
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'conversation',
        filePath: 'src/other.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(false);
  });

  it('keeps unfocused conversation diffs expanded and All Changes collapsed', () => {
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'conversation',
        filePath: 'src/other.ts',
      })
    ).toBe(true);
    expect(shouldOpenDiffFileByDefault({ mode: 'base', filePath: 'src/other.ts' })).toBe(false);
  });

  it('matches equivalent workspace path spellings', () => {
    expect(
      shouldOpenDiffFileByDefault({
        mode: 'base',
        filePath: './src/target.ts',
        focusFilePath: 'src/target.ts',
      })
    ).toBe(true);
  });
});

describe('SessionConversationDiffPanel loading cards', () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;

  // Every request stays in flight, as on a large diff the machine is still serving.
  const pending = () => new Promise<never>(() => {});
  const stalledProvider = new Proxy({} as SessionFileProvider, {
    get: (_target, property) => (property === 'then' ? undefined : pending),
  });
  const paths = Array.from({ length: 300 }, (_, index) => `deleted/file-${index}.md`);

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    // The All Changes scroll area measures itself; jsdom has no layout to report.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (props: Partial<SessionConversationDiffPanelProps>) => {
    act(() => {
      root.render(
        <Provider store={createStore()}>
          <TestCloudPlatformProvider>
            <SessionConversationDiffPanel
              sessionId={'session-1' as SessionId}
              turnId="turn-1"
              filePaths={paths}
              fileProvider={stalledProvider}
              {...props}
            />
          </TestCloudPlatformProvider>
        </Provider>
      );
    });
  };
  // A skeleton line is an empty, screen-reader-hidden block; each one pulses.
  const skeletonLines = () =>
    Array.from(container.querySelectorAll('div[aria-hidden="true"]')).filter(
      (element) => element.childNodes.length === 0
    ).length;

  it('loads every file of an unfocused All Changes diff as headers without pulsing bodies', () => {
    render({ mode: 'base', turnId: 'all-changes' });

    expect(container.textContent).toContain('deleted/file-0.md');
    expect(container.textContent).toContain('deleted/file-299.md');
    expect(skeletonLines()).toBe(0);
  });

  it('draws a body only for the focused file of an All Changes diff', () => {
    render({ mode: 'base', turnId: 'all-changes', focusFilePath: 'deleted/file-150.md' });

    expect(skeletonLines()).toBe(5);
  });

  it('bounds pulsing bodies when a conversation diff opens every file', () => {
    render({ mode: 'conversation', fileDiffs: [] });

    expect(container.textContent).toContain('deleted/file-299.md');
    expect(skeletonLines()).toBe(MAX_DIFF_SKELETON_BODIES * 5);
  });
});

describe('diff viewport loading', () => {
  it('loads nearby files and an off-screen focus, pauses hidden panels and resumes on return', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const paths = Array.from({ length: 100 }, (_, index) => `src/file-${index}.ts`);
    let publish!: (visiblePaths: string[]) => void;
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        private nodes = new Set<Element>();
        constructor(callback: IntersectionObserverCallback) {
          publish = (visiblePaths) =>
            callback(
              [...this.nodes].map(
                (target) =>
                  ({
                    target,
                    isIntersecting: visiblePaths.includes(
                      (target as HTMLElement).dataset.diffPath!
                    ),
                  }) as IntersectionObserverEntry
              ),
              this as unknown as IntersectionObserver
            );
        }
        observe(node: Element) {
          this.nodes.add(node);
        }
        unobserve(node: Element) {
          this.nodes.delete(node);
        }
        disconnect() {
          this.nodes.clear();
        }
      }
    );
    function Harness({ active }: { active: boolean }) {
      const scrollContainerRef = useRef<HTMLDivElement | null>(null);
      const { loadPaths, registerPath } = useDiffViewport({
        active,
        paths,
        priorityPath: paths[99],
        scrollContainerRef,
      });
      return createElement(
        'div',
        { ref: scrollContainerRef },
        createElement('output', null, JSON.stringify(loadPaths)),
        ...paths.map((path) =>
          createElement('div', {
            key: path,
            'data-diff-path': path,
            ref: (node: HTMLDivElement | null) => registerPath(path, node),
          })
        )
      );
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const loaded = () => JSON.parse(container.querySelector('output')!.textContent!) as string[];
    try {
      await act(async () => root.render(createElement(Harness, { active: true })));
      expect(loaded()).toEqual([paths[0], paths[1], paths[99]]);
      await act(async () => publish([paths[10], paths[11]]));
      expect(loaded()).toEqual([paths[10], paths[11], paths[99]]);
      await act(async () => root.render(createElement(Harness, { active: false })));
      expect(loaded()).toEqual([]);
      await act(async () => root.render(createElement(Harness, { active: true })));
      await act(async () => publish([paths[70]]));
      expect(loaded()).toEqual([paths[70], paths[99]]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

describe('SessionConversationDiffPanel All Changes scope', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

  const branchBase = '1234567890abcdef1234567890abcdef12345678';
  const headBase = 'abcdef1234567890abcdef1234567890abcdef12';
  const readyEntry = {
    path: 'worktree.txt',
    diff: {
      status: 'ready' as const,
      path: 'worktree.txt',
      oldSnapshot: { kind: 'text' as const, text: 'old\n' },
      newSnapshot: { kind: 'text' as const, text: 'old\nnew\n' },
    },
  };
  const committedEntry = {
    path: 'committed.txt',
    diff: {
      status: 'unavailable' as const,
      path: 'committed.txt',
      reason: 'metadata-only' as const,
    },
  };

  const makeProvider = (unavailable = false) =>
    ({
      getAllChangesDiff: async (_focusPath?: string, scope?: 'branch' | 'uncommitted') => {
        if (unavailable) {
          return {
            status: 'unavailable',
            reason: 'metadata-only',
            scopeReason: 'no_commits',
            message: 'no commits',
          };
        }
        return {
          status: 'ready',
          base: scope === 'uncommitted' ? headBase : branchBase,
          truncated: false,
          entries: scope === 'uncommitted' ? [readyEntry] : [committedEntry, readyEntry],
        };
      },
    }) as unknown as SessionFileProvider;

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    await initI18n('en');
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async (props: Partial<SessionConversationDiffPanelProps>) => {
    await act(async () => {
      root.render(
        <Provider store={createStore()}>
          <TestCloudPlatformProvider>
            <SessionConversationDiffPanel
              sessionId={'session-1' as SessionId}
              turnId="all-changes"
              mode="base"
              filePaths={['committed.txt', 'worktree.txt']}
              fileProvider={makeProvider()}
              allChangesScopeSupported
              {...props}
            />
          </TestCloudPlatformProvider>
        </Provider>
      );
    });
  };

  it('renders the uncommitted set and explains a focused committed-only file', async () => {
    await render({ allChangesScope: 'uncommitted', fileProvider: makeProvider() });

    expect(container.textContent).toContain('worktree.txt');
    expect(container.textContent).not.toContain('committed.txt');
    expect(container.textContent).toContain('HEAD · abcdef1');

    await render({
      allChangesScope: 'uncommitted',
      focusFilePath: 'committed.txt',
      fileProvider: makeProvider(),
    });
    expect(container.textContent).toContain('This file has no uncommitted changes.');
  });

  it('hides the selector without capability and reports an explicit scope limitation', async () => {
    await render({ allChangesScope: 'branch', allChangesScopeSupported: false });
    expect(container.textContent).not.toContain('Uncommitted');

    await render({ allChangesScope: 'uncommitted', fileProvider: makeProvider(true) });
    expect(container.textContent).toContain('no commits yet');
  });
});
