// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FileDiffProps } from '@pierre/diffs/react';
import type { CommentReferencePayload, SessionMeta } from '@lody/shared';
import type { CommentAnnotationMeta } from '../src/ui/diff-viewer/session-comment-types';

const workerMocks = vi.hoisted(() => {
  const pool = { kind: 'shared-diff-render-worker' };
  return {
    mobile: false,
    pool,
    configurePool: vi.fn(() => Promise.resolve()),
    createPool: vi.fn(() => pool),
  };
});

vi.mock('../src/ui/diff-viewer/diff-render-worker', () => ({
  configureDiffRenderWorkerPool: workerMocks.configurePool,
  createDiffRenderWorkerPool: workerMocks.createPool,
}));

vi.mock('@pierre/diffs/react', async () => {
  const React = await import('react');
  const WorkerPoolContext = React.createContext<unknown>(undefined);
  return {
    FileDiff: (props: FileDiffProps<CommentAnnotationMeta>) => {
      const workerPool = React.useContext(WorkerPoolContext);
      const line = {
        annotationSide: 'additions',
        side: 'additions',
        lineNumber: 1,
        lineType: 'change-addition',
      };
      return React.createElement(
        'div',
        {
          'data-testid': 'file-diff',
          'data-render-worker': workerPool === workerMocks.pool ? 'shared' : 'main-thread',
        },
        React.createElement(
          'button',
          {
            'aria-label': 'Synthetic diff line',
            onMouseEnter: () => props.options?.onLineEnter?.(line as never),
            onClick: (event: React.MouseEvent) =>
              props.options?.onLineClick?.({ ...line, event } as never),
          },
          'after'
        ),
        props.renderHoverUtility?.(() => line as never),
        ...(props.lineAnnotations ?? []).map((annotation) =>
          React.createElement(
            'div',
            { key: annotation.lineNumber },
            props.renderAnnotation?.(annotation)
          )
        )
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
  useIsMobile: () => workerMocks.mobile,
}));

vi.mock('@posthog/react', () => ({ usePostHog: () => null }));
vi.mock('../src/hooks/use-github-review-comments', () => ({
  useGitHubReviewComments: () => ({
    threads: [],
    refresh: async () => {},
    runWithToken: async () => {
      throw new Error('Unexpected GitHub request');
    },
  }),
}));
vi.mock('../src/components/sessions/use-session-conversation-diff-data', () => ({
  useSessionConversationDiffData: () => ({
    cacheKey: 'fixture',
    normalizedPaths: ['src/config.ts'],
    resolvedByPath: {
      'src/config.ts': {
        status: 'ready',
        oldSnapshot: { kind: 'text', text: 'before\n' },
        newSnapshot: { kind: 'text', text: 'after\n' },
      },
    },
    isDiffUnavailable: false,
  }),
}));
vi.mock('../src/components/sessions/use-session-all-changes-diff-data', () => ({
  useSessionAllChangesDiffData: () => ({
    cacheKey: 'fixture-base',
    normalizedPaths: ['src/config.ts'],
    resolvedByPath: {
      'src/config.ts': {
        status: 'ready',
        oldSnapshot: { kind: 'text', text: 'before\n' },
        newSnapshot: { kind: 'text', text: 'after\n' },
      },
    },
    isDiffUnavailable: false,
  }),
}));

vi.mock('../src/theme-provider', () => ({
  useActiveVSCodeDiffThemeName: () => undefined,
  useResolvedTheme: () => 'dark',
}));

import { DiffViewer } from '../src/ui/diff-viewer/diff-viewer';
import { SessionConversationDiffPanel } from '../src/components/sessions/session-conversation-diff-panel';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

describe('DiffViewer render worker routing', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    workerMocks.mobile = false;
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: function (options: ScrollToOptions) {
        this.scrollTop = options.top ?? 0;
      },
    });
    workerMocks.configurePool.mockClear();
    workerMocks.createPool.mockClear();
    workerMocks.createPool.mockReturnValue(workerMocks.pool);
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
    expect(workerMocks.createPool).toHaveBeenCalledTimes(1);
    expect(workerMocks.configurePool).toHaveBeenCalledWith(
      workerMocks.pool,
      expect.objectContaining({ lineDiffType: 'word' })
    );
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
    expect(workerMocks.configurePool).not.toHaveBeenCalled();
  });

  it.each(['conversation', 'base'] as const)(
    'routes %s drafts through the viewer and panel while preserving rejected text',
    async (mode) => {
      let accepted = false;
      const sent: CommentReferencePayload[] = [];
      await act(async () =>
        root.render(
          createElement(SessionConversationDiffPanel, {
            sessionId: 'session-1' as never,
            turnId: mode === 'base' ? undefined : 'turn-1',
            filePaths: ['src/config.ts'],
            focusFilePath: 'src/config.ts',
            mode,
            onSendToChat: (reference) => {
              sent.push(reference);
              return accepted;
            },
          })
        )
      );
      const line = container.querySelector<HTMLButtonElement>(
        '[aria-label="Synthetic diff line"]'
      )!;
      await act(async () => line.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
      await act(async () =>
        container.querySelector<HTMLButtonElement>('[aria-label="Add comment"]')!.click()
      );
      const field = container.querySelector('textarea')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
          field,
          'Local note'
        );
        field.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const send = () =>
        Array.from(container.querySelectorAll('button')).find(
          (button) => button.textContent === 'Add to chat'
        )!;
      await act(async () => send().click());
      expect(field.value).toBe('Local note');
      accepted = true;
      await act(async () => send().click());
      expect(container.querySelector('textarea')).toBeNull();
      expect(
        sent.map(
          ({ source, path, lineNumber, side, commentBody, authorName, mode: refMode, turnId }) => ({
            source,
            path,
            lineNumber,
            side,
            commentBody,
            authorName,
            mode: refMode,
            turnId,
          })
        )
      ).toEqual(
        [0, 1].map(() => ({
          source: 'lody',
          path: 'src/config.ts',
          lineNumber: 1,
          side: 'additions',
          commentBody: 'Local note',
          authorName: 'Anonymous',
          mode,
          turnId: mode === 'base' ? undefined : 'turn-1',
        }))
      );
      expect(container.querySelector('[data-render-worker="shared"]')).not.toBeNull();
    }
  );

  it('starts a draft by tapping a mobile line', async () => {
    workerMocks.mobile = true;
    await act(async () =>
      root.render(
        createElement(DiffViewer, {
          path: 'README.md',
          oldText: 'before\n',
          newText: 'after\n',
          commentsEnabled: true,
          commentCallbacks: { onSendToChat: () => true },
        })
      )
    );
    expect(container.querySelector('[aria-label="Add comment"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Synthetic diff line"]')!.click()
    );
    expect(container.querySelector('textarea')).not.toBeNull();
    expect(container.textContent).toContain('Add to chat');
  });

  it.each([false, true])(
    'enables comments without a chat callback only when PR linked=%s',
    async (prLinked) => {
      const session = {
        id: 'session-1',
        repoFullName: prLinked ? 'example/repo' : undefined,
        pullRequests: prLinked ? [{ url: 'https://github.com/example/repo/pull/1' }] : [],
      } as unknown as SessionMeta;
      await act(async () =>
        root.render(
          createElement(SessionConversationDiffPanel, {
            sessionId: session.id,
            session,
            turnId: 'turn-1',
            filePaths: ['src/config.ts'],
          })
        )
      );
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Synthetic diff line"]')!
          .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      );
      expect(Boolean(container.querySelector('[aria-label="Add comment"]'))).toBe(prLinked);
      if (prLinked) {
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[aria-label="Add comment"]')!.click()
        );
        expect(container.textContent).toContain('Posts to GitHub');
        expect(container.textContent).not.toContain('Add to chat');
      }
    }
  );
});
