/**
 * Project mode prototype (Developer mode): the sidebar's Projects view, and a
 * project page with its coordinator conversation beside every conversation of
 * the project. The board is built by the product's `buildProjectBoard` from
 * synthetic session metadata, so its grouping is the real one.
 */
import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button } from '@lody/ui/button';
import type { MachineId, SessionId, SessionMeta, SessionStatus } from '@lody/shared';
import {
  MessageRowView,
  SessionChatStreamView,
  type ChatStreamItem,
} from '@/components/ai-gui/view';
import { ChatComposer } from '@/components/chat/chat-composer';
import {
  SessionConversationPage,
  SessionConversationPageBody,
  SessionConversationPageHeader,
} from '@/components/sessions/session-conversation-page';
import { buildChildSessionsByParent } from '@/components/sessions/session-list-rows';
import { ProjectBoardView } from '@/components/project-mode/project-board';
import {
  buildProjectBoard,
  coordinatorProjectKeyId,
  type CoordinatorProjectKey,
} from '@/components/project-mode/project-board-model';
import { ProjectWorkspace } from '@/components/project-mode/project-workspace';
import {
  CoordinatorConversationPreviewProvider,
  CoordinatorTodoCard,
} from '@/components/project-mode/coordinator-conversation';
import { ConversationColumn } from '@/components/shared/conversation-column';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import {
  SessionSidePanelTabBar,
  type SessionSidePanelTabItem,
} from '@/components/sessions/session-side-panel-tab-bar';
import {
  SidebarProjectList,
  SidebarProjectViewSwitch,
  type SidebarProjectListItem,
} from '@/components/project-mode/sidebar-project-list';
import type { SidebarProjectView } from '@/atoms/sidebar-state';
import { Default as SidebarDefault, WorkspaceSidebarHarness } from './LoroSidebar.stories';
import { SettingsStoryProviders } from './settings-story-shell';

const machineId = 'machine-story' as MachineId;
const project: CoordinatorProjectKey = { kind: 'local', machineId, localProjectId: 'lody' };
const coordinatorId = 'coordinator-story' as SessionId;
const NOW = Date.UTC(2026, 10, 12, 9, 0, 0);
const minutesAgo = (minutes: number) => NOW - minutes * 60_000;

const session = (id: string, title: string, overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id,
    title,
    machineId,
    userId: 'user-story',
    createdAt: new Date(minutesAgo(600)).toISOString(),
    cliType: 'builtin',
    agentType: 'claude',
    project: { kind: 'local', localProjectId: 'lody' },
    openedBySessionId: coordinatorId,
    ...overrides,
  }) as SessionMeta;

const sessions: SessionMeta[] = [
  session(coordinatorId, '项目协调者', {
    coordinator: { version: 1 },
    openedBySessionId: undefined,
  }),
  session('asks', '迁移 E2EE 会话分享：要不要保留旧链接？', {
    createdAt: new Date(minutesAgo(120)).toISOString(),
    awaitingUserSince: minutesAgo(4),
    lastMessageAt: minutesAgo(4),
  }),
  session('permission', '修复 Android 提及列表的排序', {
    createdAt: new Date(minutesAgo(110)).toISOString(),
    lastMessageAt: minutesAgo(9),
  }),
  session('running', '给 Roost 历史分页加回归测试', {
    createdAt: new Date(minutesAgo(100)).toISOString(),
    lastMessageAt: minutesAgo(2),
  }),
  session('unread-pr', '侧边栏折叠动画卡顿（PR #2631）', {
    createdAt: new Date(minutesAgo(90)).toISOString(),
    lastMessageAt: minutesAgo(15),
    lastReadAt: minutesAgo(40),
  }),
  session('done-1', '整理协调者提示词的中英文版本', {
    // Accepted after its last reply, so it sits under Accepted.
    coordinatorTaskAcceptedAt: minutesAgo(55),
    createdAt: new Date(minutesAgo(80)).toISOString(),
    lastMessageAt: minutesAgo(70),
    lastReadAt: minutesAgo(60),
  }),
  session('manual', '手动排查 daemon 内存占用', {
    openedBySessionId: undefined,
    lastMessageAt: minutesAgo(130),
    lastReadAt: minutesAgo(120),
  }),
];

