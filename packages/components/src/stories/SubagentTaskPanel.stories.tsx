import type { Meta, StoryObj } from '@storybook/react';
import { SubagentTaskPanel, type SubagentTask } from '@/components/ai-gui/subagent-task-panel';

const running: SubagentTask[] = [
  {
    type: 'subagent_task',
    event: 'task_progress',
    taskId: 'task-1',
    taskKind: 'subagent',
    status: 'in_progress',
    subagentType: 'Explore',
    description: 'Find codex capability refresh logic',
    lastToolName: 'Read',
    summary: 'Reading apps/cli/src/agent/acp-capabilities.ts',
  },
  {
    type: 'subagent_task',
    event: 'task_progress',
    taskId: 'task-2',
    status: 'in_progress',
    subagentType: 'Explore',
    description: 'Find CLI version detection and startup path',
    lastToolName: 'Grep',
  },
];

const completed: SubagentTask[] = [
  {
    type: 'subagent_task',
    event: 'task_notification',
    taskId: 'task-1',
    status: 'completed',
    subagentType: 'Explore',
    description: 'Find codex capability refresh logic',
    summary: 'Capabilities refresh runs in acp-capabilities.ts on startup and version change.',
    usage: { totalTokens: 18420, toolUses: 6, durationMs: 42000 },
  },
  {
    type: 'subagent_task',
    event: 'task_notification',
    taskId: 'task-2',
    status: 'completed',
    subagentType: 'Explore',
    description: 'Find CLI version detection and startup path',
    summary: 'Version detected in start.ts via readPackageVersion().',
    usage: { totalTokens: 9200, toolUses: 3 },
  },
];

const mixed: SubagentTask[] = [
  {
    type: 'subagent_task',
    event: 'task_notification',
    taskId: 'task-1',
    status: 'completed',
    subagentType: 'Explore',
    description: 'Find codex capability refresh logic',
    summary: 'Done — see acp-capabilities.ts.',
  },
  {
    type: 'subagent_task',
    event: 'task_updated',
    taskId: 'task-2',
    status: 'failed',
    subagentType: 'general-purpose',
    description: 'Run the flaky integration suite',
    error: 'listen EPERM: operation not permitted 127.0.0.1:0 (sandboxed socket bind)',
  },
  {
    type: 'subagent_task',
    event: 'task_progress',
    taskId: 'task-3',
    status: 'in_progress',
    subagentType: 'Plan',
    description: 'Draft the migration plan',
    isBackgrounded: true,
    lastToolName: 'Write',
  },
  {
    type: 'subagent_task',
    event: 'task_started',
    taskId: 'task-4',
    status: 'pending',
    taskType: 'local_workflow',
    workflowName: 'spec',
    description: 'Generate the spec document',
  },
];

const many: SubagentTask[] = Array.from({ length: 16 }, (_, index) => ({
  type: 'subagent_task',
  event: 'task_notification',
  taskId: `many-task-${index + 1}`,
  status: 'completed',
  subagentType: index % 3 === 0 ? 'Plan' : 'Explore',
  description: `Inspect subsystem ${index + 1}`,
  summary: `Finished subsystem ${index + 1}.`,
  usage: { totalTokens: 4200 + index * 350, toolUses: 2 + (index % 5) },
}));

const meta = {
  title: 'Sessions/SubagentTaskPanel',
  component: SubagentTaskPanel,
  parameters: { layout: 'padded' },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="w-[560px] max-w-full p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof SubagentTaskPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Running: Story = { args: { tasks: running } };
export const CancellationError: Story = {
  args: {
    tasks: running,
    onCancel: async () => {
      throw new Error('Agent disconnected');
    },
  },
};
export const Completed: Story = { args: { tasks: completed } };
export const Mixed: Story = { args: { tasks: mixed } };
export const SingleRunning: Story = { args: { tasks: [running[0] as SubagentTask] } };
export const ManyCompleted: Story = { args: { tasks: many } };
