// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarFilterPopover } from '../src/components/sidebar-filter-popover';
import { initI18n } from '../src/i18n';

describe('SidebarFilterPopover Updated project-name preference', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
    Object.defineProperty(window, 'matchMedia', {
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
  });

  afterEach(() => {
    if (root) {
      flushSync(() => {
        root?.unmount();
      });
    }
    root = undefined;
    container?.remove();
    container = undefined;
    vi.restoreAllMocks();
  });

  function render(
    organize: 'workspace' | 'updated',
    showUpdatedProjectNames = true,
    showBranchNames = false
  ) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onShowUpdatedProjectNamesChange = vi.fn();
    const onShowBranchNamesChange = vi.fn();
    flushSync(() => {
      root?.render(
        <SidebarFilterPopover
          organize={organize}
          scope="my"
          showUpdatedProjectNames={showUpdatedProjectNames}
          onShowUpdatedProjectNamesChange={onShowUpdatedProjectNamesChange}
          showBranchNames={showBranchNames}
          onShowBranchNamesChange={onShowBranchNamesChange}
        />
      );
    });
    const trigger = container.querySelector('button[aria-label="Filter sidebar"]');
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return { onShowUpdatedProjectNamesChange, onShowBranchNamesChange };
  }

  it('places the Details group after the view and task menu groups', () => {
    render('workspace');
    const sections = [
      ...document.body.querySelectorAll<HTMLElement>('[data-sidebar-filter-section]'),
    ].map((section) => section.dataset.sidebarFilterSection);
    expect(sections).toEqual(['view', 'tasks', 'details']);
    expect(document.body.querySelector('[data-sidebar-filter-project-names]')).not.toBeNull();
    expect(document.body.querySelector('[data-sidebar-filter-branch-names]')).not.toBeNull();
  });

  it('keeps both detail switches interactive in every organize mode', () => {
    const { onShowUpdatedProjectNamesChange, onShowBranchNamesChange } = render(
      'workspace',
      true,
      true
    );
    const projectNames = document.body.querySelector<HTMLButtonElement>(
      '[data-sidebar-filter-project-names]'
    );
    const branchNames = document.body.querySelector<HTMLButtonElement>(
      '[data-sidebar-filter-branch-names]'
    );

    // The switches describe persistent content preferences, not choices tied
    // to the open organize mode, so neither row is ever disabled.
    expect(projectNames?.disabled).toBe(false);
    expect(projectNames?.getAttribute('aria-checked')).toBe('true');
    expect(branchNames?.disabled).toBe(false);

    flushSync(() => {
      projectNames?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onShowUpdatedProjectNamesChange.mock.calls[0]?.[0]).toBe(false);

    flushSync(() => {
      branchNames?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onShowBranchNamesChange.mock.calls[0]?.[0]).toBe(false);
  });

  it('closes the menu after changing the view', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    function StatefulFilter() {
      const [organize, setOrganize] = React.useState<'workspace' | 'updated'>('workspace');
      return <SidebarFilterPopover organize={organize} scope="my" onOrganizeChange={setOrganize} />;
    }

    flushSync(() => {
      root?.render(<StatefulFilter />);
    });
    const trigger = container.querySelector('button[aria-label="Filter sidebar"]');
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const updatedRow = [...document.body.querySelectorAll('[role="menuitemradio"]')].find((row) =>
      row.textContent?.includes('Updated')
    );
    flushSync(() => {
      updatedRow?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(trigger?.getAttribute('aria-expanded')).toBe('false');
  });

  it('toggles Show Project with the details switch and keeps the menu open', () => {
    const { onShowUpdatedProjectNamesChange } = render('updated', true);
    const row = document.body.querySelector('[data-sidebar-filter-project-names]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('aria-checked')).toBe('true');
    expect(row?.getAttribute('role')).toBe('switch');
    expect(row?.getAttribute('aria-label')).toBe('Show Project');
    expect((row as HTMLButtonElement | null)?.disabled).toBe(false);

    flushSync(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onShowUpdatedProjectNamesChange.mock.calls[0]?.[0]).toBe(false);
    expect(
      container?.querySelector('button[aria-label="Filter sidebar"]')?.getAttribute('aria-expanded')
    ).toBe('true');
  });

  it('labels the branch switch and reports unchecked state', () => {
    render('workspace');
    const branchSwitch = document.body.querySelector('[data-sidebar-filter-branch-names]');
    expect(branchSwitch?.getAttribute('aria-label')).toBe('Show Branch');
    expect(branchSwitch?.getAttribute('aria-checked')).toBe('false');
  });
});
