// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { SidebarFilterPopover } from '../src/components/sidebar-filter-popover';
import { SidebarOwnerFilterBar } from '../src/components/sidebar-owner-filter';
import { toggleTaskOwnerSelection } from '../src/lib/session-visibility';
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

  it('offers Hide Empty Projects only in the Project view and keeps the menu open', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onHideEmptyProjectsChange = vi.fn();
    const renderFilter = (organize: 'workspace' | 'updated') =>
      flushSync(() => {
        root?.render(
          <SidebarFilterPopover
            organize={organize}
            scope="my"
            hideEmptyProjects
            onHideEmptyProjectsChange={onHideEmptyProjectsChange}
            open
          />
        );
      });

    renderFilter('updated');
    expect(document.body.querySelector('[data-sidebar-filter-hide-empty-projects]')).toBeNull();

    renderFilter('workspace');
    const row = document.body.querySelector('[data-sidebar-filter-hide-empty-projects]');
    expect(row?.getAttribute('aria-label')).toBe('Hide Empty Projects');
    expect(row?.getAttribute('aria-checked')).toBe('true');
    flushSync(() => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onHideEmptyProjectsChange.mock.calls[0]?.[0]).toBe(false);
    expect(document.body.querySelector('[data-sidebar-filter-hide-empty-projects]')).not.toBeNull();
  });

  const teamMembers = [
    { userId: 'me', name: 'Sam Lee', isCurrentUser: true },
    { userId: 'alice', name: 'Alice Wang' },
    { userId: 'bob', name: 'Bob Chen' },
    { userId: 'carol', name: 'Carol Liu' },
    ...Array.from({ length: 46 }, (_, index) => ({
      userId: `m${index}`,
      name: `Member ${String(index).padStart(2, '0')}`,
    })),
  ];

  function renderOwnerFilter(initial: { scope: 'my' | 'team'; memberIds: string[] }) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const seen: Array<{ scope: 'my' | 'team'; memberIds: readonly string[] }> = [];
    function StatefulFilter() {
      const [selection, setSelection] = React.useState<{
        scope: 'my' | 'team';
        memberIds: readonly string[];
      }>(initial);
      seen.push(selection);
      return (
        <SidebarFilterPopover
          organize="status"
          scope={selection.scope}
          onScopeChange={(scope) => setSelection({ scope, memberIds: [] })}
          members={teamMembers}
          selectedMemberIds={selection.memberIds}
          onToggleMember={(id) => setSelection((prev) => toggleTaskOwnerSelection(prev, id, 'me'))}
          open
        />
      );
    }
    flushSync(() => {
      root?.render(<StatefulFilter />);
    });
    return { latest: () => seen[seen.length - 1] };
  }

  const ownerRow = () =>
    [...document.body.querySelectorAll<HTMLElement>('[data-sidebar-filter-owner-row]')][0];
  const ownerSearch = () =>
    document.body.querySelector<HTMLInputElement>('input[data-sidebar-owner-search]');
  const ownerOptions = () => [
    ...document.body.querySelectorAll<HTMLElement>('[data-sidebar-owner-option]'),
  ];
  function type(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    flushSync(() => {
      setter?.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('keeps the menu to three task rows however large the team is', () => {
    renderOwnerFilter({ scope: 'team', memberIds: [] });
    const tasks = document.body.querySelector('[data-sidebar-filter-section="tasks"]');
    expect(tasks?.querySelectorAll('button').length).toBe(3);
    expect(ownerSearch()).toBeNull();
  });

  it('finds a teammate by typing and ticks the top match with Enter, keeping the list open', async () => {
    const { latest } = renderOwnerFilter({ scope: 'team', memberIds: [] });
    flushSync(() => {
      ownerRow()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(ownerSearch()).not.toBeNull());
    // You first, then everyone else by name.
    expect(ownerOptions()[0]?.textContent).toContain('Sam Lee');
    expect(ownerOptions()[1]?.textContent).toContain('Alice Wang');

    type(ownerSearch()!, 'bob');
    expect(ownerOptions().map((row) => row.dataset.sidebarOwnerOption)).toEqual(['bob']);
    flushSync(() => {
      ownerSearch()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(latest()).toEqual({ scope: 'team', memberIds: ['bob'] });
    expect(ownerSearch()).not.toBeNull();
    expect(ownerRow()?.textContent).toContain('Bob Chen');
  });

  it('leaves the selection alone when Enter only confirms an IME composition', async () => {
    const { latest } = renderOwnerFilter({ scope: 'team', memberIds: [] });
    flushSync(() => {
      ownerRow()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(ownerSearch()).not.toBeNull());
    type(ownerSearch()!, 'bob');
    flushSync(() => {
      ownerSearch()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
      );
    });
    expect(latest()).toEqual({ scope: 'team', memberIds: [] });
  });

  it('lists the people already chosen right after you when the list opens', async () => {
    renderOwnerFilter({ scope: 'team', memberIds: ['carol', 'm40', 'bob'] });
    expect(ownerRow()?.textContent).toContain('Carol Liu');
    expect(ownerRow()?.textContent).toContain('+2');
    flushSync(() => {
      ownerRow()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => expect(ownerSearch()).not.toBeNull());
    expect(
      ownerOptions()
        .slice(0, 4)
        .map((row) => row.dataset.sidebarOwnerOption)
    ).toEqual(['me', 'bob', 'carol', 'm40']);
    expect(ownerOptions()[0]?.getAttribute('aria-checked')).toBe('false');
    expect(ownerOptions()[1]?.getAttribute('aria-checked')).toBe('true');
  });

  it('lists no people in a single-member workspace', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    flushSync(() => {
      root?.render(
        <SidebarFilterPopover
          organize="workspace"
          scope="team"
          members={[{ userId: 'me', name: 'Sam', isCurrentUser: true }]}
          open
        />
      );
    });
    expect(ownerRow()).toBeUndefined();
  });
});

describe('SidebarOwnerFilterBar', () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  beforeEach(async () => {
    await initI18n('en');
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
  });

  const members = [
    { userId: 'me', name: 'Sam Lee', isCurrentUser: true },
    { userId: 'alice', name: 'Alice Wang' },
    { userId: 'bob', name: 'Bob Chen' },
    { userId: 'carol', name: 'Carol Liu' },
  ];

  function renderBar(selectedMemberIds: string[]) {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onClear = vi.fn();
    flushSync(() => {
      root?.render(
        <SidebarOwnerFilterBar
          members={members}
          selectedMemberIds={selectedMemberIds}
          onToggleMember={() => {}}
          onClear={onClear}
        />
      );
    });
    return { onClear };
  }

  it('reads as a Linear-style formula and clears with its remove button', () => {
    const { onClear } = renderBar(['alice']);
    const bar = container?.querySelector('[data-sidebar-owner-filter-bar]');
    expect(bar?.textContent).toContain('Owner');
    expect(bar?.textContent).toContain('is');
    expect(bar?.textContent).not.toContain('is any of');
    expect(bar?.textContent).toContain('Alice Wang');
    const clear = container?.querySelector('button[aria-label="Clear owner filter"]');
    flushSync(() => {
      clear?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('switches to "is any of" and folds names past two into a count', () => {
    renderBar(['alice', 'bob', 'carol']);
    const bar = container?.querySelector('[data-sidebar-owner-filter-bar]');
    expect(bar?.textContent).toContain('is any of');
    expect(bar?.textContent).toContain('Alice Wang, Bob Chen');
    expect(bar?.textContent).toContain('+1');
  });

  it('renders nothing while no one is chosen', () => {
    renderBar([]);
    expect(container?.querySelector('[data-sidebar-owner-filter-bar]')).toBeNull();
  });
});
