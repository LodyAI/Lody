import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { fn, userEvent, within } from 'storybook/test';
import { useEffect, useState } from 'react';
import {
  getLodySessionPresenceKey,
  getServerNow,
  type AgentConfigId,
  type LodyPresenceInstanceId,
  type LocalProjectId,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';

import { lodyPresenceStatesAtom } from '@/atoms/presence';
import { SessionAccessControl } from '@/components/session-sharing';
import { SessionHeaderMenu } from '@/components/sessions/session-chat-interface';
import { SessionTabBar, type ViewerTabItem } from '@/components/sessions/session-tab-bar';
import type { DraftSessionTab } from '@/lib/session-draft-tabs';
import type { SessionSharingState } from '@/lib/session-sharing';

const machineId = 'machine-1' as MachineId;
const agentConfigId = 'agent-1' as AgentConfigId;
const localProjectId = 'local:lody' as LocalProjectId;
const toolbarAction = fn();

const parentSession: SessionMeta = {
  id: 'session-parent' as SessionId,
  machineId,
  createdAt: '2026-04-02T00:00:00.000Z',
  title: 'Refactor chat landing',
  userId: 'user-1',
  status: { type: 'idle' },
  cliType: 'builtin',
  agentType: 'codex',
};

const childSessions: SessionMeta[] = [
  {
    id: 'session-child-1' as SessionId,
    machineId,
    createdAt: '2026-04-02T00:05:00.000Z',
    title: 'Review changes',
    userId: 'user-1',
    status: { type: 'running' },
    lastRunningSeen: Date.now(),
    cliType: 'builtin',
    agentType: 'codex',
  },
  {
    id: 'session-child-2' as SessionId,
    machineId,
    createdAt: '2026-04-02T00:08:00.000Z',
    title: 'Write tests',
    userId: 'user-1',
    status: { type: 'requestPermission' },
    cliType: 'builtin',
    agentType: 'codex',
  },
];

const archivedChildSessions: SessionMeta[] = [
  {
    id: 'session-archived-1' as SessionId,
    machineId,
    createdAt: '2026-04-01T10:00:00.000Z',
    title: 'Old branch review',
    userId: 'user-1',
    lastMessageAt: Date.now() - 60_000,
    status: { type: 'idle' },
    cliType: 'builtin',
    agentType: 'codex',
  },
];

const draftTabs: DraftSessionTab[] = [
  {
    id: 'draft:1' as DraftSessionTab['id'],
    sessionId: 'draft-session-1' as SessionId,
    prompt: 'Investigate regression',
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId,
    modeId: null,
    modelId: null,
  },
];

const viewerTabs: ViewerTabItem[] = [
  {
    id: 'file:packages/components/src/components/chat/chat-landing.tsx',
    type: 'file',
    label: 'chat-landing.tsx',
    filePath: 'packages/components/src/components/chat/chat-landing.tsx',
  },
  {
    id: 'diff:turn-1',
    type: 'diff',
    label: 'Changes',
  },
];

const screenshotParentSession: SessionMeta = {
  ...parentSession,
  title: 'Lody E2EE Plan',
  project: {
    kind: 'local',
    localProjectId,
    branch: 'feat/shared-access-visibility',
  },
  branchName: 'feat/shared-access-visibility',
};

const toolbarSharing: SessionSharingState = {
  visibility: 'private',
  privateReason: 'project',
  canManage: true,
  machineId,
  localProjectId,
  machineName: 'Studio Mac',
  projectName: 'lody',
};

const translate = (_key: string, fallback: string, options?: Record<string, unknown>) =>
  Object.entries(options ?? {}).reduce(
    (message, [name, value]) => message.replaceAll(`{{${name}}}`, String(value)),
    fallback
  );

function ConversationToolbar() {
  return (
    <div className="flex h-full shrink-0 items-center gap-1 pl-1 pr-2">
      <SessionAccessControl state={toolbarSharing} onShareWithTeam={toolbarAction} />
      <SessionHeaderMenu
        session={screenshotParentSession}
        localProjectMeta={{ name: 'lody', rootPath: '/Users/developer/Code/lody' }}
        workspacePath="/Users/developer/Code/lody"
        machineName="Studio Mac"
        onCopyConversationHistory={toolbarAction}
        onCopyUrl={toolbarAction}
        sharing={toolbarSharing}
        onShareWithTeam={toolbarAction}
        onOpenSearch={toolbarAction}
        onFork={toolbarAction}
        onRename={toolbarAction}
        t={translate}
      />
    </div>
  );
}

const screenshotChildSessions: SessionMeta[] = [
  {
    ...childSessions[0]!,
    title: "I'll start by reading the design doc and exploring the related implementation paths",
  },
  {
    ...childSessions[1]!,
    title: '根据 AGENTS.md 中的要求，分析当前桌面端标签页的布局限制',
  },
];

/**
 * Live presence per session id. Presence — never `SessionMeta.status` — is what
 * the tab bar reads for working / waiting-permission, so a story that wants a
 * spinner or an amber marker has to seed it here.
 */
type StoryPresence = Record<string, 'running' | 'requestPermission'>;

const DEFAULT_STORY_PRESENCE: StoryPresence = {
  [childSessions[0]!.id]: 'running',
  [childSessions[1]!.id]: 'requestPermission',
};

function buildPresenceStates(presence: StoryPresence) {
  return Object.fromEntries(
    Object.entries(presence).map(([sessionId, type]) => {
      const instanceId = `storybook-${sessionId}` as LodyPresenceInstanceId;
      return [
        getLodySessionPresenceKey(sessionId as SessionId, instanceId),
        {
          kind: 'session' as const,
          sessionId: sessionId as SessionId,
          machineId,
          instanceId,
          status: { type },
          updatedAt: getServerNow(),
        },
      ];
    })
  );
}

/* ── Unread sub-session tabs ────────────────────────────────────────────
   A child tab is the ONLY place its own new output is announced: sub-sessions
   get no sidebar row of their own. These four cover the whole status ladder in
   one row — waiting > working > unread > resting. */
const UNREAD_NOW = Date.parse('2026-04-02T01:00:00.000Z');

const unreadChildSessions: SessionMeta[] = [
  {
    ...childSessions[0]!,
    id: 'session-unread-1' as SessionId,
    title: 'Review changes',
    // Answered after the user last looked at it — the unread case.
    lastMessageAt: UNREAD_NOW,
    lastReadAt: UNREAD_NOW - 120_000,
  },
  {
    ...childSessions[0]!,
    id: 'session-unread-2' as SessionId,
    title: 'Trace message dispatch',
    // Never opened, and it has produced output.
    lastMessageAt: UNREAD_NOW - 30_000,
  },
  {
    ...childSessions[0]!,
    id: 'session-unread-3' as SessionId,
    title: 'Run the integration tests',
    // Still working: the spinner outranks unread.
    lastMessageAt: UNREAD_NOW - 5_000,
  },
  {
    ...childSessions[0]!,
    id: 'session-unread-4' as SessionId,
    title: 'Write the migration notes',
    // Blocked on a permission request: outranks everything.
    lastMessageAt: UNREAD_NOW - 9_000,
  },
  {
    ...childSessions[0]!,
    id: 'session-unread-5' as SessionId,
    title: 'Update the changelog',
    // Caught up — plain agent icon.
    lastMessageAt: UNREAD_NOW - 600_000,
    lastReadAt: UNREAD_NOW - 60_000,
  },
];

const unreadPresence: StoryPresence = {
  'session-unread-3': 'running',
  'session-unread-4': 'requestPermission',
};

const manyChildSessions: SessionMeta[] = [
  'Review the protocol design',
  'Trace message dispatch',
  'Check desktop onboarding',
  'Run the integration tests',
  'Inspect the sidebar state',
  'Write the migration notes',
  'Verify the final patch',
].map((title, index) => ({
  ...childSessions[index % childSessions.length]!,
  id: `session-many-${index + 1}` as SessionId,
  createdAt: `2026-04-02T00:${String(10 + index).padStart(2, '0')}:00.000Z`,
  title,
}));

type StoryShellProps = React.ComponentProps<typeof SessionTabBar> & {
  frameWidth?: number;
  reservedRightWidth?: number;
  presence?: StoryPresence;
};

function StoryShell({
  frameWidth,
  reservedRightWidth = 0,
  presence = DEFAULT_STORY_PRESENCE,
  ...props
}: StoryShellProps) {
  const [store] = useState(() => {
    const nextStore = createStore();
    nextStore.set(lodyPresenceStatesAtom, buildPresenceStates(presence));
    return nextStore;
  });
  const [activeTabSessionId, setActiveTabSessionId] = useState(props.activeTabSessionId);
  const [activeViewerTabId, setActiveViewerTabId] = useState(props.activeViewerTabId);

  useEffect(() => {
    setActiveTabSessionId(props.activeTabSessionId);
  }, [props.activeTabSessionId]);
  useEffect(() => {
    setActiveViewerTabId(props.activeViewerTabId);
  }, [props.activeViewerTabId]);

  const reservedRightSlot =
    reservedRightWidth > 0 ? (
      <div aria-hidden="true" style={{ width: reservedRightWidth, flex: '0 0 auto' }} />
    ) : null;

  return (
    <Provider store={store}>
      <div
        className="max-w-full overflow-hidden bg-background"
        style={{ width: frameWidth ?? '100%' }}
        data-testid="session-tab-bar-story-frame"
      >
        <SessionTabBar
          {...props}
          activeTabSessionId={activeTabSessionId}
          activeViewerTabId={activeViewerTabId}
          onTabSelect={(tabId) => {
            setActiveViewerTabId(null);
            setActiveTabSessionId(tabId);
            void props.onTabSelect(tabId);
          }}
          onViewerTabSelect={(tabId) => {
            setActiveViewerTabId(tabId);
            void props.onViewerTabSelect?.(tabId);
          }}
          rightSlot={
            props.rightSlot || reservedRightSlot ? (
              <>
                {props.rightSlot}
                {reservedRightSlot}
              </>
            ) : undefined
          }
        />
      </div>
    </Provider>
  );
}

const meta = {
  title: 'Sessions/SessionTabBar',
  component: StoryShell,
  parameters: {
    layout: 'padded',
  },
  argTypes: {
    frameWidth: {
      control: { type: 'range', min: 280, max: 1440, step: 20 },
      description: 'Width of the review frame around the real SessionTabBar.',
    },
    reservedRightWidth: {
      control: { type: 'range', min: 0, max: 320, step: 20 },
      description: 'Space reserved for the production right-side toolbar.',
    },
  },
  tags: ['autodocs'],
  args: {
    variant: 'session',
    parentSession,
    childSessions,
    draftTabs,
    archivedChildSessions,
    activeTabSessionId: parentSession.id,
    onTabSelect: fn(),
    onNewTab: fn(),
    onTabRename: fn(),
    onTabClose: fn(),
    onTabRestore: fn(),
    onTabReorder: fn(),
    tabOrder: [childSessions[1]!.id, childSessions[0]!.id, draftTabs[0]!.id],
    viewerTabs: [],
    activeViewerTabId: null,
    onViewerTabSelect: fn(),
    onViewerTabClose: fn(),
    frameWidth: 960,
    reservedRightWidth: 0,
  },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const ParentActive: Story = {};

export const ChildActive: Story = {
  args: {
    activeTabSessionId: childSessions[0]!.id,
  },
};

export const ScreenshotRegression: Story = {
  args: {
    parentSession: screenshotParentSession,
    childSessions: screenshotChildSessions,
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: screenshotChildSessions.map((session) => session.id),
    activeTabSessionId: screenshotChildSessions[0]!.id,
    frameWidth: 1400,
    reservedRightWidth: 160,
  },
  parameters: {
    docs: {
      description: {
        story: 'Reproduces the three long-title pills from the reported desktop overflow.',
      },
    },
  },
};

export const ConversationPrivateAccessMenuOpen: Story = {
  name: 'Conversation private access — menu open',
  args: {
    parentSession: screenshotParentSession,
    childSessions: screenshotChildSessions,
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: screenshotChildSessions.map((session) => session.id),
    activeTabSessionId: screenshotChildSessions[0]!.id,
    frameWidth: 1400,
    rightSlot: <ConversationToolbar />,
  },
  globals: { theme: 'light' },
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: /Private to you/ }));
  },
};

