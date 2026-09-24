import type { Meta, StoryObj } from '@storybook/react-vite';
import { Bot, ChevronDown, FolderGit2 } from 'lucide-react';
import {
  ScheduleForm,
  ScheduleListView,
  type ScheduleRowContext,
} from '../components/schedules/schedule-view';
import {
  RunBarItem,
  ScheduleChatPill,
  ScheduleDestinationPill,
  runPillClass,
  runPillIssueClass,
  runWorktreePillClass,
} from '../components/schedules/schedule-run-bar';
import type { ScheduleSaveIssue } from '../components/schedules/schedule-save-blockers';
import { WorktreeCheckboxPill } from '../components/shared/workdir-mode-selector';
import type { ScheduleDestination, ScheduleRegistryRow, ScheduleRuntimeRow } from '@lody/shared';
import { useState, type ReactNode } from 'react';
import { cn } from '../lib/utils';

/** Frozen clock so "Next run" and the editor preview never drift. */
const NOW = Date.parse('2026-09-06T09:12:00+08:00');

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
  destination: { kind: 'new_session' },
  elevatedPermissions: false,
  agentConfigId: 'agent',
  definitionFingerprint: '0'.repeat(64),
  projectKind: 'github',
  projectKey: 'loro-dev/lody',
};

const runtimeFor = (
  target: ScheduleRegistryRow,
  extra: Partial<ScheduleRuntimeRow> = {}
): ScheduleRuntimeRow => ({
  scheduleId: target.scheduleId,
  machineId: target.machineId,
  activationId: target.activationId,
  observedDefinitionFingerprint: target.definitionFingerprint,
  updatedAt: 0,
  ...extra,
});

const rows: ScheduleRegistryRow[] = [
  row,
  {
    ...row,
    scheduleId: 'standup',
    title: 'Post the standup summary',
    trigger: { kind: 'cron', expression: '30 8 * * *', timeZone: 'Asia/Shanghai' },
    projectKind: undefined,
    projectKey: undefined,
  },
  {
    ...row,
    scheduleId: 'weekly-summary',
    title: 'Write a weekly project summary',
    enabled: false,
    trigger: { kind: 'cron', expression: '0 17 * * 5', timeZone: 'Asia/Shanghai' },
  },
  {
    ...row,
    scheduleId: 'dependency-sweep',
    title: 'Check dependencies for advisories',
    trigger: { kind: 'interval', everyMs: 6 * 3_600_000, anchorAt: '2026-09-06T00:00:00Z' },
    projectKind: 'local',
    projectKey: 'local-project',
  },
  {
    ...row,
    scheduleId: 'release-notes',
    title: 'Draft release notes',
    trigger: { kind: 'cron', expression: '*/20 9-17 * * 1-5', timeZone: 'Asia/Shanghai' },
  },
  {
    ...row,
    scheduleId: 'daily-journal',
    title: 'Daily journal',
    trigger: { kind: 'cron', expression: '0 21 * * *', timeZone: 'Asia/Shanghai' },
    destination: { kind: 'own_session', epoch: 0 },
    projectKind: undefined,
    projectKey: undefined,
  },
  {
    ...row,
    scheduleId: 'deploy-checklist',
    title: 'Run the deploy checklist',
    trigger: { kind: 'manual' },
    projectKind: undefined,
    projectKey: undefined,
  },
];

const context = (target: ScheduleRegistryRow): ScheduleRowContext => ({
  machine: 'MacBook Pro',
  agent: target.scheduleId === 'standup' ? 'Writer' : 'Code reviewer',
  project: target.projectKey ? (target.projectKind === 'local' ? 'lody' : target.projectKey) : null,
  presence: target.scheduleId === 'weekly-summary' ? 'offline' : 'online',
  canToggle: true,
});

