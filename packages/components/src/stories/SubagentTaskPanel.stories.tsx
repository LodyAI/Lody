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

/** Claude's background Bash tasks: the row shows the command, a click shows all of it. */
const backgroundCommands: SubagentTask[] = [
  {
    type: 'subagent_task',
    event: 'task_started',
    taskId: 'bash-1',
    taskType: 'local_bash',
    isBackgrounded: true,
    status: 'in_progress',
    description:
      'agent-browser set viewport 1280 860 2>&1\nagent-browser open "http://localhost:6019/iframe.html?id=settings-devicesdesktoplayout--own-shared-machine" 2>&1\nagent-browser wait 2500 2>&1\nagent-browser screenshot /tmp/devices-own-shared.png 2>&1',
  },
  {
    type: 'subagent_task',
    event: 'task_notification',
    taskId: 'bash-2',
    taskType: 'local_bash',
    isBackgrounded: true,
    status: 'completed',
    startedAtEpochSeconds: 1_789_000_000,
    endedAtEpochSeconds: 1_789_000_042,
    description: 'git push -u origin refactor/optimize-machine-settings-ui 2>&1',
    summary: 'git push -u origin refactor/optimize-machine-settings-ui 2>&1',
  },
];

type Run = NonNullable<SubagentTask['run']>;
const support = (
  cancel: boolean,
  stream: Run['snapshot']['support']['stream'] = ['text', 'thought', 'tool', 'plan']
) => ({
  stream,
  progress: true,
  outputRead: 'none' as const,
  cancel,
});

/** Runs streamed through subagent events: each row follows its latest step. */
const streamedRuns: SubagentTask[] = [
  {
    type: 'subagent_task',
    taskId: 'run-1',
    taskKind: 'subagent',
    status: 'in_progress',
    actor: 'Explore',
    description: 'Map the ACP capability refresh path',
    startedAtEpochSeconds: Math.floor(Date.now() / 1000) - 83,
    run: {
      sessionId: 'root-acp',
      snapshot: { state: 'running', support: support(true) },
      progress: { totalTokens: 12_400, toolCallCount: 4 },
      items: [
        { type: 'thought', text: 'Start from where the daemon reads capabilities.' },
        {
          type: 'tool_call',
          toolCallId: 'c1',
          title: 'Read apps/cli/src/agent/acp-capabilities.ts',
          kind: 'read',
          status: 'completed',
        },
        {
          type: 'tool_call',
          toolCallId: 'c2',
          title: 'Grep "refreshCapabilities"',
          kind: 'search',
          status: 'in_progress',
        },
      ],
    },
  },
  {
    type: 'subagent_task',
    taskId: 'run-2',
    taskKind: 'subagent',
    status: 'in_progress',
    parentTaskId: 'run-1',
    actor: 'Explore',
    description: 'Check the version probe',
    run: {
      sessionId: 'root-acp',
      snapshot: { state: 'running', parentRunId: 'run-1', support: support(true) },
      items: [{ type: 'text', text: 'The probe runs once per start.\n\nChecking the cache next' }],
    },
  },
  {
    type: 'subagent_task',
    taskId: 'run-3',
    taskKind: 'subagent',
    status: 'in_progress',
    actor: 'Plan',
    description: 'Draft the migration plan',
    run: {
      sessionId: 'root-acp',
      snapshot: { state: 'running', support: support(false, []) },
      progress: { summary: 'Comparing the two storage layouts' },
      items: [],
    },
  },
];

/** How settled runs end when it was not well: cancelled, lost, and lossy. */
const settledRuns: SubagentTask[] = [
  {
    type: 'subagent_task',
    taskId: 'run-c',
    taskKind: 'subagent',
    status: 'failed',
    actor: 'Explore',
    description: 'Search the archive',
    run: {
      sessionId: 'root-acp',
      snapshot: { state: 'cancelled', support: support(false) },
      items: [],
    },
  },
  {
    type: 'subagent_task',
    taskId: 'run-u',
    taskKind: 'subagent',
    status: 'in_progress',
    actor: 'Explore',
    description: 'Profile the renderer',
    run: {
      sessionId: 'root-acp',
      snapshot: { state: 'unknown', reason: { code: 'disconnected' }, support: support(false) },
      items: [],
    },
  },
  {
    type: 'subagent_task',
    taskId: 'run-f',
    taskKind: 'subagent',
    status: 'failed',
    actor: 'general-purpose',
    description: 'Run the integration suite',
    error: 'Process exited with code 1',
    run: {
      sessionId: 'root-acp',
      snapshot: { state: 'failed', outputIncomplete: true, support: support(false) },
      items: [
        {
          type: 'tool_call',
          toolCallId: 'f1',
          title: 'pnpm test',
          kind: 'execute',
          status: 'failed',
        },
      ],
    },
  },
];

/** Storybook stand-in for the conversation renderers `view.tsx` passes in. */
const renderHistory = (task: SubagentTask) => (
  <ol className="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px] text-muted-foreground">
    {task.run?.items.map((item, index) => (
      <li key={index}>
        {item.type === 'tool_call' ? item.title : 'text' in item ? item.text : item.type}
      </li>
    ))}
  </ol>
);

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
export const BackgroundCommands: Story = { args: { tasks: backgroundCommands } };
export const StreamedRuns: Story = {
  args: { tasks: streamedRuns, renderHistory, runCancellation: true, onCancel: async () => {} },
};
export const SettledRuns: Story = { args: { tasks: settledRuns, renderHistory } };
