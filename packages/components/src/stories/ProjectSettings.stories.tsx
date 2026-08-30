import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import {
  getLocalProjectHistoryProviderKey,
  type LocalProjectHistoryProvider,
  type LocalProjectId,
  type MachineId,
  type WorktreeSetupScriptConfig,
} from '@lody/shared';
import {
  ProjectSettingsView,
  type ProjectSettingsSection,
  type ProjectSettingsRow,
  type GithubProjectSettingsSection,
} from '@/components/settings/project-settings';
import { SettingsStoryProviders } from './settings-story-shell';

const machineLocal = 'machine-local' as MachineId;
const machineRemote = 'machine-remote' as MachineId;
const storyProviders: LocalProjectHistoryProvider[] = [
  { cliType: 'builtin', agentType: 'codex' },
  { cliType: 'builtin', agentType: 'claude' },
  { cliType: 'registry', agentType: 'opencode' },
];
const emptySetup: WorktreeSetupScriptConfig = { scripts: {} };

function makeRow(
  key: string,
  machineId: MachineId,
  machineName: string,
  name: string,
  rootPath: string,
  sharedWithTeam: boolean
): ProjectSettingsRow {
  return {
    key,
    machineId,
    machineName,
    shell: machineId === machineRemote ? 'powershell' : 'bash',
    project: {
      id: key.split(':')[1] as LocalProjectId,
      name,
      rootPath,
      createdAtMs: 1,
    },
    sharedWithTeam,
    isUpdating: false,
    canUpdateSharing: true,
    worktreeSetup: emptySetup,
    isWorktreeSetupLoading: false,
    isWorktreeSetupSaving: false,
    worktreeSetupError: null,
    worktreeCleanup: emptySetup,
    isWorktreeCleanupLoading: false,
    isWorktreeCleanupSaving: false,
    worktreeCleanupError: null,
    historyImports: storyProviders.map((provider) => ({
      provider,
      providerKey: getLocalProjectHistoryProviderKey(provider),
      canSync: machineId === machineLocal,
      isSyncing: false,
      isImporting: false,
      catalog: null,
      syncSummary: null,
      selectedSessionIds: [],
      resolvingSessionIds: [],
      errorMessage: null,
    })),
  };
}

function updateHistoryImportState(
  row: ProjectSettingsRow,
  provider: LocalProjectHistoryProvider,
  update: (
    state: ProjectSettingsRow['historyImports'][number]
  ) => ProjectSettingsRow['historyImports'][number]
): ProjectSettingsRow {
  const providerKey = getLocalProjectHistoryProviderKey(provider);
  return {
    ...row,
    historyImports: row.historyImports.map((state) =>
      state.providerKey === providerKey ? update(state) : state
    ),
  };
}

const baseSections: ProjectSettingsSection[] = [
  {
    machineId: machineLocal,
    machineName: 'MacBook Pro',
    rows: [
      makeRow(
        'machine-local:project-lody',
        machineLocal,
        'MacBook Pro',
        'Lody',
        '/repo/lody',
        true
      ),
      makeRow(
        'machine-local:project-site',
        machineLocal,
        'MacBook Pro',
        'marketing-site',
        '/repo/site',
        false
      ),
    ],
  },
  {
    machineId: machineRemote,
    machineName: 'Workstation',
    rows: [
      makeRow(
        'machine-remote:project-cli',
        machineRemote,
        'Workstation',
        'cli-sandbox',
        '/srv/cli-sandbox',
        false
      ),
    ],
  },
];

const baseGithubSections: GithubProjectSettingsSection[] = [
  {
    owner: 'loro-dev',
    rows: [
      {
        key: 'github:loro-dev/lody',
        owner: 'loro-dev',
        repoFullName: 'loro-dev/lody',
        name: 'lody',
        private: true,
        worktreeSetup: {
          scripts: { bash: 'pnpm install' },
        },
        isWorktreeSetupSaving: false,
        worktreeSetupError: null,
        worktreeCleanup: {
          scripts: { bash: 'rm -rf node_modules' },
        },
        isWorktreeCleanupSaving: false,
        worktreeCleanupError: null,
      },
    ],
  },
];

