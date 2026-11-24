import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import { fn } from 'storybook/test';
import { Button } from '@lody/ui/button';
import type {
  AgentConfigId,
  AgentConfigMeta,
  MachineId,
  MachineMonitorSnapshot,
  SessionId,
  SessionMeta,
} from '@lody/shared';
import {
  MachineListFilterButton,
  type MachineTabItem,
} from '@/components/settings/machine-tab-list';
import { MachineDetailPane } from '@/components/settings/machine-detail-pane';
import {
  MachineConnectedResources,
  type MachineConnectedProject,
} from '@/components/settings/my-machine-connected-resources';
import {
  WorkspaceMachineCollapsedRow,
  WorkspaceMachineExpandedSection,
  type WorkspaceMachineAccordionMeta,
} from '@/components/settings/workspace-machine-accordion';
import type { MachineSettingsFilter } from '@/atoms/settings-machine-tab';
const sceneStyles = stylex.create({
  list: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 3)',
    },
  },
  privateSection: { paddingTop: 'calc(var(--spacing) * 3)' },
  overview: {
    ':is(*) > :not(:last-child)': {
      'margin-block-start': 0,
      'margin-block-end': 'calc(var(--spacing) * 4)',
    },
  },
});

const storyLayoutStyles = stylex.create({
  caption: {
    'font-size': 'var(--text-base)',
    'line-height': 'var(--text-base--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    color: 'hsl(var(--foreground) / 1)',
  },
  caption2: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  caption3: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  label: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    width: '100%',
    'min-width': 'calc(var(--spacing) * 0)',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 4)',
  },
  section: {
    'min-width': 'calc(var(--spacing) * 0)',
  },
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  canvas: {
    'padding-inline': 'calc(var(--spacing) * 1)',
  },
  row2: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  frame: {
    'min-height': '100vh',
    'background-color': 'hsl(var(--background) / 1)',
    'padding-inline': 'calc(var(--spacing) * 6)',
    'padding-block': 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--foreground) / 1)',
  },
  section2: {
    'margin-inline': 'auto',
    'max-width': '64rem',
  },
});

/**
 * Composed preview of the desktop Machines settings tab: every machine owns a
 * full-width accordion row, and only the selected machine mounts its detail pane.
 */

type FixtureMachine = {
  id: MachineId;
  name: string;
  os: string;
  cliVersion: string;
  isOwn: boolean;
  isOnline: boolean;
  sharedWithTeam: boolean;
  ownerName: string | null;
};

const fixtureMachines: FixtureMachine[] = [
  {
    id: 'machine-mbp' as MachineId,
    name: 'MacBook-Pro.local',
    os: 'macOS 15.2',
    cliVersion: '0.57.1-next.47',
    isOwn: true,
    isOnline: true,
    sharedWithTeam: true,
    ownerName: null,
  },
  {
    id: 'machine-mini' as MachineId,
    name: 'zxdeMac-mini.local',
    os: 'macOS 15.1',
    cliVersion: '0.57.1-next.47',
    isOwn: true,
    isOnline: true,
    sharedWithTeam: false,
    ownerName: null,
  },
  {
    id: 'machine-beast' as MachineId,
    name: 'loro-beast',
    os: 'Linux',
    cliVersion: '0.57.0',
    isOwn: false,
    isOnline: false,
    sharedWithTeam: true,
    ownerName: 'Bob Smith',
  },
  {
    id: 'machine-hel' as MachineId,
    name: 'ubuntu-8gb-hel1-1',
    os: 'Ubuntu 24.04',
    cliVersion: '0.56.3',
    isOwn: true,
    isOnline: false,
    sharedWithTeam: false,
    ownerName: null,
  },
];

const machineOwners = new Map([
  [
    'user-story',
    { id: 'user-story', name: 'Zixuan Chen', email: 'zixuan@example.com', image: null },
  ],
  [
    'user-teammate',
    { id: 'user-teammate', name: 'Bob Smith', email: 'bob@example.com', image: null },
  ],
]);

const directoryCounts = new Map<MachineId, number>([
  ['machine-mbp' as MachineId, 4],
  ['machine-mini' as MachineId, 2],
  ['machine-beast' as MachineId, 6],
  ['machine-hel' as MachineId, 0],
]);

