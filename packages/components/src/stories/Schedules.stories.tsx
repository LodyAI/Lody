import type { Meta, StoryObj } from '@storybook/react-vite';
import { ScheduleForm, ScheduleListView } from '../components/schedules/schedule-view';
import type { ScheduleRegistryRow } from '@lody/shared';

const row: ScheduleRegistryRow = {
  scheduleId: 'daily-review',
  title: 'Review the latest changes',
  ownerId: 'owner',
  machineId: 'machine',
  enabled: true,
  activationId: 'activation',
  activeFrom: 0,
  createdAt: 0,
  updatedAt: 0,
  trigger: { kind: 'cron', expression: '0 9 * * MON-FRI', timeZone: 'Asia/Shanghai' },
  elevatedPermissions: false,
  agentConfigId: 'agent',
  definitionFingerprint: '0'.repeat(64),
  projectKind: 'github',
  projectKey: 'example/project',
};
const meta = {
  title: 'Workspace/Schedules',
  component: ScheduleListView,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <div className="h-dvh bg-background text-foreground">
        <Story />
      </div>
    ),
  ],
  args: {
    rows: [
      row,
      {
        ...row,
        scheduleId: 'weekly-summary',
        title: 'Write a weekly project summary',
        enabled: false,
      },
    ],
    runtimes: [],
    ready: true,
    onOpen: () => {},
    onNew: () => {},
    onToggle: () => {},
  },
} satisfies Meta<typeof ScheduleListView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const List: Story = {};
export const Empty: Story = { args: { rows: [] } };
export const Loading: Story = { args: { ready: false } };
export const Blocked: Story = {
  args: {
    runtimes: [
      {
        scheduleId: row.scheduleId,
        machineId: row.machineId,
        activationId: row.activationId,
        observedDefinitionFingerprint: row.definitionFingerprint,
        updatedAt: 0,
        queueState: 'blocked',
        blockedCode: 'PERMISSION_UNAVAILABLE',
      },
    ],
  },
};
export const Editor: Story = {
  render: () => (
    <div className="h-dvh overflow-auto">
      <ScheduleForm
        initial={{
          title: 'Review the latest changes',
          prompt:
            'Review changes since the previous working day. Summarize bugs and suggested fixes in this chat.',
          trigger: row.trigger,
          misfire: 'run_once',
          overlap: 'queue_one',
        }}
        saving={false}
        onSave={() => {}}
        selectors={
          <div className="flex flex-wrap gap-3 text-sm">
            <span>Agent: Code reviewer · Auto permission</span>
            <span>Project: example/project</span>
          </div>
        }
      />
    </div>
  ),
};

export const Offline: Story = {
  args: {
    contextForRow: () => ({
      machine: 'MacBook',
      agent: 'Code reviewer',
      project: 'example/project',
      presence: 'offline',
      canToggle: true,
    }),
  },
};
export const UnknownConnection: Story = {
  args: {
    contextForRow: () => ({
      machine: 'MacBook',
      agent: 'Code reviewer',
      project: 'example/project',
      presence: 'unknown',
      canToggle: true,
    }),
  },
};
export const Elevated: Story = { args: { rows: [{ ...row, elevatedPermissions: true }] } };
export const Due: Story = {
  args: {
    runtimes: [
      {
        scheduleId: row.scheduleId,
        machineId: row.machineId,
        activationId: row.activationId,
        observedDefinitionFingerprint: row.definitionFingerprint,
        updatedAt: 0,
        queueState: 'due',
        nextScheduledAt: Date.parse('2026-09-07T01:00:00Z'),
      },
    ],
  },
};
export const Retrying: Story = {
  args: { runtimes: [{ ...Due.args!.runtimes![0]!, queueState: 'retrying' }] },
};