export const EqualAtMinimumThreshold: Story = {
  args: {
    parentSession: screenshotParentSession,
    childSessions: screenshotChildSessions,
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: screenshotChildSessions.map((session) => session.id),
    activeTabSessionId: screenshotChildSessions[0]!.id,
    frameWidth: 592,
  },
  parameters: {
    docs: {
      description: {
        story: 'Each of the three pills receives exactly the 180px minimum width.',
      },
    },
  },
};

export const ThreeTabsNarrow: Story = {
  args: {
    parentSession: screenshotParentSession,
    childSessions: screenshotChildSessions,
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: screenshotChildSessions.map((session) => session.id),
    activeTabSessionId: screenshotChildSessions[1]!.id,
    frameWidth: 520,
  },
};

export const MinimumPanelWidth: Story = {
  args: {
    parentSession: screenshotParentSession,
    childSessions: screenshotChildSessions,
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: screenshotChildSessions.map((session) => session.id),
    activeTabSessionId: screenshotChildSessions[0]!.id,
    frameWidth: 280,
  },
  parameters: {
    docs: {
      description: {
        story: 'Exercises compressed mode at the desktop chat panel minimum width.',
      },
    },
  },
};

export const ManyTabsWide: Story = {
  args: {
    childSessions: manyChildSessions,
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: manyChildSessions.map((session) => session.id),
    activeTabSessionId: manyChildSessions[3]!.id,
    frameWidth: 1200,
  },
};

