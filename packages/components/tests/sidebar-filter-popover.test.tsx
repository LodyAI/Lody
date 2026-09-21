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

  function render(organize: 'workspace' | 'updated', showUpdatedProjectNames = true) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onShowUpdatedProjectNamesChange = vi.fn();
    flushSync(() => {
      root?.render(
        <SidebarFilterPopover
          organize={organize}
          scope="my"
          showUpdatedProjectNames={showUpdatedProjectNames}
          onShowUpdatedProjectNamesChange={onShowUpdatedProjectNamesChange}
        />
      );
    });
    const trigger = container.querySelector('button[aria-label="Filter sidebar"]');
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return { onShowUpdatedProjectNamesChange };
  }

  it('places the display switch after the view and task menu groups', () => {
    render('workspace');
    const sections = [
      ...document.body.querySelectorAll<HTMLElement>('[data-sidebar-filter-section]'),
    ].map((section) => section.dataset.sidebarFilterSection);
    expect(sections).toEqual(['view', 'tasks', 'display']);
    expect(document.body.querySelector('[data-sidebar-filter-project-names]')).not.toBeNull();
  });

  it('disables Show Project outside Updated view and explains its availability', () => {
    const { onShowUpdatedProjectNamesChange } = render('workspace');
    const switchControl = document.body.querySelector<HTMLButtonElement>(
      '[data-sidebar-filter-project-names]'
    );
    const row = document.body.querySelector('[data-sidebar-filter-section="display"]');

    expect(switchControl?.disabled).toBe(true);
    expect(switchControl?.getAttribute('aria-description')).toBe('Available in Updated view');
    expect(row?.hasAttribute('data-disabled')).toBe(true);

    flushSync(() => {
      switchControl?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onShowUpdatedProjectNamesChange).not.toHaveBeenCalled();
  });

  it('opens the unavailable hint from a touch interaction', () => {
    render('workspace');
    const row = document.body.querySelector<HTMLElement>('[data-sidebar-filter-section="display"]');
    const touchStart = new Event('pointerdown', { bubbles: true, cancelable: true });
    Object.defineProperty(touchStart, 'pointerType', { value: 'touch' });

    flushSync(() => {
      row?.dispatchEvent(touchStart);
    });

    expect(document.body.textContent).toContain('Available in Updated view');
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

  it('toggles Show Project with a bottom switch and keeps the menu open', () => {
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
});
