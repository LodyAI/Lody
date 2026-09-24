import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ScheduleForm,
  ScheduleListView,
  type ScheduleRowContext,
} from '../components/schedules/schedule-view';
import { ScheduleAgentControls } from '../components/schedules/schedule-agent-controls';
import { ScheduleDialog } from '../components/schedules/schedule-dialog';
import { ScheduleDestinationRows } from '../components/schedules/schedule-destination-rows';
import { FieldIssueMark } from '../components/schedules/schedule-field-issue-mark';
import type { ScheduleSaveIssue } from '../components/schedules/schedule-save-blockers';
import { DesktopMachineMenu } from '../components/sessions/desktop-run-config-menu';
import { ProjectRefSelector } from '../components/shared/project-ref-selector';
import type { AgentRunRef } from '../components/shared/agent-run-ref';
import { WorktreeCheckboxPill } from '../components/shared/workdir-mode-selector';
import type {
  AgentConfigId,
  AgentConfigMeta,
  MachineId,
  MachineMeta,
  ProjectRef,
  ScheduleDestination,
  ScheduleRegistryRow,
  ScheduleRuntimeRow,
} from '@lody/shared';
import { useState, type ReactNode } from 'react';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';

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

const storyMachine = {
  id: 'macbook',
  name: 'MacBook Pro',
  ownerUserId: 'owner',
  os: 'darwin',
  cliVersion: '0.100.0',
  sessions: [],
  timeZone: 'Asia/Shanghai',
} as unknown as MachineMeta;
const storyAgents = [
  {
    id: 'reviewer',
    machineId: 'macbook',
    name: 'Code reviewer',
    cliType: 'builtin',
    agentType: 'claude',
  },
  { id: 'writer', machineId: 'macbook', name: 'Writer', cliType: 'builtin', agentType: 'codex' },
] as unknown as AgentConfigMeta[];

type EditorFixture = {
  chatOnly?: boolean;
  destination?: ScheduleDestination;
  ownChatExists?: boolean;
  noAgent?: boolean;
  /** Marks the fixture shows; the same list is passed to the form. */
  issues?: ScheduleSaveIssue[];
};

/** Offline platform: the composer's controls read machines through it. */
const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'authenticated', user: { id: 'owner', name: 'Owner' } }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [{ id: 'workspace-storybook', name: 'Storybook', slug: null, role: 'owner' }],
    activeWorkspaceId: 'workspace-storybook',
  }),
});
function WithPlatform({ children }: { children: ReactNode }) {
  return <PlatformContext.Provider value={storyPlatform}>{children}</PlatformContext.Provider>;
}

/**
 * The workspace owns these controls; the story renders the SAME components —
 * the composer's Agent controls, the landing's machine menu, project chip and
 * worktree checkbox — over fixture data instead of a live runtime.
 */
function EditorStory({
  fixture = {},
  bare = false,
  ...props
}: Partial<React.ComponentProps<typeof ScheduleForm>> & {
  fixture?: EditorFixture;
  /** Render without the page scroller, e.g. inside `ScheduleDialog`. */
  bare?: boolean;
}) {
  const [destination, setDestination] = useState<ScheduleDestination>(
    fixture.destination ?? { kind: 'new_session' }
  );
  const [agent, setAgent] = useState<AgentRunRef | null>(
    fixture.noAgent ? null : { agentConfigId: 'reviewer' as AgentConfigId, modeId: 'default' }
  );
  const [project, setProject] = useState<ProjectRef | null>(
    fixture.chatOnly ? null : ({ kind: 'github', repoFullName: 'loro-dev/lody' } as ProjectRef)
  );
  const issues = fixture.issues ?? [];
  const marks = (field: ScheduleSaveIssue['field'], revealMissing: boolean) =>
    issues
      .filter((issue) => issue.field === field && (issue.kind === 'invalid' || revealMissing))
      .map((issue) => issue.message);
  const chat = (id: string) => chats.find((entry) => entry.id === id) ?? null;
  return (
    <div className={bare ? undefined : 'h-dvh overflow-auto'}>
      <ScheduleForm
        now={NOW}
        saving={false}
        onSave={() => {}}
        timeZone="Asia/Shanghai"
        clockName={storyMachine.name}
        issues={issues}
        contextNote={
          destination.kind === 'new_session' && !project
            ? 'Without a project each run is a plain chat with the Agent — no repository is checked out.'
            : undefined
        }
        agentBar={({ revealMissing }) => (
          <>
            <ScheduleAgentControls
              machine={storyMachine}
              agentConfigs={storyAgents}
              value={agent}
              onChange={setAgent}
            />
            <FieldIssueMark messages={marks('agent', revealMissing)} />
          </>
        )}
        contextBar={({ revealMissing }) => (
          <>
            <DesktopMachineMenu
              value={storyMachine.id as MachineId}
              options={[{ value: storyMachine.id as MachineId, label: storyMachine.name }]}
              onChange={() => {}}
            />
            <FieldIssueMark messages={marks('machine', revealMissing)} />
            {destination.kind === 'new_session' ? (
              <ProjectRefSelector
                triggerVariant="chip"
                value={project}
                onChange={setProject}
                localProjects={[]}
                repositories={[{ fullName: 'loro-dev/lody' }, { fullName: 'loro-dev/loro' }]}
                onAddLocalProject={() => {}}
                onConnectGitRepo={() => {}}
              />
            ) : null}
            {destination.kind === 'new_session' && !fixture.chatOnly ? (
              <WorktreeCheckboxPill checked onCheckedChange={() => {}} />
            ) : null}
          </>
        )}
        destination={({ revealMissing }) => (
          <ScheduleDestinationRows
            value={destination}
            onChange={setDestination}
            sessions={chats}
            ownSession={
              destination.kind === 'own_session' && fixture.ownChatExists && destination.epoch === 0
                ? chats[1]
                : null
            }
            pickedSession={
              destination.kind === 'existing_session' ? chat(destination.sessionId) : null
            }
            issues={marks('destination', revealMissing)}
          />
        )}
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
  );
}

