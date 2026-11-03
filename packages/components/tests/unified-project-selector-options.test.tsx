// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';

import {
  UnifiedProjectSelectorView,
  type UnifiedLocalProjectOption,
} from '../src/components/chat/unified-project-selector';
import { Tooltip } from '@lody/ui/tooltip';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
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

const machineId = 'machine-1' as MachineId;
const localProjects = Array.from({ length: 30 }, (_, index) => {
  const localProjectId = `project-${index + 1}` as LocalProjectId;
  return {
    key: `${machineId}:${localProjectId}`,
    machineId,
    localProjectId,
    name: `Project ${index + 1}`,
    rootPath: `/work/project-${index + 1}`,
    lastUsedAt: 30 - index,
  };
}) satisfies UnifiedLocalProjectOption[];

describe('UnifiedProjectSelectorView options', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    Object.defineProperty(globalThis, 'PointerEvent', {
      configurable: true,
      value: TestPointerEvent,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.innerHTML = '';
  });

  it('renders the 20 most recent projects and searches the complete list', async () => {
    await act(async () => {
      root.render(
        <Tooltip.Provider>
          <UnifiedProjectSelectorView
            value={{ kind: 'none' }}
            onChange={vi.fn()}
            localProjects={localProjects}
            onAddLocalProject={vi.fn()}
            onConnectGitRepo={vi.fn()}
            renderLimit={20}
          />
        </Tooltip.Provider>
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    expect(trigger).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('mousedown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const projectItems = Array.from(
      document.querySelectorAll<HTMLElement>('[role^="menuitem"]')
    ).filter((item) => item.textContent?.startsWith('Project '));

    expect(projectItems.map((item) => item.textContent)).toEqual(
      localProjects.slice(0, 20).map((project) => project.name)
    );

    const searchInput = document.querySelector<HTMLInputElement>(
      'input[placeholder="Search projects"]'
    );
    expect(searchInput).toBeInstanceOf(HTMLInputElement);
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(searchInput, 'Project 25');
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const searchedProjectItems = Array.from(
      document.querySelectorAll<HTMLElement>('[role^="menuitem"]')
    ).filter((item) => item.textContent?.startsWith('Project '));
    expect(searchedProjectItems.map((item) => item.textContent)).toEqual(['Project 25']);
  });

  it('keeps every source visible when the caller has no shared recency ranking', async () => {
    await act(async () => {
      root.render(
        <Tooltip.Provider>
          <UnifiedProjectSelectorView
            value={{ kind: 'none' }}
            onChange={vi.fn()}
            localProjects={localProjects}
            repositories={[{ fullName: 'loro-dev/lody' }]}
            onAddLocalProject={vi.fn()}
            onConnectGitRepo={vi.fn()}
          />
        </Tooltip.Provider>
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('mousedown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    expect(document.body.textContent).toContain('loro-dev/lody');
  });

  it('includes recently used GitHub repositories in the bounded mixed list', async () => {
    await act(async () => {
      root.render(
        <Tooltip.Provider>
          <UnifiedProjectSelectorView
            value={{ kind: 'none' }}
            onChange={vi.fn()}
            localProjects={localProjects}
            repositories={[{ fullName: 'loro-dev/lody' }]}
            latestMessageAtByRepo={new Map([['loro-dev/lody', 100]])}
            onAddLocalProject={vi.fn()}
            onConnectGitRepo={vi.fn()}
            renderLimit={20}
          />
        </Tooltip.Provider>
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('mousedown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const projectItems = Array.from(
      document.querySelectorAll<HTMLElement>('[role^="menuitem"]')
    ).filter(
      (item) =>
        item.textContent?.startsWith('Project ') || item.textContent?.includes('loro-dev/lody')
    );
    expect(projectItems).toHaveLength(20);
    expect(projectItems[0]?.textContent).toContain('loro-dev/lody');
    expect(projectItems.some((item) => item.textContent?.startsWith('Project 20'))).toBe(false);
  });

  it('reserves a source slot for a GitHub repository with no usage history', async () => {
    await act(async () => {
      root.render(
        <Tooltip.Provider>
          <UnifiedProjectSelectorView
            value={{ kind: 'none' }}
            onChange={vi.fn()}
            localProjects={localProjects}
            repositories={[{ fullName: 'loro-dev/new-repository' }]}
            latestMessageAtByRepo={new Map()}
            onAddLocalProject={vi.fn()}
            onConnectGitRepo={vi.fn()}
            renderLimit={20}
          />
        </Tooltip.Provider>
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('mousedown', {
          bubbles: true,
          button: 0,
          pointerType: 'mouse',
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const projectItems = Array.from(
      document.querySelectorAll<HTMLElement>('[role^="menuitem"]')
    ).filter(
      (item) =>
        item.textContent?.startsWith('Project ') ||
        item.textContent?.includes('loro-dev/new-repository')
    );
    expect(projectItems).toHaveLength(20);
    expect(projectItems.at(-1)?.textContent).toContain('loro-dev/new-repository');
    expect(projectItems.some((item) => item.textContent?.startsWith('Project 20'))).toBe(false);
  });

  it('offers project groups, selects one, and keeps a group it cannot run disabled', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(
        <Tooltip.Provider>
          <UnifiedProjectSelectorView
            value={{ kind: 'none' }}
            onChange={onChange}
            localProjects={[]}
            projectGroups={[
              { projectId: 'shop', name: 'Shop', memberCount: 3, lastUsedAt: 100 },
              {
                projectId: 'split',
                name: 'Split',
                memberCount: 2,
                lastUsedAt: 50,
                disabledReason: 'Its local repositories are on different machines',
              },
            ]}
            onAddLocalProject={vi.fn()}
            onConnectGitRepo={vi.fn()}
          />
        </Tooltip.Provider>
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      trigger?.dispatchEvent(
        new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'mouse' })
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
    });

    const groupItems = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).filter((item) => /Shop|Split/.test(item.textContent ?? ''));
    // This suite's `t` returns the fallback without interpolating.
    expect(groupItems.map((item) => item.textContent)).toEqual([
      'Shop{{count}} repositories',
      'SplitIts local repositories are on different machines',
    ]);
    expect(groupItems[1]?.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      groupItems[0]?.click();
      await Promise.resolve();
    });
    expect(onChange).toHaveBeenCalledWith({ kind: 'group', projectId: 'shop' });
  });

  it('edits a project group from its row without selecting it', async () => {
    const onChange = vi.fn();
    const onEditProjectGroup = vi.fn();
    await act(async () => {
      root.render(
        <Tooltip.Provider>
          <UnifiedProjectSelectorView
            value={{ kind: 'none' }}
            onChange={onChange}
            localProjects={localProjects.slice(0, 1)}
            projectGroups={[{ projectId: 'shop', name: 'Shop', memberCount: 2, lastUsedAt: 100 }]}
            onAddLocalProject={vi.fn()}
            onConnectGitRepo={vi.fn()}
            onEditProjectGroup={onEditProjectGroup}
          />
        </Tooltip.Provider>
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    vi.useFakeTimers();
    try {
      await act(async () => {
        trigger?.dispatchEvent(
          new TestPointerEvent('mousedown', { bubbles: true, button: 0, pointerType: 'mouse' })
        );
        await vi.runAllTimersAsync();
      });
    } finally {
      vi.useRealTimers();
    }

    const editButtons = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"] button')
    );
    // Only the group row offers editing; a single local project has nothing to edit.
    expect(editButtons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Edit {{name}}',
    ]);
    await act(async () => {
      editButtons[0]?.click();
      await Promise.resolve();
    });

    expect(onEditProjectGroup).toHaveBeenCalledWith('shop');
    expect(onChange).not.toHaveBeenCalled();
  });
});
