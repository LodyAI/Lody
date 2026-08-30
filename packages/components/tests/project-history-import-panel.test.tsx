// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  getLocalProjectHistoryProviderKey,
  type LocalProjectHistoryProvider,
  type LocalProjectId,
  type MachineId,
} from '@lody/shared';
import {
  ProjectHistoryImportPanel,
  type ProjectHistoryImportState,
  type ProjectSettingsRow,
} from '../src/components/settings/project-settings';
import { initI18n } from '../src/i18n';
import { TooltipProvider } from '../src/ui/tooltip';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const provider: LocalProjectHistoryProvider = {
  cliType: 'builtin',
  agentType: 'codex',
};

function makeState(catalog: ProjectHistoryImportState['catalog']): ProjectHistoryImportState {
  return {
    provider,
    providerKey: getLocalProjectHistoryProviderKey(provider),
    canSync: true,
    isSyncing: false,
    isImporting: false,
    catalog,
    syncSummary: null,
    selectedSessionIds: [],
    resolvingSessionIds: [],
    errorMessage: null,
  };
}

function makeRow(state: ProjectHistoryImportState): ProjectSettingsRow {
  return {
    key: 'machine:test-project',
    machineId: 'machine' as MachineId,
    machineName: 'Test machine',
    shell: 'bash',
    project: {
      id: 'test-project' as LocalProjectId,
      name: 'Test project',
      rootPath: '/repo/test-project',
      createdAtMs: 1,
    },
    sharedWithTeam: false,
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
    historyImports: [state],
  };
}

describe('ProjectHistoryImportPanel empty states', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(async () => {
    await initI18n('en');
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

  async function renderState(state: ProjectHistoryImportState) {
    const row = makeRow(state);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <ProjectHistoryImportPanel row={row} state={state} onSyncHistory={async () => {}} />
        </TooltipProvider>
      );
    });
  }

  function buttonLabels() {
    return Array.from(container.querySelectorAll('button')).flatMap((button) => {
      const label = button.textContent?.trim();
      return label ? [label] : [];
    });
  }

  it('guides the first sync without showing list actions', async () => {
    await renderState(makeState(null));

    expect(container.textContent).toContain('Sync Codex conversations');
    expect(buttonLabels()).toEqual(['Sync']);
  });

  it('guides another sync when the synced catalog is empty', async () => {
    await renderState(makeState({ listed: 0, lastListedAt: 1, sessions: [] }));

    expect(container.textContent).toContain('No Codex conversations found');
    expect(buttonLabels()).toEqual(['Sync again']);
  });

  it('shows the sync and import actions once conversations are available', async () => {
    await renderState(
      makeState({
        listed: 1,
        lastListedAt: 1,
        sessions: [
          {
            acpSessionId: 'codex-session',
            title: 'Conversation from Codex',
            status: 'available',
          },
        ],
      })
    );

    expect(container.textContent).toContain('Conversation from Codex');
    expect(buttonLabels()).toEqual(['Sync', 'Import']);
  });
});
