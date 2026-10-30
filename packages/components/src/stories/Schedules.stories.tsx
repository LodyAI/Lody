import type { Meta, StoryObj } from '@storybook/react-vite';
import {
  ScheduleForm,
  ScheduleListView,
  type ScheduleRowContext,
} from '../components/schedules/schedule-view';
import { ScheduleAgentControls } from '../components/schedules/schedule-agent-controls';
import {
  ScheduleDetailFrame,
  ScheduleDetailHeader,
  ScheduleDetailModal,
  ScheduleDetailPage,
  ScheduleRunList,
  type ScheduleDetailTab,
} from '../components/schedules/schedule-detail';
import { describeScheduleState } from '../components/schedules/schedule-format';
import { matchingScheduleRuntime } from '../components/schedules/schedule-list';
import { MessageSquare, Play, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
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
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createStore, Provider } from 'jotai';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import { sidebarCollapsedAtom } from '../atoms/sidebar-state';

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
  machine: target.scheduleId === 'weekly-summary' ? 'Mac mini' : 'MacBook Pro',
  agent: target.scheduleId === 'standup' ? 'Writer' : 'Code reviewer',
  project: target.projectKey ? (target.projectKind === 'local' ? 'lody' : target.projectKey) : null,
  presence: target.scheduleId === 'weekly-summary' ? 'offline' : 'online',
  canToggle: true,
  chat:
    target.destination.kind === 'own_session'
      ? { title: 'Daily journal', sessionId: 'journal-chat' }
      : target.destination.kind === 'existing_session'
        ? { title: 'Release planning', sessionId: target.destination.sessionId }
        : undefined,
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
    onRun: () => {},
    onDelete: () => {},
    onOpenSession: () => {},
  },
} satisfies Meta<typeof ScheduleListView>;
export default meta;
type Story = StoryObj<typeof meta>;

function CollapsedSidebar({ children }: { children: ReactNode }) {
  const [store] = useState(() => {
    const next = createStore();
    next.set(sidebarCollapsedAtom, true);
    return next;
  });
  return <Provider store={store}>{children}</Provider>;
}

function MacElectronCollapsedSidebar({ children }: { children: ReactNode }) {
  const [store] = useState(() => {
    window.__LODY_ELECTRON__ = true;
    window.__LODY_PLATFORM__ = {
      os: 'darwin',
      homeDir: '/Users/story',
      machineName: 'storybook',
    };
    const next = createStore();
    next.set(sidebarCollapsedAtom, true);
    return next;
  });
  useLayoutEffect(
    () => () => {
      delete window.__LODY_ELECTRON__;
      delete window.__LODY_PLATFORM__;
    },
    []
  );
  return (
    <Provider store={store}>
      <div className="relative h-dvh bg-background text-foreground">
        <div
          aria-hidden
          className="pointer-events-none absolute top-[16px] left-[16px] z-30 flex gap-2"
        >
          <span className="size-[14px] rounded-full bg-[#ff5f57]" />
          <span className="size-[14px] rounded-full bg-[#febc2e]" />
          <span className="size-[14px] rounded-full bg-[#28c840]" />
        </div>
        {children}
      </div>
    </Provider>
  );
}

export const List: Story = {};
export const SidebarHidden: Story = {
  render: (args) => (
    <CollapsedSidebar>
      <ScheduleListView {...args} />
    </CollapsedSidebar>
  ),
};
export const SidebarHiddenBesideTrafficLights: Story = {
  render: (args) => (
    <MacElectronCollapsedSidebar>
      <ScheduleListView {...args} />
    </MacElectronCollapsedSidebar>
  ),
};
export const Narrow: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
};
export const Empty: Story = { args: { rows: [], runtimes: [] } };
export const Loading: Story = { args: { ready: false } };
export const LoadFailed: Story = {
  args: { rows: [], runtimes: [], error: 'REGISTRY_UNAVAILABLE', onRetry: () => {} },
};
export const SyncFailedWithSavedTasks: Story = {
  args: { error: 'REGISTRY_UNAVAILABLE', onRetry: () => {} },
};
export const Retrying: Story = {
  args: { error: 'REGISTRY_UNAVAILABLE', retrying: true, onRetry: () => {} },
};
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