const connectedProjects = (machineId: MachineId): MachineConnectedProject[] =>
  Array.from({ length: directoryCounts.get(machineId) ?? 0 }, (_, index) => ({
    key: `${machineId}:project-${index}`,
    name: index === 0 ? 'lody' : `connected-project-${index + 1}`,
    rootPath: `/Users/zixuan/Code/${index === 0 ? 'lody' : `project-${index + 1}`}`,
    sharedWithTeam: index % 2 === 0,
  }));

const resource = {
  memoryBytes: 768 * 1024 * 1024,
  cpuCores: 0.72,
  cpuPercentOfMachine: 9,
  processCount: 6,
  memoryKind: 'cgroup-current' as const,
  quality: 'exact-cgroup' as const,
};

const monitorSnapshot = (machineId: MachineId): MachineMonitorSnapshot => ({
  kind: 'snapshot',
  protocolVersion: 1,
  machineId,
  instanceId: 'cli-story',
  updatedAtMs: Date.now(),
  sampleWindowMs: 2_000,
  platform: 'darwin',
  cpuLogicalCores: 12,
  deviceCpuCores: 1.4,
  effectiveMemoryBytes: 32 * 1024 * 1024 * 1024,
  availableMemoryBytes: 22 * 1024 * 1024 * 1024,
  sessionAccounting: 'process-tree',
  cliControlPlane: {
    ...resource,
    memoryBytes: 180 * 1024 * 1024,
    cpuCores: 0.04,
    processCount: 1,
    memoryKind: 'physical-footprint',
    quality: 'exact-process',
  },
  sessionsAggregate: {
    ...resource,
    memoryBytes: 3.4 * 1024 * 1024 * 1024,
    cpuCores: 1.36,
    processCount: 29,
    memoryKind: 'physical-footprint-sum',
    quality: 'estimated-tree',
  },
  sessions: [
    {
      sessionId: 'session-launch-video' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'kimi',
      status: 'running',
      lastActivityAtMs: Date.now(),
      startedAtMs: Date.now() - 90_000,
      resource: {
        ...resource,
        memoryBytes: 2.3 * 1024 * 1024 * 1024,
        cpuCores: 1.36,
        processCount: 15,
        memoryKind: 'physical-footprint-sum',
        quality: 'estimated-tree',
      },
    },
    {
      sessionId: 'session-stream-sync' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'kimi',
      status: 'running',
      lastActivityAtMs: Date.now() - 5_000,
      startedAtMs: Date.now() - 300_000,
      resource: {
        ...resource,
        memoryBytes: 398 * 1024 * 1024,
        cpuCores: 0.017,
        processCount: 2,
        memoryKind: 'physical-footprint-sum',
        quality: 'estimated-tree',
      },
    },
    {
      sessionId: 'session-onboarding' as SessionId,
      parentSessionId: null,
      agentCliType: 'builtin',
      agentType: 'codex',
      status: 'running',
      lastActivityAtMs: Date.now() - 120_000,
      startedAtMs: Date.now() - 600_000,
      resource: {
        ...resource,
        memoryBytes: 392 * 1024 * 1024,
        cpuCores: 0.01,
        processCount: 6,
        memoryKind: 'physical-footprint-sum',
        quality: 'estimated-tree',
      },
    },
  ],
  sessionsTruncated: false,
  warnings: [],
});

const agentConfigs = (machineId: MachineId): AgentConfigMeta[] => [
  {
    id: 'config-kimi' as AgentConfigId,
    machineId,
    name: 'Kimi Code',
    description: undefined,
    cliType: 'builtin',
    agentType: 'kimi',
    env: {},
  },
  {
    id: 'config-codex' as AgentConfigId,
    machineId,
    name: 'Codex',
    description: undefined,
    cliType: 'builtin',
    agentType: 'codex',
    env: {},
  },
];

