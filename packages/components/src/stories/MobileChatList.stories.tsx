import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn, userEvent, within } from 'storybook/test';

import {
  MobileChatList,
  type MobileChatGroupBy,
  type MobileChatListRowActions,
} from '@/components/mobile/mobile-chat-list';
import type { MobileConversationItem } from '@/components/mobile/mobile-project-screen';

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
    /* CI running — the PR glyph carries a static verdict dot. */
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
    /* Clean merge state + green CI: the row swaps its line diff for the
       Mergeable pill (the diff numbers below are deliberately still set, to
       show that the pill takes that slot). */
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
    /* Stale readiness left behind after the merge — the pill must not linger
       next to a merged PR. */
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
    /* No poller CI record yet — plain PR glyph, no verdict badge. */
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
    /* Checks expected but not reported yet. */
    prCiState: 'x',
    isPinned: true,
    machineId: 'zx-macbook',
    projectKey: 'loro-dev/lody',
    projectLabel: 'loro-dev/lody',
  },
];

/* Sessions created by another Session (`lody_session_create` MCP tool). The
   list nests each one under its opener; `openedByRowSessionId` is the row to
   indent under, which differs from the precise opener when an agent inside a
   child Tab created the Session. `fanout-3` is opened by `fanout-1`, itself
   opened by `orchestrator` — depth is capped at one, so it attaches to the
   topmost visible ancestor. `detached` names an opener that is not in this
   list and therefore stays a plain top-level row.

   `fanout-1` is deliberately working and `fanout-2` unread: an active row
   shows its status at the leading node INSTEAD of the ├/└, so only the idle
   `fanout-3` draws connectors. `OpenedBySessionsActiveOpener` shows the same
   rule applied to the opener's own fold control. */
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

/* The clutter the preview cap exists for: one busy worktree with twelve
   Sessions, then two other worktrees that a flat list would push below the
   fold. `busy-9` is an opener with two opened Sessions — expand the bucket and
   its group arrives intact, because the cap counts TOP-LEVEL rows rather than
   rendered ones. */
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
        /* Archived list: restore drops the row out of the archived
           view (here we just remove it from the mock list). */
        onRestore: (id) => {
          setChats((prev) => prev.filter((c) => c.id !== id));
          fn()(id);
        },
      }
    : undefined;

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="h-dvh w-full overflow-y-auto bg-background pb-12 shadow-2xl sm:h-[852px] sm:w-[393px] sm:rounded-[34px]">
        <div className="px-5 pb-1 pt-6 text-xl font-semibold">对话</div>
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
          /* In archived mode, swipe delete + multi-select both route
             through this; remove the confirmed ids from the mock list. */
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

/* Sessions opened by another Session indent one level under their opener with
   a ├/└ connector — the mobile face of the desktop sidebar's opened-by tree. */
export const OpenedBySessions: Story = {
  args: { groupBy: 'none', chats: openedByChats },
};

/* An active opener shows its status at the leading node instead of the fold
   chevron — status outranks the tree on both sides of the relationship. The
   fold stays reachable on desktop through the row context menu; on mobile an
   active opener simply cannot be folded until it goes quiet. */
export const OpenedBySessionsActiveOpener: Story = {
  args: {
    groupBy: 'none',
    chats: openedByChats.map((chat) =>
      chat.id === 'orchestrator' ? { ...chat, isWorking: true } : chat
    ),
  },
};

/* Same relationships, but resolved INSIDE each bucket: an opener and its
   opened Sessions land in the same date group here, so the tree survives
   grouping. A child whose opener sits in another bucket goes back to
   top-level. */
export const OpenedBySessionsGroupedByDate: Story = {
  args: { groupBy: 'date', chats: openedByChats },
};

export const GroupByDate: Story = {
  args: { groupBy: 'date' },
};

/* Group preview cap — the state this exists for. Three worktrees on the same
   project plus a long-running one: without the cap the first bucket's twelve
   rows push every other worktree off the screen. Each bucket previews five
   top-level rows and ends in "Show all (N)". */
export const GroupPreviewOverflow: Story = {
  args: { groupBy: 'project', chats: overflowingChats, capGroupPreviews: true },
};

/* One bucket expanded past the cap: the toggle reads "Show less" and stays
   pinned to the tail of the bucket it belongs to. Collapsing it scrolls the
   toggle back into view rather than dropping the user somewhere else in the
   list. */
export const GroupPreviewExpanded: Story = {
  args: { groupBy: 'project', chats: overflowingChats, capGroupPreviews: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const [toggle] = await canvas.findAllByRole('button', { name: /Show all/i });
    await userEvent.click(toggle!);
  },
};

export const WithSwipeActions: Story = {
  args: { groupBy: 'project', rowActions: {} },
};

/* Archived list: swipe a row left to reveal 恢复 (restore) + 删除
   (delete) instead of 置顶 / 归档. Delete routes through the shared
   confirm dialog; long-press still enters multi-select. */
export const Archived: Story = {
  args: { groupBy: 'none', flatHeading: '归档对话', rowActions: {}, archived: true },
};