const runtimes: ScheduleRuntimeRow[] = [
  runtimeFor(rows[0]!, {
    nextScheduledAt: Date.parse('2026-09-07T09:00:00+08:00'),
    lastDispatch: {
      scheduledFor: Date.parse('2026-09-05T09:00:00+08:00'),
      dispatchedAt: Date.parse('2026-09-05T09:00:04+08:00'),
      sessionId: 'session',
    },
  }),
  runtimeFor(rows[1]!, { nextScheduledAt: Date.parse('2026-09-07T08:30:00+08:00') }),
  runtimeFor(rows[3]!, {
    nextScheduledAt: Date.parse('2026-09-06T12:00:00+08:00'),
    queueState: 'due',
  }),
  runtimeFor(rows[4]!, { queueState: 'blocked', blockedCode: 'PERMISSION_UNAVAILABLE' }),
];

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
    rows,
    runtimes,
    ready: true,
    now: NOW,
    contextForRow: context,
    onOpen: () => {},
    onNew: () => {},
    onToggle: () => {},
    onOpenSession: () => {},
  },
} satisfies Meta<typeof ScheduleListView>;
export default meta;
type Story = StoryObj<typeof meta>;

export const List: Story = {};
export const Narrow: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const Empty: Story = { args: { rows: [], runtimes: [] } };
export const Loading: Story = { args: { ready: false } };
export const LoadError: Story = { args: { error: 'boom' } };
export const AllOffline: Story = {
  args: { contextForRow: (item) => ({ ...context(item), presence: 'offline' }) },
};
export const ConnectionUnknown: Story = {
  args: { contextForRow: (item) => ({ ...context(item), presence: 'unknown' }) },
};
export const ReadOnly: Story = {
  args: { contextForRow: (item) => ({ ...context(item), canToggle: false }) },
};
export const AwaitingMachine: Story = { args: { runtimes: [] } };

const chats = [
  { id: 'c1', title: 'Release planning', detail: 'Code reviewer · MacBook Pro' },
  { id: 'c2', title: 'Daily journal', detail: 'Writer · MacBook Pro' },
  { id: 'c3', title: 'Refactor auth module', detail: 'Code reviewer · Studio' },
];

/** The run bar is owned by the workspace; stories stand in for its pills. */
function RunBarFixture({
  chatOnly = false,
  destination: initialDestination = { kind: 'new_session' },
  ownChatExists = false,
  noAgent = false,
  issues = [],
  revealMissing,
}: {
  chatOnly?: boolean;
  destination?: ScheduleDestination;
  ownChatExists?: boolean;
  noAgent?: boolean;
  issues?: readonly ScheduleSaveIssue[];
  revealMissing: boolean;
}) {
  const [destination, setDestination] = useState<ScheduleDestination>(initialDestination);
  const [worktree, setWorktree] = useState(true);
  const marks = (field: ScheduleSaveIssue['field']) =>
    issues
      .filter((issue) => issue.field === field && (issue.kind === 'invalid' || revealMissing))
      .map((issue) => issue.message);
  const agentIssues = marks('agent');
  return (
    <>
      <RunBarItem issues={destination.kind === 'existing_session' ? [] : marks('destination')}>
        <ScheduleDestinationPill
          value={destination}
          onChange={setDestination}
          ownSession={
            destination.kind === 'own_session' && ownChatExists && destination.epoch === 0
              ? chats[1]
              : null
          }
        />
      </RunBarItem>
      {destination.kind === 'existing_session' ? (
        <RunBarItem issues={marks('destination')}>
          <ScheduleChatPill
            sessions={chats}
            value={destination.sessionId}
            label={chats.find((chat) => chat.id === destination.sessionId)?.title}
            onChange={(sessionId) => setDestination({ kind: 'existing_session', sessionId })}
          />
        </RunBarItem>
      ) : null}
      <RunBarItem issues={agentIssues}>
        <button
          type="button"
          className={cn(runPillClass, agentIssues.length > 0 && runPillIssueClass)}
        >
          <Bot />
          {noAgent ? (
            <span className="truncate">Choose agent</span>
          ) : (
            <span className="truncate">
              <span className="text-foreground">Code reviewer</span> · Sonnet · Ask each time
            </span>
          )}
          <ChevronDown className="opacity-60" />
        </button>
      </RunBarItem>
      {destination.kind === 'new_session' ? (
        <RunBarItem issues={marks('project')}>
          <button type="button" className={runPillClass}>
            <FolderGit2 />
            <span className={cn('truncate', !chatOnly && 'text-foreground')}>
              {chatOnly ? 'Choose project' : 'loro-dev/lody'}
            </span>
          </button>
        </RunBarItem>
      ) : null}
      {destination.kind === 'new_session' && !chatOnly ? (
        <WorktreeCheckboxPill
          className={runWorktreePillClass}
          checked={worktree}
          onCheckedChange={setWorktree}
        />
      ) : null}
    </>
  );
}

