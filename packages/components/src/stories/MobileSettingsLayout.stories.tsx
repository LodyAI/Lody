import * as stylex from '@stylexjs/stylex';
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
const settingsStory = stylex.create({
  row: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBlock: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  divider: { borderBottomWidth:"1px",borderBottomStyle:"solid",borderBottomColor:"color-mix(in oklab,hsl(var(--border) / 1) 40%,transparent)" },
});
const phoneFrame = stylex.create({
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflow: 'hidden',
  },
});

const storyViewport = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    '--story-device-canvas-components': '92.3% 0.003 48.717',
    backgroundColor: 'oklch(var(--story-device-canvas-components))',
    padding: { default: '0px', '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
});

const storyLayoutStyles = stylex.create({
  caption: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground) / 1)',
    'text-transform': 'uppercase',
  },
  section: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-2xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 40%, transparent)',
    'background-color': 'hsl(var(--card) / 1)',
  },
  frame: {
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
    overflow: 'hidden',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--card) / 1) 40%, transparent)',
  },
});

const storyLayout = stylex.create({
  canvas: {
    'padding-inline': 'calc(var(--spacing) * 4)',
    'padding-top': 'calc(var(--spacing) * 4)',
  },
  label: {
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  stack: {
    display: 'flex',
    height: '100%',
    'min-height': 'calc(var(--spacing) * 0)',
    'flex-direction': 'column',
    padding: 'calc(var(--spacing) * 3)',
  },
  section: {
    'padding-bottom': 'calc(var(--spacing) * 6)',
  },
});

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
    <section {...stylex.props(storyLayout.canvas)}>
      <div {...stylex.props(storyLayoutStyles.caption)}>{title}</div>
      <div {...stylex.props(storyLayoutStyles.section)}>
        {rows.map((row, i) => (
          <div
            key={row}
            {...stylex.props(settingsStory.row, i < rows.length - 1 && settingsStory.divider)}
          >
            <span>{row}</span>
            <span {...stylex.props(storyLayout.label)}>›</span>
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
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
        <MobileSettingsLayout
          title={title}
          isNativeApp={isNativeApp}
          isMachineDetail={isMachineDetail}
          isAgentConfigTab={isAgentConfigTab}
          onBack={fn()}
        >
          {isMachineDetail ? (
            <div {...stylex.props(storyLayout.stack)}>
              <div {...stylex.props(storyLayoutStyles.frame)}>
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
            <div {...stylex.props(storyLayout.section)}>
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
