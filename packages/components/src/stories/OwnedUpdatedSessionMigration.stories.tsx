import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { sidebarShowBranchNamesAtom } from '../atoms/sidebar-state';
import { sidebarCollapsedOpenedBySessionsAtom } from '../atoms/focus-layer';
import { sessionSendStatusesAtom } from '../atoms/session-send-status';
import {
  SidebarUpdatedSessionList,
  type SidebarUpdatedItem,
} from '../components/sidebar-updated-session-list';

const meta = {
  title: 'Components/OwnedUpdatedSessionMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const now = new Date('2026-10-22T09:00:00Z');
const longTitle = 'Investigate a long session title / project / branch · 中文标题边界检查';
const avatar = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#476c91"/><circle cx="16" cy="13" r="6" fill="#e9d8c0"/><path d="M5 32a11 11 0 0 1 22 0" fill="#e9d8c0"/></svg>')}`;
const examples: Omit<SidebarUpdatedItem, 'latestMessageAt'>[] = [
  {
    id: 'opener',
    kind: 'local',
    title: longTitle,
    sectionLabel: 'Local folders',
    subtitle: 'Synthetic project group with a long name 中文项目',
    projectGroup: true,
    branchName: 'feature/long-branch-for-project-context',
    isWorktree: true,
  },
  {
    id: 'child-a',
    kind: 'local',
    title: 'Working opened session',
    sectionLabel: 'Local folders',
    openedBySessionId: 'opener-tab',
    openedByRowSessionId: 'opener',
    isWorking: true,
  },
  {
    id: 'child-b',
    kind: 'chat',
    title: 'Unread opened session with a long title 中文',
    sectionLabel: 'Chats',
    openedBySessionId: 'opener',
    openedByRowSessionId: 'opener',
    hasUnreadMessages: true,
  },
  {
    id: 'selected',
    kind: 'local',
    title: 'Selected session',
    sectionLabel: 'Local folders',
    subtitle: 'Synthetic selected project',
    projectGroup: true,
    isPinned: true,
    owner: { name: 'Synthetic author', image: avatar },
  },
  {
    id: 'waiting',
    kind: 'local',
    title: 'Waiting for permission',
    sectionLabel: 'Local folders',
    subtitle: 'Synthetic folder',
    isWaitingPermission: true,
  },
  { id: 'sending', kind: 'chat', title: 'Uploading a new conversation', sectionLabel: 'Chats' },
  { id: 'failed', kind: 'chat', title: 'Failed unsent conversation', sectionLabel: 'Chats' },
  {
    id: 'github',
    kind: 'github',
    title: 'Repository fallback and CI result',
    sectionLabel: 'GitHub Worktrees',
    subtitle: 'Synthetic repository without owner metadata',
    repoFullName: '',
    prStatus: 'open',
    prCiState: 's',
    prReadiness: 'y',
    prNumber: 12345,
    prUrl: 'https://example.com/synthetic/pull/12345',
  },
];
const base: SidebarUpdatedItem[] = examples.map((item, index) => ({
  ...item,
  latestMessageAt: now.getTime() - (index + 1) * 60_000,
}));
const scope = {
  '--spacing': '0.3125rem',
  '--radius-md': '11px',
  '--sidebar-hover': '165 28% 84%',
  '--sidebar-hover-foreground': '165 52% 25%',
  '--sidebar-foreground-muted': '285 36% 44%',
  '--sidebar-ring': '310 62% 45%',
} as CSSProperties;

function Fixture({
  anchors = false,
  readOnly = false,
  scoped = false,
  caller = false,
  mobile = false,
  overflow = false,
  collapsedTree = false,
}: {
  anchors?: boolean;
  readOnly?: boolean;
  scoped?: boolean;
  caller?: boolean;
  mobile?: boolean;
  overflow?: boolean;
  collapsedTree?: boolean;
}) {
  const [store] = useState(() => {
    const next = createStore();
    next.set(sidebarShowBranchNamesAtom, true);
    if (collapsedTree) next.set(sidebarCollapsedOpenedBySessionsAtom, { opener: true });
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
  const [items, setItems] = useState(() =>
    overflow
      ? [
          ...base.slice(0, 3),
          ...Array.from({ length: 23 }, (_, index): SidebarUpdatedItem => ({
            id: `overflow-${index}`,
            kind: 'chat',
            title: `Synthetic conversation ${String(index + 1).padStart(2, '0')}`,
            sectionLabel: 'Chats',
            latestMessageAt: now.getTime() - (index + 4) * 60_000,
          })),
        ]
      : base
  );
  const [selected, setSelected] = useState<string | null>('selected');
  const [collapsed, setCollapsed] = useState(false);
  const [showFull, setShowFull] = useState(false);
  const [result, setResult] = useState('Ready');
  return (
    <Provider store={store}>
      <div
        data-owned-updated-outer=""
        {...stylex.props(stylex.defaultMarker())}
        style={{ padding: 24 }}
      >
        <div
          data-owned-updated-fixture=""
          style={{
            width: 'min(100%, 360px)',
            minWidth: 0,
            background: 'hsl(var(--sidebar))',
            ...(scoped ? scope : {}),
          }}
        >
          <SidebarUpdatedSessionList
            items={items}
            now={now}
            selectedItemId={selected}
            isMobile={mobile}
            showProjectContext
            className={
              caller
                ? 'gap-2 rounded-xl bg-muted/10 [&_[data-sidebar-updated-id]]:bg-transparent [&_[data-session-row-leading-slot]_button]:opacity-50'
                : undefined
            }
            toggleBucketLabel="Toggle updated chats"
            collapsedBuckets={{ all: collapsed }}
            onToggleBucket={() => setCollapsed((value) => !value)}
            showFullBuckets={{ all: showFull }}
            onToggleFullBucket={() => setShowFull((value) => !value)}
            onSelectItem={
              readOnly
                ? undefined
                : (id, tab) => {
                    setSelected(id);
                    setResult(`Selected ${id}${tab ? ` tab ${tab}` : ''}`);
                  }
            }
            onRenameItem={
              readOnly
                ? undefined
                : (id, title) => {
                    setItems((previous) =>
                      previous.map((item) => (item.id === id ? { ...item, title } : item))
                    );
                    setResult(`Renamed ${id}: ${title}`);
                  }
            }
            onArchiveItem={
              readOnly
                ? undefined
                : (id) => {
                    setItems((previous) => previous.filter((item) => item.id !== id));
                    setResult(`Archived ${id}`);
                  }
            }
            onMarkItemUnread={
              readOnly
                ? undefined
                : (id) => {
                    setItems((previous) =>
                      previous.map((item) =>
                        item.id === id ? { ...item, hasUnreadMessages: true } : item
                      )
                    );
                    setResult(`Unread ${id}`);
                  }
            }
            onTogglePinItem={
              readOnly
                ? undefined
                : (id, isPinned) => {
                    setItems((previous) =>
                      previous.map((item) => (item.id === id ? { ...item, isPinned } : item))
                    );
                    setResult(`${isPinned ? 'Pinned' : 'Unpinned'} ${id}`);
                  }
            }
            onCopyItemUrl={readOnly ? undefined : (id) => setResult(`Copied ${id}`)}
            onOpenPullRequest={readOnly ? undefined : () => setResult('PR opened')}
            getItemHref={anchors ? (id) => `/synthetic/sessions/${id}` : undefined}
          />
        </div>
        <output data-owned-updated-result="" style={{ display: 'block', marginTop: 16 }}>
          {result}
        </output>
        <div
          data-owned-updated-drop-target=""
          style={{ minHeight: 48 }}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            setResult(`Dropped ${event.dataTransfer.types.join(',')}`);
          }}
        >
          Mention drop target
        </div>
      </div>
    </Provider>
  );
}

export const TreeAndProjects: Story = { render: () => <Fixture /> };
export const AnchorRows: Story = { render: () => <Fixture anchors /> };
export const ReadOnly: Story = { render: () => <Fixture readOnly /> };
export const ScopedVariables: Story = { render: () => <Fixture scoped /> };
export const CallerOverrides: Story = { render: () => <Fixture caller /> };
export const CollapsedTree: Story = { render: () => <Fixture collapsedTree /> };
export const MobileRows: Story = { render: () => <Fixture mobile /> };
export const Overflow: Story = { render: () => <Fixture overflow /> };
