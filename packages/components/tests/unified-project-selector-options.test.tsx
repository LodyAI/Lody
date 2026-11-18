// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';

import {
  UnifiedProjectSelectorView,
  type UnifiedLocalProjectOption,
} from '../src/components/chat/unified-project-selector';
import { Tooltip } from '@lody/ui/tooltip';
import { useRemovedNativeProjectSelection } from '../src/hooks/use-chat-landing-defaults';
import {
  nativeMachineCatalogHarness,
  machineA,
  machineB,
  binding,
  view,
} from './native-machine-catalog.test-support';
import {
  AddLocalProjectDialog,
  type RemoteDirectoryOps,
} from '../src/components/local-projects/add-local-project-dialog';
import { createTestI18n, withTestI18n } from './test-i18n';

const testI18n = createTestI18n({ interpolate: false });

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

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
        withTestI18n(
          <Tooltip.Provider>
            <UnifiedProjectSelectorView
              value={{ kind: 'none' }}
              onChange={vi.fn()}
              localProjects={localProjects}
              onAddLocalProject={vi.fn()}
              onConnectGitRepo={vi.fn()}
              renderLimit={20}
            />
          </Tooltip.Provider>,
          testI18n
        )
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    expect(trigger).toBeInstanceOf(HTMLButtonElement);

    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
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
    });

    const searchedProjectItems = Array.from(
      document.querySelectorAll<HTMLElement>('[role^="menuitem"]')
    ).filter((item) => item.textContent?.startsWith('Project '));
    expect(searchedProjectItems.map((item) => item.textContent)).toEqual(['Project 25']);
  });

  it('includes recently used GitHub repositories in the bounded mixed list', async () => {
    await act(async () => {
      root.render(
        withTestI18n(
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
          </Tooltip.Provider>,
          testI18n
        )
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
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
        withTestI18n(
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
          </Tooltip.Provider>,
          testI18n
        )
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
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
        withTestI18n(
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
          </Tooltip.Provider>,
          testI18n
        )
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    await act(async () => {
      trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
    });

    const groupItems = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
    ).filter((item) => /Shop|Split/.test(item.textContent ?? ''));
    // Keep raw fallback labels here; interpolation is exercised by the other i18n suites.
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
        withTestI18n(
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
          </Tooltip.Provider>,
          testI18n
        )
      );
    });

    const trigger = container.querySelector<HTMLButtonElement>('button');
    vi.useFakeTimers();
    // A shared worker can have an unrelated bootstrap poll still running.
    const backgroundPoll = setInterval(() => {}, 500);
    try {
      await act(async () => {
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }));
        // Flush only the menu's immediate work, not the shared worker's polling clock.
        await vi.advanceTimersByTimeAsync(0);
      });
    } finally {
      clearInterval(backgroundPoll);
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
  it('keeps Add a folder disabled until its runtime exists, preserves ordinary selection, and retains an opened directory draft', async () => {
    const machine = {
      id: machineId,
      name: 'Your machine',
      online: true,
      ownerName: null,
      canAddProjects: true,
    };
    const machines = [machine];
    const ops: RemoteDirectoryOps = {
      listRoots: async () => ({
        ok: true,
        value: { platform: 'linux', pathSeparator: '/', homeDir: '/work' },
      }),
      browseDir: async (_id, args) => ({
        ok: true,
        value: {
          path: args.absolutePath ?? '/work',
          parentPath: '/',
          entries: [],
          truncated: false,
        },
      }),
      createDirectory: async () => ({ ok: false, message: 'Not part of this interaction' }),
      addProject: async () => ({ ok: false, message: 'Draft must remain unsubmitted' }),
    };
    function Harness({ ready, revision }: { ready: boolean; revision: number }) {
      const [open, setOpen] = useState(false);
      const [selected, setSelected] = useState<
        import('../src/components/chat/unified-project-selector').UnifiedProjectSelection
      >({ kind: 'none' });
      return (
        <>
          <UnifiedProjectSelectorView
            value={selected}
            onChange={setSelected}
            localProjects={localProjects}
            onAddLocalProject={() => setOpen(true)}
            addLocalProjectDisabled={!ready}
            onConnectGitRepo={() => {}}
          />
          <output data-selection>
            {selected.kind === 'local' ? selected.localProjectId : selected.kind}
          </output>
          <output data-revision>{revision}</output>
          <AddLocalProjectDialog
            open={open}
            onOpenChange={setOpen}
            isMobile={false}
            machines={machines}
            initialMachineId={machineId}
            ops={ops}
            onAdded={() => {}}
          />
        </>
      );
    }
    const render = async (ready: boolean, revision: number) =>
      act(async () =>
        root.render(
          withTestI18n(
            <Tooltip.Provider>
              <Harness ready={ready} revision={revision} />
            </Tooltip.Provider>,
            testI18n
          )
        )
      );
    const openMenu = async () =>
      act(async () =>
        container
          .querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')!
          .dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'ArrowDown' }))
      );
    const addFolder = () =>
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
        (node) => node.textContent === 'Add a folder'
      )!;
    await render(false, 0);
    expect(container.querySelector('button[aria-haspopup="menu"]')?.getAttribute('aria-busy')).toBe(
      'true'
    );
    await openMenu();
    expect(addFolder().getAttribute('aria-disabled')).toBe('true');
    await act(async () => addFolder().click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    const project = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (node) => node.textContent === 'Project 1'
    )!;
    await act(async () => project.click());
    expect(container.querySelector('[data-selection]')?.textContent).toBe('project-1');
    await openMenu();
    expect(addFolder().getAttribute('aria-disabled')).toBe('true');
    await render(true, 1);
    expect(
      container.querySelector('button[aria-haspopup="menu"]')?.getAttribute('aria-busy')
    ).toBeNull();
    expect(addFolder().getAttribute('aria-disabled')).not.toBe('true');
    await act(async () => addFolder().click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    const editPath = document.querySelector<HTMLButtonElement>('button[title="Edit path"]');
    expect(editPath?.disabled).toBe(false);
    await act(async () => editPath!.click());
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder="Type an absolute path"]'
    );
    expect(input).not.toBeNull();
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
        input,
        '/work/unsubmitted-draft'
      );
      input!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await render(true, 2);
    expect(container.querySelector('[data-revision]')?.textContent).toBe('2');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(
      document.querySelector<HTMLInputElement>('input[placeholder="Type an absolute path"]')?.value
    ).toBe('/work/unsubmitted-draft');
  });
  it('clears only a removed draft project confirmed by its ready native catalog, retaining unknown and foreign scopes', async () => {
    const host = nativeMachineCatalogHarness([machineA, machineB]);
    const project = {
      id: 'native-project',
      name: 'Native Project',
      rootPath: '/work/native',
      createdAtMs: 1,
    };
    const initial = view(machineA);
    host.snapshots.set(machineA, {
      ...initial,
      synced: false,
      projection: { ...initial.projection, projects: [project] },
    });
    const source = host.source();
    function Harness({
      workspace = binding.workspaceId,
      account = binding.accountId,
      owned = machineA,
    }: {
      workspace?: string;
      account?: string;
      owned?: MachineId;
    }) {
      const [selection, setSelection] = useState<
        import('../src/components/chat/unified-project-selector').UnifiedProjectSelection
      >({ kind: 'local', machineId: machineA, localProjectId: project.id as LocalProjectId });
      const [context, setContext] = useState<'local' | 'chat' | 'github'>('local');
      useRemovedNativeProjectSelection({
        runtime: {
          workspaceId: workspace as never,
          nativeMachineCatalogSource: source,
          ownsNativeMachineCatalog: (id) => id === owned,
        },
        workspaceId: workspace,
        accountId: account,
        contextType: context,
        selection: selection.kind === 'local' ? selection : null,
        onRemoved: () => {
          setSelection({ kind: 'none' });
          setContext('chat');
        },
      });
      const current = source.readProjection(machineA);
      return (
        <>
          <output data-context>{context}</output>
          <output data-selected-project>
            {selection.kind === 'local' ? selection.localProjectId : 'none'}
          </output>
          <UnifiedProjectSelectorView
            value={selection}
            onChange={setSelection}
            localProjects={(current?.projection.projects ?? []).map((value) => ({
              key: `${machineA}:${value.id}`,
              machineId: machineA,
              localProjectId: value.id as LocalProjectId,
              name: value.name,
              rootPath: value.rootPath,
            }))}
            onAddLocalProject={() => {}}
            onConnectGitRepo={() => {}}
          />
        </>
      );
    }
    const render = async (props: Parameters<typeof Harness>[0] = {}) =>
      act(async () =>
        root.render(
          withTestI18n(
            <Tooltip.Provider>
              <Harness {...props} />
            </Tooltip.Provider>,
            testI18n
          )
        )
      );
    const selected = () => container.querySelector('[data-selected-project]')?.textContent;
    try {
      await render();
      expect(selected()).toBe(project.id);
      await act(async () => source.start());
      expect(container.querySelector('button[aria-haspopup="menu"]')?.textContent).toContain(
        'Native Project'
      );
      const lease = [...host.leases.values()].find(
        (value) => value.request.machineId === machineA
      )!;
      await act(async () =>
        host.send({
          ...lease.request,
          leaseId: lease.leaseId,
          type: 'error',
          code: 'restart_required',
        })
      );
      expect(source.readProjection(machineA)).toBeUndefined();
      expect(selected()).toBe(project.id);
      host.snapshots.set(machineA, { ...initial, synced: false });
      await render({ workspace: 'foreign-workspace' });
      await act(async () => source.reacquire(machineA));
      expect(source.getStatus(machineA)).toBe('ready');
      expect(selected()).toBe(project.id);
      await render({ account: 'foreign-account' });
      expect(selected()).toBe(project.id);
      await render({ owned: machineB });
      expect(selected()).toBe(project.id);
      await render();
      expect(selected()).toBe('none');
      expect(container.querySelector('[data-context]')?.textContent).toBe('chat');
      expect(container.querySelector('button[aria-haspopup="menu"]')?.textContent).toContain(
        'Select a project'
      );
    } finally {
      await act(async () => source.close());
    }
  });
});
