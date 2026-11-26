import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { useEffect, useMemo, useState } from 'react';
import { Tooltip } from '@lody/ui/tooltip';
import { SessionList, type SessionListRow } from '@/components/session-list';
import { sessionSendStatusesAtom } from '@/atoms/session-send-status';
import type { SessionSendStatus } from '@/lib/session-send-status';
const storyLayoutStyles = stylex.create({
  canvas: {
    paddingInline: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  canvas2: {
    borderRadius: 'var(--radius-xl)',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--sidebar-border) / 1) 80%, transparent)',
    backgroundColor: 'hsl(var(--sidebar-background) / 1)',
    padding: 'calc(var(--spacing) * 2)',
    fontSize: '14px',
    color: 'hsl(var(--sidebar-foreground) / 1)',
  },
});

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    width: '280px',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 2)',
  },
  section: {
    'margin-bottom': 'calc(var(--spacing) * 3)',
  },
  row: {
    display: 'flex',
    'min-height': '100vh',
    'align-items': 'flex-start',
    gap: 'calc(var(--spacing) * 6)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
  },
  frame: {
    'min-height': '100vh',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
  },
});

/**
 * Messages still leaving this device, shown where the conversation already
 * lives: a new conversation's title stays muted until its first message is in
 * history, and the row's status slot draws a ring filling with the bytes sent,
 * or a red alert once the send stops. The mark's `aria-label` carries the
 * byte count ("Sending · 12.4 MB / 38.0 MB").
 */
const meta = {
  title: 'Components/Sidebar/Send Status',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const MB = 1024 * 1024;

function row(
  sessionId: string,
  title: string,
  status: Partial<Pick<SessionListRow, 'isWorking' | 'hasUnreadMessages' | 'repoFullName'>> = {}
): SessionListRow {
  return {
    sessionId,
    title,
    repoFullName: null,
    branchName: '',
    latestMessageAt: NOW - 10 * 60 * 1000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    ...status,
  };
}

function sending(
  sentBytes: number,
  totalBytes: number,
  unsentNewConversation: boolean
): SessionSendStatus {
  return {
    state: 'sending',
    progress: totalBytes ? Math.min(99, Math.round((sentBytes / totalBytes) * 100)) : 5,
    sentBytes,
    totalBytes,
    unsentNewConversation,
  };
}

function failed(unsentNewConversation: boolean): SessionSendStatus {
  return { state: 'failed', progress: 0, sentBytes: 0, totalBytes: 0, unsentNewConversation };
}

const CHAT_ROWS: SessionListRow[] = [
  row('new-video', 'Review the onboarding screen recording'),
  row('new-text', 'Sketch a pricing page'),
  row('new-failed', 'Summarize the Q3 interview notes'),
  row('follow-up', 'Profile the diff viewer'),
  row('working', 'Migrate settings to StyleX', { isWorking: true }),
  row('done', 'Update the onboarding docs', { hasUnreadMessages: true }),
];

const REPO_ROWS: SessionListRow[] = [
  row('repo-upload', 'Attach the crash dump', { repoFullName: 'loro-dev/loro' }),
  row('repo-failed', 'Send the profiler trace', { repoFullName: 'loro-dev/loro' }),
  row('repo-running', 'Fix flaky CI on Windows', {
    repoFullName: 'loro-dev/loro',
    isWorking: true,
  }),
];

const STATIC_STATUSES: Record<string, SessionSendStatus> = {
  'new-video': sending(12.4 * MB, 38 * MB, true),
  'new-text': sending(0, 0, true),
  'new-failed': failed(true),
  'follow-up': sending(3.1 * MB, 4.2 * MB, false),
  'repo-upload': sending(1.2 * MB, 9.6 * MB, false),
  'repo-failed': failed(false),
};

function SidebarFrame({
  statuses,
  folded,
  heading,
}: {
  statuses: Record<string, SessionSendStatus>;
  folded: boolean;
  heading: string;
}) {
  const store = useMemo(() => createStore(), []);
  useEffect(() => {
    store.set(sessionSendStatusesAtom, statuses);
  }, [statuses, store]);
  const [chatsCollapsed, setChatsCollapsed] = useState(folded);
  const [repos, setRepos] = useState([{ repoFullName: 'loro-dev/loro', collapsed: folded }]);
  return (
    <div {...stylex.props(storyLayout.stack)}>
      <div {...stylex.props(storyLayoutStyles.canvas)}>{heading}</div>
      <Provider store={store}>
        <div {...stylex.props(storyLayoutStyles.canvas2)}>
          <div {...stylex.props(storyLayout.section)}>
            <SessionList
              sessions={REPO_ROWS}
              repos={repos}
              onToggleRepoCollapsed={() =>
                setRepos((prev) => prev.map((repo) => ({ ...repo, collapsed: !repo.collapsed })))
              }
            />
          </div>
          <SessionList
            sessions={CHAT_ROWS}
            repos={[]}
            chatsCollapsed={chatsCollapsed}
            onToggleChatsCollapsed={() => setChatsCollapsed((value) => !value)}
          />
        </div>
      </Provider>
    </div>
  );
}

/**
 * Every send state next to the agent's own marks. Folded, a group rolls them
 * up by row priority: failed > waiting > working > sending > unread.
 */
export const States: Story = {
  render: () => (
    <Tooltip.Provider>
      <div {...stylex.props(storyLayout.row)}>
        <SidebarFrame statuses={STATIC_STATUSES} folded={false} heading="Expanded" />
        <SidebarFrame statuses={STATIC_STATUSES} folded heading="Folded" />
      </div>
    </Tooltip.Provider>
  ),
};

const LIVE_TOTAL = 38 * MB;
const LIVE_STEP_MS = 120;

/**
 * One new conversation uploading a 38 MB recording: the ring fills, the title
 * turns regular the moment the message reaches history, and the mark leaves.
 * The second row repeats with a dropped connection, ending in the alert.
 */
export const Live: Story = {
  render: function LiveStory() {
    const [tick, setTick] = useState(0);
    useEffect(() => {
      const id = window.setInterval(() => setTick((value) => (value + 1) % 70), LIVE_STEP_MS);
      return () => window.clearInterval(id);
    }, []);
    const statuses = useMemo<Record<string, SessionSendStatus>>(() => {
      const next: Record<string, SessionSendStatus> = {};
      if (tick < 50) next['new-video'] = sending((tick / 50) * LIVE_TOTAL, LIVE_TOTAL, true);
      next['new-failed'] =
        tick < 30 ? sending((tick / 50) * LIVE_TOTAL, LIVE_TOTAL, true) : failed(true);
      return next;
    }, [tick]);
    return (
      <Tooltip.Provider>
        <div {...stylex.props(storyLayout.frame)}>
          <SidebarFrame statuses={statuses} folded={false} heading="Live upload" />
        </div>
      </Tooltip.Provider>
    );
  },
};
