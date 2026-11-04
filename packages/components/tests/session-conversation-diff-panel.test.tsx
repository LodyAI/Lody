/** @vitest-environment jsdom */

/** @vitest-environment jsdom */
import { act, createElement } from 'react';
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
  SessionConversationDiffPanel,
  shouldOpenDiffFileByDefault,
  type SessionConversationDiffPanelProps,
} from '../src/components/sessions/session-conversation-diff-panel';

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