function StoryWrapper({
  sections = baseSections,
  githubSections = baseGithubSections,
  isLoading = false,
}: {
  sections?: ProjectSettingsSection[];
  githubSections?: GithubProjectSettingsSection[];
  isLoading?: boolean;
}) {
  const [currentSections, setCurrentSections] = useState(sections);
  const [currentGithubSections, setCurrentGithubSections] = useState(githubSections);

  return (
    <div className="mx-auto max-w-4xl p-4">
      <ProjectSettingsView
        sections={currentSections}
        githubSections={currentGithubSections}
        isLoading={isLoading}
        githubProjectsLoading={false}
        onSharedWithTeamChange={async (row, sharedWithTeam) => {
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key ? { ...current, sharedWithTeam } : current
              ),
            }))
          );
        }}
        onAddLocalProject={() => {
          console.info('Add local project');
        }}
        onAddGitHubProject={() => {
          console.info('Add GitHub project');
        }}
        onSyncHistory={async (row, provider) => {
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key
                  ? updateHistoryImportState(current, provider, (state) => ({
                      ...state,
                      isSyncing: true,
                    }))
                  : current
              ),
            }))
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key
                  ? updateHistoryImportState(current, provider, (state) => ({
                      ...state,
                      isSyncing: false,
                      catalog: {
                        listed: 4,
                        lastListedAt: Date.now(),
                        sessions: [
                          {
                            acpSessionId: `${state.providerKey}-session-3`,
                            title: 'Fix sidebar noise from imported history',
                            updatedAt: '2026-05-14T05:30:00.000Z',
                            status: 'available',
                          },
                          {
                            acpSessionId: `${state.providerKey}-session-2`,
                            title: 'Review local project settings',
                            updatedAt: '2026-05-13T14:20:00.000Z',
                            status: 'available',
                          },
                          {
                            acpSessionId: `${state.providerKey}-session-1`,
                            title: 'Initial sync prototype',
                            updatedAt: '2026-05-12T09:10:00.000Z',
                            importedSessionId: 'lody-session-1',
                            status: 'imported',
                          },
                          {
                            acpSessionId: `${state.providerKey}-session-conflict`,
                            title: 'Resolve stale imported replay',
                            updatedAt: '2026-05-11T07:45:00.000Z',
                            importedSessionId: 'lody-session-conflict',
                            status: 'sync_conflict',
                          },
                        ],
                      },
                    }))
                  : current
              ),
            }))
          );
        }}
        onHistorySelectionChange={(row, provider, selectedIds) => {
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key
                  ? updateHistoryImportState(current, provider, (state) => ({
                      ...state,
                      selectedSessionIds: selectedIds,
                    }))
                  : current
              ),
            }))
          );
        }}
        onImportHistory={async (row, provider) => {
          const providerKey = getLocalProjectHistoryProviderKey(provider);
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key
                  ? updateHistoryImportState(current, provider, (state) => ({
                      ...state,
                      isImporting: true,
                    }))
                  : current
              ),
            }))
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          const selected = new Set(
            row.historyImports.find((state) => state.providerKey === providerKey)
              ?.selectedSessionIds ?? []
          );
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key
                  ? updateHistoryImportState(current, provider, (state) => ({
                      ...state,
                      isImporting: false,
                      selectedSessionIds: [],
                      syncSummary: {
                        listed: selected.size,
                        imported: selected.size,
                        refreshed: 0,
                        skipped: 0,
                        conflicted: 0,
                        failed: 0,
                        failures: [],
                      },
                      catalog: state.catalog
                        ? {
                            ...state.catalog,
                            sessions: state.catalog.sessions.map((session) =>
                              selected.has(session.acpSessionId)
                                ? {
                                    ...session,
                                    importedSessionId: `lody-${session.acpSessionId}`,
                                    status: 'imported',
                                  }
                                : session
                            ),
                          }
                        : state.catalog,
                    }))
                  : current
              ),
            }))
          );
        }}
        onResolveHistoryConflict={async (row, provider, session) => {
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key
                  ? updateHistoryImportState(current, provider, (state) => ({
                      ...state,
                      resolvingSessionIds: [...state.resolvingSessionIds, session.acpSessionId],
                    }))
                  : current
              ),
            }))
          );
          await new Promise((resolve) => setTimeout(resolve, 300));
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key
                  ? updateHistoryImportState(current, provider, (state) => ({
                      ...state,
                      resolvingSessionIds: state.resolvingSessionIds.filter(
                        (id) => id !== session.acpSessionId
                      ),
                      catalog: state.catalog
                        ? {
                            ...state.catalog,
                            sessions: state.catalog.sessions.map((item) =>
                              item.acpSessionId === session.acpSessionId
                                ? { ...item, status: 'imported' }
                                : item
                            ),
                          }
                        : state.catalog,
                    }))
                  : current
              ),
            }))
          );
        }}
        onWorktreeSetupChange={async (row, config) => {
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key ? { ...current, worktreeSetup: config } : current
              ),
            }))
          );
        }}
        onWorktreeCleanupChange={async (row, config) => {
          setCurrentSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key ? { ...current, worktreeCleanup: config } : current
              ),
            }))
          );
        }}
        onGithubWorktreeSetupChange={async (row, config) => {
          setCurrentGithubSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key ? { ...current, worktreeSetup: config } : current
              ),
            }))
          );
        }}
        onGithubWorktreeCleanupChange={async (row, config) => {
          setCurrentGithubSections((prev) =>
            prev.map((section) => ({
              ...section,
              rows: section.rows.map((current) =>
                current.key === row.key ? { ...current, worktreeCleanup: config } : current
              ),
            }))
          );
        }}
      />
    </div>
  );
}

