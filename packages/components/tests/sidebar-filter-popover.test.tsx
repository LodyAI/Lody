// @vitest-environment jsdom

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarFilterPopover } from '../src/components/sidebar-filter-popover';
import { initI18n } from '../src/i18n';

describe('SidebarFilterPopover Updated project sub-option', () => {
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

  function render(organize: 'workspace' | 'updated', showUpdatedProject = true) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onShowUpdatedProjectChange = vi.fn();
    flushSync(() => {
      root?.render(
        React.createElement(SidebarFilterPopover, {
          organize,
          scope: 'my',
          showUpdatedProject,
          onShowUpdatedProjectChange,
        })
      );
    });
    const trigger = container.querySelector('button[aria-label="Filter sidebar"]');
    flushSync(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return { onShowUpdatedProjectChange };
  }

  it('hides the Show project row until Updated is selected', () => {
    render('workspace');
    expect(document.body.textContent).toContain('Updated');
    expect(document.body.querySelector('[data-sidebar-filter-show-project]')).toBeNull();
  });

  it('nests Show project under Updated and toggles it', () => {
    const { onShowUpdatedProjectChange } = render('updated', true);
    const row = document.body.querySelector('[data-sidebar-filter-show-project]');
    expect(row).not.toBeNull();
    expect(row?.getAttribute('aria-checked')).toBe('true');
    expect(row?.textContent).toContain('Show project');
    expect(row?.querySelector('[data-sidebar-filter-tree="trunk"]')).not.toBeNull();
    expect(row?.querySelector('[data-sidebar-filter-tree="elbow"]')).not.toBeNull();
    flushSync(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onShowUpdatedProjectChange).toHaveBeenCalledWith(false);
  });
});