const note = {
  project: undefined,
  chatOnly:
    'Without a project each run is a plain chat with the Agent — no repository is checked out.',
  ownPending: 'Created on the first run; every later run continues it.',
  ownCreated: 'The Agent is now this chat’s Agent. Start a new chat to change it.',
  existing: 'Runs use this chat’s Agent and workspace.',
};

const runBar =
  (fixture: Omit<React.ComponentProps<typeof RunBarFixture>, 'revealMissing'> = {}) =>
  ({ revealMissing }: { revealMissing: boolean }): ReactNode => (
    <RunBarFixture {...fixture} revealMissing={revealMissing} />
  );

const editor = (
  props: Partial<React.ComponentProps<typeof ScheduleForm>> = {}
): StoryObj<typeof meta> => ({
  render: () => (
    <div className="h-dvh overflow-auto">
      <ScheduleForm
        now={NOW}
        saving={false}
        onSave={() => {}}
        timeZone="Asia/Shanghai"
        clockName="MacBook Pro"
        runBar={runBar()}
        initial={{
          title: 'Review the latest changes',
          prompt:
            'Review changes since the previous working day. Summarize bugs and suggested fixes in this chat.',
          trigger: row.trigger,
          misfire: 'run_once',
          overlap: 'queue_one',
        }}
        {...props}
      />
    </div>
  ),
});

export const Editor: Story = editor();
/**
 * A DESKTOP viewport with a narrow panel — the case a `sm:` breakpoint cannot
 * see. Every row must keep its control inside the panel rather than clipping it.
 */