const sessionMetas = (machineId: MachineId): SessionMeta[] => [
  {
    id: 'session-launch-video' as SessionId,
    machineId,
    createdAt: new Date().toISOString(),
    title: 'Lody Product Launch Video',
    userId: 'user-story',
    cliType: 'builtin',
    agentType: 'kimi',
    agentConfigId: 'config-kimi' as AgentConfigId,
  },
  {
    id: 'session-stream-sync' as SessionId,
    machineId,
    createdAt: new Date().toISOString(),
    title: '桌面端 stream 加载不显示 Syncing',
    userId: 'user-story',
    cliType: 'builtin',
    agentType: 'kimi',
    agentConfigId: 'config-kimi' as AgentConfigId,
  },
  {
    id: 'session-onboarding' as SessionId,
    machineId,
    createdAt: new Date().toISOString(),
    title: 'Lody 多平台 onboarding 登录方式评估',
    userId: 'user-story',
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId: 'config-codex' as AgentConfigId,
  },
];

function DevicesDesktopLayout({
  initialSelectedId,
  resourcePending = false,
}: {
  initialSelectedId?: MachineId;
  resourcePending?: boolean;
}) {
  const [filter, setFilter] = useState<MachineSettingsFilter>({
    onlineOnly: false,
    mineOnly: false,
  });
  const [selectedId, setSelectedId] = useState<MachineId | null>(
    initialSelectedId ?? fixtureMachines[0]!.id
  );

  const allItems: MachineTabItem[] = useMemo(
    () =>
      fixtureMachines.map((machine) => ({
        machine: {
          id: machine.id,
          name: machine.name,
          os: machine.os,
          cliVersion: machine.cliVersion,
          sessions: [],
          raceLimits: {},
          ownerUserId: machine.isOwn ? 'user-story' : 'user-teammate',
        },
        isOwn: machine.isOwn,
        isOnline: machine.isOnline,
        sharedWithTeam: machine.sharedWithTeam,
      })),
    []
  );
  const items = useMemo(
    () =>
      allItems
        .filter((item) => {
          if (filter.onlineOnly && !item.isOnline) return false;
          if (filter.mineOnly && !item.isOwn) return false;
          return true;
        })
        .sort((a, b) => {
          if (a.isOnline !== b.isOnline) return a.isOnline ? -1 : 1;
          return a.machine.name.localeCompare(b.machine.name);
        }),
    [allItems, filter]
  );

  const sharedItems = items.filter((item) => item.sharedWithTeam);
  const privateItems = allItems.filter((item) => !item.sharedWithTeam);

  const getAccordionMeta = (item: MachineTabItem): WorkspaceMachineAccordionMeta => {
    const ownerUserId = item.machine.ownerUserId ?? 'user-story';
    return {
      machine: item.machine,
      isOnline: item.isOnline,
      isLocal: item.machine.id === fixtureMachines[0]!.id,
      isPrivate: !item.sharedWithTeam,
      owner: machineOwners.get(ownerUserId) ?? null,
      directoryCount: directoryCounts.get(item.machine.id) ?? 0,
      agentCount: agentConfigs(item.machine.id).length,
    };
  };

  const renderMachine = (item: MachineTabItem) => {
    const fixture = fixtureMachines.find((machine) => machine.id === item.machine.id)!;
    const accordionMeta = getAccordionMeta(item);
    if (selectedId !== item.machine.id) {
      return (
        <WorkspaceMachineCollapsedRow
          key={item.machine.id}
          meta={accordionMeta}
          onExpand={() => setSelectedId(item.machine.id)}
        />
      );
    }

    return (
      <WorkspaceMachineExpandedSection
        key={item.machine.id}
        meta={accordionMeta}
        onCollapse={() => setSelectedId(null)}
      >
        <MachineDetailPane
          key={fixture.id}
          mode="devices"
          readOnly={!fixture.isOwn}
          machine={item.machine}
          configs={agentConfigs(fixture.id)}
          isOwn={fixture.isOwn}
          isLocal={fixture.id === fixtureMachines[0]!.id}
          ownerName={fixture.ownerName}
          sharedWithTeam={fixture.sharedWithTeam}
          canDelete={!fixture.isOnline && fixture.isOwn}
          onRename={fn(async () => {})}
          onDelete={fn(async () => {})}
          onSharedWithTeamChange={fixture.isOwn ? fn(async () => {}) : undefined}
          onAddConfig={fn()}
          onEditConfig={fn()}
          onDeleteConfig={fn(async () => {})}
          onRefreshConfig={fn(async () => {})}
          onPing={fixture.isOwn ? fn(async () => 18) : undefined}
          onRestartDaemon={fixture.isOwn && fixture.isOnline ? fn(async () => {}) : undefined}
          canRevokeCredentials={fixture.isOwn}
          onRevokeCredentials={fixture.isOwn ? fn(async () => {}) : undefined}
          monitorSnapshot={
            fixture.isOnline && !resourcePending ? monitorSnapshot(fixture.id) : null
          }
          monitorState={fixture.isOnline ? 'active' : 'disabled'}
          monitorSessionMetas={sessionMetas(fixture.id)}
          onOpenMonitorSession={fn()}
          onTerminateMonitorSession={fixture.isOwn ? fn(async () => {}) : undefined}
          footer={
            <MachineConnectedResources
              machineId={fixture.id}
              configs={agentConfigs(fixture.id)}
              preloadedProjects={connectedProjects(fixture.id)}
              projectsLoading={false}
              readOnly
              onManageAgents={fn()}
            />
          }
          accordion={{
            meta: accordionMeta,
            onCollapse: () => setSelectedId(null),
            headerRenderedExternally: true,
          }}
        />
      </WorkspaceMachineExpandedSection>
    );
  };

  return (
    <div {...stylex.props(storyLayout.stack)}>
      <div {...stylex.props(storyLayout.section)}>
        <div {...stylex.props(storyLayout.row)}>
          <h2 {...stylex.props(storyLayoutStyles.caption)}>Machines</h2>
          <MachineListFilterButton filter={filter} onFilterChange={setFilter} />
        </div>
        <p {...stylex.props(storyLayoutStyles.caption2)}>
          View workspace machines and manage the machines you own.
        </p>
      </div>
      <div {...stylex.props(sceneStyles.list)}>{sharedItems.map(renderMachine)}</div>
      <section {...stylex.props(sceneStyles.list, sceneStyles.privateSection)}>
        <div {...stylex.props(storyLayout.canvas)}>
          <div {...stylex.props(storyLayout.row2)}>
            <h3 {...stylex.props(storyLayoutStyles.caption3)}>Your private machines</h3>
            <span {...stylex.props(storyLayoutStyles.label)}>{privateItems.length}</span>
          </div>
          <p {...stylex.props(storyLayoutStyles.caption2)}>
            These machines are not available to other workspace members. Select one to manage
            sharing.
          </p>
        </div>
        <div {...stylex.props(sceneStyles.list)}>{privateItems.map(renderMachine)}</div>
      </section>
    </div>
  );
}

