import type { Meta, StoryObj } from '@storybook/react';
import { createStore, Provider } from 'jotai';
import { useLayoutEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import {
  SessionList,
  type SessionListRow,
  type SessionListProjectGroupState,
} from '@/components/session-list';
import { sidebarCollapsedOpenedBySessionsAtom, sidebarShowFullListAtom } from '@/atoms/focus-layer';
import { sidebarShowBranchNamesAtom } from '@/atoms/sidebar-state';
import { sessionSendStatusesAtom } from '@/atoms/session-send-status';

const meta = {
  title: 'Components/Owned Session List Migration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: 16,
    backgroundColor: 'hsl(var(--background) / 1)',
    color: 'hsl(var(--foreground) / 1)',
  },
  panel: { width: 340, maxWidth: '100%', padding: 8, backgroundColor: 'hsl(var(--sidebar) / 1)' },
  narrow: { width: 240 },
  output: { display: 'block', marginTop: 16, fontSize: 12, overflowWrap: 'anywhere' },
  section: { marginBottom: 24 },
});
const NOW = Date.UTC(2026, 9, 22, 9);
const variables = {
  '--spacing': '0.3125rem',
  '--radius-md': '13px',
  '--font-weight-normal': '450',
  '--sidebar-row-foreground': '245 42% 42%',
  '--sidebar-foreground-muted': '285 36% 44%',
  '--sidebar-hover': '165 28% 84%',
  '--sidebar-hover-foreground': '165 52% 25%',
  '--sidebar-selection': '212 44% 40%',
  '--sidebar-selection-foreground': '0 0% 98%',
  '--sidebar-ring': '310 62% 45%',
} as CSSProperties;
function row(
  sessionId: string,
  title: string,
  extra: Partial<SessionListRow> = {}
): SessionListRow {
  return {
    sessionId,
    title,
    repoFullName: null,
    branchName: '',
    latestMessageAt: NOW - 600_000,
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: false,
    isOffline: false,
    isWaitingPermission: false,
    ...extra,
  };
}
const project = { id: 'alpha', name: 'Alpha project group with a very long name 多仓库项目' };
const SESSIONS: SessionListRow[] = [
  row('opener', 'Review the shared workspace across repositories', {
    projectGroup: project,
    branchName: 'migration/owned-header',
    isPinned: true,
  }),
  row('child', 'Opened session from a precise child Tab', {
    projectGroup: project,
    openedBySessionId: 'synthetic-precise-tab',
    openedByRowSessionId: 'opener',
    hasUnreadMessages: true,
  }),
  ...Array.from({ length: 6 }, (_, i) =>
    row(`project-${i}`, `Project conversation ${i + 1}`, {
      projectGroup: project,
      latestMessageAt: NOW - (i + 1) * 60_000,
      isWorking: i === 0,
      isWaitingPermission: i === 1,
    })
  ),
  row('removed', 'A conversation retains its removed project group', {
    projectGroup: { id: 'removed', name: 'Removed project group' },
  }),
  row('repo', 'Repository conversation', {
    repoFullName: 'migration-fixture/owned-session',
    branchName: 'migration/session-list',
  }),
  row('chat', 'A plain conversation'),
];
function RootVariables({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = Object.keys(variables).map((key) => [
      key,
      root.style.getPropertyValue(key),
      root.style.getPropertyPriority(key),
    ]);
    for (const [key, value] of Object.entries(variables))
      root.style.setProperty(key, String(value));
    return () => {
      for (const [key, value, priority] of previous) {
        if (value) root.style.setProperty(key, value, priority);
        else root.style.removeProperty(key);
      }
    };
  }, []);
  return children;
}
function Demo({
  selectedGroup = false,
  subtree = false,
  caller = false,
  narrow = false,
}: {
  selectedGroup?: boolean;
  subtree?: boolean;
  caller?: boolean;
  narrow?: boolean;
}) {
  const store = useMemo(() => {
    const value = createStore();
    value.set(sidebarShowFullListAtom, {});
    value.set(sidebarCollapsedOpenedBySessionsAtom, {});
    value.set(sidebarShowBranchNamesAtom, true);
    value.set(sessionSendStatusesAtom, {});
    return value;
  }, []);
  const [sessions, setSessions] = useState(SESSIONS);
  const [groups, setGroups] = useState<SessionListProjectGroupState[]>([
    { projectId: 'alpha', name: project.name, collapsed: false },
    { projectId: 'empty', name: 'Empty project group', collapsed: false },
  ]);
  const [selected, setSelected] = useState('opener');
  const [event, setEvent] = useState('Ready');
  return (
    <Provider store={store}>
      <div
        {...stylex.props(styles.canvas)}
        data-owned-session-fixture
        style={subtree ? variables : undefined}
      >
        <div {...stylex.props(styles.panel, narrow && styles.narrow)} data-owned-session-panel>
          <SessionList
            sessions={sessions}
            repos={[{ repoFullName: 'migration-fixture/owned-session', collapsed: false }]}
            projectGroups={groups}
            selectedSessionId={selected}
            activeGroupKey={selectedGroup ? 'projectGroup:alpha' : undefined}
            className={
              caller ? 'gap-5 p-3 border border-sidebar-ring w-[280px] max-w-full' : undefined
            }
            headerAction={
              <Button size="small" variant="ghost" onClick={() => setEvent('Header action')}>
                Filter
              </Button>
            }
            onSelectSession={(id) => {
              setSelected(id);
              setEvent(`Selected ${id}`);
            }}
            onNavigateSessionTab={(root, tab) => setEvent(`Tab ${root}/${tab}`)}
            onToggleProjectGroupCollapsed={(key) =>
              setGroups((current) =>
                current.map((group) =>
                  `projectGroup:${group.projectId}` === key
                    ? { ...group, collapsed: !group.collapsed }
                    : group
                )
              )
            }
            onNewInProjectGroup={(id) => setEvent(`New project ${id}`)}
            onOpenProjectGroupSettings={(id) => setEvent(`Settings ${id}`)}
            onArchiveProjectGroupChats={(ids) => setEvent(`Archive group ${ids.join(',')}`)}
            onMoveProjectGroup={(ids) => {
              setGroups((current) =>
                ids.flatMap((id) => current.filter((group) => group.projectId === id))
              );
              setEvent(`Moved ${ids.join(',')}`);
            }}
            onArchiveSession={(id) => {
              setSessions((current) => current.filter((session) => session.sessionId !== id));
              setEvent(`Archived ${id}`);
            }}
            onRenameSession={(id, title) => {
              setSessions((current) =>
                current.map((session) =>
                  session.sessionId === id ? { ...session, title } : session
                )
              );
              setEvent(`Renamed ${id}: ${title}`);
            }}
            onTogglePinSession={(id, isPinned) =>
              setSessions((current) =>
                current.map((session) =>
                  session.sessionId === id ? { ...session, isPinned } : session
                )
              )
            }
            onMarkSessionUnread={(id) => {
              setSessions((current) =>
                current.map((session) =>
                  session.sessionId === id ? { ...session, hasUnreadMessages: true } : session
                )
              );
              setEvent(`Unread ${id}`);
            }}
            onEditRepoProject={(name) => setEvent(`Edit repo ${name}`)}
            onArchiveRepoChats={(ids) => setEvent(`Archive repo ${ids.join(',')}`)}
            onCopySessionUrl={(id) => setEvent(`Copied ${id}`)}
            getSessionHref={(id) => `#synthetic-owned-session-${id}`}
          />
        </div>
        <output {...stylex.props(styles.output)} data-owned-session-event>
          {event}
        </output>
      </div>
    </Provider>
  );
}
export const ProjectGroups: Story = { render: () => <Demo /> };
export const SelectedProjectGroup: Story = { render: () => <Demo selectedGroup /> };
export const SubtreeVariables: Story = { render: () => <Demo subtree /> };
export const RootVariableOverrides: Story = {
  render: () => (
    <RootVariables>
      <Demo />
    </RootVariables>
  ),
};
export const CallerOverrides: Story = { render: () => <Demo caller /> };
export const Narrow: Story = { render: () => <Demo narrow /> };
export const EmptyAndLoading: Story = {
  render: () => (
    <div {...stylex.props(styles.canvas)} data-owned-session-fixture>
      <div {...stylex.props(styles.panel)}>
        <section {...stylex.props(styles.section)} data-owned-session-empty>
          <SessionList
            sessions={[]}
            repos={[]}
            emptyState={<p>No conversations in this synthetic workspace.</p>}
            headerAction={<Button size="small">Empty filter</Button>}
          />
        </section>
        <section data-owned-session-loading>
          <SessionList
            sessions={[]}
            repos={[]}
            isLoading
            className="gap-4"
            headerAction={<Button size="small">Loading filter</Button>}
          />
        </section>
      </div>
    </div>
  ),
};
