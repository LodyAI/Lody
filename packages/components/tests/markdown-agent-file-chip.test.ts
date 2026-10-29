import { NativeTextSelectionHoldContext } from '../src/hooks/use-conversation-text-selection';
// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentFileLinkIndexContext } from '../src/components/ai-gui/agent-file-link-context';
import { createAgentFileLinkIndex } from '../src/lib/agent-file-link-index';
import type { FileWorkspaceProviderEntry } from '../src/lib/file-workspace-provider';
import { toast } from '../src/lib/toast';
import { MarkdownRenderer } from '../src/components/ai-gui/markdown-renderer';
import { writeTextToClipboard } from '../src/lib/clipboard';

vi.mock('../src/lib/clipboard', () => ({
  writeTextToClipboard: vi.fn(async () => true),
}));

vi.mock('../src/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/* An absolute path with a `:line` suffix, of the shape agents emit when they
   cite a file they just touched. These used to vanish from the finished turn:
   the chip matched the turn's edited-files footer by basename and returned
   null, taking the link text with it. */
const MARKDOWN =
  '改动落在 [README.md](/srv/workspaces/demo-app/README.md:8)、' +
  '[conductor.json](/srv/workspaces/demo-app/conductor.json:3)、' +
  '[oss-revision.json](/srv/workspaces/demo-app/apps/cli-cloud/oss-revision.json:2) 三个文件。';

describe('agent file links in finished turns', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    if (root) await act(async () => void root?.unmount());
    root = undefined;
    container?.remove();
    container = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('resets copy feedback while mounted and releases its timer on unmount', async () => {
    vi.useFakeTimers();
    await act(async () => {
      root?.render(createElement(MarkdownRenderer, { text: '[Guide](./guide.md)' }));
    });
    const link = container?.querySelector<HTMLButtonElement>('button[title="./guide.md"]');
    expect(link).not.toBeNull();
    await act(async () => link!.click());
    expect(writeTextToClipboard).toHaveBeenLastCalledWith('./guide.md');
    expect(link?.querySelector('.lucide-check')).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(1200));
    expect(link?.querySelector('.lucide-check')).toBeNull();
    expect(link?.querySelector('.lucide-copy')).not.toBeNull();

    await act(async () => link!.click());
    expect(link?.querySelector('.lucide-check')).not.toBeNull();
    await act(async () => root?.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders one clickable chip per cited file, keeping the surrounding prose intact', async () => {
    await act(async () => {
      root?.render(createElement(MarkdownRenderer, { text: MARKDOWN, isStreaming: false }));
    });

    const chips = [...(container?.querySelectorAll('button[title]') ?? [])].filter((el) =>
      el.getAttribute('title')?.startsWith('/srv/workspaces/demo-app/')
    );

    expect(chips.map((el) => el.getAttribute('title'))).toEqual([
      '/srv/workspaces/demo-app/README.md:8',
      '/srv/workspaces/demo-app/conductor.json:3',
      '/srv/workspaces/demo-app/apps/cli-cloud/oss-revision.json:2',
    ]);
    expect(chips.map((el) => el.textContent?.trim())).toEqual([
      'README.md',
      'conductor.json',
      'oss-revision.json',
    ]);

    // The enumeration commas must not be left dangling next to a hole.
    expect(container?.textContent).toContain(
      '改动落在 README.md、conductor.json、oss-revision.json 三个文件。'
    );
  });

  const file = (
    path: string,
    extra: Partial<FileWorkspaceProviderEntry> = {}
  ): FileWorkspaceProviderEntry => ({ path, kind: 'text', sourceState: 'live-readonly', ...extra });

  it.each([false, true])(
    'confirms candidates against the live index (streaming=%s)',
    async (isStreaming) => {
      const index = createAgentFileLinkIndex();
      const text =
        'See src/app.ts and `src/code.ts`. [Guide](./docs/a%20b.md#L8). :codex-file-citation{path="out/report.pdf"}';
      const render = () =>
        root?.render(
          createElement(
            AgentFileLinkIndexContext.Provider,
            { value: index },
            createElement(MarkdownRenderer, { text, isStreaming })
          )
        );
      await act(async () => render());
      expect(container?.querySelectorAll('button[title]')).toHaveLength(0);
      expect(container?.querySelector('code')?.textContent).toBe('src/code.ts');
      expect(container?.textContent).toContain('out/report.pdf');
      await act(async () =>
        index.setFiles([
          file('src/app.ts'),
          file('src/code.ts'),
          file('docs/a b.md'),
          file('out/report.pdf', { kind: 'binary' }),
        ])
      );
      expect(container?.querySelectorAll('button[title]')).toHaveLength(3);
      expect(container?.querySelector('code')).toBeNull();
      expect(container?.textContent).toContain('report.pdf');
      await act(async () => index.setFiles([]));
      expect(container?.querySelectorAll('button[title]')).toHaveLength(0);
      expect(container?.querySelector('code')?.textContent).toBe('src/code.ts');
      expect(container?.textContent).toContain('out/report.pdf');
    }
  );

  it('opens absolute paths without an index and preserves the exact file and anchor', async () => {
    const index = createAgentFileLinkIndex();
    const open = vi.fn();
    await act(async () =>
      root?.render(
        createElement(
          AgentFileLinkIndexContext.Provider,
          { value: index },
          createElement(MarkdownRenderer, {
            text: '[Artifact](/tmp/worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report%2520v2.md#L12) and `C:\\repo\\file.ts:8`',
            onAgentFileLinkClick: open,
          })
        )
      )
    );
    const links = container!.querySelectorAll<HTMLButtonElement>('button[title]');
    expect(links).toHaveLength(2);
    await act(async () => links[0]!.click());
    expect(open).toHaveBeenLastCalledWith(
      '/tmp/worktrees/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/report%2520v2.md#L12'
    );
    await act(async () => links[1]!.click());
    expect(open).toHaveBeenLastCalledWith('C:/repo/file.ts:8');
    expect(index.isRequested()).toBe(false);
  });

  it('matches whole paths and excludes deleted files, directories and unresolved symlinks', async () => {
    const index = createAgentFileLinkIndex();
    index.setFiles([
      file('src/app.ts'),
      file('old/a.ts', { kind: 'deleted' }),
      file('dir/a.ts', { entryType: 'lazy-directory' }),
      file('special/a.ts', { kind: 'special' }),
      file('link/a.ts', { kind: 'symlink', linkTarget: '../src/app.ts' }),
      file('broken/a.ts', { kind: 'symlink', linkTarget: '../absent.ts' }),
    ]);
    await act(async () =>
      root?.render(
        createElement(
          AgentFileLinkIndexContext.Provider,
          { value: index },
          createElement(MarkdownRenderer, {
            text: '`app.ts` src/app.ts wrong/src/app.ts old/a.ts dir/a.ts special/a.ts link/a.ts broken/a.ts ../src/app.ts [directory](src/app.ts/) [parent](src/../src/app.ts)',
          })
        )
      )
    );
    expect(
      [...container!.querySelectorAll('button[title]')].map((link) => link.getAttribute('title'))
    ).toEqual(['src/app.ts', 'link/a.ts']);
    expect(container?.querySelector('code')?.textContent).toBe('app.ts');
  });

  it('does not leak index matches across cached Markdown consumers', async () => {
    const first = createAgentFileLinkIndex();
    first.setFiles([file('src/app.ts')]);
    const second = createAgentFileLinkIndex();
    for (const index of [first, second, first]) {
      await act(async () =>
        root?.render(
          createElement(
            AgentFileLinkIndexContext.Provider,
            { value: index },
            createElement(MarkdownRenderer, { text: '`src/app.ts`' })
          )
        )
      );
      expect(container?.querySelectorAll('button[title]')).toHaveLength(index === first ? 1 : 0);
    }
  });

  it('copies the original Codex path with punctuation and confirms success', async () => {
    const path = '/tmp/exports/预算 #draft%20.xlsx';
    await act(async () =>
      root?.render(
        createElement(MarkdownRenderer, { text: `:codex-file-citation{path="${path}"}` })
      )
    );
    const button = container!.querySelector<HTMLButtonElement>('button');
    expect(button).not.toBeNull();
    await act(async () => button!.click());
    expect(writeTextToClipboard).toHaveBeenLastCalledWith(path);
    expect(toast.success).toHaveBeenLastCalledWith('File path copied');
  });
  it.each(['/tmp/file%00.txt', '/tmp/file.txt#L0'])(
    'copies invalid absolute target %s instead of opening it',
    async (path) => {
      const open = vi.fn();
      await act(async () =>
        root?.render(
          createElement(
            AgentFileLinkIndexContext.Provider,
            { value: createAgentFileLinkIndex() },
            createElement(MarkdownRenderer, {
              text: `[Broken](${path})`,
              onAgentFileLinkClick: open,
            })
          )
        )
      );
      const button = container!.querySelector<HTMLButtonElement>('button[title]');
      expect(button).not.toBeNull();
      await act(async () => button!.click());
      expect(writeTextToClipboard).toHaveBeenLastCalledWith(path);
      expect(toast.success).toHaveBeenLastCalledWith('File path copied');
      expect(button?.querySelector('.lucide-check')).not.toBeNull();
      expect(open).not.toHaveBeenCalled();
    }
  );
  it('preserves selected prose when index confirmation changes its presentation', async () => {
    const index = createAgentFileLinkIndex();
    const render = (held: boolean) =>
      root?.render(
        createElement(
          NativeTextSelectionHoldContext.Provider,
          { value: held },
          createElement(
            AgentFileLinkIndexContext.Provider,
            { value: index },
            createElement(MarkdownRenderer, { text: '`src/app.ts`' })
          )
        )
      );
    await act(async () => render(false));
    const code = container!.querySelector('code')!;
    const range = document.createRange();
    range.selectNodeContents(code);
    document.getSelection()!.addRange(range);
    await act(async () => render(true));
    await act(async () => index.setFiles([file('src/app.ts')]));
    expect(container?.querySelector('code')).toBe(code);
    expect(document.getSelection()?.toString()).toBe('src/app.ts');
    document.getSelection()!.removeAllRanges();
    await act(async () => render(false));
    expect(container?.querySelector('code')).toBeNull();
    expect(container?.querySelector('button[title]')).not.toBeNull();
  });
});