const liveStatuses = new Map<string, SessionStatus>([
  ['permission', { type: 'requestPermission' }],
  ['running', { type: 'running' }],
]);

const board = buildProjectBoard({
  sessions,
  childSessionsByParent: buildChildSessionsByParent(sessions),
  project,
  coordinatorSessionId: coordinatorId,
  currentUserId: 'user-story',
  liveSessionStatuses: liveStatuses,
  sendStates: {},
});

const sidebarProjects: SidebarProjectListItem[] = [
  {
    id: coordinatorProjectKeyId(project),
    kind: 'local',
    name: 'lody',
    detail: 'MacBook Pro',
    activity: { failed: 0, waiting: 2, working: 1, sending: 0, unread: 1 },
  },
  {
    id: 'github:loro-dev/loro',
    kind: 'github',
    name: 'loro-dev/loro',
    detail: null,
    activity: { failed: 0, waiting: 0, working: 1, sending: 0, unread: 0 },
  },
  {
    id: 'local:machine-story:website',
    kind: 'local',
    name: 'website',
    detail: 'Ubuntu',
    activity: null,
  },
];

const turns: { role: 'user' | 'assistant'; text: string }[] = [
  {
    role: 'user',
    text: '把 E2EE 会话分享迁移到新协议，顺便修一下 Android 提及列表的排序，再给 Roost 分页补测试。',
  },
  {
    role: 'assistant',
    text: '已开 3 个对话：\n\n1. **迁移 E2EE 会话分享**（天才程序员）\n2. **修复 Android 提及列表排序**（Android 专家）\n3. **Roost 历史分页回归测试**（Codex）\n\n结果会自动回到这里。',
  },
  {
    role: 'assistant',
    text: '**需要你决定**：迁移 E2EE 会话分享那边问——旧的分享链接要继续有效，还是迁移后一律失效？\n\n**已完成**：侧边栏折叠动画卡顿已修好，PR #2631 等你看。',
  },
];

const turnItem = (
  id: string,
  role: 'user' | 'assistant' | 'system',
  minutes: number,
  items: unknown[]
): ChatStreamItem =>
  ({
    turnIndex: 0,
    type: 'message',
    sessionId: coordinatorId,
    message: {
      id,
      role,
      timestamp: new Date(minutesAgo(minutes)).toISOString(),
      read: true,
      finished: true,
      modelInfo: role === 'assistant' ? { modelId: 'sonnet-5.5', name: 'Sonnet 5.5' } : undefined,
      items,
    },
  }) as ChatStreamItem;

const target = (sessionId: string) => ({ sessionId, userTurnId: `${sessionId}-turn-1` });

