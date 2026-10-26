import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import { createStore, Provider } from 'jotai';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import {
  getLocalProjectHistoryProviderKey,
  getLodyMachinePresenceKey,
  type LocalProjectId,
  type LodyPresenceInstanceId,
  type MachineId,
} from '@lody/shared';
import { MobileProjectSettings } from '../components/mobile/mobile-project-settings';
import type { ProjectSettingsRow } from '../components/settings/project-settings';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '../atoms/presence';
import { resources } from '../i18n';

const styles = stylex.create({
  canvas: {
    minHeight: '100dvh',
    paddingBlock: 16,
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  },
  frame: { maxWidth: 640, marginInline: 'auto' },
  output: { display: 'block', padding: 16, overflowWrap: 'anywhere' },
});
const studio = 'synthetic-studio' as MachineId;
const remote = 'synthetic-remote' as MachineId;
const instanceId = 'synthetic-presence' as LodyPresenceInstanceId;
const now = 1790000000000;
type Mode =
  | 'multiple'
  | 'local'
  | 'loading'
  | 'empty'
  | 'long'
  | 'readonly'
  | 'pending'
  | 'filtered';

function makeRow(mode: Mode): ProjectSettingsRow {
  return {
    key: 'synthetic-local-project',
    machineId: studio,
    machineName: 'Synthetic Studio',
    shell: 'bash',
    project: {
      id: 'synthetic-project' as LocalProjectId,
      name: 'Synthetic local folder',
      rootPath: '/synthetic/workspace/project',
      createdAtMs: 1,
    },
    sharedWithTeam: false,
    conversationCount: 0,
    isUpdating: mode === 'pending',
    canUpdateSharing: mode !== 'readonly',
    worktreeSetup: { scripts: { bash: 'printf "synthetic setup"' } },
    worktreeCleanup: { scripts: { bash: 'printf "synthetic cleanup"' } },
    isWorktreeSetupLoading: false,
    isWorktreeSetupSaving: mode === 'pending',
    worktreeSetupError: null,
    isWorktreeCleanupLoading: mode === 'pending',
    isWorktreeCleanupSaving: false,
    worktreeCleanupError: null,
    historyImports: ['codex', 'claude'].map((agentType) => {
      const provider = { cliType: 'builtin' as const, agentType };
      return {
        provider,
        providerKey: getLocalProjectHistoryProviderKey(provider),
        canSync: true,
        isSyncing: mode === 'pending',
        isImporting: false,
        catalog: null,
        syncSummary: null,
        selectedSessionIds: [],
        resolvingSessionIds: [],
        errorMessage: null,
      };
    }),
  };
}

function Fixture({ mode }: { mode: Mode }) {
  const [intent, setIntent] = useState('none');
  const [row, setRow] = useState(() => makeRow(mode));
  const store = useMemo(() => {
    const next = createStore();
    next.set(lodyPresenceNowMsAtom, now);
    next.set(lodyPresenceStatesAtom, {
      [getLodyMachinePresenceKey(studio, instanceId)]: {
        kind: 'machine',
        machineId: studio,
        instanceId,
        updatedAt: now,
      },
    });
    return next;
  }, []);
  const language = useMemo(() => {
    const next = createInstance();
    void next.init({
      lng: 'en',
      fallbackLng: 'en',
      initAsync: false,
      resources: {
        en: {
          translation: {
            ...resources.en.translation,
            ...(mode === 'long'
              ? {
                  'workspace.projects.createMultiRepo':
                    'Several synthetic repositories or folders with an intentionally very long translated label / 多个代码仓库与文件夹',
                  'workspace.projects.repositoryCount':
                    '{{count}} synthetic repositories or folders with an intentionally long translated count description / 合成仓库和文件夹',
                }
              : {}),
          },
        },
      },
      interpolation: { escapeValue: false },
    });
    return next;
  }, [mode]);
  const hasLocal = ['local', 'readonly', 'pending', 'filtered'].includes(mode);
  const blank = mode === 'empty' || mode === 'loading';
  return (
    <Provider store={store}>
      <I18nextProvider i18n={language}>
        <div {...stylex.props(styles.canvas)}>
          <div
            {...stylex.props(styles.frame)}
            data-mobile-project-settings=""
            data-fixture-mode={mode}
          >
            <MobileProjectSettings
              sections={
                hasLocal
                  ? [
                      {
                        machineId: studio,
                        machineName: 'Synthetic Studio',
                        sharedWithTeam: false,
                        rows: [row],
                      },
                    ]
                  : []
              }
              githubSections={[]}
              isLoading={mode === 'loading'}
              githubProjectsLoading={false}
              initialMachineId={mode === 'filtered' ? studio : undefined}
              addableMachines={
                blank
                  ? []
                  : [
                      { machineId: studio, machineName: 'Synthetic Studio', online: true },
                      {
                        machineId: remote,
                        machineName: 'Synthetic offline machine with a long name',
                        online: false,
                      },
                    ]
              }
              multiRepoProjects={
                blank
                  ? []
                  : [
                      {
                        id: 'studio-project',
                        name:
                          mode === 'long'
                            ? 'Synthetic project with a deliberately overflowing name / 合成项目名称很长 '.repeat(
                                3
                              )
                            : 'Studio project',
                        memberCount: 3,
                        boundMachineId: studio,
                        canManage: true,
                      },
                      {
                        id: 'any-project',
                        name: 'Anywhere project',
                        memberCount: 12,
                        boundMachineId: null,
                        canManage: mode !== 'readonly',
                      },
                    ]
              }
              onAddLocalProject={
                mode === 'readonly' ? undefined : (machineId) => setIntent(`add:${machineId}`)
              }
              onCreateMultiRepoProject={mode === 'readonly' ? undefined : () => setIntent('create')}
              onOpenMultiRepoProject={
                mode === 'readonly' ? undefined : (id) => setIntent(`open:${id}`)
              }
              onSharedWithTeamChange={
                mode === 'readonly'
                  ? undefined
                  : async (_, sharedWithTeam) => {
                      setIntent(`share:${sharedWithTeam}`);
                      setRow((current) => ({ ...current, sharedWithTeam }));
                    }
              }
              onSyncHistory={async (_, provider) => setIntent(`sync:${provider.agentType}`)}
              onWorktreeSetupChange={async (_, config) => {
                setIntent(`setup:${config.scripts.bash}`);
                setRow((current) => ({ ...current, worktreeSetup: config }));
              }}
              onWorktreeCleanupChange={async (_, config) => {
                setIntent(`cleanup:${config.scripts.bash}`);
                setRow((current) => ({ ...current, worktreeCleanup: config }));
              }}
            />
            <output {...stylex.props(styles.output)} data-mobile-project-intent="">
              {intent}
            </output>
          </div>
        </div>
      </I18nextProvider>
    </Provider>
  );
}

const meta = {
  title: 'Mobile/OwnedMobileProjectSettingsMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const MultipleMachines: Story = { render: () => <Fixture mode="multiple" /> };
export const LocalEditors: Story = { render: () => <Fixture mode="local" /> };
export const Loading: Story = { render: () => <Fixture mode="loading" /> };
export const Empty: Story = { render: () => <Fixture mode="empty" /> };
export const LongTranslation: Story = { render: () => <Fixture mode="long" /> };
export const ReadOnly: Story = { render: () => <Fixture mode="readonly" /> };
export const Pending: Story = { render: () => <Fixture mode="pending" /> };
export const MachineFiltered: Story = { render: () => <Fixture mode="filtered" /> };