const editor = (
  props: Partial<React.ComponentProps<typeof ScheduleForm>> & { fixture?: EditorFixture } = {}
): StoryObj<typeof meta> => ({
  render: () => (
    <WithPlatform>
      <EditorStory {...props} />
    </WithPlatform>
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
        <WithPlatform>
          <EditorStory
            initial={{
              title: 'Review the latest changes',
              prompt: 'Review changes since the previous working day.',
              trigger: { kind: 'cron', expression: '*/20 9-17 * * 1-5', timeZone: 'Asia/Shanghai' },
              misfire: 'run_once',
              overlap: 'queue_one',
            }}
          />
        </WithPlatform>
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
  fixture: { noAgent: true, chatOnly: true },
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
  ...editor({ fixture: { chatOnly: true } }),
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
  fixture: { destination: { kind: 'own_session', epoch: 0 } },
  initial: {
    title: 'Daily journal',
    prompt: 'Ask me how the day went and note the answer.',
    trigger: { kind: 'cron', expression: '0 21 * * *', timeZone: 'Asia/Shanghai' },
    misfire: 'run_once',
    overlap: 'queue_one',
  },
});
export const EditorOwnChatCreated: Story = editor({
  fixture: { destination: { kind: 'own_session', epoch: 0 }, ownChatExists: true },
  initial: {
    title: 'Daily journal',
    prompt: 'Ask me how the day went and note the answer.',
    trigger: { kind: 'cron', expression: '0 21 * * *', timeZone: 'Asia/Shanghai' },
    misfire: 'run_once',
    overlap: 'queue_one',
  },
});
export const EditorExistingChat: Story = editor({
  fixture: { destination: { kind: 'existing_session', sessionId: 'c1' } },
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
  fixture: {
    noAgent: true,
    chatOnly: true,
    issues: [{ field: 'agent', kind: 'missing', message: 'Choose an available Agent.' }],
  },
});
/** A real conflict is marked at once, before any save attempt. */
export const EditorAgentConflict: Story = editor({
  fixture: {
    issues: [{ field: 'agent', kind: 'invalid', message: 'Choose an explicit permission mode.' }],
  },
});
/** A reason that belongs to no control sits beside Save. */
export const EditorWorkspaceLoading: Story = editor({
  fixture: {
    issues: [
      {
        field: 'form',
        kind: 'invalid',
        message: 'Wait for your workspace and account to finish loading.',
      },
    ],
  },
});
export const EditorSaving: Story = editor({ saving: true });
export const EditorError: Story = editor({ error: 'The schedule could not be saved.' });

/**
 * Desktop: the list stays the page and a schedule opens over it in a Dialog —
 * no tabs. Saving or closing returns to the list.
 */
export const EditorInDialog: Story = {
  render: (args) => (
    <WithPlatform>
      <ScheduleListView {...args} />
      <ScheduleDialog title="New schedule" open onClose={() => {}}>
        <EditorStory bare autoFocus fixture={{ chatOnly: true }} />
      </ScheduleDialog>
    </WithPlatform>
  ),
};