/** The rows a real coordinator conversation carries: creation progress and a result batch. */
const streamItems: ChatStreamItem[] = [
  turnItem('turn-0', 'user', 30, [{ type: 'text', text: turns[0]!.text }]),
  turnItem('turn-1', 'assistant', 29, [
    // Hidden in the coordinator's bubble: only the text output shows.
    { type: 'thought', text: '三件事互不依赖，可以并行开三个对话。' },
    {
      type: 'tool_call',
      toolCallId: 'call-create',
      title: 'lody_session_create_many',
      kind: 'other',
      status: 'completed',
    },
    { type: 'text', text: turns[1]!.text },
  ]),
  turnItem('turn-created', 'system', 28, [
    {
      type: 'operation_progress',
      operationId: 'op-create',
      operationKind: 'session_create_many',
      items: [
        { target: target('asks'), label: '迁移 E2EE 会话分享', status: 'running' },
        { target: target('permission'), label: '修复 Android 提及列表排序', status: 'running' },
        { target: target('running'), label: 'Roost 历史分页回归测试', status: 'running' },
      ],
    },
  ]),
  turnItem('turn-results', 'system', 12, [
    {
      type: 'operation_completion_batch',
      batchId: 'batch-1',
      memberCount: 2,
      deliveryStatus: 'settled',
      members: [
        {
          type: 'operation_completion',
          deliveryId: 'delivery-1',
          operationId: 'op-chat-1',
          operationKind: 'session_chat',
          completion: {
            type: 'result',
            value: {
              items: [
                {
                  status: 'succeeded',
                  target: target('asks'),
                  label: '迁移 E2EE 会话分享',
                  output: { text: '需要你决定：旧的分享链接要继续有效，还是迁移后一律失效？' },
                },
                {
                  status: 'succeeded',
                  target: target('unread-pr'),
                  label: '侧边栏折叠动画卡顿',
                  output: { text: '已修好，PR #2631。' },
                },
              ],
            },
          },
        },
      ],
    },
  ]),
  turnItem('turn-2', 'assistant', 10, [{ type: 'text', text: turns[2]!.text }]),
].map((item, turnIndex) => ({ ...item, turnIndex }));

function ConversationPage({
  sessionId,
  title,
  items,
  placeholder,
  trailingContent,
}: {
  sessionId: SessionId;
  title: string;
  items: ChatStreamItem[];
  placeholder: string;
  trailingContent?: ReactNode;
}) {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');
  return (
    <SessionConversationPage
      className="h-full"
      headerSlot={<SessionConversationPageHeader titleSlot={title} />}
      bodySlot={
        <SessionConversationPageBody
          streamSlot={
            <SessionChatStreamView
              sessionId={sessionId}
              items={items}
              trailingContent={trailingContent}
              className="h-full"
              renderMessageRow={({ message, sessionId: id }) => (
                <MessageRowView message={message} sessionId={id} />
              )}
            />
          }
          composerSlot={
            <ChatComposer
              tone="light"
              variant="session"
              promptRef={promptRef}
              promptValue={prompt}
              onPromptChange={setPrompt}
              promptPlaceholder={placeholder}
              primaryAction={
                <Button icon aria-label="Send">
                  <ArrowUp size={16} />
                </Button>
              }
              autoResize
              maxRows={11}
            />
          }
        />
      }
    />
  );
}

const childId = 'asks' as SessionId;
const childItems: ChatStreamItem[] = [
  {
    role: 'user' as const,
    text: '把 E2EE 会话分享迁移到新协议。完成后发回结果和 PR 链接。',
  },
  {
    role: 'assistant' as const,
    text: '迁移需要先确定一件事：**旧的分享链接要继续有效，还是迁移后一律失效？** 两种做法都已准备好，等你决定。',
  },
].map((turn, turnIndex) => ({
  turnIndex,
  type: 'message',
  sessionId: childId,
  message: {
    id: `child-turn-${turnIndex}`,
    role: turn.role,
    timestamp: new Date(minutesAgo(10 - turnIndex)).toISOString(),
    read: true,
    finished: true,
    items: [{ type: 'text', text: turn.text }],
  },
}));

const coordinatorTasks = new Map(
  Object.values(board)
    .flat()
    .map((row) => [row.session.id, row] as const)
);

const BOARD_TAB = 'project-board';
const CHILD_TAB = `side-session:${childId}`;

/**
 * The coordinator's page as SessionDetail composes it: the conversation on the
 * left and the session's own right panel, whose resident first tab is the board.
 * A board row opens that conversation as another panel tab.
 */
