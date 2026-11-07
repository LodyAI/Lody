import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { useMemo, useState, type CSSProperties } from 'react';
import { sessionSendStatusesAtom } from '../atoms/session-send-status';
import {
  SidebarUpdatedTaskList,
  type SidebarUpdatedItem,
} from '../components/sidebar-updated-task-list';

const meta = {
  title: 'Components/LegacyUpdatedTaskListMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const now = new Date('2026-10-22T09:00:00Z');
const longTitle =
  'Investigate an exceptionally long session title / branch / repository 中文标题边界检查';
const avatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#476c91"/><circle cx="16" cy="13" r="6" fill="#e9d8c0"/><path d="M5 32a11 11 0 0 1 22 0" fill="#e9d8c0"/></svg>')}`;
const examples: Omit<SidebarUpdatedItem, 'latestMessageAt'>[] = [
  {
    id: 'pinned',
    kind: 'chat',
    title: 'Pinned conversation',
    sectionLabel: 'Chats',
    isPinned: true,
  },
  {
    id: 'selected',
    kind: 'local',
    title: 'Selected local session',
    sectionLabel: 'Local folders',
    subtitle: 'Synthetic folder',
  },
  {
    id: 'unread',
    kind: 'chat',
    title: 'Unread conversation',
    sectionLabel: 'Chats',
    hasUnreadMessages: true,
  },
  {
    id: 'working',
    kind: 'github',
    title: 'Working on synthetic changes',
    sectionLabel: 'GitHub Worktrees',
    isWorking: true,
  },
  {
    id: 'waiting',
    kind: 'local',
    title: 'Waiting for permission',
    sectionLabel: 'Local folders',
    isWaitingPermission: true,
  },
  { id: 'sending', kind: 'chat', title: 'Uploading a new conversation', sectionLabel: 'Chats' },
  {
    id: 'failed',
    kind: 'chat',
    title: 'Failed first message remains unsent',
    sectionLabel: 'Chats',
  },
  {
    id: 'long',
    kind: 'github',
    title: longTitle,
    sectionLabel: 'GitHub Worktrees',
    repoFullName: 'synthetic/visual-fixture',
    branchName: 'feature/long-branch-name-for-layout-boundaries',
    prStatus: 'open',
    prCiState: 's',
    prReadiness: 'y',
    prNumber: 12345,
    prUrl: 'https://example.com/synthetic/pull/12345',
    addedLines: 1234,
    deletedLines: 567,
    owner: { name: 'Synthetic author', image: avatar },
    isWorktree: true,
  },
  {
    id: 'private',
    kind: 'local',
    title: 'Private local session',
    sectionLabel: 'Local folders',
    subtitle: 'Synthetic folder',
    sharing: {
      visibility: 'private',
      privateReason: 'machine',
      canManage: true,
      machineId: null,
      localProjectId: null,
      machineName: 'Synthetic laptop',
      projectName: 'Synthetic folder',
    },
  },
  {
    id: 'offline',
    kind: 'local',
    title: 'Offline local session',
    sectionLabel: 'Local folders',
    isOffline: true,
  },
];
const base: SidebarUpdatedItem[] = examples.map((item, index) => ({
  ...item,
  latestMessageAt: new Date(now.getTime() - (index + 1) * 60_000),
}));

const scopedVariables = {
  '--spacing': '0.3125rem',
  '--radius-md': '11px',
  '--radius-sm': '5px',
  '--font-weight-normal': '450',
  '--text-sm': '15px',
  '--text-sm--line-height': '22px',
  '--sidebar-row-foreground': '245 42% 42%',
  '--sidebar-foreground-muted': '285 36% 44%',
  '--sidebar-hover': '165 28% 84%',
  '--sidebar-hover-foreground': '165 52% 25%',
  '--sidebar-selection': '212 44% 40%',
  '--sidebar-selection-foreground': '0 0% 98%',
  '--sidebar-ring': '310 62% 45%',
} as CSSProperties;

function Fixture({
  mode = 'status',
  mobile = false,
  anchors = false,
  scoped = false,
}: {
  mode?: 'status' | 'interactions' | 'overflow' | 'empty' | 'loading';
  mobile?: boolean;
  anchors?: boolean;
  scoped?: boolean;
}) {
  const [store] = useState(() => {
    const next = createStore();
    next.set(sessionSendStatusesAtom, {
      sending: {
        state: 'sending',
        progress: 37,
        sentBytes: 370_000,
        totalBytes: 1_000_000,
        unsentNewConversation: true,
      },
      failed: {
        state: 'failed',
        progress: 62,
        sentBytes: 620_000,
        totalBytes: 1_000_000,
        unsentNewConversation: true,
      },
    });
    return next;
  });
  const initial = useMemo(() => {
    if (mode === 'empty' || mode === 'loading') return [];
    if (mode === 'interactions')
      return base.filter((item) => ['long', 'private', 'selected'].includes(item.id));
    if (mode === 'overflow')
      return Array.from({ length: 24 }, (_, index): SidebarUpdatedItem => ({
        id: `overflow-${index}`,
        kind: index % 3 === 0 ? 'github' : index % 3 === 1 ? 'local' : 'chat',
        title: `Conversation ${String(index + 1).padStart(2, '0')} · ${index === 23 ? longTitle : 'Synthetic history'}`,
        sectionLabel: 'Chats',
        latestMessageAt: now.getTime() - index * 60_000,
        isPinned: index === 0,
      }));
    return base;
  }, [mode]);
  const [items, setItems] = useState(initial);
  const [selected, setSelected] = useState<string | null>('selected');
  const [collapsed, setCollapsed] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [result, setResult] = useState('Ready');
  return (
    <Provider store={store}>
      <div style={{ padding: 16 }}>
        <div
          data-legacy-updated-fixture=""
          style={{
            width: 'min(100%, 360px)',
            minWidth: 0,
            background: 'hsl(var(--sidebar))',
            ...(scoped ? scopedVariables : {}),
          }}
        >
          <SidebarUpdatedTaskList
            items={items}
            now={now}
            isMobile={mobile}
            isLoading={mode === 'loading'}
            selectedItemId={selected}
            toggleBucketLabel="Toggle legacy chats"
            collapsedBuckets={{ all: collapsed }}
            onToggleBucket={() => setCollapsed((value) => !value)}
            showFullBuckets={{ all: showFull }}
            onToggleFullBucket={() => setShowFull((value) => !value)}
            onSelectItem={(id) => {
              setSelected(id);
              setResult(`Selected ${id}`);
            }}
            onRenameItem={(id, title) => {
              setItems((previous) =>
                previous.map((item) => (item.id === id ? { ...item, title } : item))
              );
              setResult(`Renamed ${id}: ${title}`);
            }}
            onArchiveItem={(id) => {
              setItems((previous) => previous.filter((item) => item.id !== id));
              setResult(`Archived ${id}`);
            }}
            onTogglePinItem={(id, isPinned) => {
              setItems((previous) =>
                previous.map((item) => (item.id === id ? { ...item, isPinned } : item))
              );
              setResult(`${isPinned ? 'Pinned' : 'Unpinned'} ${id}`);
            }}
            onCopyItemUrl={(id) => setResult(`Copied ${id}`)}
            onShareItemWithTeam={(id) => setResult(`Share requested ${id}`)}
            onOpenPullRequest={() => setResult('PR opened')}
            getItemHref={anchors ? (id) => `/synthetic/sessions/${id}` : undefined}
            headerAction={
              <button
                type="button"
                aria-label="Legacy header action"
                onClick={() => setResult('Header action invoked')}
              >
                ⋯
              </button>
            }
          />
        </div>
        <output data-legacy-updated-result="" style={{ display: 'block', marginTop: 16 }}>
          {result}
        </output>
        <button type="button" data-legacy-blur-target="">
          Outside list
        </button>
      </div>
    </Provider>
  );
}

export const StatusMatrix: Story = { render: () => <Fixture /> };
export const Interactions: Story = { render: () => <Fixture mode="interactions" /> };
export const AnchorRows: Story = { render: () => <Fixture mode="interactions" anchors /> };
export const Overflow: Story = { render: () => <Fixture mode="overflow" /> };
export const Empty: Story = { render: () => <Fixture mode="empty" /> };
export const Loading: Story = { render: () => <Fixture mode="loading" /> };
export const MobileRows: Story = { render: () => <Fixture mobile /> };
export const ScopedVariables: Story = { render: () => <Fixture mode="interactions" scoped /> };