const meta = {
  title: 'Settings/ProjectSettings',
  component: StoryWrapper,
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) => (
      <SettingsStoryProviders capabilities={['teamSharing']}>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
  tags: ['autodocs'],
} satisfies Meta<typeof StoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SingleMachine: Story = {
  args: {
    sections: [baseSections[0]!],
  },
};

export const InitialHistorySync: Story = {
  args: {
    sections: [
      {
        ...baseSections[0]!,
        rows: [baseSections[0]!.rows[0]!],
      },
    ],
    githubSections: [],
  },
};

export const SyncedEmptyHistory: Story = {
  args: {
    sections: [
      {
        ...baseSections[0]!,
        rows: [
          updateHistoryImportState(baseSections[0]!.rows[0]!, storyProviders[0]!, (state) => ({
            ...state,
            catalog: {
              listed: 0,
              lastListedAt: 0,
              sessions: [],
            },
          })),
        ],
      },
    ],
    githubSections: [],
  },
};

export const ManyProjects: Story = {
  args: {
    sections: [
      {
        machineId: machineLocal,
        machineName: 'MacBook Pro',
        rows: [
          makeRow('machine-local:p1', machineLocal, 'MacBook Pro', 'Lody', '/repo/lody', true),
          makeRow(
            'machine-local:p2',
            machineLocal,
            'MacBook Pro',
            'marketing-site',
            '/repo/site',
            false
          ),
          makeRow('machine-local:p3', machineLocal, 'MacBook Pro', 'docs', '/repo/docs', true),
          makeRow(
            'machine-local:p4',
            machineLocal,
            'MacBook Pro',
            'playground',
            '/repo/playground',
            false
          ),
        ],
      },
      {
        machineId: machineRemote,
        machineName: 'Workstation',
        rows: [
          makeRow(
            'machine-remote:p1',
            machineRemote,
            'Workstation',
            'cli-sandbox',
            '/srv/cli-sandbox',
            false
          ),
          makeRow(
            'machine-remote:p2',
            machineRemote,
            'Workstation',
            'experiment',
            '/srv/experiment',
            true
          ),
        ],
      },
    ],
  },
};

export const Empty: Story = {
  args: {
    sections: [],
  },
};

export const Loading: Story = {
  args: {
    isLoading: true,
  },
};
