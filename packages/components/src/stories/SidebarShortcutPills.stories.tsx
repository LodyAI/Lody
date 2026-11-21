import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore, useAtomValue, useSetAtom } from 'jotai';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  buildPinnedSectionLayout,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
  type PinSection,
  type PinnedSessionPlacement,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
} from '@lody/shared';
import { Button } from '@lody/ui/button';
import { Tooltip } from '@lody/ui/tooltip';
import {
  sidebarCollapsedOpenedBySessionsAtom,
  sidebarNavItemsAtom,
  sidebarShowFullListAtom,
  toggleSidebarCollapsedOpenedBySessionAtom,
} from '@/atoms/focus-layer';
import {
  getVisibleSidebarShortcutSessionIds,
  sidebarShortcutOverlayActiveAtom,
  sidebarShortcutPlatformOverrideAtom,
  type SidebarShortcutPlatform,
} from '@/atoms/sidebar-shortcuts';
import { LocalProjectItem } from '@/components/loro-app-sidebar';
import { LoroSidebar, type LoroSidebarOrganizeMode } from '@/components/loro-sidebar';
import {
  SessionList,
  type SessionListRepoState,
  type SessionListRow,
} from '@/components/session-list';
import {
  getLocalProjectSessionGroupKey,
  buildSidebarNavigationItems,
} from '@/components/sidebar-navigation-model';
import { SidebarSectionHeader } from '@/components/sidebar-row-shared';
import { SidebarShortcutPill } from '@/components/sidebar-shortcut-pill';
import {
  SidebarUpdatedSessionList,
  type SidebarUpdatedBucketKey,
  type SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';
import { useSidebarShortcutHold } from '@/hooks/use-sidebar-shortcut-hold';
import { isMac } from '@/lib/commands/platform';
import { isSidebarBucketCollapsed } from '@/lib/sidebar-status-group';

const meta = {
  title: 'Sidebar/Shortcut Pills',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const MACHINE_ID = 'machine-mac-studio' as MachineId;

const GALLERY_ROWS: SidebarUpdatedItem[] = [
  {
    id: 'gal-1',
    kind: 'local',
    title: 'Design sidebar shortcut pills',
    sectionLabel: 'lody',
    subtitle: 'lody',
    latestMessageAt: NOW - 4 * MINUTE,
  },
  {
    id: 'gal-2',
    kind: 'local',
    title: 'Long conversation title that truncates cleanly before the pill',
    sectionLabel: 'lody',
    subtitle: 'lody',
    latestMessageAt: NOW - 10 * MINUTE,
  },
  {
    id: 'gal-3',
    kind: 'github',
    title: 'Streamline E2EE workspace bootstrap flow',
    sectionLabel: 'lodyai/lody',
    subtitle: 'lodyai/lody',
    repoFullName: 'lodyai/lody',
    latestMessageAt: NOW - 25 * MINUTE,
    isWorking: true,
  },
  {
    id: 'gal-4',
    kind: 'github',
    title: 'Approve database migration plan',
    sectionLabel: 'lodyai/cloud',
    subtitle: 'lodyai/cloud',
    repoFullName: 'lodyai/cloud',
    latestMessageAt: NOW - 40 * MINUTE,
    isWaitingPermission: true,
  },
  {
    id: 'gal-5',
    kind: 'github',
    title: 'Fix OAuth refresh race condition',
    sectionLabel: 'lodyai/lody',
    subtitle: 'lodyai/lody',
    repoFullName: 'lodyai/lody',
    latestMessageAt: NOW - 2 * HOUR,
    hasUnreadMessages: true,
  },
  {
    id: 'gal-6',
    kind: 'github',
    title: 'Ship fractional-index pin sections',
    sectionLabel: 'lodyai/lody',
    subtitle: 'lodyai/lody',
    repoFullName: 'lodyai/lody',
    latestMessageAt: NOW - 3 * HOUR,
    prUrl: 'https://github.com/lodyai/lody/pull/412',
    prStatus: 'open',
    prCiState: 's',
    prReadiness: 'y',
  },
  {
    id: 'gal-7',
    kind: 'chat',
    title: 'Re-run flaky Safari Playwright suite',
    sectionLabel: 'Chats',
    subtitle: null,
    latestMessageAt: NOW - 5 * HOUR,
    snoozedUntil: NOW + 2 * HOUR,
  },
];

function GallerySidebarColumn({
  heading,
  active,
  platform,
}: {
  heading: string;
  active: boolean;
  platform: SidebarShortcutPlatform;
}) {
  const store = useMemo(() => {
    const next = createStore();
    next.set(sidebarShortcutOverlayActiveAtom, active);
    next.set(sidebarShortcutPlatformOverrideAtom, platform);
    next.set(
      sidebarNavItemsAtom,
      GALLERY_ROWS.map((row) => ({
        kind: 'session',
        sessionId: row.id,
        groupKey: '__status:focus__',
      }))
    );
    return next;
  }, [active, platform]);

  return (
    <div className="flex w-[280px] flex-col gap-2">
      <div className="px-1 text-xs font-medium text-muted-foreground">{heading}</div>
      <Provider store={store}>
        <div className="rounded-xl border border-sidebar-border/80 bg-sidebar p-2 text-sidebar-foreground">
          <SidebarUpdatedSessionList
            items={GALLERY_ROWS}
            now={new Date(NOW)}
            grouping="status"
            selectedItemId="gal-2"
            showProjectContext={false}
            collapsedBuckets={{ later: false }}
            labels={{ heading: 'Focus', emptyTitle: 'Empty', emptyDescription: '' }}
          />
        </div>
      </Provider>
    </div>
  );
}

/**
 * Style review sheet: inspects the pill anatomy across 1–9 on both macOS and
 * Windows, plus side-by-side row comparison (resting vs holding Command vs holding Control).
 */
export const PillGallery: Story = {
  render: () => (
    <Tooltip.Provider>
      <div className="min-h-screen space-y-8 bg-background p-6 text-foreground">
        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Pill Scale (1–9)</h2>
          <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
            {(['mac', 'windows'] as const).map((platform) => (
              <div
                key={platform}
                className="space-y-3 rounded-xl border border-sidebar-border/80 bg-sidebar p-4 text-sidebar-foreground"
              >
                <div className="text-xs font-medium text-sidebar-foreground-muted">
                  {platform === 'mac' ? 'macOS · Command icon' : 'Windows / Linux · Control label'}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((index) => (
                    <SidebarShortcutPill
                      key={index}
                      index={index}
                      platform={platform}
                      animate={false}
                    />
                  ))}
                </div>
                <div className="rounded-md bg-sidebar-selection px-2.5 py-2">
                  <div className="mb-1.5 text-[11px] text-sidebar-selection-foreground/80">
                    On selected row
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {[1, 2, 3].map((index) => (
                      <SidebarShortcutPill
                        key={index}
                        index={index}
                        platform={platform}
                        selected
                        animate={false}
                      />
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="space-y-3">
          <h2 className="text-sm font-semibold">Sidebar Row Replacement &amp; Alignment</h2>
          <p className="max-w-2xl text-xs text-muted-foreground">
            Holding the primary modifier swaps trailing row status / PR / Mergeable / countdown
            marks for the aligned 1–9 shortcut pill so long titles truncate cleanly and no badge
            stacking occurs.
          </p>
          <div className="flex flex-wrap items-start gap-6">
            <GallerySidebarColumn
              heading="Resting (no modifier held)"
              active={false}
              platform="mac"
            />
            <GallerySidebarColumn heading="macOS · Holding Command (⌘)" active platform="mac" />
            <GallerySidebarColumn heading="Windows · Holding Control" active platform="windows" />
          </div>
        </div>
      </div>
    </Tooltip.Provider>
  ),
};

type PlaygroundSession = {
  id: string;
  title: string;
  kind: 'local' | 'github' | 'chat';
  projectId?: string;
  projectName?: string;
  repoFullName?: string;
  branchName?: string;
  openedBySessionId?: string;
  latestMessageAt: number;
  isPinned?: boolean;
  pinSectionId?: string;
  orderKey?: string;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  hasUnreadMessages?: boolean;
  snoozedUntil?: number;
  settledAt?: number;
  prStatus?: 'open' | 'draft' | 'merged' | 'closed';
  prCiState?: 's' | 'f' | 'p';
  prReadiness?: 'y';
  prUrl?: string;
};

const DEMO_PROJECTS: LocalProjectMeta[] = [
  {
    id: 'proj-lody' as LocalProjectId,
    name: 'lody',
    rootPath: '/Users/demo/code/lody',
  } as LocalProjectMeta,
  {
    id: 'proj-loro' as LocalProjectId,
    name: 'loro',
    rootPath: '/Users/demo/code/loro',
  } as LocalProjectMeta,
];

const INITIAL_PIN_SECTIONS: PinSection[] = [
  { id: 'sec-maintenance', name: 'Maintenance', orderKey: '80' },
];

const DEMO_SESSIONS: PlaygroundSession[] = [
  // Pinned (default)
  {
    id: 'pin-release',
    title: 'Release 0.107 checklist',
    kind: 'github',
    repoFullName: 'lodyai/lody',
    branchName: 'release/0.107',
    latestMessageAt: NOW - 12 * MINUTE,
    isPinned: true,
    orderKey: '80',
    hasUnreadMessages: true,
  },
  // Pinned (Maintenance section)
  {
    id: 'pin-mirror',
    title: 'Weekly mirror update check',
    kind: 'github',
    repoFullName: 'lodyai/lody',
    branchName: 'chore/mirror',
    latestMessageAt: NOW - 3 * HOUR,
    isPinned: true,
    pinSectionId: 'sec-maintenance',
    orderKey: '80',
  },
  // Local project: lody (incl. opened-by child)
  {
    id: 'local-lody-1',
    title: 'Sidebar Command 1–9 shortcut pills',
    kind: 'local',
    projectId: 'proj-lody',
    projectName: 'lody',
    branchName: 'feat/sidebar-shortcut-pills',
    latestMessageAt: NOW - 5 * MINUTE,
    isWorking: true,
    orderKey: '80',
  },
  {
    id: 'local-lody-child',
    title: 'Verify StyleX pill contrast in Storybook',
    kind: 'local',
    projectId: 'proj-lody',
    projectName: 'lody',
    openedBySessionId: 'local-lody-1',
    latestMessageAt: NOW - 6 * MINUTE,
    orderKey: '80a',
  },
  {
    id: 'local-lody-2',
    title: 'Approve prod DB migration plan',
    kind: 'local',
    projectId: 'proj-lody',
    projectName: 'lody',
    latestMessageAt: NOW - 35 * MINUTE,
    isWaitingPermission: true,
    orderKey: '81',
  },
  // Local project: loro (6 sessions -> folds at 5 with "Show all (6)")
  {
    id: 'local-loro-1',
    title: 'Benchmark movable list CRDT',
    kind: 'local',
    projectId: 'proj-loro',
    projectName: 'loro',
    latestMessageAt: NOW - 20 * MINUTE,
    orderKey: '82',
  },
  {
    id: 'local-loro-2',
    title: 'Add snapshot compaction tests',
    kind: 'local',
    projectId: 'proj-loro',
    projectName: 'loro',
    latestMessageAt: NOW - 1 * HOUR,
    orderKey: '83',
  },
  {
    id: 'local-loro-3',
    title: 'Fix WASM worker memory leak',
    kind: 'local',
    projectId: 'proj-loro',
    projectName: 'loro',
    latestMessageAt: NOW - 2 * HOUR,
    snoozedUntil: NOW + 3 * HOUR,
  },
  {
    id: 'local-loro-4',
    title: 'Audit Rust FFI error messages',
    kind: 'local',
    projectId: 'proj-loro',
    projectName: 'loro',
    latestMessageAt: NOW - 4 * HOUR,
    snoozedUntil: NOW + 14 * HOUR,
  },
  {
    id: 'local-loro-5',
    title: 'Document text diff events',
    kind: 'local',
    projectId: 'proj-loro',
    projectName: 'loro',
    latestMessageAt: NOW - 6 * HOUR,
    settledAt: NOW - 4 * HOUR,
  },
  {
    id: 'local-loro-6',
    title: 'Clean up deprecated v0.16 codecs',
    kind: 'local',
    projectId: 'proj-loro',
    projectName: 'loro',
    latestMessageAt: NOW - 10 * DAY,
  },
  // GitHub worktrees
  {
    id: 'gh-1',
    title: 'Fix OAuth refresh race condition',
    kind: 'github',
    repoFullName: 'lodyai/lody',
    branchName: 'fix/oauth-race',
    prStatus: 'open',
    prCiState: 's',
    prReadiness: 'y',
    prUrl: 'https://github.com/lodyai/lody/pull/412',
    latestMessageAt: NOW - 45 * MINUTE,
    hasUnreadMessages: true,
    orderKey: '84',
  },
  {
    id: 'gh-2',
    title: 'Refactor sidebar Status view',
    kind: 'github',
    repoFullName: 'loro-dev/loro',
    branchName: 'feat/status-view',
    prStatus: 'open',
    prCiState: 'p',
    prUrl: 'https://github.com/loro-dev/loro/pull/918',
    latestMessageAt: NOW - 3 * HOUR,
    orderKey: '85',
  },
  // Chats
  {
    id: 'chat-1',
    title: 'Plan Q4 keyboard navigation polish',
    kind: 'chat',
    latestMessageAt: NOW - 50 * MINUTE,
    orderKey: '86',
  },
  {
    id: 'chat-2',
    title: 'Draft onboarding copy review',
    kind: 'chat',
    latestMessageAt: NOW - 8 * DAY,
  },
];

function toUpdatedItem(s: PlaygroundSession): SidebarUpdatedItem {
  return {
    id: s.id,
    kind: s.kind,
    title: s.title,
    sectionLabel: s.repoFullName ?? s.projectName ?? 'Chats',
    subtitle: s.repoFullName ?? s.projectName ?? null,
    repoFullName: s.repoFullName ?? null,
    branchName: s.branchName ?? null,
    openedBySessionId: s.openedBySessionId ?? null,
    openedByRowSessionId: s.openedBySessionId ?? null,
    latestMessageAt: s.latestMessageAt,
    isPinned: s.isPinned,
    orderKey: s.orderKey ?? null,
    isWorking: s.isWorking,
    isWaitingPermission: s.isWaitingPermission,
    hasUnreadMessages: s.hasUnreadMessages,
    snoozedUntil: s.snoozedUntil ?? null,
    settledAt: s.settledAt ?? null,
    prStatus: s.prStatus,
    prCiState: s.prCiState,
    prReadiness: s.prReadiness,
    prUrl: s.prUrl,
  };
}

function toSessionMeta(s: PlaygroundSession): SessionMeta {
  return {
    id: s.id as SessionId,
    machineId: MACHINE_ID,
    createdAt: new Date(s.latestMessageAt - HOUR).toISOString(),
    lastMessageAt: s.latestMessageAt,
    lastReadAt: s.hasUnreadMessages ? s.latestMessageAt - HOUR : s.latestMessageAt,
    userId: 'user-demo',
    cliType: 'builtin',
    agentType: 'claude',
    title: s.title,
    branchName: s.branchName,
    isPinned: s.isPinned,
    openedBySessionId: s.openedBySessionId as SessionId | undefined,
    openedByRootSessionId: s.openedBySessionId as SessionId | undefined,
    isWorktree: Boolean(s.branchName),
  } as SessionMeta;
}

function toRepoRow(s: PlaygroundSession): SessionListRow {
  return {
    sessionId: s.id,
    title: s.title,
    repoFullName: s.repoFullName ?? null,
    branchName: s.branchName ?? '',
    prStatus: s.prStatus,
    prCiState: s.prCiState,
    prReadiness: s.prReadiness,
    prUrl: s.prUrl,
    latestMessageAt: s.latestMessageAt,
    addedLines: 42,
    deletedLines: 12,
    isWorking: Boolean(s.isWorking),
    hasUnreadMessages: Boolean(s.hasUnreadMessages),
    isOffline: false,
    isWaitingPermission: Boolean(s.isWaitingPermission),
    isPinned: s.isPinned,
    openedBySessionId: s.openedBySessionId ?? null,
    openedByRowSessionId: s.openedBySessionId ?? null,
  };
}

function PlaygroundContent() {
  const store = useMemo(() => createStore(), []);
  const [organizeMode, setOrganizeMode] = useState<LoroSidebarOrganizeMode>('workspace');
  const [platform, setPlatform] = useState<SidebarShortcutPlatform>(() =>
    isMac() ? 'mac' : 'windows'
  );
  const [lockOverlay, setLockOverlay] = useState(false);
  const [selectedId, setSelectedId] = useState<string>('local-lody-1');
  const [lastTriggerNote, setLastTriggerNote] = useState<string | null>(null);

  // Collapse & show-more state across all views
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [collapsedPinSectionIds, setCollapsedPinSectionIds] = useState<Record<string, boolean>>({});
  const [machineCollapsed, setMachineCollapsed] = useState(false);
  const [localProjectCollapsed, setLocalProjectCollapsed] = useState<Record<string, boolean>>({});
  const [githubSectionCollapsed, setGithubSectionCollapsed] = useState(false);
  const [repos, setRepos] = useState<SessionListRepoState[]>([
    { repoFullName: 'lodyai/lody', collapsed: false },
    { repoFullName: 'loro-dev/loro', collapsed: false },
  ]);
  const [chatsCollapsed, setChatsCollapsed] = useState(false);
  const [updatedBucketsCollapsed, setUpdatedBucketsCollapsed] = useState<
    Partial<Record<SidebarUpdatedBucketKey, boolean>>
  >({});
  const [updatedBucketsShowFull, setUpdatedBucketsShowFull] = useState<
    Partial<Record<SidebarUpdatedBucketKey, boolean>>
  >({});

  return (
    <Provider store={store}>
      <PlaygroundInner
        store={store}
        organizeMode={organizeMode}
        onOrganizeModeChange={setOrganizeMode}
        platform={platform}
        onPlatformChange={setPlatform}
        lockOverlay={lockOverlay}
        onLockOverlayChange={setLockOverlay}
        selectedId={selectedId}
        onSelectSession={setSelectedId}
        lastTriggerNote={lastTriggerNote}
        onLastTriggerNote={setLastTriggerNote}
        pinnedCollapsed={pinnedCollapsed}
        onTogglePinnedCollapsed={() => setPinnedCollapsed((prev) => !prev)}
        collapsedPinSectionIds={collapsedPinSectionIds}
        onTogglePinSection={(id) =>
          setCollapsedPinSectionIds((prev) => ({ ...prev, [id]: !prev[id] }))
        }
        machineCollapsed={machineCollapsed}
        onToggleMachineCollapsed={() => setMachineCollapsed((prev) => !prev)}
        localProjectCollapsed={localProjectCollapsed}
        onToggleLocalProjectCollapsed={(projectId) =>
          setLocalProjectCollapsed((prev) => ({ ...prev, [projectId]: !prev[projectId] }))
        }
        githubSectionCollapsed={githubSectionCollapsed}
        onToggleGithubSectionCollapsed={() => setGithubSectionCollapsed((prev) => !prev)}
        repos={repos}
        onToggleRepoCollapsed={(repoFullName) =>
          setRepos((prev) =>
            prev.map((repo) =>
              repo.repoFullName === repoFullName ? { ...repo, collapsed: !repo.collapsed } : repo
            )
          )
        }
        chatsCollapsed={chatsCollapsed}
        onToggleChatsCollapsed={() => setChatsCollapsed((prev) => !prev)}
        updatedBucketsCollapsed={updatedBucketsCollapsed}
        onToggleUpdatedBucket={(key) =>
          setUpdatedBucketsCollapsed((prev) => ({
            ...prev,
            [key]: !isSidebarBucketCollapsed(key, prev),
          }))
        }
        updatedBucketsShowFull={updatedBucketsShowFull}
        onToggleUpdatedShowFull={(key) =>
          setUpdatedBucketsShowFull((prev) => ({ ...prev, [key]: !prev[key] }))
        }
      />
    </Provider>
  );
}

function PlaygroundInner({
  store,
  organizeMode,
  onOrganizeModeChange,
  platform,
  onPlatformChange,
  lockOverlay,
  onLockOverlayChange,
  selectedId,
  onSelectSession,
  lastTriggerNote,
  onLastTriggerNote,
  pinnedCollapsed,
  onTogglePinnedCollapsed,
  collapsedPinSectionIds,
  onTogglePinSection,
  machineCollapsed,
  onToggleMachineCollapsed,
  localProjectCollapsed,
  onToggleLocalProjectCollapsed,
  githubSectionCollapsed,
  onToggleGithubSectionCollapsed,
  repos,
  onToggleRepoCollapsed,
  chatsCollapsed,
  onToggleChatsCollapsed,
  updatedBucketsCollapsed,
  onToggleUpdatedBucket,
  updatedBucketsShowFull,
  onToggleUpdatedShowFull,
}: {
  store: ReturnType<typeof createStore>;
  organizeMode: LoroSidebarOrganizeMode;
  onOrganizeModeChange: (mode: LoroSidebarOrganizeMode) => void;
  platform: SidebarShortcutPlatform;
  onPlatformChange: (platform: SidebarShortcutPlatform) => void;
  lockOverlay: boolean;
  onLockOverlayChange: (locked: boolean) => void;
  selectedId: string;
  onSelectSession: (id: string) => void;
  lastTriggerNote: string | null;
  onLastTriggerNote: (note: string) => void;
  pinnedCollapsed: boolean;
  onTogglePinnedCollapsed: () => void;
  collapsedPinSectionIds: Record<string, boolean>;
  onTogglePinSection: (id: string) => void;
  machineCollapsed: boolean;
  onToggleMachineCollapsed: () => void;
  localProjectCollapsed: Record<string, boolean>;
  onToggleLocalProjectCollapsed: (projectId: string) => void;
  githubSectionCollapsed: boolean;
  onToggleGithubSectionCollapsed: () => void;
  repos: SessionListRepoState[];
  onToggleRepoCollapsed: (repoFullName: string) => void;
  chatsCollapsed: boolean;
  onToggleChatsCollapsed: () => void;
  updatedBucketsCollapsed: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
  onToggleUpdatedBucket: (key: SidebarUpdatedBucketKey) => void;
  updatedBucketsShowFull: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
  onToggleUpdatedShowFull: (key: SidebarUpdatedBucketKey) => void;
}) {
  const showFullGroups = useAtomValue(sidebarShowFullListAtom);
  const setShowFullGroups = useSetAtom(sidebarShowFullListAtom);
  const collapsedOpenedBySessions = useAtomValue(sidebarCollapsedOpenedBySessionsAtom);
  const toggleOpenedBySession = useSetAtom(toggleSidebarCollapsedOpenedBySessionAtom);
  const overlayActive = useAtomValue(sidebarShortcutOverlayActiveAtom);

  useEffect(() => {
    store.set(sidebarShortcutPlatformOverrideAtom, platform);
  }, [platform, store]);

  useEffect(() => {
    store.set(sidebarShortcutOverlayActiveAtom, lockOverlay);
  }, [lockOverlay, store]);

  useSidebarShortcutHold({
    enabled: !lockOverlay,
  });

  const pinnedSessions = useMemo(() => DEMO_SESSIONS.filter((s) => s.isPinned), []);
  const unpinnedSessions = useMemo(() => DEMO_SESSIONS.filter((s) => !s.isPinned), []);

  const pinnedLayout = useMemo(() => {
    const byId = new Map(pinnedSessions.map((s) => [s.id, s]));
    return buildPinnedSectionLayout(
      pinnedSessions.map(toUpdatedItem),
      INITIAL_PIN_SECTIONS,
      (item): PinnedSessionPlacement => {
        const meta = byId.get(item.id);
        return {
          id: item.id,
          pinSectionId: meta?.pinSectionId ?? null,
          orderKey: meta?.orderKey ?? null,
          recency: meta?.latestMessageAt ?? 0,
        };
      }
    );
  }, [pinnedSessions]);

  const pinnedSections = useMemo(
    () =>
      pinnedLayout.map((entry) => ({
        id: entry.sectionId,
        name: entry.section?.name ?? '',
        items: entry.items,
      })),
    [pinnedLayout]
  );

  const updatedItems = useMemo(() => unpinnedSessions.map(toUpdatedItem), [unpinnedSessions]);

  const repoRows = useMemo(
    () => unpinnedSessions.filter((s) => s.kind === 'github').map(toRepoRow),
    [unpinnedSessions]
  );
  const chatRows = useMemo(
    () => unpinnedSessions.filter((s) => s.kind === 'chat').map(toRepoRow),
    [unpinnedSessions]
  );
  const localMetasByProject = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    for (const project of DEMO_PROJECTS) {
      map.set(
        project.id,
        unpinnedSessions
          .filter((s) => s.kind === 'local' && s.projectId === project.id)
          .map(toSessionMeta)
      );
    }
    return map;
  }, [unpinnedSessions]);
  const liveStatuses = useMemo(() => {
    const map = new Map<string, SessionStatus>();
    for (const s of DEMO_SESSIONS) {
      if (s.isWaitingPermission) map.set(s.id, { type: 'requestPermission' });
      else if (s.isWorking) map.set(s.id, { type: 'running' });
    }
    return map;
  }, []);
  const emptyChildren = useMemo(() => new Map<string, SessionMeta[]>(), []);

  const navItems = useMemo(
    () =>
      buildSidebarNavigationItems({
        organizeMode,
        showFullSessionGroups: showFullGroups,
        collapsedOpenedBySessions,
        pinnedSections: pinnedSections.map((section) => ({
          id: section.id,
          items: section.items,
          collapsed:
            section.id === null ? pinnedCollapsed : collapsedPinSectionIds[section.id] === true,
        })),
        workspace: {
          localSections: [
            {
              collapsed: machineCollapsed,
              projects: DEMO_PROJECTS.map((project) => ({
                machineId: MACHINE_ID,
                localProjectId: project.id,
                collapsed: localProjectCollapsed[project.id] === true,
                showFull:
                  showFullGroups[getLocalProjectSessionGroupKey(MACHINE_ID, project.id)] === true,
                sessions: (localMetasByProject.get(project.id) ?? []).map((meta) => ({
                  id: meta.id,
                  openedByRowSessionId: meta.openedByRootSessionId ?? null,
                  rootRankMs: typeof meta.lastMessageAt === 'number' ? meta.lastMessageAt : 0,
                })),
              })),
            },
          ],
          githubSectionCollapsed,
          repoSessions: repoRows,
          repos,
          chatSessions: chatRows,
          chatsCollapsed,
        },
        updated: {
          items: updatedItems,
          collapsedBuckets: updatedBucketsCollapsed,
          showFullBuckets: updatedBucketsShowFull,
        },
      }),
    [
      chatRows,
      chatsCollapsed,
      collapsedOpenedBySessions,
      collapsedPinSectionIds,
      githubSectionCollapsed,
      localMetasByProject,
      localProjectCollapsed,
      machineCollapsed,
      organizeMode,
      pinnedCollapsed,
      pinnedSections,
      repoRows,
      repos,
      showFullGroups,
      updatedBucketsCollapsed,
      updatedBucketsShowFull,
      updatedItems,
    ]
  );

  useEffect(() => {
    store.set(sidebarNavItemsAtom, navItems);
  }, [navItems, store]);

  const slotSessionIds = useMemo(() => getVisibleSidebarShortcutSessionIds(navItems), [navItems]);
  const sessionById = useMemo(() => new Map(DEMO_SESSIONS.map((s) => [s.id, s])), []);

  const triggerSlot = useCallback(
    (slot: number, source: 'keyboard' | 'click') => {
      const targetId = slotSessionIds[slot - 1];
      if (!targetId) return;
      onSelectSession(targetId);
      const targetTitle = sessionById.get(targetId)?.title ?? targetId;
      const label = platform === 'mac' ? `⌘${slot}` : `Control+${slot}`;
      onLastTriggerNote(`${label} (${source}) → ${targetTitle}`);
    },
    [onLastTriggerNote, onSelectSession, platform, sessionById, slotSessionIds]
  );

  // Story-local keyboard listener so Cmd+1..9 / Ctrl+1..9 can be tested directly
  // inside Storybook (Electron handles these via the command registry).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.shiftKey) return;
      const targetModifierMatch =
        platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!targetModifierMatch) return;
      const digitMatch = /^[1-9]$/.exec(event.key) ?? /^Digit([1-9])$/.exec(event.code);
      if (!digitMatch) return;
      const digit = Number(digitMatch[1] ?? digitMatch[0]);
      if (digit < 1 || digit > 9 || digit > slotSessionIds.length) return;
      event.preventDefault();
      triggerSlot(digit, 'keyboard');
    };
    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true });
  }, [platform, slotSessionIds.length, triggerSlot]);

  const toggleProjectFullList = useCallback(
    (groupKey: string) => {
      setShowFullGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
    },
    [setShowFullGroups]
  );

  const topContent = (
    <div>
      <div className={machineCollapsed ? 'mb-1 space-y-0.5' : 'mb-4 space-y-0.5'}>
        <SidebarSectionHeader
          label="Mac Studio"
          collapsed={machineCollapsed}
          toggleLabel="Toggle Mac Studio"
          onToggleCollapsed={onToggleMachineCollapsed}
        />
        {machineCollapsed ? null : (
          <div className="space-y-0.5">
            {DEMO_PROJECTS.map((project) => {
              const groupKey = getLocalProjectSessionGroupKey(MACHINE_ID, project.id);
              return (
                <LocalProjectItem
                  key={project.id}
                  machineId={MACHINE_ID}
                  machineName="Mac Studio"
                  project={project}
                  canRemoveProject={false}
                  collapsed={localProjectCollapsed[project.id] === true}
                  whetherShowFullList={showFullGroups[groupKey] === true}
                  isSelected={false}
                  sessionsForProject={localMetasByProject.get(project.id) ?? []}
                  childSessionsByParent={emptyChildren}
                  liveSessionStatuses={liveStatuses}
                  formattedPath={project.rootPath ?? null}
                  defaultSessionTitle="Untitled"
                  selectedSessionId={selectedId}
                  removeProjectLabel="Remove project"
                  archiveTooltipLabel="Archive"
                  archiveActionLabel="Archive"
                  archiveConfirmLabel="Confirm"
                  isMobile={false}
                  toggleLabel="Toggle"
                  onNavigateProject={() => {}}
                  onNavigateSession={(id) => onSelectSession(id)}
                  onArchive={() => {}}
                  collapsedOpenedBySessionIds={collapsedOpenedBySessions}
                  onToggleOpenedBySessions={toggleOpenedBySession}
                  onToggleCollapsed={(_m, pId) => onToggleLocalProjectCollapsed(pId)}
                  onToggleFullList={toggleProjectFullList}
                  onRequestRemoval={() => {}}
                />
              );
            })}
          </div>
        )}
      </div>

      <SidebarSectionHeader
        label="GitHub Worktrees"
        collapsed={githubSectionCollapsed}
        toggleLabel="Toggle GitHub Worktrees"
        onToggleCollapsed={onToggleGithubSectionCollapsed}
      />
    </div>
  );

  const afterSessionListContent = (
    <SessionList
      className={chatsCollapsed ? 'mb-1' : 'mb-3'}
      sessions={chatRows}
      repos={[]}
      chatsCollapsed={chatsCollapsed}
      selectedSessionId={selectedId}
      onSelectSession={(id) => onSelectSession(id)}
      onToggleChatsCollapsed={onToggleChatsCollapsed}
    />
  );

  const selectedSession = sessionById.get(selectedId);

  return (
    <div className="flex h-[740px] w-full bg-background text-foreground">
      <LoroSidebar
        workspaceName="Lody"
        userEmail="alex@lody.ai"
        workspaces={[{ id: 'ws-1', name: 'Lody' }]}
        currentWorkspaceId="ws-1"
        organizeMode={organizeMode}
        onOrganizeModeChange={onOrganizeModeChange}
        showUpdatedProjectNames
        pinnedSections={pinnedSections}
        pinnedSectionCollapsed={pinnedCollapsed}
        onTogglePinnedSection={onTogglePinnedCollapsed}
        collapsedPinSectionIds={collapsedPinSectionIds}
        onTogglePinSection={onTogglePinSection}
        topContent={topContent}
        sessionListProps={{
          sessions: githubSectionCollapsed ? [] : repoRows,
          repos: githubSectionCollapsed ? [] : repos,
          selectedSessionId: selectedId,
          onSelectSession: (id) => onSelectSession(id),
          onToggleRepoCollapsed,
        }}
        afterSessionListContent={afterSessionListContent}
        updatedItems={updatedItems}
        updatedSelectedItemId={selectedId}
        updatedBucketsCollapsed={updatedBucketsCollapsed}
        updatedShowFullBuckets={updatedBucketsShowFull}
        onToggleUpdatedBucket={onToggleUpdatedBucket}
        onToggleUpdatedShowFullBucket={onToggleUpdatedShowFull}
        onSelectUpdatedItem={(id) => onSelectSession(id)}
      />

      <div className="flex flex-1 flex-col gap-5 overflow-y-auto border-l border-border/60 p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
          <div>
            <div className="text-xs font-medium text-muted-foreground">Active Session</div>
            <div className="mt-0.5 text-base font-semibold">
              {selectedSession ? selectedSession.title : selectedId}
            </div>
            {lastTriggerNote ? (
              <div className="mt-1 text-xs text-muted-foreground">
                Last trigger: {lastTriggerNote}
              </div>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-0.5">
              {(
                [
                  { id: 'workspace', label: 'Project' },
                  { id: 'updated', label: 'Updated' },
                  { id: 'status', label: 'Status' },
                ] as const
              ).map((mode) => (
                <Button
                  key={mode.id}
                  type="button"
                  size="small"
                  variant={organizeMode === mode.id ? 'secondary' : 'ghost'}
                  onClick={() => onOrganizeModeChange(mode.id)}
                >
                  {mode.label}
                </Button>
              ))}
            </div>

            <div className="inline-flex rounded-lg border border-border/70 bg-muted/40 p-0.5">
              {(
                [
                  { id: 'mac', label: 'macOS (⌘)' },
                  { id: 'windows', label: 'Windows (Control)' },
                ] as const
              ).map((item) => (
                <Button
                  key={item.id}
                  type="button"
                  size="small"
                  variant={platform === item.id ? 'secondary' : 'ghost'}
                  onClick={() => onPlatformChange(item.id)}
                >
                  {item.label}
                </Button>
              ))}
            </div>

            <Button
              type="button"
              size="small"
              variant={lockOverlay ? 'primary' : 'secondary'}
              onClick={() => onLockOverlayChange(!lockOverlay)}
            >
              {lockOverlay
                ? 'Release Pill Preview'
                : platform === 'mac'
                  ? 'Pin ⌘ Pills'
                  : 'Pin Control Pills'}
            </Button>
          </div>
        </div>

        <div className="space-y-2 text-xs text-muted-foreground">
          <p>
            Hold{' '}
            <strong className="text-foreground">
              {platform === 'mac' ? 'Command (⌘)' : 'Control'}
            </strong>{' '}
            for 150ms to reveal the shortcut pills on the first 9 visible rows across expanded
            sections. Overlay status:{' '}
            <strong className="text-foreground">
              {overlayActive ? 'Visible' : 'Hidden (hold modifier or click Pin Pills)'}
            </strong>
            .
          </p>
          <p>
            Collapse/expand any section (Pinned, Maintenance, Mac Studio, projects, GitHub repos,
            Focus, Later, Settled, Chats) or click <em>Show all</em> to see slots 1–9 adapt live.
            Note: web browsers reserve <code>⌘1–⌘9</code> for browser tabs, so use{' '}
            <code>Control+1–9</code> in Windows mode or click any slot below to test switching.
          </p>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            Current Visible Top-9 Mapping (Click to simulate shortcut)
          </div>
          <div className="grid max-w-xl gap-1.5">
            {slotSessionIds.map((id, index) => {
              const slot = index + 1;
              const session = sessionById.get(id);
              const isSelected = id === selectedId;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => triggerSlot(slot, 'click')}
                  className="flex items-center justify-between gap-3 rounded-lg border border-border/60 px-3 py-2 text-left text-xs transition-colors hover:bg-muted/50"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className={
                        isSelected
                          ? 'h-1.5 w-1.5 shrink-0 rounded-full bg-primary'
                          : 'h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/30'
                      }
                    />
                    <span className="truncate font-medium text-foreground">
                      {session?.title ?? id}
                    </span>
                    <span className="shrink-0 text-muted-foreground">
                      ({session?.repoFullName ?? session?.projectName ?? 'Chats'})
                    </span>
                  </span>
                  <SidebarShortcutPill index={slot} platform={platform} animate={false} />
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Interactive sidebar playground: switch between Project / Updated / Status views,
 * toggle macOS vs Windows pills, hold Command/Control for 150ms, and fold/unfold
 * sections to feel how 1–9 adapts to visible rows.
 */
export const InteractiveSidebar: Story = {
  render: () => <PlaygroundContent />,
};