function CoordinatorPage() {
  const [openedChild, setOpenedChild] = useState(true);
  const [activeTab, setActiveTab] = useState(BOARD_TAB);
  const tabs: SessionSidePanelTabItem[] = [
    { id: BOARD_TAB, label: '全部子对话', kind: 'board', closeable: false },
    ...(openedChild
      ? [
          {
            id: CHILD_TAB,
            label: '迁移 E2EE 会话分享：要不要保留旧链接？',
            kind: 'session' as const,
            closeable: true,
          },
        ]
      : []),
  ];
  return (
    <DesktopSessionDetailLayout
      defaultSizes={{ main: 58, sidebar: 42 }}
      topBar={null}
      chatSurfaces={
        <CoordinatorConversationPreviewProvider
          value={{
            tasks: coordinatorTasks,
            todo: [...board.needsYou, ...board.review],
            openTask: () => {
              setOpenedChild(true);
              setActiveTab(CHILD_TAB);
            },
            acceptTasks: () => {},
          }}
        >
          <ConversationPage
            sessionId={coordinatorId}
            title="项目协调者 · lody"
            items={streamItems}
            placeholder="告诉协调者你想做什么"
            trailingContent={
              <ConversationColumn>
                <CoordinatorTodoCard />
              </ConversationColumn>
            }
          />
        </CoordinatorConversationPreviewProvider>
      }
      terminalDock={null}
      secondaryPanel={
        <div className="flex h-full min-h-0 flex-col">
          <SessionSidePanelTabBar
            tabs={tabs}
            activeTabId={activeTab}
            onTabSelect={setActiveTab}
            onTabClose={(tabId) => {
              if (tabId === CHILD_TAB) setOpenedChild(false);
              setActiveTab(BOARD_TAB);
            }}
            closeTabLabel={(label) => `关闭 ${label}`}
          />
          <div className="relative min-h-0 flex-1">
            {activeTab === BOARD_TAB ? (
              <ProjectBoardView
                board={board}
                getSessionHref={(id) => `#${id}`}
                onOpenSession={() => {
                  setOpenedChild(true);
                  setActiveTab(CHILD_TAB);
                }}
                hideTitle
                onAcceptTasks={() => {}}
              />
            ) : (
              <ConversationPage
                sessionId={childId}
                title="迁移 E2EE 会话分享"
                items={childItems}
                placeholder="回复这个对话"
              />
            )}
          </div>
        </div>
      }
      sidebarOpen
      onSidebarCollapse={() => {}}
      deleteConfirmDialog={null}
    />
  );
}

function ProjectModePage({ page = 'coordinator' }: { page?: 'coordinator' | 'start' }) {
  const [view, setView] = useState<SidebarProjectView>('projects');
  const [selectedId, setSelectedId] = useState<string | null>(coordinatorProjectKeyId(project));
  const content = useMemo(
    () =>
      page === 'coordinator' ? (
        <CoordinatorPage />
      ) : (
        <ProjectWorkspace
          main={
            <div className="flex h-full items-center justify-center text-lg">
              开始一个协调者对话
            </div>
          }
          board={
            <ProjectBoardView
              board={board}
              getSessionHref={(id) => `#${id}`}
              onOpenSession={() => {}}
            />
          }
        />
      ),
    [page]
  );
  return (
    <WorkspaceSidebarHarness
      {...SidebarDefault.args!}
      fullApp
      navAccessory={<SidebarProjectViewSwitch value={view} onChange={setView} />}
      listOverride={
        view === 'projects' ? (
          <SidebarProjectList
            items={sidebarProjects}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        ) : undefined
      }
      storyContent={content}
    />
  );
}

const meta = {
  title: 'Project mode/Coordinator page',
  component: ProjectModePage,
  parameters: { layout: 'fullscreen' },
  // The composer's add menu reads cloud queries, which need a platform.
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta<typeof ProjectModePage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LightZhCn: Story = { globals: { theme: 'light', locale: 'zh_CN' } };
export const DarkZhCn: Story = { globals: { theme: 'dark', locale: 'zh_CN' } };
export const LightEn: Story = { globals: { theme: 'light', locale: 'en' } };
/** The start page: the board beside the start form, split by a resizable divider. */
export const StartPageZhCn: Story = {
  args: { page: 'start' },
  globals: { theme: 'light', locale: 'zh_CN' },
};