/** One-time scheduled messages in each state; sent and cancelled ones are finished. */
const messageRows: ScheduleRegistryRow[] = (
  [
    ['message-pending', 'Remind me to ship the release', true],
    ['message-sent', 'Ask for the CI summary', true],
    ['message-cancelled', 'Follow up on the review', false],
    ['message-failed', 'Ping the design thread', true],
  ] as const
).map(([scheduleId, title, enabled]) => ({
  ...row,
  scheduleId,
  title,
  enabled,
  scheduledMessage: true,
  trigger: { kind: 'once', at: '2026-09-06T18:00:00+08:00' },
  destination: { kind: 'existing_session', sessionId: 'c1' },
  projectKind: undefined,
  projectKey: undefined,
}));
const messageContents = new Map<string, string>([
  ['message-pending', 'Ship the release once the CI run passes'],
  ['message-sent', 'Summarize today’s CI failures for the team'],
  ['message-cancelled', 'Ask for another review pass on the auth change'],
  ['message-failed', 'Ping the design thread about the empty state'],
]);
const contentForRow = (target: ScheduleRegistryRow) => messageContents.get(target.scheduleId);
const messageRuntimes: ScheduleRuntimeRow[] = [
  runtimeFor(messageRows[0]!, {
    messageState: 'pending',
    nextScheduledAt: Date.parse('2026-09-06T18:00:00+08:00'),
  }),
  runtimeFor(messageRows[1]!, {
    messageState: 'sent',
    lastDispatch: {
      scheduledFor: Date.parse('2026-09-05T18:00:00+08:00'),
      dispatchedAt: Date.parse('2026-09-05T18:00:02+08:00'),
      sessionId: 'c1',
    },
  }),
  runtimeFor(messageRows[2]!, { messageState: 'cancelled' }),
  runtimeFor(messageRows[3]!, { messageState: 'failed' }),
];
export const WithScheduledMessages: Story = {
  args: {
    rows: [...rows, ...messageRows],
    runtimes: [...runtimes, ...messageRuntimes],
    contentForRow,
  },
};
export const ProtectedMessageNeedsOwnerSave: Story = {
  args: {
    rows: [messageRows[0]!],
    runtimes: [
      runtimeFor(messageRows[0]!, {
        messageState: 'pending',
        queueState: 'blocked',
        blockedCode: 'E2EE_SCHEDULE_NOT_AUTHORIZED',
      }),
    ],
  },
};
/** One project picked, sorted by name. */
export const Filtered: Story = {
  args: {
    rows: [...rows, ...messageRows],
    runtimes: [...runtimes, ...messageRuntimes],
    contentForRow,
    initialFilters: { project: { kind: 'project', name: 'loro-dev/lody' }, sort: 'name' },
  },
};
export const MobileList: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  args: {
    rows: [...rows, ...messageRows],
    runtimes: [...runtimes, ...messageRuntimes],
    contentForRow,
  },
};

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
  /** Render without the page scroller, e.g. inside the detail pane. */
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
export const EditorOnceMachineClock: Story = editor({
  now: Date.parse('2026-10-01T00:00:00Z'),
  timeZone: 'America/Los_Angeles',
  clockName: 'Fixture machine',
  contextBar: undefined,
  agentBar: undefined,
  initial: {
    title: 'One-off review',
    prompt: 'Review the fixture changes.',
    trigger: { kind: 'once', at: '2026-10-01T09:21:00.000Z' },
    misfire: 'run_once',
    overlap: 'queue_one',
  },
});
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

const journal = rows.find((entry) => entry.scheduleId === 'daily-journal')!;
const journalRuns = [
  {
    id: 'r4',
    title: 'Run 4',
    when: 'Today 9:00 PM',
    state: 'running' as const,
    sessionId: 'journal-chat',
  },
  {
    id: 'r3',
    title: 'Run 3',
    when: 'Yesterday 9:00 PM',
    state: 'done' as const,
    sessionId: 'journal-chat',
  },
  {
    id: 'r2',
    title: 'Run 2',
    when: 'Thu 9:00 PM',
    state: 'done' as const,
    sessionId: 'journal-chat',
  },
  {
    id: 'r1',
    title: 'Run 1',
    when: 'Wed 9:00 PM',
    state: 'done' as const,
    sessionId: 'journal-chat',
  },
];
const reviewRuns = [
  {
    id: 's3',
    title: 'Review of Sep 5 changes',
    when: 'Yesterday 9:00 AM',
    state: 'done' as const,
    sessionId: 's3',
  },
  {
    id: 's2',
    title: 'Review of Sep 4 changes',
    when: 'Thu 9:00 AM',
    state: 'failed' as const,
    sessionId: 's2',
  },
  {
    id: 's1',
    title: 'Review of Sep 3 changes',
    when: 'Wed 9:00 AM',
    state: 'done' as const,
    sessionId: 's1',
  },
];

