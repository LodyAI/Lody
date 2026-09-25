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
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
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
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
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
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
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
      document.querySelectorAll<HTMLElement>('[role="menuitem"]')
    ).filter(
      (item) =>
        item.textContent?.startsWith('Project ') ||
        item.textContent?.includes('loro-dev/new-repository')
    );
    expect(projectItems).toHaveLength(20);
    expect(projectItems.at(-1)?.textContent).toContain('loro-dev/new-repository');
    expect(projectItems.some((item) => item.textContent?.startsWith('Project 20'))).toBe(false);
  });
});
