import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn, userEvent, within } from 'storybook/test';

import {
  MobileChatList,
  type MobileChatGroupBy,
  type MobileChatListRowActions,
} from '@/components/mobile/mobile-chat-list';
import type { MobileConversationItem } from '@/components/mobile/mobile-project-screen';
const phoneFrame = stylex.create({
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': '852px' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflowY: 'auto',
    paddingBottom: 'calc(var(--spacing) * 12)',
  },
});

const storyViewport = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    '--story-device-canvas-components': '92.3% 0.003 48.717',
    backgroundColor: 'oklch(var(--story-device-canvas-components))',
    padding: { default: '0px', '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
});

const storyLayout = stylex.create({
  canvas: {
    'padding-inline': 'calc(var(--spacing) * 5)',
    'padding-top': 'calc(var(--spacing) * 6)',
    'padding-bottom': 'calc(var(--spacing) * 1)',
    'font-size': 'var(--text-xl)',
    'line-height': 'var(--text-xl--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
});
import type { MobileStatusCommands } from '@/components/mobile/use-mobile-status-list';
import {
  planStatusViewCommand,
  type PinSection,
  type StatusViewCommand,
  type StatusViewState,
} from '@lody/shared';

const hour = 60 * 60 * 1000;
const now = Date.now();

const baseChats: MobileConversationItem[] = [
  {
    id: 'pr-154',
    title: '重构评估 UI',
    kind: 'github',
    branchName: 'feat/eval-ui-overhaul',
    prNumber: 154,
    prStatus: 'open',
    prUrl: 'https://github.com/loro-dev/lody/pull/154',
    prCiState: 'p',
    addedLines: 156,
    deletedLines: 8,
    latestMessageAt: now - 0.5 * hour,
    ageLabel: '30m',
    isWorking: true,
    machineId: 'zx-macbook',
    projectKey: 'loro-dev/lody',
    projectLabel: 'loro-dev/lody',
  },
  {
    id: 'pr-152',
    title: '合并就绪的会话',
    kind: 'github',
    branchName: 'feat/ready-to-merge',
    prNumber: 152,
    prStatus: 'open',
    prUrl: 'https://github.com/loro-dev/lody/pull/152',
    prCiState: 's',
    prReadiness: 'y',
    addedLines: 88,
    deletedLines: 21,
    latestMessageAt: now - 2 * hour,
    ageLabel: '2h',
    machineId: 'zx-macbook',
    projectKey: 'loro-dev/lody',
    projectLabel: 'loro-dev/lody',
  },
  {
    id: 'pr-149',
    title: 'PR 看板对齐',
    kind: 'github',
    branchName: 'fix/board-alignment',
    prNumber: 149,
    prStatus: 'merged',
    prUrl: 'https://github.com/loro-dev/lody/pull/149',
    prCiState: 's',
    prReadiness: 'y',
    addedLines: 42,
    deletedLines: 10,
    latestMessageAt: now - 5 * hour,
    ageLabel: '5h',
    machineId: 'zx-macbook',
    projectKey: 'loro-dev/lody',
    projectLabel: 'loro-dev/lody',
  },
  {
    id: 'pr-151',
    title: 'WIP 草稿评审',
    kind: 'github',
    branchName: 'feat/draft-review',
    prNumber: 151,
    prStatus: 'draft',
    prUrl: 'https://github.com/loro-dev/lody/pull/151',
    addedLines: 73,
    deletedLines: 4,
    latestMessageAt: now - 12 * hour,
    ageLabel: '12h',
    machineId: 'zx-macbook',
    projectKey: 'loro-dev/lody',
    projectLabel: 'loro-dev/lody',
  },
  {
    id: 'pr-148',
    title: '权限对话框关闭',
    kind: 'github',
    branchName: 'fix/permission-close',
    prNumber: 148,
    prStatus: 'closed',
    prUrl: 'https://github.com/anthropic/claude-code/pull/148',
    prCiState: 'f',
    latestMessageAt: now - 28 * hour,
    ageLabel: '1d',
    machineId: 'zx-macbook',
    projectKey: 'anthropic/claude-code',
    projectLabel: 'anthropic/claude-code',
  },
  {
    id: 'local-1',
    title: '同步进度提示',
    kind: 'local',
    branchName: 'feat/sync-progress',
    latestMessageAt: now - 18 * hour,
    ageLabel: '18h',
    hasUnreadMessages: true,
    machineId: 'lab-m2',
    projectKey: 'lab-m2:experimental-app',
    projectLabel: 'experimental-app',
  },
  {
    id: 'local-2',
    title: '权限审批弹窗',
    kind: 'local',
    branchName: 'fix/permission-modal',
    latestMessageAt: now - 2 * 24 * hour,
    ageLabel: '2d',
    isWaitingPermission: true,
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody-cli',
    projectLabel: 'lody-cli',
  },
  {
    id: 'chat-1',
    title: '随手问 Claude 关于 fzf 配置',
    kind: 'chat',
    latestMessageAt: now - 3 * 24 * hour,
    ageLabel: '3d',
    isOffline: true,
    machineId: 'lab-m2',
  },
  {
    id: 'pinned',
    title: '🌟 旗舰会话(已置顶)',
    kind: 'github',
    branchName: 'main',
    prNumber: 142,
    prStatus: 'open',
    prUrl: 'https://github.com/loro-dev/lody/pull/142',
    prCiState: 'x',
    isPinned: true,
    machineId: 'zx-macbook',
    projectKey: 'loro-dev/lody',
    projectLabel: 'loro-dev/lody',
  },
];

const openedByChats: MobileConversationItem[] = [
  {
    id: 'orchestrator',
    title: '拆分 Streams 分片拓扑排查',
    kind: 'local',
    latestMessageAt: now - 0.2 * hour,
    ageLabel: '12m',
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody',
    projectLabel: 'lody',
  },
  {
    id: 'fanout-1',
    title: '子会话:核对 token-mint 响应',
    kind: 'local',
    latestMessageAt: now - 0.3 * hour,
    ageLabel: '18m',
    isWorking: true,
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody',
    projectLabel: 'lody',
    openedBySessionId: 'orchestrator',
    openedByRowSessionId: 'orchestrator',
  },
  {
    id: 'fanout-2',
    title: '子会话:补 presence 分片回归测试',
    kind: 'local',
    latestMessageAt: now - 0.8 * hour,
    ageLabel: '48m',
    hasUnreadMessages: true,
    addedLines: 64,
    deletedLines: 3,
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody',
    projectLabel: 'lody',
    openedBySessionId: 'orchestrator',
    openedByRowSessionId: 'orchestrator',
  },
  {
    id: 'fanout-3',
    title: '孙会话:写 changelog(挂到最近的可见祖先)',
    kind: 'local',
    latestMessageAt: now - 1.5 * hour,
    ageLabel: '1h',
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody',
    projectLabel: 'lody',
    openedBySessionId: 'fanout-1',
    openedByRowSessionId: 'fanout-1',
  },
  {
    id: 'detached',
    title: '开启者不在本列表 → 保持顶层',
    kind: 'chat',
    latestMessageAt: now - 4 * hour,
    ageLabel: '4h',
    machineId: 'lab-m2',
    openedBySessionId: 'archived-opener',
    openedByRowSessionId: 'archived-opener',
  },
  ...baseChats,
];

const overflowingChats: MobileConversationItem[] = [
  ...Array.from({ length: 12 }, (_, index): MobileConversationItem => ({
    id: `busy-${index}`,
    title: `修复 presence 分片 #${index + 1}`,
    kind: 'local',
    branchName: `fix/presence-shard-${index + 1}`,
    latestMessageAt: now - (index + 1) * 0.4 * hour,
    ageLabel: `${(index + 1) * 24}m`,
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody-main',
    projectLabel: 'lody (main)',
    ...(index === 0 ? { isWorking: true } : {}),
  })),
  {
    id: 'busy-9-opened-a',
    title: '子会话:分片回归测试',
    kind: 'local',
    latestMessageAt: now - 4.2 * hour,
    ageLabel: '4h',
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody-main',
    projectLabel: 'lody (main)',
    openedBySessionId: 'busy-9',
    openedByRowSessionId: 'busy-9',
  },
  {
    id: 'busy-9-opened-b',
    title: '子会话:补 changelog',
    kind: 'local',
    latestMessageAt: now - 4.4 * hour,
    ageLabel: '4h',
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody-main',
    projectLabel: 'lody (main)',
    openedBySessionId: 'busy-9',
    openedByRowSessionId: 'busy-9',
  },
  ...Array.from({ length: 3 }, (_, index): MobileConversationItem => ({
    id: `wt-review-${index}`,
    title: `评审 worktree 里的改动 #${index + 1}`,
    kind: 'local',
    branchName: `review/${index + 1}`,
    latestMessageAt: now - (6 + index) * hour,
    ageLabel: `${6 + index}h`,
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody-review',
    projectLabel: 'lody (review worktree)',
  })),
  {
    id: 'wt-docs-0',
    title: '文档站改版',
    kind: 'local',
    branchName: 'docs/site-refresh',
    latestMessageAt: now - 20 * hour,
    ageLabel: '20h',
    machineId: 'zx-macbook',
    projectKey: 'zx-macbook:lody-docs',
    projectLabel: 'lody (docs worktree)',
  },
];

function StoryShell({
  groupBy,
  rowActions,
  flatHeading,
  archived = false,
  capGroupPreviews = false,
  chats: chatsOverride,
}: {
  groupBy: MobileChatGroupBy;
  rowActions?: MobileChatListRowActions;
  flatHeading?: string;
  archived?: boolean;
  /** Mirrors the workspace home list, which caps each bucket's preview. */
  capGroupPreviews?: boolean;
  /** Story-only dataset override; defaults to the shared mixed list. */
  chats?: MobileConversationItem[];
}) {
  const [chats, setChats] = useState(chatsOverride ?? baseChats);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const actions: MobileChatListRowActions | undefined = rowActions
    ? {
        onTogglePin: (id, nextPinned) => {
          setChats((prev) => prev.map((c) => (c.id === id ? { ...c, isPinned: nextPinned } : c)));
        },
        onArchive: (id) => {
          setChats((prev) => prev.filter((c) => c.id !== id));
        },
        onRestore: (id) => {
          setChats((prev) => prev.filter((c) => c.id !== id));
          fn()(id);
        },
      }
    : undefined;

  return (
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
        <div {...stylex.props(storyLayout.canvas)}>对话</div>
        <MobileChatList
          chats={chats}
          groupBy={groupBy}
          flatHeading={flatHeading}
          archived={archived}
          capGroupPreviews={capGroupPreviews}
          groupLabels={{
            chat: 'Chat',
            local: 'Local',
            github: 'GitHub',
            open: 'Open',
            merged: 'Merged',
            closed: 'Closed',
            'no-pr': 'No PR',
            working: 'Working',
            waiting: 'Waiting permission',
            idle: 'Idle',
            offline: 'Offline',
          }}
          selectedConversationId={selectedId}
          onSelect={(id) => {
            setSelectedId(id);
            fn()(id);
          }}
          rowActions={actions}
          onPermanentDelete={
            archived
              ? (ids) => {
                  setChats((prev) => prev.filter((c) => !ids.includes(c.id)));
                  ids.forEach((id) => fn()(id));
                }
              : undefined
          }
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileChatList',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Flat: Story = {
  args: { groupBy: 'none' },
};

export const GroupByProject: Story = {
  args: { groupBy: 'project' },
};

export const OpenedBySessions: Story = {
  args: { groupBy: 'none', chats: openedByChats },
};

export const OpenedBySessionsActiveOpener: Story = {
  args: {
    groupBy: 'none',
    chats: openedByChats.map((chat) =>
      chat.id === 'orchestrator' ? { ...chat, isWorking: true } : chat
    ),
  },
};

export const OpenedBySessionsGroupedByDate: Story = {
  args: { groupBy: 'date', chats: openedByChats },
};

export const GroupByDate: Story = {
  args: { groupBy: 'date' },
};

/* Group preview cap — the state this exists for. Three worktrees on the same
   project plus a long-running one: without the cap the first bucket's twelve
   rows push every other worktree off the screen. Each bucket previews five
   top-level rows and ends in "Show more". */

export const GroupPreviewOverflow: Story = {
  args: { groupBy: 'project', chats: overflowingChats, capGroupPreviews: true },
};

/* One bucket expanded past the cap: "Show more" uncovers another page and
   "Show less" appears beside it, pinned to the tail of the bucket it belongs
   to. Collapsing scrolls the toggle back into view rather than dropping the
   user somewhere else in the list. */

export const GroupPreviewExpanded: Story = {
  args: { groupBy: 'project', chats: overflowingChats, capGroupPreviews: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [toggle] = await canvas.findAllByRole('button', { name: /Show more/i });
    await userEvent.click(toggle!);
  },
};

export const WithSwipeActions: Story = {
  args: { groupBy: 'project', rowActions: {} },
};

export const Archived: Story = {
  args: { groupBy: 'none', flatHeading: '归档对话', rowActions: {}, archived: true },
};

export const ReadOnlyRows: Story = {
  args: {
    groupBy: 'none',
    chats: baseChats.map((chat, index) =>
      index < 2 ? { ...chat, readOnly: true, owner: { id: 'teammate', name: 'Alex' } } : chat
    ),
  },
};

/**
 * Status grouping fixtures. The story host runs the real shared planner and
 * applies its writes; open at a phone viewport with touch emulation.
 */
const statusSections: PinSection[] = [
  { id: 'review', name: 'Review', orderKey: '80' },
  { id: 'ops', name: 'Ops', orderKey: '81' },
];

const statusChats: MobileConversationItem[] = [
  { id: 's-pin', title: 'Release checklist', isPinned: true, orderKey: '80' },
  {
    id: 's-review-1',
    title: 'Review the sync PR',
    isPinned: true,
    pinSectionId: 'review',
    orderKey: '80',
  },
  {
    id: 's-ops-1',
    title: 'Rotate staging keys',
    isPinned: true,
    pinSectionId: 'ops',
    orderKey: '80',
  },
  { id: 's-f1', title: 'Phone Status view', orderKey: '80', isWorking: true },
  {
    id: 's-f2',
    title: 'Fix flaky upload test',
    orderKey: '81',
    hasUnreadMessages: true,
    lastReadAt: now - 2 * hour,
  },
  { id: 's-f3', title: 'Draft release notes', orderKey: '82' },
  { id: 's-woken', title: 'Check CI after the weekend', snoozedUntil: now - 10 * 60 * 1000 },
  { id: 's-l1', title: 'Follow up with design', snoozedUntil: now + 3 * hour },
  { id: 's-l2', title: 'Revisit pricing copy', snoozedUntil: now + 4 * 24 * hour },
  { id: 's-done', title: 'Migrate settings page', settledAt: now - hour },
  {
    id: 's-quiet',
    title: 'Old spike',
    latestMessageAt: now - 9 * 24 * hour,
    lastMessageAt: now - 9 * 24 * hour,
  },
].map((chat) => ({
  kind: 'chat' as const,
  latestMessageAt: now - hour,
  lastMessageAt: now - hour,
  lastReadAt: now,
  ...chat,
}));

function toSession(chat: MobileConversationItem) {
  return {
    id: chat.id,
    title: chat.title,
    lastMessageAt: chat.lastMessageAt ?? null,
    activityAt: chat.latestMessageAt ?? null,
    lastReadAt: chat.lastReadAt ?? null,
    isPinned: chat.isPinned === true,
    pinSectionId: chat.pinSectionId ?? null,
    orderKey: chat.orderKey ?? null,
    snoozedUntil: chat.snoozedUntil ?? null,
    settledAt: chat.settledAt ?? null,
    focusRestoredAt: chat.focusRestoredAt ?? null,
    openedById: chat.openedByRowSessionId ?? chat.openedBySessionId ?? null,
    isWorking: chat.isWorking === true,
    isWaitingPermission: chat.isWaitingPermission === true,
    canManage: chat.readOnly !== true,
    canPrefer: true,
  };
}

function StatusStoryShell({
  initialChats = statusChats,
  initialSections = statusSections,
  canManageSections = true,
}: {
  initialChats?: MobileConversationItem[];
  initialSections?: PinSection[];
  canManageSections?: boolean;
}) {
  const [host, setHost] = useState({ chats: initialChats, sections: initialSections });
  const apply = (command: StatusViewCommand, state?: StatusViewState) =>
    setHost((current) => {
      const writes = planStatusViewCommand(
        state ?? {
          sessions: current.chats.map(toSession),
          sections: current.sections,
          sectionsLoaded: true,
          canManageSections,
          nowMs: Date.now(),
        },
        command,
        { nowMs: Date.now(), randomByte: () => Math.floor(Math.random() * 256) }
      );
      let { chats, sections } = current;
      for (const write of writes) {
        if (write.type === 'session')
          chats = chats.map((chat) =>
            chat.id === write.sessionId
              ? ({ ...chat, ...write.patch } as MobileConversationItem)
              : chat
          );
        else if (write.type === 'putSection')
          sections = [...sections.filter((s) => s.id !== write.section.id), write.section];
        else sections = sections.filter((s) => s.id !== write.sectionId);
      }
      return { chats, sections };
    });
  const commands: MobileStatusCommands = {
    run: async (command, state) => apply(command, state),
    snooze: (sessionId, until) => apply({ type: 'snooze', sessionId, until, includeOpened: false }),
    settle: (sessionId) => apply({ type: 'settle', sessionId, includeOpened: false }),
    moveToFocus: (sessionId) => apply({ type: 'moveToFocus', sessionId, includeOpened: false }),
    report: fn(),
  };
  return (
    <div {...stylex.props(storyViewport.canvas)}>
      <div data-story-phone-scroll="" {...stylex.props(phoneFrame.frame)}>
        <div {...stylex.props(storyLayout.canvas)}>Chat</div>
        <MobileChatList
          chats={host.chats}
          groupBy="status"
          capGroupPreviews
          pinSections={host.sections}
          statusWritable={canManageSections}
          statusCommands={commands}
          groupLabels={{ __pinned__: 'Pinned' }}
          onSelect={fn()}
          rowActions={{
            onTogglePin: (sessionId, pinned) => apply({ type: 'setPinned', sessionId, pinned }),
            onArchive: (id) =>
              setHost((current) => ({
                ...current,
                chats: current.chats.filter((c) => c.id !== id),
              })),
          }}
        />
      </div>
    </div>
  );
}

export const Status: StoryObj<typeof StatusStoryShell> = {
  render: (args) => <StatusStoryShell {...args} />,
};

export const StatusReadOnlyRows: StoryObj<typeof StatusStoryShell> = {
  render: (args) => <StatusStoryShell {...args} />,
  args: {
    canManageSections: false,
    initialChats: statusChats.map((chat, index) =>
      index % 2 ? { ...chat, readOnly: true } : chat
    ),
  },
};

/** Taller than a phone: a flick scrolls, a dragged row scrolls the list at the edges. */
export const StatusLongList: StoryObj<typeof StatusStoryShell> = {
  render: (args) => <StatusStoryShell {...args} />,
  args: {
    initialChats: [
      ...statusChats,
      ...Array.from({ length: 24 }, (_, index) => ({
        id: `s-extra-${index}`,
        title: `Background task ${index + 1}`,
        kind: 'chat' as const,
        orderKey: `9${index.toString(16).padStart(2, '0')}`,
        latestMessageAt: now - hour,
        lastMessageAt: now - hour,
        lastReadAt: now,
      })),
    ],
  },
};
