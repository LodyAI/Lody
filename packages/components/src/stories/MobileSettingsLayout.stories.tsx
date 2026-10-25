import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';
import {
  getServerNow,
  type MachineId,
  type MachineMonitorSnapshot,
  type MachineViewMeta,
} from '@lody/shared';

import { MobileSettingsLayout } from '@/components/mobile/mobile-settings-layout';
import { MachineDetailPane } from '@/components/settings/machine-detail-pane';
import { AccountMachinesOverviewView } from '@/components/settings/account-machines-overview';
import { ForceMobileLayoutProvider } from '@/hooks/use-mobile';

const machineId = 'mobile-device-story' as MachineId;
const machine: MachineViewMeta = {
  id: machineId,
  name: 'codex-happy',
  cliVersion: '0.69.0',
  os: 'linux',
  sessions: [],
  raceLimits: {},
  lastSeen: getServerNow(),
  ownerUserId: 'user-story',
};
const resource = {
  memoryBytes: 1.1 * 1024 * 1024 * 1024,
  cpuCores: 1.19,
  cpuPercentOfMachine: 14.9,
  processCount: 1,
  memoryKind: 'rss' as const,
  quality: 'exact-process' as const,
};
const monitorSnapshot: MachineMonitorSnapshot = {
  kind: 'snapshot',
  protocolVersion: 1,
  machineId,
  instanceId: 'cli-story',
  updatedAtMs: getServerNow(),
  sampleWindowMs: 2_000,
  platform: 'linux',
  cpuLogicalCores: 8,
  deviceCpuCores: 1.21,
  effectiveMemoryBytes: 26 * 1024 * 1024 * 1024,
  availableMemoryBytes: 19.9 * 1024 * 1024 * 1024,
  sessionAccounting: 'cgroup-v2',
  cliControlPlane: resource,
  sessionsAggregate: { ...resource, memoryBytes: 0, cpuCores: 0, processCount: 0 },
  sessions: [],
  sessionsTruncated: false,
  warnings: [],
};

function SettingsSection({ title, rows }: { title: string; rows: string[] }) {
  return (
    <section className="px-4 pt-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </div>
      <div className="overflow-hidden rounded-2xl border border-border/40 bg-card">
        {rows.map((row, i) => (
          <div
            key={row}
            className={`flex items-center justify-between px-4 py-3 text-sm ${
              i < rows.length - 1 ? 'border-b border-border/40' : ''
            }`}
          >
            <span>{row}</span>
            <span className="text-muted-foreground">›</span>
          </div>
        ))}
      </div>
    </section>
  );
}

function StoryShell({
  title,
  isMachineDetail,
  isAgentConfigTab,
  isNativeApp,
}: {
  title: string;
  isMachineDetail: boolean;
  isAgentConfigTab: boolean;
  isNativeApp: boolean;
}) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <MobileSettingsLayout
          title={title}
          isNativeApp={isNativeApp}
          isMachineDetail={isMachineDetail}
          isAgentConfigTab={isAgentConfigTab}
          onBack={fn()}
        >
          {isMachineDetail ? (
            <div className="flex h-full min-h-0 flex-col p-3">
              <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-card/40">
                <MachineDetailPane
                  mode="devices"
                  machine={machine}
                  configs={[]}
                  isOwn
                  isLocal={false}
                  ownerName={null}
                  sharedWithTeam={false}
                  canDelete={false}
                  onRename={async () => {}}
                  onDelete={async () => {}}
                  onSharedWithTeamChange={async () => {}}
                  onAddConfig={() => {}}
                  onEditConfig={() => {}}
                  monitorSnapshot={monitorSnapshot}
                  monitorState="active"
                />
              </div>
            </div>
          ) : (
            <div className="pb-6">
              <SettingsSection title="账号" rows={['个人资料', '邮箱与登录', '订阅与配额']} />
              <SettingsSection title="工作空间" rows={['成员', '权限', '密钥', '集成']} />
              <SettingsSection title="机器" rows={['zx-macbook', 'lab-m2', 'mini-offline']} />
              <SettingsSection title="实验功能" rows={['Codex preview', 'Mobile redesign']} />
            </div>
          )}
        </MobileSettingsLayout>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileSettingsLayout',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
  args: {
    title: '设置',
    isMachineDetail: false,
    isAgentConfigTab: false,
    isNativeApp: false,
  },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const MachineDetail: Story = {
  args: {
    title: 'zx-macbook',
    isMachineDetail: true,
  },
};

export const AgentConfigTab: Story = {
  args: {
    title: 'Agent 配置',
    isAgentConfigTab: true,
  },
};

function AccountMachineNavigation() {
  const [selected, setSelected] = useState(false);
  return (
    <ForceMobileLayoutProvider force>
      <div style={{ height: '100dvh' }}>
        <MobileSettingsLayout
          title="Account"
          isNativeApp
          isMachineDetail={selected}
          isAgentConfigTab={false}
          onBack={() => setSelected(false)}
        >
          {selected ? (
            <MachineDetailPane
              mode="devices"
              machine={machine}
              configs={[]}
              isOwn
              isLocal={false}
              ownerName={null}
              sharedWithTeam={false}
              canDelete={false}
              onRename={async () => {}}
              onDelete={async () => {}}
              onAddConfig={() => {}}
              onEditConfig={() => {}}
            />
          ) : (
            <AccountMachinesOverviewView
              items={[
                {
                  id: machineId,
                  name: machine.name,
                  os: machine.os,
                  isOnline: true,
                  sharedWithTeam: false,
                  agents: [],
                  directories: [],
                },
              ]}
              onManageMachine={() => setSelected(true)}
            />
          )}
        </MobileSettingsLayout>
      </div>
    </ForceMobileLayoutProvider>
  );
}

export const AccountMachineManagement: Story = {
  beforeEach: () => {
    const nativeWindow = window as Window & { __LODY_NATIVE__?: boolean };
    const previous = nativeWindow.__LODY_NATIVE__;
    nativeWindow.__LODY_NATIVE__ = true;
    return () => {
      nativeWindow.__LODY_NATIVE__ = previous;
    };
  },
  render: () => <AccountMachineNavigation />,
};
