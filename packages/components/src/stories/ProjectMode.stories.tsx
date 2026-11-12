/**
 * Project mode prototype (Developer mode): the sidebar's Projects view, and a
 * project page with its coordinator conversation beside every conversation of
 * the project. The board is built by the product's `buildProjectBoard` from
 * synthetic session metadata, so its grouping is the real one.
 */
import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useRef, useState } from 'react';
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
    awaitingUserSince: minutesAgo(4),
    lastMessageAt: minutesAgo(4),
  }),
  session('permission', '修复 Android 提及列表的排序', { lastMessageAt: minutesAgo(9) }),
  session('running', '给 Roost 历史分页加回归测试', { lastMessageAt: minutesAgo(2) }),
  session('unread-pr', '侧边栏折叠动画卡顿（PR #2631）', {
    lastMessageAt: minutesAgo(15),
    lastReadAt: minutesAgo(40),
  }),
  session('done-1', '整理协调者提示词的中英文版本', {
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

const streamItems: ChatStreamItem[] = turns.map((turn, turnIndex) => ({
  turnIndex,
  type: 'message',
  sessionId: coordinatorId,
  message: {
    id: `turn-${turnIndex}`,
    role: turn.role,
    timestamp: new Date(minutesAgo(30 - turnIndex * 10)).toISOString(),
    read: true,
    finished: true,
    modelInfo:
      turn.role === 'assistant' ? { modelId: 'sonnet-5.5', name: 'Sonnet 5.5' } : undefined,
    items: [{ type: 'text', text: turn.text }],
  },
}));

function CoordinatorConversation() {
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const [prompt, setPrompt] = useState('');
  return (
    <SessionConversationPage
      className="h-full"
      headerSlot={<SessionConversationPageHeader titleSlot="项目协调者 · lody" />}
      bodySlot={
        <SessionConversationPageBody
          streamSlot={
            <SessionChatStreamView
              sessionId={coordinatorId}
              items={streamItems}
              className="h-full"
              renderMessageRow={({ message, sessionId }) => (
                <MessageRowView message={message} sessionId={sessionId} />
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
              promptPlaceholder="告诉协调者你想做什么"
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

function ProjectModePage() {
  const [view, setView] = useState<SidebarProjectView>('projects');
  const [selectedId, setSelectedId] = useState<string | null>(coordinatorProjectKeyId(project));
  const content = useMemo(
    () => (
      <ProjectWorkspace
        main={<CoordinatorConversation />}
        board={
          <ProjectBoardView
            board={board}
            getSessionHref={(id) => `#${id}`}
            onOpenSession={() => {}}
          />
        }
      />
    ),
    []
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
