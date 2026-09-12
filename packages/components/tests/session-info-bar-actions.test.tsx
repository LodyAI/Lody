// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextChipAction } from '../src/components/sessions/session-info-chips';
import { SessionInfoBar } from '../src/components/sessions/session-info-bar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

/** jsdom has no PointerEvent, and Radix opens its menu on pointerdown. */
class TestPointerEvent extends MouseEvent {
  readonly pointerType: string;

  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? '';
  }
}

const PR_CONTEXT = {
  projectName: 'owner/repo',
  branch: 'feature/info-bar',
  pr: { url: 'https://github.com/owner/repo/pull/7', status: 'open' as const },
  initialStage: 'context' as const,
};

const findButton = (container: HTMLElement, label: string): HTMLButtonElement | undefined =>
  [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label
  ) as HTMLButtonElement | undefined;

const findMenuItem = (label: string): HTMLElement | undefined =>
  [...document.body.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent?.trim() === label
  ) as HTMLElement | undefined;

describe('Info Bar repository actions', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('PointerEvent', TestPointerEvent);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  const renderActions = (actions: readonly ContextChipAction[]) => {
    act(() => {
      root.render(<SessionInfoBar {...PR_CONTEXT} contextActions={actions} />);
    });
  };

  const openOverflowMenu = () => {
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="More actions"]');
    expect(trigger).not.toBeNull();
    act(() => {
      trigger?.dispatchEvent(
        new TestPointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' })
      );
    });
  };

  it('renders only the highest-priority action as the visible button', () => {
    const onCommitAndPush = vi.fn();
    renderActions([
      { id: 'commit-and-push', label: 'Commit & Push', onClick: onCommitAndPush },
      { id: 'fix-ci-errors', label: 'Fix CI Errors', onClick: vi.fn() },
    ]);

    expect(findButton(container, 'Commit & Push')).toBeDefined();
    // The lower-priority action is collapsed behind the chevron, not rendered
    // as a second competing button.
    expect(findButton(container, 'Fix CI Errors')).toBeUndefined();

    act(() => findButton(container, 'Commit & Push')?.click());
    expect(onCommitAndPush).toHaveBeenCalledTimes(1);
  });

  it('reaches a collapsed action through the chevron menu', () => {
    const onFixCi = vi.fn();
    renderActions([
      { id: 'commit-and-push', label: 'Commit & Push', onClick: vi.fn() },
      { id: 'fix-ci-errors', label: 'Fix CI Errors', onClick: onFixCi },
    ]);

    openOverflowMenu();
    const item = findMenuItem('Fix CI Errors');
    expect(item).toBeDefined();

    act(() => item?.click());
    expect(onFixCi).toHaveBeenCalledTimes(1);
  });

  it('keeps a demoted Merge reachable and performs the selected method', () => {
    // Merge is a split button when it leads, but a dirty worktree outranks it.
    // Demoting it must not drop it: the menu item performs the method the split
    // button would have used.
    const onMerge = vi.fn();
    renderActions([
      { id: 'commit-and-push', label: 'Commit & Push', onClick: vi.fn() },
      {
        kind: 'merge',
        id: 'merge',
        method: 'squash',
        onMerge,
        onSelectMethod: vi.fn(),
      },
    ]);

    expect(container.querySelector('[data-pr-merge-control]')).toBeNull();

    openOverflowMenu();
    const item = findMenuItem('Squash and merge');
    expect(item).toBeDefined();

    act(() => item?.click());
    expect(onMerge).toHaveBeenCalledWith('squash');
  });

  it('restores the merge split button when Merge is the top-priority action', () => {
    const onMerge = vi.fn();
    renderActions([
      {
        kind: 'merge',
        id: 'merge',
        method: 'merge',
        onMerge,
        onSelectMethod: vi.fn(),
      },
    ]);

    // A clean worktree leaves nothing ahead of Merge, so the method-picking
    // split button is back rather than a plain menu item.
    expect(container.querySelector('[data-pr-merge-control]')).not.toBeNull();
    act(() => findButton(container, 'Merge pull request')?.click());
    expect(onMerge).toHaveBeenCalledWith('merge');
  });

  it('renders no action affordance when there is nothing to offer', () => {
    renderActions([]);

    expect(container.querySelector('[aria-label="More actions"]')).toBeNull();
    expect(container.querySelector('[data-pr-merge-control]')).toBeNull();
  });
});