export const EditorInNarrowPanel: Story = {
  render: () => (
    <div className="flex h-dvh">
      <div className="w-[360px] shrink-0 overflow-auto border-r">
        <ScheduleForm
          now={NOW}
          saving={false}
          onSave={() => {}}
          timeZone="Asia/Shanghai"
          clockName="MacBook Pro"
          runBar={runBar()}
          initial={{
            title: 'Review the latest changes',
            prompt: 'Review changes since the previous working day.',
            trigger: { kind: 'cron', expression: '*/20 9-17 * * 1-5', timeZone: 'Asia/Shanghai' },
            misfire: 'run_once',
            overlap: 'queue_one',
          }}
        />
      </div>
      <div className="min-w-0 flex-1 bg-muted/10" />
    </div>
  ),
};
export const EditorNarrow: Story = {
  ...editor(),
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const EditorNew: Story = editor({
  autoFocus: true,
  runBar: runBar({ noAgent: true, chatOnly: true }),
  runNote: note.chatOnly,
  issues: [{ field: 'agent', kind: 'missing', message: 'Choose an available Agent.' }],
  initial: {
    title: '',
    prompt: '',
    trigger: { kind: 'cron', expression: '0 9 * * *', timeZone: 'Asia/Shanghai' },
    misfire: 'run_once',
    overlap: 'queue_one',
  },
});
export const EditorChatOnly: Story = {
  ...editor({ runBar: runBar({ chatOnly: true }), runNote: note.chatOnly }),
};
export const EditorWeekly: Story = editor({
  initial: {
    title: 'Weekly digest',
    prompt: 'Summarize what shipped this week.',
    trigger: { kind: 'cron', expression: '0 17 * * 1,3,5', timeZone: 'Asia/Shanghai' },
    misfire: 'skip',
    overlap: 'skip',
  },
});
export const EditorInterval: Story = editor({
  initial: {
    title: 'Dependency sweep',
    prompt: 'Check dependencies for new advisories.',
    trigger: { kind: 'interval', everyMs: 6 * 3_600_000, anchorAt: '2026-09-06T00:00:00Z' },
    misfire: 'skip',
    overlap: 'skip',
  },
});
export const EditorEveryFewHours: Story = editor({
  initial: {
    title: 'Dependency sweep',
    prompt: 'Check dependencies for new advisories.',
    trigger: { kind: 'cron', expression: '0 */6 * * *', timeZone: 'Asia/Shanghai' },
    misfire: 'skip',
    overlap: 'skip',
  },
});
export const EditorMonthly: Story = editor({
  initial: {
    title: 'Invoice reminder',
    prompt: 'Draft the invoice reminder.',
    trigger: { kind: 'cron', expression: '0 9 1,15 * *', timeZone: 'Asia/Shanghai' },
    misfire: 'run_once',
    overlap: 'queue_one',
  },
});
export const EditorManual: Story = editor({
  initial: {
    title: 'Run the deploy checklist',
    prompt: 'Walk through the deploy checklist and report anything that fails.',
    trigger: { kind: 'manual' },
    misfire: 'run_once',
    overlap: 'queue_one',
  },
});
export const EditorOwnChatPending: Story = editor({
  runBar: runBar({ destination: { kind: 'own_session', epoch: 0 } }),
  runNote: note.ownPending,
  initial: {
    title: 'Daily journal',
    prompt: 'Ask me how the day went and note the answer.',
    trigger: { kind: 'cron', expression: '0 21 * * *', timeZone: 'Asia/Shanghai' },
    misfire: 'run_once',
    overlap: 'queue_one',
  },
});
export const EditorOwnChatCreated: Story = editor({
  runBar: runBar({ destination: { kind: 'own_session', epoch: 0 }, ownChatExists: true }),
  runNote: note.ownCreated,
  initial: {
    title: 'Daily journal',
    prompt: 'Ask me how the day went and note the answer.',
    trigger: { kind: 'cron', expression: '0 21 * * *', timeZone: 'Asia/Shanghai' },
    misfire: 'run_once',
    overlap: 'queue_one',
  },
});
export const EditorExistingChat: Story = editor({
  runBar: runBar({ destination: { kind: 'existing_session', sessionId: 'c1' } }),
  runNote: note.existing,
});
/** A rule from an older version that the picker cannot name stays read-only. */
export const EditorUnsupportedRule: Story = editor({
  initial: {
    title: 'Business-hours sweep',
    prompt: 'Check the build every twenty minutes during business hours.',
    trigger: { kind: 'cron', expression: '*/20 9-17 * * 1-5', timeZone: 'Asia/Shanghai' },
    misfire: 'skip',
    overlap: 'skip',
  },
});
export const EditorMissingRequirements: Story = editor({
  initial: {
    title: '',
    prompt: '',
    trigger: row.trigger,
    misfire: 'run_once',
    overlap: 'queue_one',
  },
  revealIssues: true,
  runBar: runBar({
    noAgent: true,
    chatOnly: true,
    issues: [{ field: 'agent', kind: 'missing', message: 'Choose an available Agent.' }],
  }),
  issues: [{ field: 'agent', kind: 'missing', message: 'Choose an available Agent.' }],
});
/** A real conflict is marked at once, before any save attempt. */
export const EditorAgentConflict: Story = editor({
  runBar: runBar({
    issues: [{ field: 'agent', kind: 'invalid', message: 'Choose an explicit permission mode.' }],
  }),
  issues: [{ field: 'agent', kind: 'invalid', message: 'Choose an explicit permission mode.' }],
});
/** A reason that belongs to no control sits beside Save. */
export const EditorWorkspaceLoading: Story = editor({
  issues: [
    {
      field: 'form',
      kind: 'invalid',
      message: 'Wait for your workspace and account to finish loading.',
    },
  ],
});
export const EditorSaving: Story = editor({ saving: true });
export const EditorError: Story = editor({ error: 'The schedule could not be saved.' });