export const ManyTabsNarrow: Story = {
  args: {
    childSessions: manyChildSessions,
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: manyChildSessions.map((session) => session.id),
    activeTabSessionId: manyChildSessions[3]!.id,
    frameWidth: 480,
  },
};

export const ToolbarAndHistoryPressure: Story = {
  args: {
    parentSession: screenshotParentSession,
    childSessions: screenshotChildSessions,
    draftTabs,
    archivedChildSessions,
    tabOrder: [...screenshotChildSessions.map((session) => session.id), draftTabs[0]!.id],
    activeTabSessionId: screenshotChildSessions[0]!.id,
    frameWidth: 760,
    reservedRightWidth: 220,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Reserves space for the production toolbar while the new-tab and history buttons remain pinned.',
      },
    },
  },
};

export const ViewerActive: Story = {
  args: {
    variant: 'viewer',
    childSessions: [],
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: [viewerTabs[1]!.id, viewerTabs[0]!.id],
    viewerTabs,
    activeViewerTabId: viewerTabs[0]!.id,
  },
};

export const MixedSessionAndViewerTabs: Story = {
  args: {
    variant: 'mixed',
    tabOrder: [childSessions[1]!.id, childSessions[0]!.id, draftTabs[0]!.id, viewerTabs[0]!.id],
    viewerTabs,
  },
};

/* Lone parent tab — fills the row with NO pill tint (solo mode). */
export const SingleTab: Story = {
  args: {
    childSessions: [],
    draftTabs: [],
    tabOrder: [],
  },
};

export const ViewerGroupOnly: Story = {
  args: {
    variant: 'viewer',
    childSessions: [],
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: [viewerTabs[1]!.id, viewerTabs[0]!.id],
    activeViewerTabId: viewerTabs[1]!.id,
  },
};

export const UnreadChildTabs: Story = {
  name: 'Unread sub-session tabs',
  args: {
    parentSession: screenshotParentSession,
    childSessions: unreadChildSessions,
    draftTabs: [],
    archivedChildSessions: [],
    tabOrder: unreadChildSessions.map((session) => session.id),
    activeTabSessionId: screenshotParentSession.id,
    presence: unreadPresence,
    frameWidth: 1200,
  },
  parameters: {
    docs: {
      description: {
        story:
          'The tab bar status slot across its whole ladder, left to right: the ACTIVE parent ' +
          '(never marked — it is the surface clearing unread), an unread child, a never-read ' +
          'child, a working child (spinner outranks unread), a child blocked on a permission ' +
          'request (outranks everything), and a caught-up child (plain agent icon).',
      },
    },
  },
};