/**
 * The open schedule as production composes it (`schedules-workspace.tsx`):
 * header, Settings / Run history tabs and body, in the desktop modal over the
 * list or as the phone page. The editor is the real form over fixture data.
 */
function DetailStory({
  target = row,
  initialTab = 'settings',
  mobile = false,
  history,
}: {
  target?: ScheduleRegistryRow;
  initialTab?: ScheduleDetailTab;
  mobile?: boolean;
  history?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<ScheduleDetailTab>(initialTab);
  const runtime = matchingScheduleRuntime(target, [...runtimes, ...messageRuntimes]);
  const ctx = context(target);
  const header = (
    <ScheduleDetailHeader
      kind={target.scheduledMessage ? 'message' : 'task'}
      title={target.title}
      status={describeScheduleState(t, target, runtime, {
        timeZone: 'Asia/Shanghai',
        now: NOW,
        locale: i18n.language,
      })}
      enabled={
        target.scheduledMessage || target.trigger.kind === 'manual'
          ? undefined
          : { value: target.enabled, onChange: () => {} }
      }
      actions={[
        { key: 'run', label: t('schedules.runNow'), icon: Play, onClick: () => {} },
        ...(ctx.chat
          ? [
              {
                key: 'chat',
                label: t('schedules.openChat', { title: ctx.chat.title }),
                icon: MessageSquare,
                onClick: () => {},
              },
            ]
          : []),
        {
          key: 'delete',
          label: t('schedules.delete'),
          icon: Trash2,
          destructive: true,
          onClick: () => {},
        },
      ]}
      onClose={() => {}}
      mobile={mobile}
    />
  );
  const frame = (
    <ScheduleDetailFrame
      header={header}
      tab={target.scheduledMessage ? undefined : tab}
      onTabChange={setTab}
    >
      {tab === 'history' ? (
        (history ?? <ScheduleRunList runs={reviewRuns} onOpen={() => {}} />)
      ) : (
        <EditorStory
          bare
          stickyFooter
          onCancel={() => {}}
          fixture={
            target.destination.kind === 'own_session'
              ? { destination: target.destination, ownChatExists: true }
              : {}
          }
        />
      )}
    </ScheduleDetailFrame>
  );
  return (
    <WithPlatform>
      {mobile ? (
        <div className="h-dvh">
          <ScheduleDetailPage>{frame}</ScheduleDetailPage>
        </div>
      ) : (
        <div className="h-dvh">
          <ScheduleListView
            rows={[...rows, ...messageRows]}
            runtimes={[...runtimes, ...messageRuntimes]}
            contentForRow={contentForRow}
            ready
            now={NOW}
            contextForRow={context}
            selectedId={target.scheduleId}
            onOpen={() => {}}
            onNew={() => {}}
          />
          <ScheduleDetailModal open title={target.title} onClose={() => {}}>
            {frame}
          </ScheduleDetailModal>
        </div>
      )}
    </WithPlatform>
  );
}

/** Desktop: the open schedule is a modal over the list. */
export const DetailModal: Story = { render: () => <DetailStory /> };
/** Run history of a schedule that starts a new chat per run. */
export const DetailRunHistory: Story = { render: () => <DetailStory initialTab="history" /> };
/** Run history of a schedule that posts into one chat: the chat first, then each run in it. */
export const DetailRunHistoryInChat: Story = {
  render: () => (
    <DetailStory
      target={journal}
      initialTab="history"
      history={
        <ScheduleRunList
          runs={journalRuns}
          chat={{ title: 'Daily journal', sessionId: 'journal-chat' }}
          onOpen={() => {}}
        />
      }
    />
  ),
};
export const DetailRunHistoryEmpty: Story = {
  render: () => (
    <DetailStory initialTab="history" history={<ScheduleRunList runs={[]} onOpen={() => {}} />} />
  ),
};
/** Phone: the open schedule is a pushed page with a back button. */
export const MobileDetail: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: () => <DetailStory mobile />,
};
export const MobileRunHistory: Story = {
  parameters: { viewport: { defaultViewport: 'mobile1' } },
  render: () => (
    <DetailStory
      mobile
      target={journal}
      initialTab="history"
      history={
        <ScheduleRunList
          runs={journalRuns}
          chat={{ title: 'Daily journal', sessionId: 'journal-chat' }}
          onOpen={() => {}}
        />
      }
    />
  ),
};