const meta = {
  title: 'Settings/MachinesDesktopLayout',
  component: DevicesDesktopLayout,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <div {...stylex.props(storyLayout.section2)}>
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof DevicesDesktopLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const OwnSharedMachine: Story = {};

export const TeammateMachine: Story = {
  args: { initialSelectedId: 'machine-beast' as MachineId },
};

export const OfflinePrivateMachine: Story = {
  args: { initialSelectedId: 'machine-hel' as MachineId },
};

export const WaitingForResourceSample: Story = {
  args: { resourcePending: true },
};

/** A real card with controlled presence, for motion and reduced-motion inspection. */
function MachineOnlineStatusPreview() {
  const [isOnline, setIsOnline] = useState(true);
  const previewMeta: WorkspaceMachineAccordionMeta = {
    machine: {
      id: 'machine-status-preview' as MachineId,
      name: 'Docker Agent Workspace',
      os: 'Linux',
      cliVersion: '0.57.1',
      sessions: [],
      raceLimits: {},
    },
    isOnline,
    isLocal: true,
    isPrivate: false,
    owner: null,
    directoryCount: 4,
    agentCount: 3,
  };
  return (
    <div {...stylex.props(sceneStyles.overview)}>
      <WorkspaceMachineCollapsedRow meta={previewMeta} onExpand={fn()} />
      <Button variant="secondary" size="small" onClick={() => setIsOnline((online) => !online)}>
        Toggle online status
      </Button>
    </div>
  );
}

export const OnlineStatusMotion: Story = {
  render: () => <MachineOnlineStatusPreview />,
};
