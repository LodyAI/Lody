// @vitest-environment jsdom

import { act, createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionPullRequestMeta } from '@lody/shared';
import { writeTextToClipboard } from '../src/lib/clipboard';
import { ContextChip } from '../src/components/sessions/session-info-chips';

vi.mock('../src/lib/clipboard', () => ({
  writeTextToClipboard: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn() },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

describe('ContextChip actions', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
  });

  afterEach(async () => {
    if (root) {
      await act(async () => root?.unmount());
    }
    container?.remove();
    root = undefined;
    container = undefined;
  });

  it('keeps PR, branch, and All Changes as independent click targets', async () => {
    const onOpenPr = vi.fn();
    const onOpenAllChanges = vi.fn();
    const branch = 'fix/acp-capability-authority';

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ContextChip, {
          mode: 'stage',
          projectName: 'loro-dev/lody',
          branch,
          pr: {
            url: 'https://github.com/loro-dev/lody/pull/2894',
            status: 'open',
          } as SessionPullRequestMeta,
          diffStat: { add: 1048, del: 821 },
          onOpenPr,
          onOpenAllChanges,
        })
      );
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const prButton = buttons.find((button) => button.textContent?.includes('#2894'));
    const branchButton = buttons.find((button) => button.textContent?.includes(branch));
    const diffButton = buttons.find((button) => button.textContent?.includes('+1048'));

    expect(prButton).toBeInstanceOf(HTMLButtonElement);
    expect(branchButton).toBeInstanceOf(HTMLButtonElement);
    expect(diffButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => prButton?.click());
    expect(onOpenPr).toHaveBeenCalledTimes(1);
    expect(onOpenAllChanges).not.toHaveBeenCalled();
    expect(writeTextToClipboard).not.toHaveBeenCalled();

    await act(async () => branchButton?.click());
    expect(writeTextToClipboard).toHaveBeenCalledWith(branch);
    expect(onOpenPr).toHaveBeenCalledTimes(1);
    expect(onOpenAllChanges).not.toHaveBeenCalled();

    await act(async () => diffButton?.click());
    expect(onOpenAllChanges).toHaveBeenCalledTimes(1);
    expect(onOpenPr).toHaveBeenCalledTimes(1);
  });

  it('renders the highest-priority action directly and folds the rest into a menu', async () => {
    const onCreatePr = vi.fn();
    const onCommitAndPush = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ContextChip, {
          mode: 'stage',
          projectName: 'loro-dev/lody',
          branch: 'feat/info-bar-actions',
          workspaceLocation: { kind: 'worktree', path: '/tmp/lody-worktree' },
          diffStat: { add: 12, del: 4 },
          actions: [
            { id: 'create-pr', label: 'Create PR', onClick: onCreatePr },
            {
              id: 'commit-and-push',
              label: 'Commit & Push',
              onClick: onCommitAndPush,
            },
          ],
        })
      );
    });

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
    const createPrButton = buttons.find((button) => button.textContent === 'Create PR');
    const commitButton = buttons.find((button) => button.textContent === 'Commit & Push');
    const menuButton = buttons.find(
      (button) => button.getAttribute('aria-label') === 'More actions'
    );

    expect(createPrButton).toBeInstanceOf(HTMLButtonElement);
    expect(commitButton).toBeUndefined();
    expect(menuButton).toBeInstanceOf(HTMLButtonElement);
    expect(createPrButton?.className).toContain('focus-visible:ring-0');
    expect(createPrButton?.className).toContain('text-muted-foreground/80');
    expect(menuButton?.className).toContain('focus-visible:ring-0');
    // Light theme uses a soft hairline border + faint fill; dark keeps muted fill only.
    expect(createPrButton?.parentElement?.className).toContain('border-foreground/[0.08]');
    expect(createPrButton?.parentElement?.className).toContain('bg-foreground/[0.03]');
    expect(createPrButton?.parentElement?.className).toContain(
      'dark:bg-muted-foreground/[0.08]'
    );

    await act(async () => createPrButton?.click());

    expect(onCreatePr).toHaveBeenCalledTimes(1);
    expect(onCommitAndPush).not.toHaveBeenCalled();

    await act(async () => {
      menuButton?.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });

    const menuItems = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'));
    expect(menuItems.map((item) => item.textContent)).toEqual(['Commit & Push']);

    await act(async () => {
      menuItems[0]?.focus();
      menuItems[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });

    expect(onCommitAndPush).toHaveBeenCalledTimes(1);
  });

  it('does not render an overflow trigger for a single action', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ContextChip, {
          mode: 'stage',
          projectName: 'loro-dev/lody',
          actions: [{ id: 'merge-pr', label: 'Merge PR', onClick: vi.fn() }],
        })
      );
    });

    expect(container.textContent).toContain('Merge PR');
    expect(container.querySelector('button[aria-label="More actions"]')).toBeNull();
  });

  it('keeps the location tooltip stable across context rerenders', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    for (let render = 0; render < 20; render += 1) {
      await act(async () => {
        root?.render(
          createElement(ContextChip, {
            mode: 'stage',
            projectName: 'loro-dev/lody',
            branch: `fix/location-tooltip-${render}`,
            workspaceLocation: { kind: 'worktree', path: '/tmp/lody-worktree' },
          })
        );
      });
    }

    expect(container.querySelector('button[aria-label="Worktree"]')).toBeInstanceOf(
      HTMLButtonElement
    );
  });

  it('renders the compact merge split button and switches methods without merging', async () => {
    const onMerge = vi.fn();
    const onSelectMethod = vi.fn();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(ContextChip, {
          mode: 'stage',
          projectName: 'loro-dev/lody',
          pr: {
            url: 'https://github.com/loro-dev/lody/pull/2894',
            status: 'open',
          } as SessionPullRequestMeta,
          actions: [
            {
              kind: 'merge',
              id: 'merge',
              method: 'merge',
              onMerge,
              onSelectMethod,
            },
          ],
        })
      );
    });

    const mergeControl = container.querySelector('[data-pr-merge-control]');
    const buttons = Array.from(mergeControl?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const mergeButton = buttons.find((button) =>
      button.textContent?.includes('Merge pull request')
    );
    const methodButton = buttons.find(
      (button) => button.getAttribute('aria-label') === 'Choose merge method'
    );
    expect(mergeControl?.className).toContain('border-status-success/35');
    expect(mergeButton).toBeInstanceOf(HTMLButtonElement);
    expect(methodButton).toBeInstanceOf(HTMLButtonElement);

    await act(async () => mergeButton?.click());
    expect(onMerge).toHaveBeenCalledWith('merge');

    await act(async () => {
      methodButton?.dispatchEvent(
        new TestPointerEvent('pointerdown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
    });
    const squashItem = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent?.includes('Squash and merge')
    );
    expect(squashItem).toBeInstanceOf(HTMLElement);
    await act(async () => squashItem?.click());
    expect(onSelectMethod).toHaveBeenCalledWith('squash');
    expect(onMerge).toHaveBeenCalledTimes(1);
  });
});
