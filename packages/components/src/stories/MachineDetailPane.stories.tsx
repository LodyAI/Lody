import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Provider, createStore } from 'jotai';
import {
  CODEX_SPARK_LIMIT_ID,
  getLodyMachinePresenceKey,
  getRateLimitEntryKey,
  getServerNow,
  type AgentConfigId,
  type AgentConfigMeta,
  type LodyPresenceInstanceId,
  type MachineId,
  type MachineViewMeta,
} from '@lody/shared';
import { MachineDetailPane } from '@/components/settings/machine-detail-pane';
import { lodyPresenceStatesAtom, lodyPresenceSyncStateAtom } from '@/atoms/presence';

const machineId = 'machine-story' as MachineId;
const resetIn = (seconds: number) => Math.floor(getServerNow() / 1000) + seconds;

const baseMachine: MachineViewMeta = {
  id: machineId,
  name: 'MacBook Pro',
  cliVersion: '0.44.0',
  os: 'macOS 15.2',
  sessions: [],
  raceLimits: {},
  lastSeen: getServerNow(),
  ownerUserId: 'user-1',
};

const configs: AgentConfigMeta[] = [
  {
    id: 'cfg-claude' as AgentConfigId,
    machineId,
    name: 'Claude Code',
    description: undefined,
    cliType: 'builtin',
    agentType: 'claude',
    env: { ANTHROPIC_API_KEY: 'sk-test', ANTHROPIC_BASE_URL: 'https://api.example.com' },
  },
  {
    id: 'cfg-codex' as AgentConfigId,
    machineId,
    name: 'Codex Spark',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
  {
    id: 'cfg-auggie' as AgentConfigId,
    machineId,
    name: 'Auggie',
    description: undefined,
    cliType: 'registry',
    agentType: 'auggie',
    env: {},
  },
];

type StoryProps = {
  machine?: MachineViewMeta;
  configs?: AgentConfigMeta[];
  isOwn?: boolean;
  sharedWithTeam?: boolean;
  canDelete?: boolean;
  ownerName?: string | null;
  showPing?: boolean;
  showRestart?: boolean;
  canRevokeCredentials?: boolean;
  /** Mocks the presence transport as synced + heartbeating so `isOnline` (and
   * anything gated on it, like the daemon-update banner) reads true. */
  presenceOnline?: boolean;
  showUpdate?: boolean;
};

function StoryWrapper({
  machine = baseMachine,
  configs: storyConfigs = configs,
  isOwn = true,
  sharedWithTeam = true,
  canDelete = false,
  ownerName = null,
  showPing = false,
  showRestart = false,
  canRevokeCredentials = false,
  presenceOnline = false,
  showUpdate = false,
}: StoryProps) {
  const [store] = useState(() => {
    const nextStore = createStore();
    if (presenceOnline) {
      nextStore.set(lodyPresenceSyncStateAtom, 'synced');
      nextStore.set(lodyPresenceStatesAtom, {
        [getLodyMachinePresenceKey(machine.id, 'storybook-instance' as LodyPresenceInstanceId)]: {
          kind: 'machine',
          machineId: machine.id,
          instanceId: 'storybook-instance' as LodyPresenceInstanceId,
          updatedAt: getServerNow(),
        },
      });
    }
    return nextStore;
  });
  return (
    <Provider store={store}>
      <div className="h-[620px] w-[720px] overflow-hidden rounded-lg border border-border/60 bg-card/40">
        <MachineDetailPane
          machine={machine}
          configs={storyConfigs}
          isOwn={isOwn}
          isLocal={isOwn}
          ownerName={ownerName}
          sharedWithTeam={sharedWithTeam}
          canDelete={canDelete}
          onRename={async () => {}}
          onDelete={async () => {}}
          onSharedWithTeamChange={isOwn ? async () => {} : undefined}
          onAddConfig={() => {}}
          onEditConfig={() => {}}
          onDeleteConfig={async () => {}}
          onRefreshConfig={async () => {}}
          onPing={showPing ? async () => 18 : undefined}
          onRestartDaemon={showRestart ? async () => {} : undefined}
          canRevokeCredentials={canRevokeCredentials}
          onRevokeCredentials={canRevokeCredentials ? async () => {} : undefined}
          daemonUpdate={
            showUpdate ? { currentVersion: '0.44.0', latestVersion: '0.45.2' } : undefined
          }
          onUpgradeDaemon={showUpdate ? async () => {} : undefined}
        />
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Settings/MachineDetailPane',
  component: StoryWrapper,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryWrapper>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OwnWithProviders: Story = {
  args: {
    machine: {
      ...baseMachine,
      raceLimits: {
        [getRateLimitEntryKey('claude', 'claude', 'cfg-claude' as AgentConfigId)]: {
          limitId: 'claude',
          scope: { providerId: 'claude' },
          planName: 'Claude Pro',
          windows: [
            {
              usedPercent: 40,
              windowDurationSeconds: 18_000,
              resetsAtEpochSeconds: resetIn(7_200),
            },
            {
              usedPercent: 60,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(345_600),
            },
          ],
        },
        [getRateLimitEntryKey(
          'codex',
          CODEX_SPARK_LIMIT_ID,
          'cfg-codex' as AgentConfigId
        )]: {
          limitId: CODEX_SPARK_LIMIT_ID,
          scope: { providerId: 'codex' },
          planName: 'Codex Spark',
          windows: [
            { usedPercent: 12, windowDurationSeconds: 18_000, resetsAtEpochSeconds: resetIn(300) },
            {
              usedPercent: 88,
              windowDurationSeconds: 604_800,
              resetsAtEpochSeconds: resetIn(172_800),
            },
          ],
        },
      },
    },
  },
};

export const TeamMachine: Story = {
  args: {
    isOwn: false,
    sharedWithTeam: true,
    ownerName: 'Bob Smith',
    machine: {
      ...baseMachine,
      ownerUserId: 'user-2',
    },
  },
};

export const EmptyProviders: Story = {
  args: {
    configs: [],
  },
};

export const OfflineDeletable: Story = {
  args: {
    canDelete: true,
    machine: {
      ...baseMachine,
      lastSeen: getServerNow() - 3_600_000,
    },
  },
};

export const DeveloperPing: Story = {
  args: {
    showPing: true,
  },
};

export const DesktopDevicesActions: Story = {
  args: {
    showPing: true,
    showRestart: true,
    canRevokeCredentials: true,
    canDelete: true,
  },
};

export const DesktopDaemonUpdateBanner: Story = {
  args: {
    showPing: true,
    showRestart: true,
    canRevokeCredentials: true,
    canDelete: true,
    presenceOnline: true,
    showUpdate: true,
  },
};
