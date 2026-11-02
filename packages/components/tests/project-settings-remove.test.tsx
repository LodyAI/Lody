// @vitest-environment jsdom

import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProjectId, MachineId } from '@lody/shared';

import {
  ProjectSettingsView,
  type ProjectSettingsRow,
  type ProjectSettingsSection,
} from '../src/components/settings/project-settings';
import { initI18n } from '../src/i18n';
import { SettingsStoryProviders } from '../src/stories/settings-story-shell';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const machineId = 'machine-local' as MachineId;

function makeRow(): ProjectSettingsRow {
  return {
    key: `${machineId}:project-lody`,
    machineId,
    machineName: 'MacBook Pro',
    shell: 'bash',
    project: {
      id: 'project-lody' as LocalProjectId,
      name: 'Lody',
      rootPath: '/repo/lody',
      createdAtMs: 1,
    },
    sharedWithTeam: false,
    conversationCount: 4,
    isUpdating: false,
    canUpdateSharing: true,
    worktreeSetup: { scripts: {} },
    isWorktreeSetupLoading: false,
    isWorktreeSetupSaving: false,
    worktreeSetupError: null,
    worktreeCleanup: { scripts: {} },
    isWorktreeCleanupLoading: false,
    isWorktreeCleanupSaving: false,
    worktreeCleanupError: null,
    historyImports: [],
  };
}

const sections: ProjectSettingsSection[] = [
  { machineId, machineName: 'MacBook Pro', sharedWithTeam: false, rows: [makeRow()] },
];

describe('ProjectSettingsView local-project remove', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    await initI18n('en');
    Object.defineProperty(globalThis, 'ResizeObserver', {
      configurable: true,
      writable: true,
      value: class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    });
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it('hides delete when canRemoveLocalProject is false', async () => {
    await act(async () => {
      root.render(
        <SettingsStoryProviders>
          <ProjectSettingsView
            sections={sections}
            githubSections={[]}
            isLoading={false}
            githubProjectsLoading={false}
          />
        </SettingsStoryProviders>
      );
    });

    expect(container.textContent).not.toContain('Delete project');
  });

  it('deletes the selected project directly from settings', async () => {
    function Settings() {
      const [rows, setRows] = useState(sections);
      return (
        <ProjectSettingsView
          sections={rows}
          githubSections={[]}
          isLoading={false}
          githubProjectsLoading={false}
          canRemoveLocalProject={() => true}
          onRequestRemoveLocalProject={(target) =>
            setRows((current) =>
              current.map((section) => ({
                ...section,
                rows: section.rows.filter((row) => row.key !== target.key),
              }))
            )
          }
        />
      );
    }
    await act(async () => {
      root.render(
        <SettingsStoryProviders>
          <Settings />
        </SettingsStoryProviders>
      );
    });

    const projectRow = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Lody')
    );
    expect(projectRow).toBeInstanceOf(HTMLButtonElement);
    await act(async () => projectRow?.click());
    const deleteButtons = Array.from(document.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('Delete project')
    );
    expect(deleteButtons.length).toBeGreaterThan(0);
    await act(async () => deleteButtons[0]?.click());
    expect(container.textContent).toContain('No folders added on this machine yet.');
    expect(
      Array.from(document.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Delete project'
      )
    ).toBe(false);
  });

  // One add for the page, named like every catalog's: the folder dialog asks
  // which machine, so a source section carries no second "Add folder".
  it('adds a project from the one labelled page action', async () => {
    const onAddLocalProject = vi.fn();
    await act(async () => {
      root.render(
        <SettingsStoryProviders>
          <ProjectSettingsView
            sections={[{ ...sections[0]!, rows: [] }]}
            githubSections={[]}
            isLoading={false}
            githubProjectsLoading={false}
            addableMachines={[{ machineId, machineName: 'MacBook Pro', online: true }]}
            onAddLocalProject={onAddLocalProject}
          />
        </SettingsStoryProviders>
      );
    });

    const buttons = Array.from(container.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent?.includes('Add folder'))).toBe(false);
    const add = buttons.filter((button) => button.textContent?.trim() === 'Add project');
    expect(add).toHaveLength(1);
    await act(async () => add[0]?.click());
    expect(onAddLocalProject).toHaveBeenCalledWith();
    expect(container.textContent).toContain('No folders added on this machine yet.');
  });
});
