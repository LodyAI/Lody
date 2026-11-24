import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useMemo, useState, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ArrowUp, MessageSquare } from 'lucide-react';
import { fn } from 'storybook/test';
import { Button } from '@lody/ui/button';
import { space } from '@lody/ui/tokens/scales.stylex';

import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import {
  getLodySessionPresenceKey,
  getServerNow,
  type AgentConfigId,
  type LodyPresenceInstanceId,
  type MachineId,
  type SessionId,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';

import { lodyPresenceStatesAtom } from '@/atoms/presence';
import { conversationSurface } from '@/components/ai-gui/surface';
import { ChatComposer } from '@/components/chat/chat-composer';
import {
  closeConversationPane,
  createConversationSplit,
  focusConversationPane,
  openInConversationPane,
  splitConversationRight,
  type ConversationSplitState,
} from '@/components/sessions/conversation-split';
import { SessionTabBar } from '@/components/sessions/session-tab-bar';
import {
  SplitConversationLayout,
  SplitPaneActions,
  SplitPaneEmptyState,
  type SplitConversationPaneView,
} from '@/components/sessions/split-conversation-layout';
import { ConversationColumn } from '@/components/shared/conversation-column';
import type { DraftSessionTab } from '@/lib/session-draft-tabs';

const STORY_WORKSPACE_ID = 'workspace-storybook-split' as WorkspaceId;
const storyPlatform = createLocalPlatformProvider({
  session: createStaticStore({
    status: 'authenticated',
    user: { id: 'local:storybook-user', name: 'Storybook user' },
  }),
  workspaces: createStaticStore({
    status: 'ready',
    workspaces: [
      { id: STORY_WORKSPACE_ID, name: 'Storybook Workspace', slug: 'storybook', role: 'owner' },
    ],
    activeWorkspaceId: STORY_WORKSPACE_ID,
  }),
});

const machineId = 'machine-1' as MachineId;
const agentConfigId = 'agent-1' as AgentConfigId;

function session(id: string, title: string, extra: Partial<SessionMeta> = {}): SessionMeta {
  return {
    id: id as SessionId,
    machineId,
    createdAt: '2026-11-09T08:00:00.000Z',
    title,
    userId: 'user-1',
    status: { type: 'idle' },
    cliType: 'builtin',
    agentType: 'codex',
    ...extra,
  };
}

type Turn = { role: 'user' | 'agent'; text: string };

/** A root session, its child tabs, and a short synthetic transcript per tab. */
type StoryConversation = {
  root: SessionMeta;
  children: SessionMeta[];
  detail: string;
  transcripts: Record<string, Turn[]>;
};

const CONVERSATIONS: StoryConversation[] = [
  {
    root: session('s-ninja', 'Simulate the beat-drop camera kicks'),
    children: [session('s-ninja-render', 'Render the 30s preview')],
    detail: 'ninja-video · t3/ninja-fix',
    transcripts: {
      's-ninja': [
        {
          role: 'user',
          text: 'The first beat drop needs a longer build-up — it should start well before 0:37.',
        },
        {
          role: 'agent',
          text: 'The new build ramp runs for 30 seconds, so short builds barely rise. I gave it a steeper ramp that starts at a third and reaches full strength quickly, with the CDs, static and camera kicks showing from about 0:37 and the word spam from 0:38.6.',
        },
      ],
      's-ninja-render': [
        { role: 'user', text: 'Render the 30 seconds around the drop.' },
        { role: 'agent', text: 'Rendering frames 1080–1980 at preview quality.' },
      ],
    },
  },
  {
    root: session('s-diorama', 'Diorama meta thread'),
    children: [
      session('s-diorama-map', 'Shared map: server half'),
      session('s-diorama-web', 'Web map: vanilla colour table'),
    ],
    detail: 'diorama · master',
    transcripts: {
      's-diorama': [
        { role: 'user', text: 'What is left before the shared map ships?' },
        {
          role: 'agent',
          text: 'Two threads are building it in parallel: the in-game half (Diorama loads on dedicated servers for all 23 builds) and the web map (a vanilla colour table built into the jar). Each will merge its PR into master once it is tested in game.',
        },
      ],
      's-diorama-map': [{ role: 'agent', text: 'Shared land is saved on each player’s disk.' }],
      's-diorama-web': [{ role: 'agent', text: 'The web map draws on its own thread.' }],
    },
  },
  {
    root: session('s-icarus', 'Icarus novel flutter and Convex patterns'),
    children: [session('s-icarus-ci', 'ci.yml')],
    detail: 'icarus · t3/decoders',
    transcripts: {
      's-icarus': [
        {
          role: 'agent',
          text: 'I merged both fixes to the desktop app’s Convex Rust client: a reconnect no longer runs a picture upload’s server step twice, and a refused sign-in stops reconnecting after the first attempt.',
        },
        { role: 'user', text: 'Ship it with the next desktop release.' },
      ],
      's-icarus-ci': [{ role: 'agent', text: 'CI now runs the decoder suite on every PR.' }],
    },
  },
  {
    root: session('s-linux', 'Set up Linux on the Intel MacBook'),
    children: [],
    detail: 'No project · Dara’s MacBook Pro',
    transcripts: { 's-linux': [{ role: 'agent', text: 'Fedora 41 boots with the T2 kernel.' }] },
  },
];

const presence: Record<string, 'running' | 'requestPermission'> = {
  's-diorama': 'running',
  's-icarus': 'requestPermission',
  's-ninja-render': 'running',
};

function createPresenceStore() {
  const store = createStore();
  store.set(
    lodyPresenceStatesAtom,
    Object.fromEntries(
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
    )
  );
  return store;
}

const story = stylex.create({
  frame: {
    display: 'flex',
    height: '100vh',
    flexDirection: 'column',
    backgroundColor: 'hsl(var(--sidebar))',
    padding: space[1],
  },
  card: {
    display: 'flex',
    flex: 1,
    minHeight: 0,
    overflow: 'hidden',
    borderRadius: '12px',
    backgroundColor: 'hsl(var(--background))',
    boxShadow: '0 0 0 0.5px hsl(var(--border))',
  },
  stream: {
    flex: 1,
    minHeight: 0,
    overflowY: 'auto',
    paddingTop: space[6],
    paddingBottom: space[4],
  },
  turns: { display: 'flex', flexDirection: 'column', gap: space[6] },
  agentText: { margin: 0 },
  composer: { flexShrink: 0, paddingBottom: space[3] },
});

/** One column's tab state: the same tab mechanism as a whole session page, kept per column. */
type ColumnTabs = {
  activeTabId: string;
  children: SessionMeta[];
  drafts: DraftSessionTab[];
  order?: string[];
};

function initialTabs(conversation: StoryConversation): ColumnTabs {
  return { activeTabId: conversation.root.id, children: conversation.children, drafts: [] };
}

function ColumnTabBar({
  conversation,
  tabs,
  onChange,
  actions,
}: {
  conversation: StoryConversation;
  tabs: ColumnTabs;
  onChange: (update: (current: ColumnTabs) => ColumnTabs) => void;
  actions: ReactNode;
}) {
  return (
    <SessionTabBar
      parentSession={conversation.root}
      childSessions={tabs.children}
      draftTabs={tabs.drafts}
      archivedChildSessions={[]}
      activeTabSessionId={tabs.activeTabId}
      tabOrder={tabs.order}
      onTabSelect={(tabId) => onChange((current) => ({ ...current, activeTabId: tabId }))}
      onTabReorder={(order) => onChange((current) => ({ ...current, order }))}
      onTabClose={(tabId) =>
        onChange((current) => ({
          ...current,
          children: current.children.filter((child) => child.id !== tabId),
          drafts: current.drafts.filter((item) => item.id !== tabId),
          activeTabId: tabId === current.activeTabId ? conversation.root.id : current.activeTabId,
        }))
      }
      onNewTab={() =>
        onChange((current) => {
          const id = `draft:${conversation.root.id}-${current.drafts.length + 1}`;
          return {
            ...current,
            activeTabId: id,
            drafts: [
              ...current.drafts,
              {
                id: id as DraftSessionTab['id'],
                sessionId: id as SessionId,
                prompt: '',
                cliType: 'builtin',
                agentType: 'codex',
                agentConfigId,
                modeId: null,
                modelId: null,
              },
            ],
          };
        })
      }
      rightSlot={actions}
    />
  );
}

/** The column's conversation and its own composer. */
function ColumnBody({ turns }: { turns: readonly Turn[] }) {
  const [draft, setDraft] = useState('');
  return (
    <>
      <div {...stylex.props(story.stream)}>
        <ConversationColumn>
          <div {...stylex.props(story.turns)}>
            {turns.map((turn, index) =>
              turn.role === 'user' ? (
                <div key={index} {...stylex.props(conversationSurface.userRow)}>
                  <div {...stylex.props(conversationSurface.userStack)}>
                    <div {...stylex.props(conversationSurface.bubble)}>{turn.text}</div>
                  </div>
                </div>
              ) : (
                <p key={index} {...stylex.props(story.agentText)}>
                  {turn.text}
                </p>
              )
            )}
          </div>
        </ConversationColumn>
      </div>
      <div {...stylex.props(story.composer)}>
        <ConversationColumn>
          <ChatComposer
            variant="session"
            tone="dark"
            promptValue={draft}
            onPromptChange={setDraft}
            promptPlaceholder="Ask anything…"
            autoResize
            primaryAction={
              <Button
                variant="primary"
                size="small"
                shape="pill"
                icon
                aria-label="Send"
                disabled={!draft.trim()}
                onClick={() => setDraft('')}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
            }
          />
        </ConversationColumn>
      </div>
    </>
  );
}

function SplitDemo({ initial }: { initial: ConversationSplitState }) {
  const [store] = useState(createPresenceStore);
  const [split, setSplit] = useState(initial);
  const [extra, setExtra] = useState<StoryConversation[]>([]);
  const [tabsBySession, setTabsBySession] = useState<Record<string, ColumnTabs>>({});
  const catalog = useMemo(() => [...CONVERSATIONS, ...extra], [extra]);
  const byId = (id: string | null) => catalog.find((item) => item.root.id === id) ?? null;
  const shown = new Set(split.panes.map((pane) => pane.sessionId));

  const panes: SplitConversationPaneView[] = split.panes.map((pane) => {
    const conversation = byId(pane.sessionId);
    const actions = (context: { canSplit: boolean; canClose: boolean }) => (
      <SplitPaneActions
        canSplit={context.canSplit}
        canClose={context.canClose}
        onSplit={() => setSplit((current) => splitConversationRight(current, pane.id))}
        onClose={() => setSplit((current) => closeConversationPane(current, pane.id))}
      />
    );
    if (!conversation) {
      return {
        id: pane.id,
        // An empty column still has its row, so the band of tab rows stays unbroken.
        topBar: (context) => (
          <div className="flex h-12 items-center justify-end border-b border-border pr-1">
            {actions(context)}
          </div>
        ),
        body: (
          <SplitPaneEmptyState
            recent={catalog.map((item) => ({
              id: item.root.id,
              title: item.root.title ?? '',
              detail: item.detail,
              icon: <MessageSquare className="h-3.5 w-3.5" strokeWidth={2} />,
              open: shown.has(item.root.id),
            }))}
            onOpen={(sessionId) =>
              setSplit((current) => openInConversationPane(current, pane.id, sessionId))
            }
            onNewChat={() => {
              const id = `s-new-${catalog.length}`;
              setExtra((current) => [
                ...current,
                {
                  root: session(id, 'New chat'),
                  children: [],
                  detail: 'No project',
                  transcripts: {},
                },
              ]);
              setSplit((current) => openInConversationPane(current, pane.id, id));
            }}
          />
        ),
      };
    }
    const sessionId = conversation.root.id;
    const tabs = tabsBySession[sessionId] ?? initialTabs(conversation);
    const update = (change: (current: ColumnTabs) => ColumnTabs) =>
      setTabsBySession((current) => ({
        ...current,
        [sessionId]: change(current[sessionId] ?? initialTabs(conversation)),
      }));
    return {
      id: pane.id,
      topBar: (context) => (
        <ColumnTabBar
          conversation={conversation}
          tabs={tabs}
          onChange={update}
          actions={actions(context)}
        />
      ),
      body: (
        <ColumnBody
          key={`${sessionId}:${tabs.activeTabId}`}
          turns={conversation.transcripts[tabs.activeTabId] ?? []}
        />
      ),
    };
  });

  return (
    <Provider store={store}>
      <div {...stylex.props(story.frame)}>
        <div {...stylex.props(story.card)}>
          <SplitConversationLayout
            panes={panes}
            focusedPaneId={split.focusedPaneId}
            onFocusPane={(paneId) => setSplit((current) => focusConversationPane(current, paneId))}
          />
        </div>
      </div>
    </Provider>
  );
}

function initialSplit(...sessionIds: (string | null)[]): ConversationSplitState {
  let state = createConversationSplit(sessionIds[0] ?? null);
  for (const sessionId of sessionIds.slice(1)) {
    state = splitConversationRight(state, state.focusedPaneId);
    if (sessionId) state = openInConversationPane(state, state.focusedPaneId, sessionId);
  }
  return focusConversationPane(state, state.panes[0]!.id);
}

const meta = {
  title: 'Sessions/SplitConversation',
  component: SplitConversationLayout,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <PlatformContext.Provider value={storyPlatform}>
        <Story />
      </PlatformContext.Provider>
    ),
  ],
  args: { panes: [], focusedPaneId: 'pane-1', onFocusPane: fn() },
} satisfies Meta<typeof SplitConversationLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/**
 * Three conversations side by side, each with its own tabs: select, add and close tabs in one
 * column and the others keep theirs. Click into a column to focus it; the other tab rows recede.
 * Drag a seam to resize.
 */
export const ThreeColumns: Story = {
  render: () => <SplitDemo initial={initialSplit('s-ninja', 's-diorama', 's-icarus')} />,
};

export const ThreeColumnsLight: Story = {
  globals: { theme: 'light' },
  render: () => <SplitDemo initial={initialSplit('s-ninja', 's-diorama', 's-icarus')} />,
};

/** Two columns: "Split right" in either tab row opens a third. */
export const TwoColumns: Story = {
  render: () => <SplitDemo initial={initialSplit('s-diorama', 's-icarus')} />,
};

/**
 * Just split: the new column waits for a choice. Conversations already open in another column
 * say so, and choosing one focuses that column instead of opening it twice.
 */
export const JustSplit: Story = {
  render: () => <SplitDemo initial={initialSplit('s-diorama', null)} />,
};

/** One column, as today: "Split right" is the only new control. */
export const Single: Story = {
  render: () => <SplitDemo initial={initialSplit('s-diorama')} />,
};
