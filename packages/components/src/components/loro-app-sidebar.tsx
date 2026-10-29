import { openSessionOnModifiedClick } from '@/lib/desktop-window';
import { buildSessionLink } from '@lody/shared/session-link';
import { jsonValueEqual } from '@/lib/json-value-equal';
import { usePostHog } from '@posthog/react';
import { capturePostHogEvent } from '@/lib/posthog-analytics';
import { SessionWindowMenuItem } from './session-window-menu-item';
import { SIDEBAR_ROW_LINE_CLASS } from './sidebar-surface';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { startSessionMentionDrag } from '@/lib/session-mention-drag';
import {
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useSidebarKeyboardNav } from '@/hooks/use-sidebar-keyboard-nav';
import { useLocation, useRouter } from '@tanstack/react-router';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  findFreshSessionPresenceState,
  machineSupportsLocalProjectRemovalProtocol,
  resolveProjectGitHubRepo,
  resolveSessionHistoryBackendKind,
  type LocalProjectId,
  type LocalProjectMeta,
  type MachineId,
  type PrStatus,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
} from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAppCapability } from '@/lib/app-platform';
import { useCloudQuery } from '@lody/platform/react';
import { resolveWorkspaceIdentityLogo } from '@/lib/workspace-identity';
import {
  SidebarMachineHoverCard,
  SidebarMachineOfflinePill,
  type SidebarMachineInfo,
} from '@/components/sidebar-machine-card';
import { cn } from '@/lib/utils';
import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeSpace,
  themeRadius,
  themeFontWeight,
  themeDuration,
  themeEasing,
} from '../style/theme-scale.stylex';
/**
 * The parts of the app sidebar that were Tailwind. The rows' own box, ink and
 * fills come from sidebarSurface; these are the pieces around it.
 */
const appStyles = stylex.create({
  rowBox: {
    width: '100%',
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    textAlign: 'left',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'transparent',
    backgroundColor: 'transparent',
  },
  rowNormalPadding: { paddingBlock: themeSpace[1] },
  rowMetaPadding: { paddingBlock: themeSpace[1.5] },
  rowInk: { color: themeColors.sidebarRowForeground },
  rowHover: { backgroundColor: { default: 'transparent', ':hover': themeColors.sidebarHover } },
  projectHover: {
    color: {
      default: themeColors.sidebarRowForeground,
      ':hover': themeColors.sidebarHoverForeground,
    },
  },
  rowSelected: {
    backgroundColor: {
      default: themeColors.sidebarSelection,
      ':hover': themeColors.sidebarSelection,
    },
    color: themeColors.sidebarSelectionForeground,
  },
  projectSelected: { borderColor: 'hsl(var(--sidebar-ring) / 0.3)' },
  projectRow: {
    position: 'relative',
    display: 'flex',
    minWidth: 0,
    flex: '1 1 0%',
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[2],
    fontWeight: themeFontWeight.normal,
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  navigable: { cursor: 'pointer' },
  inert: { cursor: 'default' },
  muted: { color: themeColors.mutedForeground },
  flexRow: { display: 'flex', alignItems: 'center' },
  rowLayout: { display: 'flex' },
  rowTop: { alignItems: 'flex-start' },
  rowCenter: { alignItems: 'center' },
  gapMobile: { gap: themeSpace[1.5] },
  gapDesktop: { gap: themeSpace[2] },
  lineBox: { display: 'flex', flexShrink: 0, alignItems: 'center' },
  contents: { display: 'contents' },
  titleColumn: {
    display: 'flex',
    minWidth: 0,
    flex: '1 1 0%',
    flexDirection: 'column',
    gap: themeSpace[1],
  },
  titleContent: {
    minWidth: 0,
    flex: '1 1 0%',
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1],
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'currentColor',
  },
  projectTitle: {
    minWidth: 0,
    flex: '1 1 0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'left',
  },
  mobileTime: {
    marginLeft: 'auto',
    display: 'flex',
    flexShrink: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1],
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.mutedForeground,
  },
  restMarks: { display: 'flex', alignItems: 'center', gap: themeSpace[1.5] },
  folderGlyph: {
    position: 'absolute',
    left: 0,
    top: '50%',
    height: themeSpace[4],
    width: themeSpace[4],
    translate: '0 -50%',
    transitionProperty: 'opacity,color',
    transitionDuration: themeDuration[100],
    transitionTimingFunction: themeEasing['in-out'],
  },
  chevronGlyph: {
    position: 'absolute',
    left: 0,
    top: '50%',
    height: themeSpace[4],
    width: themeSpace[4],
    translate: '0 -50%',
    color: 'currentColor',
    transitionProperty: 'opacity,translate,scale,rotate',
    transitionDuration: themeDuration[100],
    transitionTimingFunction: themeEasing['in-out'],
  },
  currentInk: { color: 'currentColor' },
  folderIdle: { color: themeColors.sidebarForegroundMuted },
  hidden: { opacity: 0 },
  shown: { opacity: 1 },
  collapsedChevron: { rotate: '-90deg' },
  expandedChevron: { rotate: '0deg' },
  removalStatus: {
    display: 'inline-flex',
    minWidth: 0,
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
  },
  projectListSpacing: { marginBottom: { default: themeSpace[0.5], ':last-child': 0 } },
  groupCollapsedSpacing: { marginBottom: themeSpace[1] },
  groupOpenSpacing: { marginBottom: themeSpace[4] },
  chatsOpenSpacing: { marginBottom: themeSpace[3] },
  tooltipLines: { display: 'flex', flexDirection: 'column', gap: themeSpace[0.5] },
  mono: {
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
  },
  showMore: {
    display: 'flex',
    height: '30px',
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.md,
    paddingInline: themeSpace[2],
    textAlign: 'left',
    color: {
      default: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
      ':hover': themeColors.sidebarHoverForeground,
    },
    backgroundColor: { default: null, ':hover': themeColors.sidebarHover },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  sortable: { width: '100%', marginBottom: { default: themeSpace[0.5], ':last-child': 0 } },
  headerActions: { display: 'flex', alignItems: 'center', gap: themeSpace[1] },
  sectionLabel: { display: 'inline-flex', minWidth: 0, alignItems: 'center', gap: themeSpace[1.5] },
  focusScope: {
    position: 'relative',
    display: 'flow-root',
    backgroundColor: themeColors.background,
  },
  shellFill: { width: '100%', height: '100%' },
  desktopFill: { backgroundColor: themeColors.sidebar },
  electronShell: { zIndex: 20 },
  /**
   * The focus state these controls had before the migration. The hover
   * actions carried `focus-visible:ring-2 focus-visible:ring-ring/60` and the
   * group's "show more" row carried
   * `focus-visible:ring-2 focus-visible:ring-sidebar-ring/40`. Each of them
   * declared a full box-shadow in the utilities layer, which erased the app's
   * global inset focus ring, and the app forces Tailwind's own ring
   * transparent — so the focused control painted NO focus indicator of its
   * own. Keep that: no resting shadow, and no focus shadow.
   */
  noFocusRing: { boxShadow: { default: null, ':focus-visible': 'none' } },
  glyph16: { width: themeSpace[4], height: themeSpace[4] },
  /** A title the row owns: one clipped line, regular weight. */
  titleText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: 400,
  },
  glyph12: { width: themeSpace[3], height: themeSpace[3] },
  waitingGlyph: { flexShrink: 0 },
  glyph14: { width: themeSpace[3.5], height: themeSpace[3.5] },
  glyphBox16: {
    display: 'flex',
    width: themeSpace[4],
    height: themeSpace[4],
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** A muted glyph that never changes colour. */
  mutedGlyph12: {
    width: themeSpace[3],
    height: themeSpace[3],
    flexShrink: 0,
    color: 'hsl(var(--sidebar-foreground-muted) / 0.8)',
  },
  /** A row's leading slot. */
  leadingSlot: {
    position: 'relative',
    marginRight: '-0.375rem',
    display: 'flex',
    height: themeSpace[5],
    width: themeSpace[5],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** A row's trailing cluster. */
  trailing: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: themeSpace[0.5] },
  /** A row's own title. */
  titleRow: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%', textAlign: 'left' },
  /** A clipped label. */
  clipped: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** A capped label: a long name gives up its tail. */
  clippedCapped: {
    maxWidth: '6rem',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The archive action's own fill. */
  archiveAction: {
    backgroundColor: themeColors.sidebarHover,
    color: themeColors.sidebarHoverForeground,
  },
  /** A drag handle's own box. */
  dragHandle: {
    cursor: { default: 'grab', ':active': 'grabbing' },
    touchAction: 'none',
  },
  /** A row being dragged. */
  dragging: { zIndex: 10, opacity: 0.6 },
});
import {
  SIDEBAR_ROW_TEXT_CLASS,
  SIDEBAR_CAPTION_TEXT_CLASS,
  SIDEBAR_HELPER_TEXT_CLASS,
} from './sidebar-row-shared';
import { formatCompactRelativeTime } from '@/lib/format-relative-time';
import { isElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { WindowDragStrip } from '@/ui/window-drag-region';
import { getIpcServices } from '@/lib/electron-ipc-client';
import { formatSessionTabSearch } from '@/lib/session-tab-url';
import { openExternalUrl } from '@/lib/native-browser';
import { getChangelogUrl } from '@/lib/lody-urls';
import { getCachedWorkspaceName } from '@/lib/local-storage-cache';
import {
  languageAtom,
  ONLY_CHATS_KEY,
  sessionSidebarCodeChangesOnlyAtom,
  sidebarCollapsedOpenedBySessionsAtom,
  toggleSidebarCollapsedOpenedBySessionAtom,
  sidebarShowFullListAtom,
  setMobileDrawerOpenAtom,
  userAtom,
  WORKSPACE_FOCUS_SCOPES,
} from '@/atoms';
import {
  activeWorkspaceRuntimeAtom,
  workspaceRuntimeInitFailureAtom,
  bugReportDialogOpenAtom,
  joinCommunityDialogOpenAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  setWorkspaceContextAtom,
} from '@/atoms';
import { docMetaCacheScopeAtom } from '@/atoms/doc-meta';
import { useWorkspaceRouteTargetSlug } from '../providers/workspace-route-target';
import { resolveWorkspaceDataScope } from '@/lib/workspace-data-scope';

import { lodyConnectionUiStateAtom } from '@/atoms/control-connection';
import { lastKnownLocalMachineIdAtom, localMachineIdAtom } from '@/atoms/local-probe';
import { compareSidebarMachineOrder } from './sidebar-machine-order';
import { getLocalProjectVisibilityKey } from '@/lib/visible-local-project-index';
import { selectAndWriteLocalProject } from '@/lib/local-project-import';
import { importSidebarLocalProject } from '@/components/sidebar-local-project-import';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import { useArchiveSessionWithConfirmation } from '@/components/sessions/session-archive-confirmation';
import {
  chatScopeAtom,
  chatsCollapsedAtom,
  githubWorktreesSectionCollapsedAtom,
  projectGroupOrderAtom,
  localProjectCollapseStateAtom,
  localProjectOrderAtom,
  moveLocalProjectOrder,
  localProjectsSectionCollapseStateAtom,
  pinnedSectionCollapsedAtom,
  repoCollapseStateAtom,
  repoOrderAtom,
  sidebarCollapsedAtom,
  sidebarLastWidthAtom,
  sidebarOrganizeModeAtom,
  sidebarShowBranchNamesAtom,
  sidebarUpdatedShowProjectNamesAtom,
  sidebarUpdatedBucketCollapseStateAtom,
  sidebarUpdatedBucketShowFullStateAtom,
  type SidebarOrganizeMode,
} from '@/atoms/sidebar-state';
import {
  sortUpdatedItems,
  type SidebarUpdatedBucketKey,
  type SidebarUpdatedItem,
} from '@/components/sidebar-updated-session-list';
import { SidebarUpdateBanner } from '@/components/sidebar-update-banner';
import { UpdateChangelogDialog } from '@/components/update-changelog-dialog';
import { pickLocalizedReleaseNotes, readUpdateBannerState } from '@/lib/electron-update-banner';
import { useElectronUpdaterState } from '@/hooks/use-electron-updater-state';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { canManageWorkspaceProject, useWorkspaceProjects } from '@/hooks/use-workspace-projects';
import { useOrganization } from '@/hooks/useOrganization';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { useReportVisibleSessionsForEagerSync } from '@/hooks/use-report-visible-sessions-for-eager-sync';
import { SidebarVisibilityGate } from './sidebar-visibility-gate';
import {
  LoroSidebar,
  type LoroSidebarLabels,
  type LoroSidebarWorkspace,
} from '@/components/loro-sidebar';
import { SidebarFilterPopover } from '@/components/sidebar-filter-popover';
import { Button } from '@lody/ui/button';
import { ContextMenu } from '@lody/ui/context-menu';
import { Tooltip } from '@lody/ui/tooltip';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';
import { SwipeActionRow } from '@/components/shared/swipe-action-row';
import {
  MAX_VISIBLE_SESSIONS,
  SessionList,
  shallowEqualExceptKeys,
  type SessionListPullRequestOpen,
  getProjectGroupSessionGroupKey,
  type SessionListProjectGroupState,
  type SessionListRepoMove,
  type SessionListRepoState,
  type SessionListRow,
} from '@/components/session-list';
import { projectEditorRequestAtom } from '@/atoms/project-editor';
import { placeProjectGroups } from '@/lib/project-group-placement';
import {
  buildChildSessionsByParent,
  buildSessionListRows,
  buildSidebarOpenerRowResolver,
  getEffectiveSessionActivitySummary,
  getEffectiveLatestMessageAt,
  getLatestPullRequestInfo,
  type EffectiveSessionActivitySummary,
  type SessionListScope,
} from './sessions/session-list-rows';
import { getSelectedLocalProjectKey } from './chat/chat-landing-derived';
import { useSessionActions } from '@/hooks/use-session-actions';
import {
  useLocalProjectRemovalResultNotifications,
  usePendingLocalProjectRemovals,
  useRemoveLocalProject,
} from '@/hooks/use-remove-local-project';
import {
  Archive,
  ChevronDown,
  Clock3,
  Folder,
  FolderPlus,
  Link2,
  LockKeyhole,
  Mail,
  FolderOpen,
  GripVertical,
  MoreHorizontal,
  Settings2,
  Folders,
  Pencil,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
  Users,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { toast } from '@/lib/toast';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useStableNow } from '@/hooks/use-stable-now';
import { useSidebarWorkspaceNavigation } from './sidebar-workspaces';
import {
  SessionOpenedByTreeRow,
  SessionPrIcon,
  SessionRowAuthorAvatar,
  SessionRowLeadingSlot,
  SessionRowWorktreeIndicator,
  SidebarRowArchiveButton,
  SidebarRowEndSlot,
  SidebarSectionHeader,
  SidebarGroupActivityMark,
  SidebarSessionMetaLine,
  SessionRowOpenedByMenuItems,
  buildSessionRowOpenedByTreeSlot,
  summarizeSidebarGroupActivity,
  useSessionUnsentNewConversation,
  useSidebarGroupActivityDescription,
  withSessionSendStates,
  type SessionRowOpenedByTreeSlot,
  type SidebarGroupActivity,
  SIDEBAR_HOVER_ACTION_CLASS,
  SIDEBAR_MENU_TRIGGER_OPEN_CLASS,
  SIDEBAR_ROW_LIST_CLASS,
  SIDEBAR_UNSENT_TITLE_CLASS,
} from '@/components/sidebar-row-shared';
import { sessionSendStatesAtom } from '@/atoms/session-send-status';
import type { SessionSendState } from '@/lib/session-send-status';
import {
  buildOpenedBySessionTree,
  countOpenedByTreeRoots,
  hasOpenedByTreeNesting,
  normalizeSessionRowId,
} from '@/lib/session-opened-by-tree';
import { SessionInfoHoverCard } from '@/components/session-info-hover-card';
import { SessionShareDialog } from '@/components/session-sharing';
import type { SessionSharingState } from '@/lib/session-sharing';
import { useSessionSharing } from '@/hooks/use-session-sharing';
import {
  buildSidebarNavigationItems,
  getLocalProjectSessionGroupKey,
  type SidebarNavigationLocalSection,
} from '@/components/sidebar-navigation-model';
import {
  RenameSessionDialogView,
  type RenameSessionDialogTarget,
} from '@/components/sessions/rename-session-dialog';

/** A machine's sidebar label: its name without the mDNS `.local` suffix. */
const sidebarMachineLabel = (name: string): string => name.trim().replace(/\.local$/i, '');

/**
 * Space below a top-level group (a machine, GitHub Worktrees): 16px when open,
 * wider than the 12px between repo groups inside a section and far wider than
 * the 2px from a header to its first row, so each header binds to its rows.
 */
// No `last:mb-0`: the last machine group is followed by GitHub Worktrees and
// Chats, which need the same gap as between machines.
const SIDEBAR_TOP_GROUP_SPACING = (collapsed: boolean) =>
  stylex.props(collapsed ? appStyles.groupCollapsedSpacing : appStyles.groupOpenSpacing).className;

export type LoroAppSidebarProps = {
  className?: string;
  /** Desktop retained sidebar pauses sidebar-only sources while hidden. */
  pauseSidebarSourcesWhenHidden?: boolean;
  /**
   * Overlay presentation for the compact desktop layout: the sidebar is a
   * floating sheet whose width the caller's wrapper owns, so it drops its
   * resizable inline width and the resize sash. Desktop chrome (header,
   * shortcuts, context menus) is unchanged — this is NOT the mobile drawer.
   */
  overlay?: boolean;
};

type LocalProjectRemovalRequest = {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  name: string;
  originalRootPath?: string | null;
};

export type LocalProjectRemovalState = 'removing' | 'waiting_for_device';

type PendingSessionShare = {
  sessionId: string;
  title: string;
  sharing: SessionSharingState;
};

const DOCS_LINK_FALLBACK_ORIGIN = 'https://lody.ai';
const SIDEBAR_RELATIVE_TIME_REFRESH_MS = 30_000;
const EMPTY_SESSION_SHARING_BY_ID: ReadonlyMap<string, SessionSharingState> = new Map();

function getDocsLinkOrigin(): string {
  const configuredSiteUrl = import.meta.env.VITE_SITE_URL?.trim();
  if (configuredSiteUrl) {
    try {
      return new URL(configuredSiteUrl).origin;
    } catch {
      // Ignore malformed env value and fall back to default site origin.
    }
  }
  return DOCS_LINK_FALLBACK_ORIGIN;
}

function getStableRepoFullNames(tasks: { repoFullName?: string | null }[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];

  for (const task of tasks) {
    const repoFullName = typeof task.repoFullName === 'string' ? task.repoFullName.trim() : '';
    if (!repoFullName) continue;
    if (seen.has(repoFullName)) continue;
    seen.add(repoFullName);
    ordered.push(repoFullName);
  }

  return ordered;
}

function getSelectedSessionId(pathname: string, workspaceSlug: string | null): string | null {
  const workspacePrefix = workspaceSlug ? `/${workspaceSlug}` : '';
  const normalizedPath =
    workspaceSlug && pathname.startsWith(workspacePrefix)
      ? pathname.slice(workspacePrefix.length) || '/'
      : pathname;

  const segments = normalizedPath.split('/').filter(Boolean);
  if (segments[0] !== 'sessions') return null;

  const sessionId = segments[1];
  return sessionId ? sessionId : null;
}

function isHomeRoute(pathname: string, workspaceSlug: string | null): boolean {
  const workspacePrefix = workspaceSlug ? `/${workspaceSlug}` : '';
  const normalizedPath =
    workspaceSlug && pathname.startsWith(workspacePrefix)
      ? pathname.slice(workspacePrefix.length) || '/'
      : pathname;

  return normalizedPath.startsWith('/chat');
}

function isArchiveRoute(pathname: string, workspaceSlug: string | null): boolean {
  const workspacePrefix = workspaceSlug ? `/${workspaceSlug}` : '';
  const normalizedPath =
    workspaceSlug && pathname.startsWith(workspacePrefix)
      ? pathname.slice(workspacePrefix.length) || '/'
      : pathname;

  return normalizedPath.startsWith('/archive');
}

const isElectronMacOS =
  typeof window !== 'undefined' &&
  window.__LODY_ELECTRON__ === true &&
  window.__LODY_PLATFORM__?.os === 'darwin';

const isElectron = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;

// ---------------------------------------------------------------------------
// Extracted memoized sub-components for local project sidebar sections
// ---------------------------------------------------------------------------

type LocalProjectSessionItemProps = {
  session: SessionMeta;
  isWorking: boolean;
  isWaitingPermission: boolean;
  hasUnreadMessages: boolean;
  /**
   * Effective "last activity" timestamp rolled up across the session and its
   * sub-sessions. Owned by the sidebar so each row stays a pure renderer.
   */
  effectiveLatestMessageAt: number;
  defaultSessionTitle: string;
  /** Local project folder name, shown in the desktop hover info card. */
  projectName: string;
  /** Name of the machine hosting the project, shown in the hover info card. */
  machineName?: string | null;
  /** Conversation creator, shown as the card's Author row (team scope only). */
  author?: { name?: string | null; image?: string | null } | null;
  /** Whether this row is the currently-open session (drives selected styling). */
  isSelected: boolean;
  workspaceSlug: string | null;
  onNavigate: (sessionId: string, tabSessionId?: string) => void;
  onArchive: (sessionId: string) => void;
  onMarkUnread?: (sessionId: string) => void;
  onRename?: (sessionId: string, nextTitle: string) => void | Promise<void>;
  onTogglePinned?: (sessionId: string, nextPinned: boolean) => void;
  onCopyUrl?: (sessionId: string) => void;
  onShareWithTeam?: (sessionId: string) => void;
  /**
   * Session that opened this one (`SessionMeta.openedBySessionId`). Present on
   * MCP-created independent Sessions; drives the row's "go back to the opener"
   * menu action even when the opener is not visible in this project list.
   */
  openerSessionId?: string | null;
  /** Root route that owns `openerSessionId` when it is a child Tab. */
  openerRootSessionId?: string | null;
  openedByTree?: SessionRowOpenedByTreeSlot;
  /** The previous visible row is a top-level one, so this is its first child. */
  followsOpener?: boolean;
  /** The first child follows a local worktree opener, which has the taller metadata line. */
  followsTallOpener?: boolean;
  sharing?: SessionSharingState;
  archiveTooltipLabel: string;
  archiveActionLabel: string;
  archiveConfirmLabel: string;
  isMobile: boolean;
};

const LocalProjectSessionItem = memo(function LocalProjectSessionItem({
  session,
  isWorking,
  isWaitingPermission,
  hasUnreadMessages,
  effectiveLatestMessageAt,
  defaultSessionTitle,
  projectName,
  machineName,
  author,
  isSelected,
  onNavigate,
  onArchive,
  onMarkUnread,
  onRename,
  onTogglePinned,
  onCopyUrl,
  onShareWithTeam,
  openerSessionId,
  openerRootSessionId,
  openedByTree: baseOpenedByTree,
  followsOpener = false,
  followsTallOpener = false,
  sharing,
  archiveTooltipLabel,
  archiveActionLabel,
  archiveConfirmLabel,
  isMobile,
}: LocalProjectSessionItemProps) {
  const { t } = useTranslation();
  const moreActionsLabel = t('sessions.moreActions', 'More actions');
  const title = (session.title ?? '').trim() || defaultSessionTitle;
  // Self-ticking on the shared sidebar timer: a tick re-renders only this row's
  // time label, not every row in the project section.
  const now = useStableNow(SIDEBAR_RELATIVE_TIME_REFRESH_MS);
  const relativeTime = formatCompactRelativeTime(effectiveLatestMessageAt, now);
  const showSelectedState = isSelected && !isMobile;
  const showBranchNames = useAtomValue(sidebarShowBranchNamesAtom);
  // A local project row only carries branch/time on the second line when its
  // session has its own worktree. A repo association alone does not make this a
  // worktree. The Details turn-off collapses the line entirely (the first
  // child's tall connector follows via `followsTallOpener`).
  const showMetaLine =
    showBranchNames &&
    !isMobile &&
    session.isWorktree === true &&
    baseOpenedByTree?.kind !== 'child';
  const openedByTree =
    baseOpenedByTree?.kind === 'child' && !isMobile
      ? {
          ...baseOpenedByTree,
          isFirstChild: followsOpener,
          tallOpener: followsOpener && followsTallOpener,
        }
      : baseOpenedByTree;
  const lineBoxClassName = showMetaLine
    ? clsx(stylex.props(appStyles.lineBox).className, SIDEBAR_ROW_LINE_CLASS)
    : stylex.props(appStyles.contents).className;
  const showInlineArchive = !isMobile;
  const showWorktreeIcon = session.isWorktree === true;
  const isPinned = Boolean(session.isPinned);
  // Local-project sessions linked to a GitHub repo can carry a PR — the repo
  // identity lives on `session.project`, resolved the same way as the info
  // bar's `getSessionGitHubState`. Surface it like the GitHub rows do.
  const prInfo = getLatestPullRequestInfo(session);
  const prStatus: PrStatus = prInfo.status ?? 'open';
  const showPr = Boolean(prInfo.url);
  const prRepoFullName = resolveProjectGitHubRepo(session.project) ?? null;
  const [renameTarget, setRenameTarget] = useState<RenameSessionDialogTarget | null>(null);
  const canRename = typeof onRename === 'function';
  const canTogglePinned = typeof onTogglePinned === 'function';
  const canCopyUrl = typeof onCopyUrl === 'function';
  const canMarkUnread = typeof onMarkUnread === 'function' && !hasUnreadMessages;
  const hasContextMenuActions = !isMobile;
  const openedByOpener = openedByTree?.kind === 'opener' ? openedByTree : null;
  const contextMenuLabels = useMemo(
    () => ({
      rename: t('sessions.contextMenu.rename', 'Rename'),
      pin: t('sessions.contextMenu.pin', 'Pin Session'),
      unpin: t('sessions.contextMenu.unpin', 'Unpin Session'),
      archive: t('sessions.contextMenu.archive', 'Archive Session'),
      markUnread: t('sessions.contextMenu.markUnread', 'Mark as unread'),
      copyUrl: t('sessions.contextMenu.copyUrl', 'Copy Session URL'),
      goToOpenerSession: t('sessions.contextMenu.goToOpenerSession', 'Go to Opener Session'),
      shareWithTeam: t('sessions.sharing.shareWithTeam', 'Share with team…'),
      onlyOwnerCanShare: t('sessions.sharing.onlyOwnerCanShare', 'Only the device owner can share'),
      registerDeviceToShare: t(
        'sessions.sharing.registerDeviceToShare',
        'Register this device before sharing'
      ),
      loadingSharing: t('sessions.sharing.loadingAction', 'Checking sharing…'),
    }),
    [t]
  );
  const beginRename = useCallback(() => {
    if (!canRename) return;
    setRenameTarget({ sessionId: session.id, initialTitle: title });
  }, [canRename, session.id, title]);
  const isUnsent = useSessionUnsentNewConversation(session.id);
  const titleContent = (
    <span
      className={clsx(
        stylex.props(appStyles.titleText).className,
        isUnsent && !showSelectedState && SIDEBAR_UNSENT_TITLE_CLASS
      )}
    >
      {title}
    </span>
  );
  // Copy URL is always available (a private link still works for the owner);
  // sharing is a separate menu item that only appears when the conversation
  // isn't already team-visible.
  const shareMenuState = !sharing
    ? null
    : sharing.visibility === 'unknown'
      ? 'loading'
      : sharing.visibility === 'team'
        ? null
        : sharing.privateReason === 'machine-not-registered'
          ? 'unregistered'
          : sharing.canManage
            ? 'share'
            : 'owner-only';

  const [rowMenuOpen, setRowMenuOpen] = useState(false);

  const row = (
    <div
      key={session.id}
      role="button"
      tabIndex={0}
      aria-label={title}
      aria-current={isSelected ? 'page' : undefined}
      data-id={`session:${session.id}`}
      data-scope-item="row"
      data-sidebar-session-id={session.id}
      data-menu-open={rowMenuOpen ? '' : undefined}
      // Drag a conversation onto a chat surface to mention it there.
      draggable
      onDragStart={(event) => startSessionMentionDrag(event, { sessionId: session.id, title })}
      className={cn(
        'group',
        stylex.props(
          appStyles.rowBox,
          showMetaLine ? appStyles.rowMetaPadding : appStyles.rowNormalPadding,
          appStyles.rowInk,
          !showSelectedState && !isMobile && appStyles.rowHover,
          showSelectedState && appStyles.rowSelected
        ).className,
        !showSelectedState && !isMobile && 'data-[menu-open]:bg-sidebar-hover'
      )}
      onClick={(event) => {
        if (openSessionOnModifiedClick(event, session.id)) return;
        onNavigate(session.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onNavigate(session.id);
      }}
    >
      <div
        {...stylex.props(
          appStyles.rowLayout,
          showMetaLine ? appStyles.rowTop : appStyles.rowCenter,
          isMobile ? appStyles.gapMobile : appStyles.gapDesktop
        )}
      >
        {/* On a two-line row the leading and end slots sit in a box one title line
            tall, so they stay on the title line; otherwise the box disappears. */}
        <div className={lineBoxClassName}>
          <SessionRowLeadingSlot
            showMenuButton={hasContextMenuActions}
            menuLabel={moreActionsLabel}
            openedByTree={openedByTree}
          />
        </div>
        <div {...stylex.props(showMetaLine ? appStyles.titleColumn : appStyles.contents)}>
          <div
            className={cn(SIDEBAR_ROW_TEXT_CLASS, stylex.props(appStyles.titleContent).className)}
            // Double-click to rename is scoped to the title only, so it can't be
            // triggered by double-clicking the Archive confirm button.
            onDoubleClick={(event) => {
              if (!canRename) return;
              event.preventDefault();
              event.stopPropagation();
              beginRename();
            }}
          >
            <SessionRowAuthorAvatar author={author} />
            {isPinned ? <Pin aria-hidden="true" {...stylex.props(appStyles.mutedGlyph12)} /> : null}
            {titleContent}
          </div>
          {showMetaLine ? (
            <SidebarSessionMetaLine
              branchName={session.branchName}
              latestMessageAt={effectiveLatestMessageAt}
            />
          ) : null}
        </div>
        {/* ③ A relative time on mobile only (no hover info card on touch); on desktop
            the time / branch live in the hover info card, so nothing sits here. */}
        {isMobile ? (
          <span
            className={cn(SIDEBAR_CAPTION_TEXT_CLASS, stylex.props(appStyles.mobileTime).className)}
          >
            {relativeTime}
          </span>
        ) : null}
        {/* ④ Fixed end slot: the PR status sits here at rest when the session
            has one, with a faint worktree glyph just to its left; the Archive
            button replaces it on desktop hover. */}
        <div className={lineBoxClassName}>
          <SidebarRowEndSlot
            sessionId={session.id}
            isWaitingPermission={isWaitingPermission}
            isWorking={isWorking}
            hasUnreadMessages={hasUnreadMessages}
            restIcon={
              showPr || showWorktreeIcon ? (
                <span {...stylex.props(appStyles.restMarks)}>
                  <SessionRowWorktreeIndicator isWorktree={showWorktreeIcon} />
                  {showPr ? (
                    <SessionPrIcon compact prStatus={prStatus} prCiState={prInfo.ciState} />
                  ) : null}
                </span>
              ) : undefined
            }
            archive={
              showInlineArchive ? (
                <SidebarRowArchiveButton
                  label={archiveTooltipLabel}
                  confirmLabel={archiveConfirmLabel}
                  onConfirm={() => onArchive(session.id)}
                />
              ) : undefined
            }
          />
        </div>
      </div>
    </div>
  );

  const menuRow = hasContextMenuActions ? (
    <ContextMenu.Root onOpenChange={setRowMenuOpen}>
      <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
      <ContextMenu.Content minWidth={180}>
        <SessionRowOpenedByMenuItems
          opener={openedByOpener}
          goToOpenerLabel={contextMenuLabels.goToOpenerSession}
        />
        {canTogglePinned ? (
          <ContextMenu.Item
            icon={isPinned ? PinOff : Pin}
            onClick={() => {
              onTogglePinned?.(session.id, !isPinned);
            }}
          >
            {isPinned ? contextMenuLabels.unpin : contextMenuLabels.pin}
          </ContextMenu.Item>
        ) : null}
        {canMarkUnread ? (
          <ContextMenu.Item
            icon={Mail}
            onClick={() => {
              onMarkUnread?.(session.id);
            }}
          >
            {contextMenuLabels.markUnread}
          </ContextMenu.Item>
        ) : null}
        {canRename ? (
          <ContextMenu.Item icon={Pencil} onClick={beginRename}>
            {contextMenuLabels.rename}
          </ContextMenu.Item>
        ) : null}
        {(openedByOpener || canTogglePinned || canMarkUnread || canRename) &&
        (canCopyUrl || shareMenuState) ? (
          <ContextMenu.Separator />
        ) : null}
        {canCopyUrl ? (
          <ContextMenu.Item
            icon={Link2}
            onClick={() => {
              onCopyUrl?.(session.id);
            }}
          >
            {contextMenuLabels.copyUrl}
          </ContextMenu.Item>
        ) : null}

        {shareMenuState ? (
          <ContextMenu.Item
            disabled={shareMenuState !== 'share'}
            icon={
              shareMenuState === 'share' ? (
                Users
              ) : shareMenuState === 'loading' ? (
                <Spinner size="small" label={null} />
              ) : (
                LockKeyhole
              )
            }
            onClick={() => {
              onShareWithTeam?.(session.id);
            }}
          >
            {shareMenuState === 'share'
              ? contextMenuLabels.shareWithTeam
              : shareMenuState === 'unregistered'
                ? contextMenuLabels.registerDeviceToShare
                : shareMenuState === 'owner-only'
                  ? contextMenuLabels.onlyOwnerCanShare
                  : contextMenuLabels.loadingSharing}
          </ContextMenu.Item>
        ) : null}
        {(openedByOpener ||
          canTogglePinned ||
          canMarkUnread ||
          canRename ||
          canCopyUrl ||
          shareMenuState) &&
        (openerSessionId || isElectronRenderer()) ? (
          <ContextMenu.Separator />
        ) : null}

        <SessionRowOpenedByMenuItems
          goToOpener={
            openerSessionId
              ? () => onNavigate(openerRootSessionId ?? openerSessionId, openerSessionId)
              : undefined
          }
          goToOpenerLabel={contextMenuLabels.goToOpenerSession}
        />
        <SessionWindowMenuItem sessionId={session.id} />
        {(openedByOpener ||
          canTogglePinned ||
          canMarkUnread ||
          canRename ||
          canCopyUrl ||
          shareMenuState ||
          openerSessionId ||
          isElectronRenderer()) &&
        true ? (
          <ContextMenu.Separator />
        ) : null}
        <ContextMenu.Item
          icon={Archive}
          onClick={() => {
            onArchive(session.id);
          }}
        >
          {contextMenuLabels.archive}
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  ) : (
    row
  );

  const renameDialog = (
    <RenameSessionDialogView
      target={renameTarget}
      onClose={() => setRenameTarget(null)}
      onRename={(sessionId, nextTitle) => onRename?.(sessionId, nextTitle)}
    />
  );

  if (!isMobile) {
    // Desktop hover info card (right side) carries the time / branch pulled out of
    // the single-line row. Mobile has no hover, so it keeps the inline time instead.
    return (
      <>
        <SessionInfoHoverCard
          kind="local"
          author={author ?? undefined}
          title={title}
          isWorktree={showWorktreeIcon}
          latestMessageAt={effectiveLatestMessageAt}
          repoFullName={prRepoFullName}
          folderName={projectName}
          machineName={machineName}
          historyBackend={resolveSessionHistoryBackendKind(session)}
          branchName={session.branchName}
          prStatus={showPr ? prStatus : undefined}
          prCiState={prInfo.ciState}
          prNumber={prInfo.number}
          prUrl={prInfo.url}
          sharing={sharing}
        >
          {menuRow}
        </SessionInfoHoverCard>
        {renameDialog}
      </>
    );
  }

  return (
    <>
      <SwipeActionRow
        enabled={isMobile}
        className="rounded-md"
        contentClassName="bg-sidebar"
        actions={[
          {
            key: 'archive',
            label: archiveActionLabel,
            ariaLabel: archiveTooltipLabel,
            icon: <Archive className={stylex.props(appStyles.glyph16).className} />,
            hideLabel: true,
            className: 'bg-sidebar-hover text-sidebar-hover-foreground',
            onClick: () => onArchive(session.id),
          },
        ]}
        onCommit={() => onArchive(session.id)}
      >
        {row}
      </SwipeActionRow>
      {renameDialog}
    </>
  );
});

export type LocalProjectItemProps = {
  machineId: MachineId;
  machineName?: string | null;
  project: LocalProjectMeta;
  /**
   * Whether the current user may remove this project. True for the current
   * device, and for remote devices the user owns (remote deletions are
   * dispatched to the owning machine via the local-project control channel).
   */
  canRemoveProject: boolean;
  removalState?: LocalProjectRemovalState | null;
  collapsed: boolean;
  whetherShowFullList: boolean;
  isSelected: boolean;
  sessionsForProject: SessionMeta[];
  /**
   * Map of parent session id -> non-archived child sessions. Used to roll up
   * sub-session activity time into the parent row's displayed timestamp.
   */
  childSessionsByParent: Map<string, SessionMeta[]>;
  liveSessionStatuses: ReadonlyMap<string, SessionStatus>;
  /** Resolve a session's author (team scope only); null in solo / My-Tasks view. */
  resolveSessionAuthor?: (
    session: SessionMeta
  ) => { name?: string | null; image?: string | null } | null;
  formattedPath: string | null;
  defaultSessionTitle: string;
  selectedSessionId: string | null;
  removeProjectLabel: string;
  newChatLabel?: string;
  archiveTooltipLabel: string;
  archiveActionLabel: string;
  archiveConfirmLabel: string;
  isMobile: boolean;
  toggleLabel: string;
  onNavigateProject: (machineId: MachineId, localProjectId: string) => void;
  onNewChatInProject?: (machineId: MachineId, localProjectId: string) => void;
  onOpenProjectSettings?: (machineId: MachineId, localProjectId: string) => void;
  /** Opens the project editor seeded with this folder, to add more repositories. */
  onEditProject?: (machineId: MachineId, localProjectId: string, name: string) => void;
  onRevealProject?: (rootPath: string) => void;
  onArchiveProjectChats?: (sessionIds: string[]) => void;
  onNavigateSession: (sessionId: string, tabSessionId?: string) => void;
  onArchive: (sessionId: string) => void;
  onMarkSessionUnread?: (sessionId: string) => void;
  onRenameSession?: (sessionId: string, nextTitle: string) => void | Promise<void>;
  onToggleSessionPinned?: (sessionId: string, nextPinned: boolean) => void;
  onCopySessionUrl?: (sessionId: string) => void;
  onShareSessionWithTeam?: (sessionId: string) => void;
  sessionSharingById?: ReadonlyMap<string, SessionSharingState>;
  /** Opener session ids whose MCP-opened Sessions are collapsed in this list. */
  collapsedOpenedBySessionIds: Record<string, boolean>;
  onToggleOpenedBySessions: (openerSessionId: string) => void;
  /**
   * Maps a precise opener to the sidebar row that hosts the nesting. A Session
   * opened from a child Tab resolves to that Tab's root Session, which is the
   * one this list actually renders. Optional: a caller without a session cache
   * degrades to nesting on the precise opener (identity), which is correct
   * whenever that opener is already a root.
   */
  resolveOpenerRowId?: (openerSessionId: string | null | undefined) => string | null;
  onToggleCollapsed: (machineId: MachineId, localProjectId: LocalProjectId) => void;
  onToggleFullList: (groupKey: string) => void;
  onRequestRemoval: (info: LocalProjectRemovalRequest) => void;
  dragHandle?: ReactNode;
};

const hoverActionClassName = SIDEBAR_HOVER_ACTION_CLASS;
const menuTriggerOpenClassName = SIDEBAR_MENU_TRIGGER_OPEN_CLASS;

/**
 * Folded-group status for local-project Sessions: each one counted by the mark
 * its row would draw, child Tabs rolled up exactly as the row rolls them up.
 */
function summarizeLocalSessionsActivity(
  sessions: Iterable<SessionMeta>,
  childSessionsByParent: Map<string, SessionMeta[]>,
  liveSessionStatuses: ReadonlyMap<string, SessionStatus>,
  sendStates: Readonly<Record<string, SessionSendState>>
): SidebarGroupActivity {
  const rows: (EffectiveSessionActivitySummary & { sendState?: SessionSendState })[] = [];
  for (const session of sessions) {
    rows.push({
      ...getEffectiveSessionActivitySummary(session, childSessionsByParent, liveSessionStatuses),
      sendState: sendStates[session.id],
    });
  }
  return summarizeSidebarGroupActivity(rows);
}

/** Two folded groups' marks as one, for a machine that folds both. */
function addSidebarGroupActivity(
  left: SidebarGroupActivity,
  right: SidebarGroupActivity
): SidebarGroupActivity {
  return {
    failed: left.failed + right.failed,
    waiting: left.waiting + right.waiting,
    working: left.working + right.working,
    sending: left.sending + right.sending,
    unread: left.unread + right.unread,
  };
}

const LOCAL_PROJECT_SELECTION_PROP_KEYS: ReadonlySet<string> = new Set(['selectedSessionId']);

/**
 * `memo` equality for local-project sections: a `selectedSessionId` change only
 * re-renders the project(s) containing the previously or newly selected row,
 * instead of every project section in the sidebar. All other props fall back
 * to identity comparison.
 */
function localProjectItemPropsEqual(prev: LocalProjectItemProps, next: LocalProjectItemProps) {
  if (!shallowEqualExceptKeys(prev, next, LOCAL_PROJECT_SELECTION_PROP_KEYS)) return false;
  if (prev.selectedSessionId === next.selectedSessionId) return true;
  const contains = (id: string | null | undefined) =>
    id != null && next.sessionsForProject.some((session) => session.id === id);
  return !contains(prev.selectedSessionId) && !contains(next.selectedSessionId);
}

export const LocalProjectItem = memo(function LocalProjectItem({
  machineId,
  machineName,
  project,
  canRemoveProject,
  removalState = null,
  collapsed,
  whetherShowFullList,
  isSelected,
  sessionsForProject,
  childSessionsByParent,
  liveSessionStatuses,
  resolveSessionAuthor,
  formattedPath,
  defaultSessionTitle,
  selectedSessionId,
  removeProjectLabel,
  newChatLabel,
  archiveTooltipLabel,
  archiveActionLabel,
  archiveConfirmLabel,
  isMobile,
  toggleLabel,
  onNavigateProject,
  onNewChatInProject,
  onOpenProjectSettings,
  onEditProject,
  onRevealProject,
  onArchiveProjectChats,
  onNavigateSession,
  onArchive,
  onMarkSessionUnread,
  onRenameSession,
  onToggleSessionPinned,
  onCopySessionUrl,
  onShareSessionWithTeam,
  sessionSharingById = EMPTY_SESSION_SHARING_BY_ID,
  collapsedOpenedBySessionIds,
  onToggleOpenedBySessions,
  // Default: nest on the precise opener, which is correct whenever it is a root.
  resolveOpenerRowId = normalizeSessionRowId,
  onToggleCollapsed,
  onToggleFullList,
  onRequestRemoval,
  dragHandle,
}: LocalProjectItemProps) {
  const { t } = useTranslation();
  // Whether the branch/time detail line is shown at all — a child's tall
  // connector must match whether its opener actually renders that line.
  const showBranchNames = useAtomValue(sidebarShowBranchNamesAtom);
  const groupKey = getLocalProjectSessionGroupKey(machineId, project.id);
  // Same opened-by presentation the GitHub/Chats groups use: MCP-opened
  // independent Sessions indent under the Session that created them, and a
  // list with no such relationship keeps its previous flat geometry.
  const { canToggleFullList, sessionNodes } = useMemo(() => {
    const accessors = {
      getId: (session: SessionMeta) => session.id,
      // Nest under the opener's sidebar ROW, not necessarily the precise
      // opener: a Session created from a child Tab belongs under that Tab's
      // root Session, because child Tabs have no row here.
      getOpenedBySessionId: (session: SessionMeta) =>
        session.openedByRootSessionId ?? resolveOpenerRowId(session.openedBySessionId),
      isCollapsed: (openerId: string) => collapsedOpenedBySessionIds[openerId] === true,
      // Same contract as the other lists: this section is sorted by latest
      // activity, so an opener is ranked by its freshest opened Session.
      rootRank: (session: SessionMeta) =>
        getEffectiveLatestMessageAt(session, childSessionsByParent),
    } as const;
    const canToggle = countOpenedByTreeRoots(sessionsForProject, accessors) > MAX_VISIBLE_SESSIONS;
    return {
      canToggleFullList: canToggle,
      sessionNodes: buildOpenedBySessionTree(sessionsForProject, {
        ...accessors,
        ...(whetherShowFullList ? {} : { maxRoots: MAX_VISIBLE_SESSIONS }),
      }),
    };
  }, [
    childSessionsByParent,
    collapsedOpenedBySessionIds,
    resolveOpenerRowId,
    sessionsForProject,
    whetherShowFullList,
  ]);
  const showTreeGutter = hasOpenedByTreeNesting(sessionNodes);
  const toggleListLabel = whetherShowFullList
    ? t('sessions.showLess', 'Show less')
    : t('sessions.showAll', 'Show all ({{count}})', { count: sessionsForProject.length });
  const trimmedMachineName =
    typeof machineName === 'string' && machineName.trim() ? machineName.trim() : null;
  const baseAriaLabel = formattedPath
    ? trimmedMachineName
      ? `${project.name} · ${trimmedMachineName} · ${formattedPath}`
      : `${project.name} · ${formattedPath}`
    : project.name;
  const removalStateLabel =
    removalState === 'waiting_for_device'
      ? t('sidebar.localProjects.remove.waitingForDevice', 'Waiting for device…')
      : removalState === 'removing'
        ? t('sidebar.localProjects.remove.removing', 'Removing…')
        : null;
  // A folded project still says whether anything inside it needs the user: the
  // mark each hidden row would draw, rolled up. Pinned Sessions are not here —
  // they stay visible in Pinned, so folding the project does not hide them.
  const sendStates = useAtomValue(sessionSendStatesAtom);
  const collapsedActivity = useMemo(
    () =>
      collapsed && !removalState
        ? summarizeLocalSessionsActivity(
            sessionsForProject,
            childSessionsByParent,
            liveSessionStatuses,
            sendStates
          )
        : null,
    [
      childSessionsByParent,
      collapsed,
      liveSessionStatuses,
      removalState,
      sendStates,
      sessionsForProject,
    ]
  );
  const collapsedActivityDescription = useSidebarGroupActivityDescription(collapsedActivity);
  const ariaLabel = [baseAriaLabel, removalStateLabel, collapsedActivityDescription]
    .filter(Boolean)
    .join(' · ');
  const showSelectedState = isSelected && !isMobile;
  const handleNavigate = useCallback(() => {
    if (removalState) return;
    onNavigateProject(machineId, project.id);
  }, [machineId, onNavigateProject, project.id, removalState]);
  // A project being removed is inert; every other project row navigates,
  // including projects on a teammate's shared machine.
  const projectCanNavigate = removalState === null;
  // Mobile has no hover, so both row controls stay desktop-only, exactly like
  // the ⋯ on session rows.
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const projectMenuLabel = t('sessions.moreActions', 'More actions');
  const projectSettingsLabel = t('sidebar.localProjects.settings', 'Project settings');
  const revealProjectLabel = t('sidebar.localProjects.reveal', 'Reveal in file manager');
  const archiveProjectChatsLabel = t('sidebar.localProjects.archiveChats', 'Archive chats');
  const archivableSessionIds = useMemo(
    () => sessionsForProject.map((session) => session.id),
    [sessionsForProject]
  );
  const revealPath = onRevealProject && formattedPath ? formattedPath : null;
  const editProjectLabel = t('sidebar.localProjects.editProject', 'Edit project…');
  const showProjectMenu =
    !isMobile &&
    (canRemoveProject ||
      Boolean(onOpenProjectSettings) ||
      Boolean(onEditProject) ||
      Boolean(revealPath) ||
      Boolean(onArchiveProjectChats));
  const showNewChatButton = Boolean(onNewChatInProject) && projectCanNavigate && !isMobile;
  const ProjectFolderIcon = collapsed ? Folder : FolderOpen;

  const projectRow = (
    <div
      role={projectCanNavigate ? 'button' : undefined}
      tabIndex={projectCanNavigate ? 0 : -1}
      aria-label={ariaLabel}
      aria-current={isSelected ? 'page' : undefined}
      aria-disabled={!projectCanNavigate ? true : undefined}
      data-id={`project:${machineId}:${project.id}`}
      data-scope-item="row"
      data-sidebar-project-key={`${machineId}:${project.id}`}
      // Own attribute rather than Radix's `data-state`: TooltipTrigger
      // and ContextMenuTrigger both target this element through
      // `asChild`, so their `data-state` values collide here.
      data-menu-open={projectMenuOpen ? '' : undefined}
      className={cn(
        'group',
        stylex.props(
          appStyles.rowBox,
          appStyles.rowNormalPadding,
          appStyles.projectRow,
          appStyles.rowInk,
          !showSelectedState && !isMobile && appStyles.rowHover,
          !showSelectedState && !isMobile && appStyles.projectHover,
          showSelectedState && appStyles.rowSelected,
          showSelectedState && appStyles.projectSelected,
          projectCanNavigate ? appStyles.navigable : appStyles.inert
        ).className,
        SIDEBAR_ROW_TEXT_CLASS,
        !showSelectedState &&
          !isMobile &&
          'data-[menu-open]:bg-sidebar-hover data-[menu-open]:text-sidebar-hover-foreground'
      )}
      onClick={handleNavigate}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        handleNavigate();
      }}
    >
      <button
        type="button"
        {...stylex.props(appStyles.leadingSlot)}
        aria-label={toggleLabel}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onToggleCollapsed(machineId, project.id);
        }}
      >
        {/* Open folder while expanded, closed while collapsed. Same stroke and
            resting ink as the navigation icons above, coming up to the row's
            ink with the hover or selected fill. */}
        <ProjectFolderIcon
          strokeWidth={1.5}
          className={cn(
            stylex.props(
              appStyles.folderGlyph,
              showSelectedState ? appStyles.currentInk : appStyles.folderIdle,
              isMobile && appStyles.hidden
            ).className,
            !showSelectedState && 'group-hover:text-current',
            // Mobile: chevron is always visible so the folder icon must hide
            // permanently to avoid stacking. Desktop keeps the hover swap.
            !isMobile && 'group-hover:opacity-0'
          )}
        />
        <ChevronDown
          strokeWidth={1.5}
          className={cn(
            stylex.props(
              appStyles.chevronGlyph,
              isMobile ? appStyles.shown : appStyles.hidden,
              collapsed ? appStyles.collapsedChevron : appStyles.expandedChevron
            ).className,
            !isMobile && 'group-hover:opacity-100'
          )}
        />
      </button>
      <span {...stylex.props(appStyles.projectTitle)}>{project.name}</span>

      {removalStateLabel ? (
        <Tooltip.Root>
          <Tooltip.Trigger
            delay={300}
            render={
              <span
                className={cn(
                  SIDEBAR_CAPTION_TEXT_CLASS,
                  stylex.props(appStyles.removalStatus).className
                )}
              >
                {removalState === 'waiting_for_device' ? (
                  <Clock3
                    {...stylex.props(appStyles.glyph12, appStyles.waitingGlyph)}
                    aria-hidden="true"
                  />
                ) : (
                  <Spinner {...stylex.props(appStyles.glyph12)} aria-hidden="true" />
                )}
                <span {...stylex.props(appStyles.clippedCapped)}>{removalStateLabel}</span>
              </span>
            }
          />
          <Tooltip.Content side="right">{removalStateLabel}</Tooltip.Content>
        </Tooltip.Root>
      ) : showProjectMenu || showNewChatButton || dragHandle ? (
        <div {...stylex.props(appStyles.trailing)}>
          {showProjectMenu ? (
            <button
              type="button"
              className={cn(hoverActionClassName, menuTriggerOpenClassName)}
              aria-label={projectMenuLabel}
              onClick={(event) => {
                // Open the row's own right-click menu from a left click.
                event.preventDefault();
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(
                  new MouseEvent('contextmenu', {
                    bubbles: true,
                    cancelable: true,
                    clientX: Math.round(rect.left),
                    clientY: Math.round(rect.bottom),
                  })
                );
              }}
            >
              <MoreHorizontal {...stylex.props(appStyles.glyph14)} />
            </button>
          ) : null}
          {showNewChatButton ? (
            <button
              type="button"
              className={hoverActionClassName}
              aria-label={newChatLabel}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onNewChatInProject?.(machineId, project.id);
              }}
            >
              <SquarePen {...stylex.props(appStyles.glyph14)} />
            </button>
          ) : null}
          {dragHandle}
        </div>
      ) : null}
      {collapsedActivity ? (
        // The row's path tooltip carries the description; a second hover
        // surface on the mark would open alongside it.
        <SidebarGroupActivityMark activity={collapsedActivity} describe={false} />
      ) : null}
    </div>
  );

  return (
    <div>
      <div
        className={clsx(
          'group',
          stylex.props(appStyles.flexRow, appStyles.projectListSpacing).className
        )}
      >
        <ContextMenu.Root onOpenChange={setProjectMenuOpen}>
          <Tooltip.Root>
            <Tooltip.Trigger
              delay={500}
              render={showProjectMenu ? <ContextMenu.Trigger render={projectRow} /> : projectRow}
            />
            {formattedPath || trimmedMachineName || collapsedActivityDescription ? (
              <Tooltip.Content side="right" align="start" className="max-w-[420px] break-all">
                <div
                  className={clsx(
                    SIDEBAR_HELPER_TEXT_CLASS,
                    stylex.props(appStyles.tooltipLines).className
                  )}
                >
                  {trimmedMachineName ? (
                    <span {...stylex.props(appStyles.muted)}>{trimmedMachineName}</span>
                  ) : null}
                  {formattedPath ? (
                    <span
                      className={clsx(
                        SIDEBAR_CAPTION_TEXT_CLASS,
                        stylex.props(appStyles.mono).className
                      )}
                    >
                      {formattedPath}
                    </span>
                  ) : null}
                  {collapsedActivityDescription ? (
                    <span data-sidebar-group-activity-description="">
                      {collapsedActivityDescription}
                    </span>
                  ) : null}
                </div>
              </Tooltip.Content>
            ) : null}
          </Tooltip.Root>
          {showProjectMenu ? (
            <ContextMenu.Content minWidth={180}>
              {onEditProject && projectCanNavigate ? (
                <ContextMenu.Item
                  icon={Folders}
                  onClick={() => {
                    onEditProject(machineId, project.id, project.name);
                  }}
                >
                  {editProjectLabel}
                </ContextMenu.Item>
              ) : null}
              {onOpenProjectSettings ? (
                <ContextMenu.Item
                  icon={Settings2}
                  onClick={() => {
                    onOpenProjectSettings(machineId, project.id);
                  }}
                >
                  {projectSettingsLabel}
                </ContextMenu.Item>
              ) : null}
              {revealPath ? (
                <ContextMenu.Item
                  icon={FolderOpen}
                  onClick={() => {
                    onRevealProject?.(revealPath);
                  }}
                >
                  {revealProjectLabel}
                </ContextMenu.Item>
              ) : null}
              {onArchiveProjectChats ? (
                <ContextMenu.Item
                  disabled={archivableSessionIds.length === 0}
                  icon={Archive}
                  onClick={() => {
                    onArchiveProjectChats(archivableSessionIds);
                  }}
                >
                  {archiveProjectChatsLabel}
                </ContextMenu.Item>
              ) : null}
              {canRemoveProject &&
              (onOpenProjectSettings || revealPath || onArchiveProjectChats) ? (
                <ContextMenu.Separator />
              ) : null}
              {canRemoveProject ? (
                <ContextMenu.Item
                  icon={Trash2}
                  onClick={() => {
                    onRequestRemoval({
                      machineId,
                      localProjectId: project.id,
                      name: project.name,
                      originalRootPath: project.rootPath,
                    });
                  }}
                >
                  {removeProjectLabel}
                </ContextMenu.Item>
              ) : null}
            </ContextMenu.Content>
          ) : null}
        </ContextMenu.Root>
      </div>

      {/* An expanded project with nothing to list renders no container: an empty
          child of the space-y parent would still add its gap, so expanding an
          empty folder would nudge everything below it. */}
      {!collapsed && sessionNodes.length > 0 ? (
        <div className={SIDEBAR_ROW_LIST_CLASS}>
          {sessionNodes.map((node, nodeIndex) => {
            const session = node.item;
            const activity = getEffectiveSessionActivitySummary(
              session,
              childSessionsByParent,
              liveSessionStatuses
            );
            const openedByTree = buildSessionRowOpenedByTreeSlot(node, t, () =>
              onToggleOpenedBySessions(session.id)
            );
            return (
              <SessionOpenedByTreeRow key={session.id} depth={node.depth} gutter={showTreeGutter}>
                <LocalProjectSessionItem
                  session={session}
                  isWorking={activity.isWorking}
                  isWaitingPermission={activity.isWaitingPermission}
                  hasUnreadMessages={activity.hasUnreadMessages}
                  effectiveLatestMessageAt={activity.latestMessageAt}
                  defaultSessionTitle={defaultSessionTitle}
                  projectName={project.name}
                  machineName={trimmedMachineName}
                  author={resolveSessionAuthor?.(session) ?? null}
                  isSelected={session.id === selectedSessionId}
                  workspaceSlug={null}
                  onNavigate={onNavigateSession}
                  onArchive={onArchive}
                  onMarkUnread={onMarkSessionUnread}
                  onRename={onRenameSession}
                  onTogglePinned={onToggleSessionPinned}
                  onCopyUrl={onCopySessionUrl}
                  onShareWithTeam={onShareSessionWithTeam}
                  openerSessionId={session.openedBySessionId ?? null}
                  openerRootSessionId={
                    session.openedByRootSessionId ?? resolveOpenerRowId(session.openedBySessionId)
                  }
                  openedByTree={openedByTree}
                  followsOpener={sessionNodes[nodeIndex - 1]?.depth === 0}
                  followsTallOpener={
                    sessionNodes[nodeIndex - 1]?.depth === 0 &&
                    sessionNodes[nodeIndex - 1]?.item.isWorktree === true &&
                    showBranchNames
                  }
                  sharing={sessionSharingById.get(session.id)}
                  archiveTooltipLabel={archiveTooltipLabel}
                  archiveActionLabel={archiveActionLabel}
                  archiveConfirmLabel={archiveConfirmLabel}
                  isMobile={isMobile}
                />
              </SessionOpenedByTreeRow>
            );
          })}
          {canToggleFullList ? (
            <button
              type="button"
              data-id={`show-more:${groupKey}`}
              data-scope-item="row"
              data-sidebar-show-more={groupKey}
              className={cn(
                // Same 30px pitch as a conversation row (py-1 + 1px borders + 20px line).
                SIDEBAR_CAPTION_TEXT_CLASS,
                stylex.props(appStyles.showMore, appStyles.noFocusRing).className
              )}
              aria-label={toggleListLabel}
              onClick={() => onToggleFullList(groupKey)}
            >
              <span {...stylex.props(appStyles.glyphBox16)} aria-hidden="true" />
              <span>{toggleListLabel}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}, localProjectItemPropsEqual);

const SortableLocalProjectItem = memo(
  function SortableLocalProjectItem({
    sortableId,
    canReorder,
    ...props
  }: LocalProjectItemProps & { sortableId: string; canReorder: boolean }) {
    const { t } = useTranslation();
    const {
      attributes,
      listeners,
      setNodeRef,
      setActivatorNodeRef,
      transform,
      transition,
      isDragging,
    } = useSortable({ id: sortableId, disabled: !canReorder });
    const constrainedTransform = transform ? { ...transform, x: 0, scaleX: 1, scaleY: 1 } : null;
    const dragHandle = canReorder ? (
      <button
        type="button"
        ref={setActivatorNodeRef}
        className={clsx(hoverActionClassName, stylex.props(appStyles.dragHandle).className)}
        aria-label={t('sidebar.localProjects.reorder', 'Reorder project')}
        {...attributes}
        {...listeners}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <GripVertical {...stylex.props(appStyles.glyph14)} />
      </button>
    ) : undefined;

    return (
      <div
        ref={setNodeRef}
        style={{
          transform: CSS.Transform.toString(constrainedTransform),
          transition,
        }}
        className={stylex.props(appStyles.sortable, isDragging && appStyles.dragging).className}
        data-local-project-sortable-id={sortableId}
      >
        <LocalProjectItem {...props} dragHandle={dragHandle} />
      </div>
    );
  },
  (prev, next) =>
    prev.sortableId === next.sortableId &&
    prev.canReorder === next.canReorder &&
    localProjectItemPropsEqual(prev, next)
);

export const hasWorkspaceSidebarTopContent = (
  localProjectSectionCount: number,
  showGithubWorktrees: boolean
): boolean => localProjectSectionCount > 0 || showGithubWorktrees;

const EMPTY_REPO_STATES: SessionListRepoState[] = [];

function VisibleSidebarEagerSync({
  sessions,
  allActiveSessions,
}: {
  sessions: readonly SessionMeta[];
  allActiveSessions: readonly SessionMeta[];
}) {
  useReportVisibleSessionsForEagerSync('loro-app-sidebar', sessions, allActiveSessions);
  return null;
}

function SidebarKeyboardNavReporter(opts: Parameters<typeof useSidebarKeyboardNav>[0]) {
  useSidebarKeyboardNav(opts);
  return null;
}

export function LoroAppSidebar({
  className,
  overlay = false,
  pauseSidebarSourcesWhenHidden = false,
}: LoroAppSidebarProps) {
  const { t, i18n } = useTranslation();
  const router = useRouter();
  // Narrow subscription: the sidebar only derives state from pathname + search,
  // so hash/history-state-only navigations no longer re-render the whole tree.
  const location = useLocation({
    select: (l) => ({ pathname: l.pathname, search: l.search }),
  });
  const isMobile = useIsMobile();
  const multiWorkspaceAvailable = useAppCapability('multiWorkspace');
  const { openSettings } = useOpenSettings();

  const user = useAtomValue(userAtom);
  const userId = user?.id ?? null;
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const atomWorkspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const routeTargetSlug = useWorkspaceRouteTargetSlug();
  const workspaceSlug = routeTargetSlug ?? atomWorkspaceSlug;
  const setWorkspaceContext = useSetAtom(setWorkspaceContextAtom);
  const connectionUiState = useAtomValue(lodyConnectionUiStateAtom);
  const setMobileDrawerOpen = useSetAtom(setMobileDrawerOpenAtom);
  const language = useAtomValue(languageAtom);
  const updaterState = useElectronUpdaterState();
  const isElectronFullscreen = useElectronFullscreen();
  const [dismissedUpdaterVersion, setDismissedUpdaterVersion] = useState<string | null>(() => {
    try {
      return localStorage.getItem('lody:dismissedUpdaterVersion');
    } catch {
      return null;
    }
  });
  // Dismissing a download only hides the banner for that download; the
  // `downloaded` banner (the one that can actually restart) comes back on its
  // own, so this stays in memory instead of the persisted dismissal key.
  const [dismissedDownloadingVersion, setDismissedDownloadingVersion] = useState<string | null>(
    null
  );
  const [isInstallingUpdate, setIsInstallingUpdate] = useState(false);
  const [isChangelogOpen, setIsChangelogOpen] = useState(false);

  const defaultSessionTitle = t('sessions.untitled', 'Untitled session');

  const closeMobileDrawer = useCallback(() => {
    if (!isMobile) return;
    setMobileDrawerOpen(false);
  }, [isMobile, setMobileDrawerOpen]);

  const updateBanner = useMemo(() => readUpdateBannerState(updaterState), [updaterState]);
  // The changelog follows the language the UI actually rendered in, which is
  // i18next's resolved language rather than the stored preference.
  const resolvedLanguage = i18n.resolvedLanguage;
  const updateReleaseNotes = useMemo(
    () => pickLocalizedReleaseNotes(updaterState, resolvedLanguage),
    [updaterState, resolvedLanguage]
  );

  const { organizations, activeOrganization, switchOrganization } = useOrganization();
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const navigateWorkspace = useCallback(
    (slug: string) => {
      void router.navigate({ to: '/$workspaceName/chat', params: { workspaceName: slug } });
    },
    [router]
  );
  const workspaceNavigation = useSidebarWorkspaceNavigation({
    encryptedAccountId: runtime?.contentMode === 'e2ee' ? runtime.accountId : null,
    organizations,
    switchOrganization,
    setContext: setWorkspaceContext,
    navigate: navigateWorkspace,
    close: closeMobileDrawer,
  });

  const runtimeInitFailure = useAtomValue(workspaceRuntimeInitFailureAtom);
  const docMetaScope = useAtomValue(docMetaCacheScopeAtom);
  const organizationsReady = Array.isArray(organizations);
  const expectedWorkspace = useMemo(() => {
    if (!organizationsReady) {
      return null;
    }
    const slug = workspaceSlug;
    if (!slug) {
      return null;
    }
    return organizations.find((org) => org.slug === slug) ?? null;
  }, [organizations, organizationsReady, workspaceSlug]);
  const expectedWorkspaceId = expectedWorkspace?.id ?? null;
  const expectedWorkspaceName = expectedWorkspace?.name ?? null;
  const workspaceDataScope = useMemo(
    () =>
      workspaceSlug
        ? resolveWorkspaceDataScope({
            targetSlug: workspaceSlug,
            runtime,
            runtimeInitFailure,
            docMetaScope,
            organizationsReady,
            expectedWorkspaceId,
          })
        : null,
    [
      docMetaScope,
      expectedWorkspaceId,
      organizationsReady,
      runtime,
      runtimeInitFailure,
      workspaceSlug,
    ]
  );
  const workspaceDataReady = workspaceDataScope?.status === 'ready';
  const scopedWorkspaceId = workspaceDataReady ? workspaceDataScope.workspaceId : null;
  const { sessions, allActiveSessions } = useVisibleSessionMetas({
    workspaceId: scopedWorkspaceId,
    enabled: workspaceDataReady,
  });
  const sessionsListLoading = Boolean(workspaceSlug) && !workspaceDataReady;
  const {
    machines: machineMetaMap,
    projects: visibleLocalProjectMap,
    showSessionSharing,
    resolve: resolveSessionSharing,
    shareWithTeam: shareSessionWithTeam,
  } = useSessionSharing({
    includeLocalProjectDetails: true,
    workspaceId: scopedWorkspaceId,
    enabled: workspaceDataReady,
  });
  const localMachineId = useAtomValue(localMachineIdAtom);
  const lastKnownLocalMachineId = useAtomValue(lastKnownLocalMachineIdAtom);
  const onlineMachineIds = useOnlineMachineIds();
  const visibleMachineIds = useMemo(() => Array.from(machineMetaMap.keys()), [machineMetaMap]);
  const pendingLocalProjectRemovals = usePendingLocalProjectRemovals(visibleMachineIds);
  useLocalProjectRemovalResultNotifications(visibleMachineIds);

  const selectedSessionId = useMemo(() => {
    return getSelectedSessionId(location.pathname, workspaceSlug);
  }, [location.pathname, workspaceSlug]);
  // Row handlers read the selection at call time: depending on it would hand
  // every sidebar row a new callback on each switch and re-render all of them.
  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
  const selectedLocalProjectKey = useMemo(() => {
    return getSelectedLocalProjectKey(
      location.pathname,
      workspaceSlug,
      location.search as Record<string, unknown>
    );
  }, [location.pathname, location.search, workspaceSlug]);
  // Detect if the user navigated to new session with a specific context/repo from sidebar
  const activeNewSessionGroup = useMemo(() => {
    if (!isHomeRoute(location.pathname, workspaceSlug) || selectedSessionId) return null;
    const search = location.search as Record<string, unknown>;
    const context = search?.context;
    if (context === 'chat') return ONLY_CHATS_KEY;
    if (context === 'github' && typeof search?.repo === 'string') return search.repo;
    // Local project selection is handled by selectedLocalProjectKey, but we still need
    // to suppress the "home" nav highlight when a local project is selected via search params.
    if (context === 'local') return '__local_project__';
    return null;
  }, [location.pathname, location.search, selectedSessionId, workspaceSlug]);

  const activeNav = useMemo(() => {
    if (isArchiveRoute(location.pathname, workspaceSlug)) return 'archive';
    if (workspaceSlug && location.pathname.startsWith(`/${workspaceSlug}/schedules`))
      return 'schedules';
    if (
      isHomeRoute(location.pathname, workspaceSlug) &&
      !selectedSessionId &&
      !activeNewSessionGroup
    )
      return 'home';
    return null;
  }, [location.pathname, selectedSessionId, activeNewSessionGroup, workspaceSlug]);

  const [chatScope, setChatScope] = useAtom(chatScopeAtom);
  const scope: SessionListScope = chatScope;

  // Local-project sessions bypass buildSessionListRows, so resolve their author
  // (creator) here from org members — only in team scope, mirroring the mapping's own
  // gate so a solo / My-Tasks view never shows a redundant "always you" author.
  const membersByUserId = useMemo(() => {
    const map = new Map<string, { name?: string | null; image?: string | null }>();
    for (const member of activeOrganization?.members ?? []) {
      if (member.user) map.set(member.userId, { name: member.user.name, image: member.user.image });
    }
    return map;
  }, [activeOrganization?.members]);
  // Only attribute an owner on a multi-member workspace: a solo workspace's tasks
  // are "always you", so an author avatar there would be redundant. Mirrors the
  // same gate in `buildSessionListRows` so both row paths agree.
  const isMultiMemberWorkspace = membersByUserId.size > 1;
  const resolveSessionAuthor = useCallback(
    (session: SessionMeta) =>
      scope === 'team' && isMultiMemberWorkspace
        ? (membersByUserId.get(session.userId) ?? null)
        : null,
    [scope, isMultiMemberWorkspace, membersByUserId]
  );
  const [organizeMode, setOrganizeMode] = useAtom(sidebarOrganizeModeAtom);
  const [showUpdatedProjectNames, setShowUpdatedProjectNames] = useAtom(
    sidebarUpdatedShowProjectNamesAtom
  );
  const [showBranchNames, setShowBranchNames] = useAtom(sidebarShowBranchNamesAtom);
  const setSidebarCollapsed = useSetAtom(sidebarCollapsedAtom);
  const [sidebarLastWidth, setSidebarLastWidth] = useAtom(sidebarLastWidthAtom);
  const handleChatScopeChanged = useCallback(
    (nextScope: SessionListScope) => {
      setChatScope(nextScope);
    },
    [setChatScope]
  );
  const handleOrganizeModeChange = useCallback(
    (nextMode: SidebarOrganizeMode) => {
      setOrganizeMode(nextMode);
    },
    [setOrganizeMode]
  );
  const postHog = usePostHog();
  const handleShowUpdatedProjectNamesChange = useCallback(
    (next: boolean) => {
      capturePostHogEvent(postHog, 'settings/changed', {
        key: 'sidebar_updated_show_project_names',
        value: next,
      });
      setShowUpdatedProjectNames(next);
    },
    [postHog, setShowUpdatedProjectNames]
  );
  const handleShowBranchNamesChange = useCallback(
    (next: boolean) => {
      capturePostHogEvent(postHog, 'settings/changed', {
        key: 'sidebar_show_branch_names',
        value: next,
      });
      setShowBranchNames(next);
    },
    [postHog, setShowBranchNames]
  );
  const sessionSidebarCodeChangesOnly = useAtomValue(sessionSidebarCodeChangesOnlyAtom);
  const { archiveSession, markSessionUnread, setSessionPinned, updateSessionTitle } =
    useSessionActions();
  const { removeLocalProject } = useRemoveLocalProject();
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);

  const archiveSessionWithConfirmation = useArchiveSessionWithConfirmation(archiveSession);
  const handleArchiveSession = useCallback(
    (sessionId: string) => {
      void archiveSessionWithConfirmation(sessionId as SessionId)
        .then(async (archived) => {
          if (!archived || !workspaceSlug || selectedSessionIdRef.current !== sessionId) return;
          await router.navigate({
            to: '/$workspaceName/chat',
            params: { workspaceName: workspaceSlug },
          });
        })
        .catch((error: unknown) => {
          toast.error(error instanceof Error ? error.message : String(error));
        });
    },
    [archiveSessionWithConfirmation, router, workspaceSlug]
  );

  const handleTogglePinSession = useCallback(
    (sessionId: string, nextPinned: boolean) => {
      void setSessionPinned(sessionId as SessionId, nextPinned);
    },
    [setSessionPinned]
  );

  const handleMarkSessionUnread = useCallback(
    (sessionId: string) => {
      void markSessionUnread(sessionId as SessionId);
    },
    [markSessionUnread]
  );

  const sessionById = useMemo(() => {
    const map = new Map<string, SessionMeta>();
    for (const session of [...allActiveSessions, ...sessions]) {
      map.set(session.id, session);
    }
    return map;
  }, [allActiveSessions, sessions]);
  const sessionSharingById = useMemo(() => {
    const map = new Map<string, SessionSharingState>();
    if (!showSessionSharing) return map;
    for (const [sessionId, session] of sessionById) {
      map.set(sessionId, resolveSessionSharing(session));
    }
    return map;
  }, [resolveSessionSharing, sessionById, showSessionSharing]);

  const copySessionUrl = useCallback(
    async (sessionId: string, successMessage: string) => {
      if (!workspaceId) return;
      if (typeof window === 'undefined') return;
      const url = buildSessionLink({ sessionId, workspaceId });
      await navigator.clipboard.writeText(url);
      toast.success(successMessage);
    },
    [workspaceId]
  );

  const [pendingSessionShare, setPendingSessionShare] = useState<PendingSessionShare | null>(null);
  const [isSharingSession, setIsSharingSession] = useState(false);

  useEffect(() => {
    if (!showSessionSharing) setPendingSessionShare(null);
  }, [showSessionSharing]);

  const handleCopySessionUrl = useCallback(
    (sessionId: string) => {
      void copySessionUrl(
        sessionId,
        t('sessions.urlCopied', 'Session URL copied to clipboard')
      ).catch(() => toast.error(t('sessions.copyFailed', 'Unable to copy')));
    },
    [copySessionUrl, t]
  );

  const handleRequestShareSession = useCallback(
    (sessionId: string) => {
      const sharing = sessionSharingById.get(sessionId);
      const session = sessionById.get(sessionId);
      if (!sharing || sharing.visibility !== 'private') return;

      if (sharing.privateReason === 'machine-not-registered') {
        toast.error(
          t('sessions.sharing.registerDeviceToShare', 'Register this device before sharing')
        );
        return;
      }
      if (!sharing.canManage) {
        toast.error(t('sessions.sharing.onlyOwnerCanShare', 'Only the device owner can share'));
        return;
      }
      setPendingSessionShare({
        sessionId: sessionId,
        title: session?.title?.trim() || defaultSessionTitle,
        sharing,
      });
    },
    [defaultSessionTitle, sessionById, sessionSharingById, t]
  );

  const handleConfirmSessionShare = useCallback(async () => {
    const pending = pendingSessionShare;
    if (!showSessionSharing || !pending || isSharingSession) return;
    setIsSharingSession(true);
    try {
      await shareSessionWithTeam(pending.sharing);
    } catch (error) {
      toast.error(t('sessions.sharing.shareFailed', "Couldn't share this conversation"), {
        description: error instanceof Error ? error.message : String(error),
      });
      setIsSharingSession(false);
      return;
    }

    try {
      await copySessionUrl(
        pending.sessionId,
        t('sessions.sharing.sharedAndCopied', 'Shared with team and copied link')
      );
    } catch {
      toast.warning(
        t('sessions.sharing.sharedCopyFailed', "Shared with team, but couldn't copy the link")
      );
    } finally {
      setIsSharingSession(false);
      setPendingSessionShare(null);
    }
  }, [
    copySessionUrl,
    isSharingSession,
    pendingSessionShare,
    shareSessionWithTeam,
    showSessionSharing,
    t,
  ]);

  // Rebuilt on every presence tick; keep the previous map while no status
  // changed, or every sidebar row is rebuilt and re-rendered several times a second.
  const liveSessionStatusesRef = useRef<Map<string, SessionStatus> | null>(null);
  const liveSessionStatuses = useMemo(() => {
    const next = new Map<string, SessionStatus>();
    const seen = new Set<string>();
    for (const session of [...allActiveSessions, ...sessions]) {
      if (seen.has(session.id)) continue;
      seen.add(session.id);
      const status = findFreshSessionPresenceState(
        presenceStates,
        session.id,
        presenceNowMs
      )?.status;
      if (status) {
        next.set(session.id, status);
      }
    }
    const previous = liveSessionStatusesRef.current;
    if (previous && previous.size === next.size) {
      let unchanged = true;
      for (const [sessionId, status] of next) {
        if (!jsonValueEqual(previous.get(sessionId), status)) {
          unchanged = false;
          break;
        }
      }
      if (unchanged) return previous;
    }
    return next;
  }, [allActiveSessions, presenceNowMs, presenceStates, sessions]);
  liveSessionStatusesRef.current = liveSessionStatuses;
  // `allActiveSessions` is the only view that still contains child Tabs, so it
  // is the only place an opener→sidebar-row mapping can be resolved. Shared by
  // every list plus the keyboard nav model so they agree on where a Session
  // opened from a child Tab lands.
  const resolveOpenerRowId = useMemo(
    () => buildSidebarOpenerRowResolver(allActiveSessions),
    [allActiveSessions]
  );

  const tasks = useMemo(() => {
    const sourceSessions = sessionsListLoading ? [] : sessions;
    const filteredSessions = sourceSessions.filter(
      (session) => session.project?.kind !== 'local' || session.projectRun !== undefined
    );
    return buildSessionListRows(
      filteredSessions,
      {
        scope,
        currentUserId: userId,
        defaultTitle: defaultSessionTitle,
        onlineMachineIds,
        members: activeOrganization?.members,
        lineChangeScope: sessionSidebarCodeChangesOnly ? 'code' : 'all',
        liveSessionStatuses,
        resolveOpenerRowId,
      },
      allActiveSessions
    ).map((task) => ({
      ...task,
      machineName: task.machineId ? machineMetaMap.get(task.machineId)?.name?.trim() || null : null,
      sharing: sessionSharingById.get(task.sessionId),
    }));
  }, [
    activeOrganization?.members,
    allActiveSessions,
    onlineMachineIds,
    liveSessionStatuses,
    machineMetaMap,
    resolveOpenerRowId,
    scope,
    sessions,
    sessionsListLoading,
    sessionSidebarCodeChangesOnly,
    sessionSharingById,
    defaultSessionTitle,
    userId,
  ]);

  const chatSessions = useMemo(
    () => tasks.filter((task) => !task.repoFullName && !task.projectGroup),
    [tasks]
  );
  const repoSessions = useMemo(
    () => tasks.filter((task) => Boolean(task.repoFullName) && !task.projectGroup),
    [tasks]
  );
  const { projects: workspaceProjects } = useWorkspaceProjects();
  const projectGroupTasks = useMemo(() => tasks.filter((task) => task.projectGroup), [tasks]);
  const projectGroupSessions = useMemo(
    () => projectGroupTasks.filter((task) => !task.isPinned),
    [projectGroupTasks]
  );
  const workspaceChatSessions = useMemo(
    () => chatSessions.filter((task) => !task.isPinned),
    [chatSessions]
  );
  const workspaceRepoSessions = useMemo(
    () => repoSessions.filter((task) => !task.isPinned),
    [repoSessions]
  );
  // Progress-free: changes only when a local send starts, fails or finishes.
  const sendStates = useAtomValue(sessionSendStatesAtom);
  const handleRenameSession = useCallback(
    (sessionId: string, nextTitle: string) => {
      return updateSessionTitle(sessionId as SessionId, nextTitle);
    },
    [updateSessionTitle]
  );
  const repoFullNames = useMemo(
    () => getStableRepoFullNames(workspaceRepoSessions),
    [workspaceRepoSessions]
  );
  const [repoCollapseState, setRepoCollapseState] = useAtom(repoCollapseStateAtom);
  const [repoOrder, setRepoOrder] = useAtom(repoOrderAtom);
  const [localProjectCollapseState, setLocalProjectCollapseState] = useAtom(
    localProjectCollapseStateAtom
  );
  const [localProjectOrder, setLocalProjectOrder] = useAtom(localProjectOrderAtom);
  const localProjectOrderRef = useRef(localProjectOrder);
  localProjectOrderRef.current = localProjectOrder;
  const localProjectSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );
  const [showFullSessionGroups, setShowFullSessionGroups] = useAtom(sidebarShowFullListAtom);
  // Shared with SessionList (same atom) so an opener collapsed in one sidebar
  // surface stays collapsed in the other, and with the keyboard nav model so
  // arrow keys never visit a hidden row.
  const collapsedOpenedBySessionIds = useAtomValue(sidebarCollapsedOpenedBySessionsAtom);
  const handleToggleOpenedBySessions = useSetAtom(toggleSidebarCollapsedOpenedBySessionAtom);

  const toggleLocalProjectCollapsed = useCallback(
    (machineId: MachineId, localProjectId: LocalProjectId) => {
      const key = `${machineId}:${localProjectId}`;
      const groupKey = getLocalProjectSessionGroupKey(machineId, localProjectId);
      setLocalProjectCollapseState((prev) => ({
        ...prev,
        [key]: !(prev[key] ?? false),
      }));
      if (!(localProjectCollapseState[key] ?? false)) {
        setShowFullSessionGroups((prev) => ({ ...prev, [groupKey]: false }));
      }
    },
    [localProjectCollapseState, setLocalProjectCollapseState, setShowFullSessionGroups]
  );

  const handleToggleLocalProjectFullList = useCallback(
    (groupKey: string) => {
      setShowFullSessionGroups((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
    },
    [setShowFullSessionGroups]
  );

  const handleNavigateToProject = useCallback(
    (machineId: MachineId, localProjectId: string) => {
      if (!workspaceSlug) return;
      closeMobileDrawer();
      // The landing mirrors composer steering back into the URL, so the URL
      // names the live selection: a click on an already-selected project is an
      // identical-URL no-op, and any other click is an ordinary search change
      // the landing's pre-selection effect applies.
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: { context: 'local' as const, machine: machineId, project: localProjectId },
      });
    },
    [closeMobileDrawer, router, workspaceSlug]
  );

  const handleOpenProjectSettings = useCallback(
    (machineId: MachineId, localProjectId: string) => {
      closeMobileDrawer();
      openSettings('projects', {
        machineId,
        projectKey: getLocalProjectVisibilityKey(machineId, localProjectId),
      });
    },
    [closeMobileDrawer, openSettings]
  );

  const handleArchiveProjectChats = useCallback(
    (sessionIds: string[]) => {
      void (async () => {
        for (const sessionId of sessionIds) {
          await archiveSession(sessionId as SessionId);
        }
        if (!workspaceSlug) return;
        if (!selectedSessionId || !sessionIds.includes(selectedSessionId)) return;
        await router.navigate({
          to: '/$workspaceName/chat',
          params: { workspaceName: workspaceSlug },
        });
      })().catch((error: unknown) => {
        toast.error(error instanceof Error ? error.message : String(error));
      });
    },
    [archiveSession, router, selectedSessionId, workspaceSlug]
  );

  const handleRevealProject = useCallback(
    (rootPath: string) => {
      void (async () => {
        const result = await getIpcServices()?.app.revealLocalPath(rootPath);
        if (result && !result.revealed) {
          toast.error(
            result.error === 'not_found'
              ? t('sidebar.localProjects.revealMissing', 'That folder no longer exists.')
              : t('sidebar.localProjects.revealFailed', 'Could not open that folder.')
          );
        }
      })();
    },
    [t]
  );

  const handleImportLocalProject = useCallback(async () => {
    if (!isElectron || !runtime) return;
    const selectDirectory = getIpcServices()?.localProjects.selectDirectory.bind(
      getIpcServices()!.localProjects
    );
    if (!selectDirectory) return;

    try {
      await importSidebarLocalProject({
        importProject: () =>
          selectAndWriteLocalProject({
            runtime,
            selectDirectory,
            timeoutMessage: t('localProjects.add.timeout', 'The machine did not respond in time.'),
          }),
        navigateToProject: handleNavigateToProject,
      });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [handleNavigateToProject, runtime, t]);

  const handleRequestRemoval = useCallback(
    async (pending: LocalProjectRemovalRequest) => {
      const removed = await removeLocalProject({
        machineId: pending.machineId,
        localProjectId: pending.localProjectId,
        projectName: pending.name,
        originalRootPath: pending.originalRootPath ?? undefined,
      });
      if (!removed) return;

      setLocalProjectCollapseState((prev) => {
        const key = `${pending.machineId}:${pending.localProjectId}`;
        const { [key]: _, ...rest } = prev;
        return rest;
      });

      if (
        selectedLocalProjectKey === `${pending.machineId}:${pending.localProjectId}` &&
        workspaceSlug
      ) {
        void router.navigate({
          to: '/$workspaceName/chat',
          params: { workspaceName: workspaceSlug },
        });
      }
    },
    [
      removeLocalProject,
      router,
      selectedLocalProjectKey,
      setLocalProjectCollapseState,
      workspaceSlug,
    ]
  );

  // Sub-session times roll up into the parent — opening or messaging in a child
  // tab keeps the parent fresh in the sidebar order.
  const childSessionsByParent = useMemo(
    () => buildChildSessionsByParent(allActiveSessions),
    [allActiveSessions]
  );
  const localProjectSessionsByKey = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    const sourceSessions = sessionsListLoading ? [] : sessions;

    for (const session of sourceSessions) {
      const project = session.project;
      if (!project || project.kind !== 'local') continue;
      // A multi-repository Session belongs to its Project group, even though
      // its legacy `project` projection names the first member's folder.
      if (session.projectRun) continue;
      if (scope === 'my') {
        if (!userId) continue;
        if (session.userId !== userId) continue;
      }

      const key = `${session.machineId}:${project.localProjectId}`;
      const existing = map.get(key);
      if (existing) {
        existing.push(session);
      } else {
        map.set(key, [session]);
      }
    }

    for (const sessionsForProject of map.values()) {
      sessionsForProject.sort((a, b) => {
        const aTime = getEffectiveLatestMessageAt(a, childSessionsByParent);
        const bTime = getEffectiveLatestMessageAt(b, childSessionsByParent);
        return bTime - aTime;
      });
    }

    return map;
  }, [childSessionsByParent, scope, sessions, sessionsListLoading, userId]);
  const workspaceLocalProjectSessionsByKey = useMemo(() => {
    const map = new Map<string, SessionMeta[]>();
    for (const [projectKey, sessionsForProject] of localProjectSessionsByKey) {
      map.set(
        projectKey,
        sessionsForProject.filter((session) => !session.isPinned)
      );
    }
    return map;
  }, [localProjectSessionsByKey]);

  // The ONE session-navigation callback for every sidebar surface (rows,
  // Updated items, keyboard nav). `tabSessionId` restores the precise child Tab
  // that "Go to Opener Session" points at.
  const handleNavigateToSession = useCallback(
    (sessionId: string, tabSessionId?: string) => {
      if (!workspaceSlug) return;
      closeMobileDrawer();
      if (selectedSessionIdRef.current === sessionId && tabSessionId === undefined) return;
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId: sessionId as SessionId },
        ...(tabSessionId
          ? {
              search: {
                tab: formatSessionTabSearch(tabSessionId, sessionId),
              },
            }
          : {}),
      });
    },
    [closeMobileDrawer, router, workspaceSlug]
  );

  const handleNavigateToNewSession = useCallback(
    (repoFullName?: string) => {
      if (!workspaceSlug) return;
      closeMobileDrawer();
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: repoFullName
          ? { context: 'github' as const, repo: repoFullName }
          : { context: 'chat' as const },
      });
    },
    [closeMobileDrawer, router, workspaceSlug]
  );

  const handleNewInProjectGroup = useCallback(
    (projectId: string) => {
      if (!workspaceSlug) return;
      closeMobileDrawer();
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: { context: 'group' as const, group: projectId },
      });
    },
    [closeMobileDrawer, router, workspaceSlug]
  );

  const localProjectSections = useMemo(() => {
    if (sessionsListLoading) return [];

    const localMachineMeta = localMachineId ? machineMetaMap.get(localMachineId) : undefined;
    const projectEntries = Array.from(visibleLocalProjectMap.values());
    for (const pending of pendingLocalProjectRemovals.values()) {
      if (visibleLocalProjectMap.has(pending.key)) continue;
      const machine = machineMetaMap.get(pending.machineId);
      if (!machine) continue;
      projectEntries.push({
        key: pending.key,
        machineId: pending.machineId,
        machine,
        project: pending.project,
        isMachineRegistered: true,
      });
    }
    const localProjects = localMachineId
      ? projectEntries.filter((entry) => entry.machineId === localMachineId)
      : [];

    const remoteProjectsByMachineId = new Map<MachineId, Array<(typeof localProjects)[number]>>();
    for (const entry of projectEntries) {
      if (localMachineId && entry.machineId === localMachineId) continue;
      const existing = remoteProjectsByMachineId.get(entry.machineId);
      if (existing) {
        existing.push(entry);
      } else {
        remoteProjectsByMachineId.set(entry.machineId, [entry]);
      }
    }

    const localSection =
      isElectron || localMachineId
        ? {
            kind: 'local' as const,
            sectionKey: localMachineId ?? 'local',
            machineId: localMachineId,
            // This device, by name like every other machine group (marked
            // current by a dot in the header).
            sectionLabel:
              typeof localMachineMeta?.name === 'string' && localMachineMeta.name.trim()
                ? sidebarMachineLabel(localMachineMeta.name)
                : t('sidebar.localProjects', 'Local Projects'),
            machineDisplayName:
              typeof localMachineMeta?.name === 'string' && localMachineMeta.name.trim()
                ? localMachineMeta.name.trim()
                : null,
            canImport: isElectron,
            canRemoveProject: machineSupportsLocalProjectRemovalProtocol(localMachineMeta),
            defaultCollapsed: false,
            projects: localProjects.map((entry) => entry.project),
          }
        : null;

    // The user's own machines come first; a teammate's machine follows,
    // folded by default, so the first screen shows the user's own projects.
    const isTeammateMachine = (machine: { ownerUserId?: string | null }) =>
      Boolean(userId) && Boolean(machine.ownerUserId) && machine.ownerUserId !== userId;
    const remoteSections = Array.from(remoteProjectsByMachineId.entries())
      .sort((left, right) => {
        const leftMachine = left[1][0]!.machine;
        const rightMachine = right[1][0]!.machine;
        // A missing CLI snapshot changes available actions, not the machine's
        // position. The live identity still owns localSection above.
        return compareSidebarMachineOrder(
          leftMachine,
          rightMachine,
          lastKnownLocalMachineId,
          userId
        );
      })
      .map(([machineId, entries]) => {
        const machine = entries[0]!.machine;
        const isOwnMachine = Boolean(userId) && machine.ownerUserId === userId;
        return {
          kind: 'remote' as const,
          sectionKey: machineId,
          machineId,
          // A machine grouping is labelled by the machine name alone — the leading
          // machine icon already conveys "these projects live on a machine", so we
          // drop the "projects"/"的项目" suffix the label used to carry.
          sectionLabel: sidebarMachineLabel(machine.name),
          machineDisplayName:
            typeof machine.name === 'string' && machine.name.trim() ? machine.name.trim() : null,
          canImport: false,
          // Only the machine owner can remove a remote device's projects; the
          // request is queued on that device's machine Flock doc.
          canRemoveProject: isOwnMachine && machineSupportsLocalProjectRemovalProtocol(machine),
          defaultCollapsed: isTeammateMachine(machine),
          projects: entries.map((entry) => entry.project),
        };
      });

    // Hide any section that has no projects — empty placeholders/section labels
    // should not appear in the sidebar.
    const showLocalSection = localSection && localSection.projects.length > 0;

    const savedRank = new Map(localProjectOrder.map((key, index) => [key, index]));
    return [...(showLocalSection ? [localSection] : []), ...remoteSections].map((section) => ({
      ...section,
      projects: [...section.projects].sort((a, b) => {
        const machineId = section.machineId;
        const aRank = machineId ? savedRank.get(`${machineId}:${a.id}`) : undefined;
        const bRank = machineId ? savedRank.get(`${machineId}:${b.id}`) : undefined;
        if (aRank !== undefined || bRank !== undefined) {
          if (aRank === undefined) return 1;
          if (bRank === undefined) return -1;
          if (aRank !== bRank) return aRank - bRank;
        }
        const aTime = typeof a.createdAtMs === 'number' ? a.createdAtMs : 0;
        const bTime = typeof b.createdAtMs === 'number' ? b.createdAtMs : 0;
        if (aTime !== bTime) return aTime - bTime;
        return a.name.localeCompare(b.name);
      }),
    }));
  }, [
    lastKnownLocalMachineId,
    localMachineId,
    localProjectOrder,
    machineMetaMap,
    pendingLocalProjectRemovals,
    sessionsListLoading,
    t,
    userId,
    visibleLocalProjectMap,
  ]);

  // Register newly visible projects without deleting saved entries. A project
  // may disappear briefly while its machine reconnects; retaining the key
  // keeps its chosen position when the catalog returns.
  useEffect(() => {
    if (sessionsListLoading) return;
    const prevOrder = localProjectOrderRef.current;
    const known = new Set(prevOrder);
    const discovered: string[] = [];
    for (const section of localProjectSections) {
      if (!section.machineId) continue;
      for (const project of section.projects) {
        const key = `${section.machineId}:${project.id}`;
        if (known.has(key)) continue;
        known.add(key);
        discovered.push(key);
      }
    }
    if (discovered.length > 0) setLocalProjectOrder([...prevOrder, ...discovered]);
  }, [localProjectSections, sessionsListLoading, setLocalProjectOrder]);

  const handleMoveLocalProject = useCallback(
    (sectionProjectKeys: readonly string[], event: DragEndEvent) => {
      const overId = event.over?.id;
      if (!overId) return;
      const activeKey = String(event.active.id);
      const overKey = String(overId);
      const nextOrder = moveLocalProjectOrder(
        localProjectOrderRef.current,
        sectionProjectKeys,
        activeKey,
        overKey
      );
      if (nextOrder) setLocalProjectOrder(nextOrder);
    },
    [setLocalProjectOrder]
  );

  // Build one complete, mode-independent row model first. Pinned sessions are
  // split from this model below so Workspace and Updated cannot accidentally
  // disagree about which sessions belong in the dedicated top section.
  // Items are rebuilt whenever any session changes (opening one marks it read).
  // Rows are memoized, so an unchanged item keeps its previous object and only
  // the rows whose data changed re-render.
  const previousSidebarItemsRef = useRef<readonly SidebarUpdatedItem[]>([]);
  const allSidebarItems = useMemo<SidebarUpdatedItem[]>(() => {
    if (sessionsListLoading) return [];

    const chatsLabel = t('sessions.sidebar.chats', 'Chats');
    const localSectionLabel = t('sidebar.localProjects', 'Local Projects');
    const items: SidebarUpdatedItem[] = [];

    for (const task of chatSessions) {
      items.push({
        id: task.sessionId,
        kind: 'chat',
        title: task.title,
        sectionLabel: chatsLabel,
        subtitle: null,
        machineName: task.machineName ?? null,
        historyBackend: task.historyBackend,
        latestMessageAt: task.latestMessageAt,
        isPinned: task.isPinned,
        isWorking: task.isWorking,
        isWorktree: task.isWorktree,
        hasUnreadMessages: task.hasUnreadMessages,
        isOffline: task.isOffline,
        isWaitingPermission: task.isWaitingPermission,
        externalHistoryProvider: task.externalHistoryProvider ?? null,
        owner: task.owner ?? null,
        openedBySessionId: task.openedBySessionId ?? null,
        openedByRowSessionId: task.openedByRowSessionId ?? null,
        sharing: task.sharing,
      });
    }

    for (const task of repoSessions) {
      const repoName = (task.repoFullName ?? '').trim();
      items.push({
        id: task.sessionId,
        kind: 'github',
        title: task.title,
        sectionLabel: repoName || 'GitHub Worktrees',
        subtitle: repoName || null,
        repoFullName: repoName || null,
        branchName: task.branchName,
        machineName: task.machineName ?? null,
        historyBackend: task.historyBackend,
        latestMessageAt: task.latestMessageAt,
        isPinned: task.isPinned,
        isWorking: task.isWorking,
        isWorktree: task.isWorktree,
        hasUnreadMessages: task.hasUnreadMessages,
        isOffline: task.isOffline,
        isWaitingPermission: task.isWaitingPermission,
        prStatus: task.prStatus,
        prCiState: task.prCiState,
        prReadiness: task.prReadiness,
        prNumber: task.prNumber,
        prUrl: task.prUrl ?? null,
        externalHistoryProvider: task.externalHistoryProvider ?? null,
        owner: task.owner ?? null,
        openedBySessionId: task.openedBySessionId ?? null,
        openedByRowSessionId: task.openedByRowSessionId ?? null,
        addedLines: task.addedLines,
        deletedLines: task.deletedLines,
        sharing: task.sharing,
      });
    }

    // A Project group conversation belongs to its group, not to the
    // repository of its first member, so it is neither a chat nor a GitHub row.
    const projectGroupsLabel = t('sidebar.projectGroups', 'Project groups');
    for (const task of projectGroupTasks) {
      const groupName = task.projectGroup?.name ?? '';
      items.push({
        id: task.sessionId,
        kind: 'local',
        projectGroup: true,
        title: task.title,
        sectionLabel: `${projectGroupsLabel} · ${groupName}`,
        subtitle: groupName || null,
        repoFullName: task.repoFullName ?? null,
        branchName: task.branchName,
        machineName: task.machineName ?? null,
        historyBackend: task.historyBackend,
        latestMessageAt: task.latestMessageAt,
        isPinned: task.isPinned,
        isWorking: task.isWorking,
        isWorktree: task.isWorktree,
        hasUnreadMessages: task.hasUnreadMessages,
        isOffline: task.isOffline,
        isWaitingPermission: task.isWaitingPermission,
        prStatus: task.prStatus,
        prCiState: task.prCiState,
        prReadiness: task.prReadiness,
        prNumber: task.prNumber,
        prUrl: task.prUrl ?? null,
        externalHistoryProvider: task.externalHistoryProvider ?? null,
        owner: task.owner ?? null,
        openedBySessionId: task.openedBySessionId ?? null,
        openedByRowSessionId: task.openedByRowSessionId ?? null,
        sharing: task.sharing,
      });
    }

    for (const section of localProjectSections) {
      const machineId = section.machineId;
      if (!machineId) continue;
      for (const project of section.projects) {
        const projectKey = `${machineId}:${project.id}`;
        const sessionsForProject = localProjectSessionsByKey.get(projectKey) ?? [];
        const sectionLabel = `${localSectionLabel} · ${project.name}`;
        for (const session of sessionsForProject) {
          const title = (session.title ?? '').trim() || defaultSessionTitle;
          const activity = getEffectiveSessionActivitySummary(
            session,
            childSessionsByParent,
            liveSessionStatuses
          );
          const isOffline = !onlineMachineIds.has(session.machineId);
          // Local projects linked to a GitHub repo can have a PR; carry it so the
          // row shows the same PR icon / hover info as GitHub rows.
          const prInfo = getLatestPullRequestInfo(session);
          items.push({
            id: session.id,
            kind: 'local',
            title,
            sectionLabel,
            subtitle: project.name,
            repoFullName: resolveProjectGitHubRepo(session.project) ?? null,
            machineName: section.machineDisplayName,
            historyBackend: resolveSessionHistoryBackendKind(session),
            owner: resolveSessionAuthor(session),
            latestMessageAt: activity.latestMessageAt,
            isPinned: Boolean(session.isPinned),
            isWorking: activity.isWorking,
            isWorktree: Boolean(session.isWorktree),
            externalHistoryProvider:
              session.origin === 'external-acp'
                ? (session.externalHistory?.provider ?? null)
                : null,
            hasUnreadMessages: activity.hasUnreadMessages,
            isOffline,
            isWaitingPermission: activity.isWaitingPermission,
            prStatus: prInfo.status,
            prCiState: prInfo.ciState,
            prReadiness: prInfo.readiness,
            prNumber: prInfo.number,
            prUrl: prInfo.url,
            openedBySessionId: session.openedBySessionId ?? null,
            openedByRowSessionId:
              session.openedByRootSessionId ?? resolveOpenerRowId(session.openedBySessionId),
            sharing: sessionSharingById.get(session.id),
          });
        }
      }
    }

    const previousById = new Map(previousSidebarItemsRef.current.map((item) => [item.id, item]));
    return items.map((item) => {
      const previous = previousById.get(item.id);
      return previous && jsonValueEqual(previous, item) ? previous : item;
    });
  }, [
    chatSessions,
    childSessionsByParent,
    defaultSessionTitle,
    localProjectSections,
    localProjectSessionsByKey,
    liveSessionStatuses,
    onlineMachineIds,
    projectGroupTasks,
    repoSessions,
    resolveOpenerRowId,
    resolveSessionAuthor,
    sessionsListLoading,
    sessionSharingById,
    t,
  ]);
  previousSidebarItemsRef.current = allSidebarItems;
  const pinnedItems = useMemo(
    () => sortUpdatedItems(allSidebarItems.filter((item) => item.isPinned)),
    [allSidebarItems]
  );
  const updatedItems = useMemo(
    () => allSidebarItems.filter((item) => !item.isPinned),
    [allSidebarItems]
  );

  const archiveTooltipLabel = useMemo(() => t('sessions.archive', 'Archive session'), [t]);
  const archiveActionLabel = useMemo(() => t('archive.title', 'Archive'), [t]);
  const archiveConfirmLabel = useMemo(() => t('common.confirm', 'Confirm'), [t]);
  const removeProjectLabel = useMemo(
    () => t('sidebar.localProjects.remove', 'Remove project'),
    [t]
  );
  const newChatLabel = useMemo(
    () => t('sidebar.localProjects.newChat', 'New chat in this project'),
    [t]
  );
  const toggleLabel = useMemo(() => t('common.toggle', 'Toggle'), [t]);
  const importProjectLabel = useMemo(
    () => t('sidebar.localProjects.import', 'Import local project folder'),
    [t]
  );
  const [localProjectsSectionCollapseState, setLocalProjectsSectionCollapseState] = useAtom(
    localProjectsSectionCollapseStateAtom
  );
  const handleToggleLocalProjectsSection = useCallback(
    (sectionKey: string, defaultCollapsed: boolean) => {
      setLocalProjectsSectionCollapseState((prev) => ({
        ...prev,
        [sectionKey]: !(prev[sectionKey] ?? defaultCollapsed),
      }));
    },
    [setLocalProjectsSectionCollapseState]
  );

  const showChats = sessionsListLoading || workspaceChatSessions.length > 0;
  const filterLabels = useMemo(
    () => ({
      triggerAriaLabel: t('sidebar.filter.trigger', 'Filter sidebar'),
      organizeHeading: t('sidebar.filter.organizeHeading', 'View'),
      showHeading: t('sidebar.filter.showHeading', 'Tasks'),
      organizeProject: t('sidebar.filter.organizeProject', 'Project'),
      organizeUpdated: t('sidebar.filter.organizeUpdated', 'Updated'),
      detailsHeading: t('sidebar.filter.detailsHeading', 'Details'),
      updatedProjectNames: t('sidebar.filter.updatedProjectNames', 'Show Project'),
      showBranchNames: t('sidebar.filter.showBranchNames', 'Show Branch'),
      showMyTasks: t('sessions.sidebar.my', 'My Tasks'),
      showAllTasks: t('sessions.sidebar.team', 'All Tasks'),
      emptyMyTasks: t('sidebar.filter.emptyMyTasks', 'No tasks match this view'),
      emptyMyTasksHint: t(
        'sidebar.filter.emptyMyTasksHint',
        'Try showing every task in this workspace.'
      ),
      emptyAllTasks: t('sidebar.filter.emptyAllTasks', 'No tasks yet'),
      emptyAllTasksHint: t(
        'sidebar.filter.emptyAllTasksHint',
        'Tasks in this workspace will appear here.'
      ),
      showAllTasksAction: t('sidebar.filter.showAllTasks', 'Show all tasks'),
    }),
    [t]
  );
  // The filter trigger renders in-flow as the action of whichever section
  // header is first, so alignment comes from the header row itself — no
  // overlay or placeholder. `open` is owned here, the common ancestor of every
  // candidate slot, so remounting the one instance at a new slot does not
  // close an open popover.
  const [sidebarFilterOpen, setSidebarFilterOpen] = useState(false);
  const closeFilterOnHide = useCallback(() => setSidebarFilterOpen(false), []);
  const sidebarFilterPopover = !isMobile ? (
    <SidebarFilterPopover
      organize={organizeMode}
      scope={chatScope}
      onOrganizeChange={handleOrganizeModeChange}
      onScopeChange={handleChatScopeChanged}
      showUpdatedProjectNames={showUpdatedProjectNames}
      onShowUpdatedProjectNamesChange={handleShowUpdatedProjectNamesChange}
      showBranchNames={showBranchNames}
      onShowBranchNamesChange={handleShowBranchNamesChange}
      labels={filterLabels}
      open={sidebarFilterOpen}
      onOpenChange={setSidebarFilterOpen}
      side="right"
      align="start"
      triggerSize="mini"
    />
  ) : null;
  // Sidebar task rows render as real anchors on web so middle/Cmd-click open the
  // session in a new browser tab. Electron deliberately returns undefined here:
  // its main process installs `setWindowOpenHandler` returning `{ action: 'deny' }`
  // (apps/electron/src/main/window.ts), so any anchor-driven `window.open` in
  // Electron either no-ops or escapes to `shell.openExternal` — which would push
  // the user out to the system browser instead of opening a second app window.
  // Until Electron grows multi-window + an internal-route IPC, keep rows as the
  // plain `<div role="button">` they were before this PR. See task-list.tsx anchor
  // overlay comment for the row-level rationale.
  const getSessionHref = useMemo(() => {
    if (!workspaceSlug || isElectronRenderer()) return undefined;
    return (sessionId: string) => `/${workspaceSlug}/sessions/${sessionId}`;
  }, [workspaceSlug]);

  const handleOpenTaskPullRequest = useCallback(
    (request: SessionListPullRequestOpen) => {
      if (!workspaceSlug) return;
      closeMobileDrawer();
      const prNumber =
        typeof request.prNumber === 'number' && Number.isFinite(request.prNumber)
          ? request.prNumber
          : null;
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId: request.sessionId as SessionId },
        search: prNumber ? { pr: prNumber } : {},
      });
    },
    [closeMobileDrawer, router, workspaceSlug]
  );

  // Multi-repository projects are projects: one that needs a machine (it holds
  // a folder without a GitHub remote) sits under that machine with its
  // folders; one that runs anywhere sits with the GitHub repositories.
  // Collapse state shares the repo-group store, keyed by group key, so the
  // keyboard model's group-header toggle needs no second path.
  const [projectGroupOrder, setProjectGroupOrder] = useAtom(projectGroupOrderAtom);
  const projectGroupStates = useMemo<SessionListProjectGroupState[]>(() => {
    const rank = new Map(projectGroupOrder.map((id, index) => [id, index]));
    const collapsedOf = (projectId: string) =>
      repoCollapseState[getProjectGroupSessionGroupKey(projectId)] ?? false;
    const defined = workspaceProjects
      .map((project, index) => ({ project, index }))
      .sort(
        (left, right) =>
          (rank.get(left.project.id) ?? projectGroupOrder.length + left.index) -
          (rank.get(right.project.id) ?? projectGroupOrder.length + right.index)
      )
      .map(({ project }) => ({
        projectId: project.id,
        name: project.name,
        collapsed: collapsedOf(project.id),
        canDelete: canManageWorkspaceProject(project, userId),
      }));
    // A deleted project's conversations keep its name; it folds like any group.
    const definedIds = new Set<string>(workspaceProjects.map((project) => project.id));
    const removed = new Map<string, SessionListProjectGroupState>();
    for (const session of projectGroupSessions) {
      const group = session.projectGroup;
      if (!group || definedIds.has(group.id) || removed.has(group.id)) continue;
      removed.set(group.id, {
        projectId: group.id,
        name: group.name,
        collapsed: collapsedOf(group.id),
        removed: true,
      });
    }
    return [
      ...defined,
      ...[...removed.values()].sort((left, right) => left.name.localeCompare(right.name)),
    ];
  }, [projectGroupOrder, projectGroupSessions, repoCollapseState, userId, workspaceProjects]);
  const projectGroupPlacement = useMemo(
    () =>
      placeProjectGroups({
        projects: workspaceProjects,
        states: projectGroupStates,
        sessions: projectGroupSessions,
        listedMachineIds: new Set(
          localProjectSections.flatMap((section) => (section.machineId ? [section.machineId] : []))
        ),
      }),
    [localProjectSections, projectGroupSessions, projectGroupStates, workspaceProjects]
  );
  const showGithubWorktrees =
    sessionsListLoading ||
    workspaceRepoSessions.length > 0 ||
    projectGroupPlacement.anywhere.states.length > 0 ||
    projectGroupPlacement.anywhere.sessions.length > 0;
  const requestProjectEditor = useSetAtom(projectEditorRequestAtom);
  const handleMoveProjectGroup = useCallback(
    (projectIds: string[]) => {
      const listed = new Set(projectIds);
      setProjectGroupOrder([...projectIds, ...projectGroupOrder.filter((id) => !listed.has(id))]);
    },
    [projectGroupOrder, setProjectGroupOrder]
  );
  const handleOpenProjectGroupSettings = useCallback(
    (projectId: string) => requestProjectEditor({ kind: 'edit', projectId }),
    [requestProjectEditor]
  );
  const handleDeleteProjectGroup = useCallback(
    (projectId: string) => requestProjectEditor({ kind: 'delete', projectId }),
    [requestProjectEditor]
  );
  const handleEditLocalProject = useCallback(
    (machineId: MachineId, localProjectId: string, name: string) =>
      requestProjectEditor({
        kind: 'create',
        seedSourceKey: `local:${machineId}:${localProjectId}`,
        seedName: name,
      }),
    [requestProjectEditor]
  );
  const handleEditRepoProject = useCallback(
    (repoFullName: string) =>
      requestProjectEditor({
        kind: 'create',
        seedSourceKey: `github:${repoFullName.toLowerCase()}`,
        seedName: repoFullName.split('/').pop() ?? repoFullName,
      }),
    [requestProjectEditor]
  );
  const handleToggleProjectGroupCollapsed = useCallback(
    (groupKey: string) => {
      setRepoCollapseState((prev) => ({ ...prev, [groupKey]: !prev[groupKey] }));
    },
    [setRepoCollapseState]
  );
  const renderProjectGroupList = (
    bucket: { states: SessionListProjectGroupState[]; sessions: SessionListRow[] } | undefined
  ) =>
    bucket && (bucket.states.length > 0 || bucket.sessions.length > 0) ? (
      <SessionList
        sessions={bucket.sessions}
        repos={EMPTY_REPO_STATES}
        projectGroups={bucket.states}
        isLoading={false}
        selectedSessionId={selectedSessionId}
        activeGroupKey={activeNewSessionGroup}
        onSelectSession={handleNavigateToSession}
        onNavigateSessionTab={handleNavigateToSession}
        onArchiveSession={handleArchiveSession}
        onMarkSessionUnread={handleMarkSessionUnread}
        onRenameSession={handleRenameSession}
        onTogglePinSession={handleTogglePinSession}
        onCopySessionUrl={handleCopySessionUrl}
        onShareSessionWithTeam={handleRequestShareSession}
        onToggleProjectGroupCollapsed={handleToggleProjectGroupCollapsed}
        onNewInProjectGroup={handleNewInProjectGroup}
        onOpenProjectGroupSettings={handleOpenProjectGroupSettings}
        onDeleteProjectGroup={handleDeleteProjectGroup}
        onArchiveProjectGroupChats={handleArchiveProjectChats}
        onMoveProjectGroup={isMobile ? undefined : handleMoveProjectGroup}
        onOpenPullRequest={handleOpenTaskPullRequest}
        getSessionHref={getSessionHref}
      />
    ) : null;
  const firstSectionFilterAction = pinnedItems.length === 0 ? sidebarFilterPopover : null;
  const localProjectsTopContent =
    localProjectSections.length === 0 ? null : (
      // Sections carry their own bottom margin (see sidebarTopContent): 12px
      // when expanded, 4px when collapsed so folded sections stack compactly.
      <div>
        {localProjectSections.map((section, sectionIndex) => {
          const sectionCollapsed =
            localProjectsSectionCollapseState[section.sectionKey] ?? section.defaultCollapsed;
          const sectionProjectKeys = section.machineId
            ? section.projects.map((project) => `${section.machineId}:${project.id}`)
            : [];
          const canReorderProjects = !isMobile && sectionProjectKeys.length > 1;
          const headerFilter = sectionIndex === 0 ? firstSectionFilterAction : null;
          const machineMeta = section.machineId ? machineMetaMap.get(section.machineId) : undefined;
          const sectionMachine: SidebarMachineInfo | null =
            section.machineId && machineMeta
              ? {
                  machineId: section.machineId,
                  name: machineMeta.name,
                  owner: machineMeta.ownerUserId
                    ? (membersByUserId.get(machineMeta.ownerUserId) ?? null)
                    : null,
                  isOwn:
                    section.kind === 'local' ||
                    (Boolean(userId) && machineMeta.ownerUserId === userId),
                  isCurrent: section.kind === 'local',
                  os: machineMeta.os,
                  projectCount: section.projects.length,
                }
              : null;
          // A folded machine says whether anything in its projects needs the
          // user; the mark sits where a row's would, the machine card says how many.
          // Its multi-repository projects fold with it, so they count too.
          const sectionActivity =
            sectionCollapsed && section.machineId
              ? addSidebarGroupActivity(
                  summarizeLocalSessionsActivity(
                    section.projects.flatMap(
                      (project) =>
                        workspaceLocalProjectSessionsByKey.get(
                          `${section.machineId}:${project.id}`
                        ) ?? []
                    ),
                    childSessionsByParent,
                    liveSessionStatuses,
                    sendStates
                  ),
                  summarizeSidebarGroupActivity(
                    withSessionSendStates(
                      projectGroupPlacement.byMachine.get(section.machineId)?.sessions ?? [],
                      (row) => row.sessionId,
                      sendStates
                    )
                  )
                )
              : null;
          const dividerRight =
            section.canImport && isElectron ? (
              <Button
                type="button"
                variant="ghost"
                size="mini"
                icon
                aria-label={importProjectLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleImportLocalProject();
                }}
              >
                <FolderPlus {...stylex.props(appStyles.glyph16)} strokeWidth={1.5} />
              </Button>
            ) : undefined;
          const headerAction =
            dividerRight || headerFilter ? (
              <div {...stylex.props(appStyles.headerActions)}>
                {dividerRight}
                {headerFilter}
              </div>
            ) : undefined;

          return (
            <div key={section.sectionKey} className={SIDEBAR_TOP_GROUP_SPACING(sectionCollapsed)}>
              <div {...stylex.props(appStyles.projectListSpacing)}>
                {/* No icon: a machine group reads like GitHub Worktrees and
                    Chats. "Offline" marks the exception, and hovering the
                    header tells what the group is (owner, status, OS). */}
                <SidebarSectionHeader
                  wrapToggle={(toggle) => (
                    <SidebarMachineHoverCard
                      disabled={isMobile || !sectionMachine}
                      machine={
                        sectionMachine
                          ? { ...sectionMachine, activity: sectionActivity }
                          : {
                              machineId: '' as MachineId,
                              name: section.sectionLabel,
                              isOwn: true,
                              isCurrent: true,
                              projectCount: section.projects.length,
                            }
                      }
                    >
                      {toggle}
                    </SidebarMachineHoverCard>
                  )}
                  label={
                    <span {...stylex.props(appStyles.sectionLabel)}>
                      <span {...stylex.props(appStyles.clipped)}>{section.sectionLabel}</span>
                      {section.machineId && section.kind === 'remote' ? (
                        <SidebarMachineOfflinePill machineId={section.machineId} />
                      ) : null}
                    </span>
                  }
                  collapsed={sectionCollapsed}
                  activity={sectionActivity}
                  // The machine card owns this header's hover and lists the counts.
                  describeActivity={isMobile || !sectionMachine}
                  action={headerAction}
                  isMobile={isMobile}
                  toggleLabel={toggleLabel}
                  onToggleCollapsed={() =>
                    handleToggleLocalProjectsSection(section.sectionKey, section.defaultCollapsed)
                  }
                />
              </div>

              {sectionCollapsed ? null : (
                <>
                  <DndContext
                    sensors={localProjectSensors}
                    collisionDetection={closestCenter}
                    onDragEnd={(event) => handleMoveLocalProject(sectionProjectKeys, event)}
                  >
                    <SortableContext
                      items={sectionProjectKeys}
                      strategy={verticalListSortingStrategy}
                    >
                      <div className="space-y-0.5">
                        {section.projects.map((project) => {
                          const machineId = section.machineId;
                          if (!machineId) return null;
                          const projectKey = `${machineId}:${project.id}`;
                          const collapsed = localProjectCollapseState[projectKey] ?? false;
                          const sessionGroupKey = getLocalProjectSessionGroupKey(
                            machineId,
                            project.id
                          );
                          const sessionsForProject =
                            workspaceLocalProjectSessionsByKey.get(projectKey) ?? [];
                          const isSelected = projectKey === selectedLocalProjectKey;
                          const rootPath =
                            typeof project.rootPath === 'string' ? project.rootPath.trim() : '';
                          const formattedPath = rootPath ? rootPath : null;

                          return (
                            <SortableLocalProjectItem
                              key={project.id}
                              sortableId={projectKey}
                              canReorder={canReorderProjects}
                              machineId={machineId}
                              machineName={section.machineDisplayName}
                              project={project}
                              canRemoveProject={section.canRemoveProject}
                              removalState={
                                pendingLocalProjectRemovals.has(projectKey)
                                  ? onlineMachineIds.has(machineId)
                                    ? 'removing'
                                    : 'waiting_for_device'
                                  : null
                              }
                              collapsed={collapsed}
                              whetherShowFullList={showFullSessionGroups[sessionGroupKey] ?? false}
                              isSelected={isSelected}
                              sessionsForProject={sessionsForProject}
                              childSessionsByParent={childSessionsByParent}
                              liveSessionStatuses={liveSessionStatuses}
                              resolveSessionAuthor={resolveSessionAuthor}
                              formattedPath={formattedPath}
                              defaultSessionTitle={defaultSessionTitle}
                              selectedSessionId={selectedSessionId}
                              removeProjectLabel={removeProjectLabel}
                              newChatLabel={newChatLabel}
                              archiveTooltipLabel={archiveTooltipLabel}
                              archiveActionLabel={archiveActionLabel}
                              archiveConfirmLabel={archiveConfirmLabel}
                              isMobile={isMobile}
                              toggleLabel={toggleLabel}
                              onNavigateProject={handleNavigateToProject}
                              // New Chat selects a target; it must not fork or clear
                              // the workspace-owned Chat Landing draft.
                              onNewChatInProject={handleNavigateToProject}
                              onOpenProjectSettings={handleOpenProjectSettings}
                              onEditProject={handleEditLocalProject}
                              onRevealProject={
                                isElectron && machineId === localMachineId
                                  ? handleRevealProject
                                  : undefined
                              }
                              onArchiveProjectChats={handleArchiveProjectChats}
                              onNavigateSession={handleNavigateToSession}
                              onArchive={handleArchiveSession}
                              onMarkSessionUnread={handleMarkSessionUnread}
                              onRenameSession={handleRenameSession}
                              onToggleSessionPinned={handleTogglePinSession}
                              onCopySessionUrl={handleCopySessionUrl}
                              onShareSessionWithTeam={handleRequestShareSession}
                              sessionSharingById={sessionSharingById}
                              collapsedOpenedBySessionIds={collapsedOpenedBySessionIds}
                              onToggleOpenedBySessions={handleToggleOpenedBySessions}
                              resolveOpenerRowId={resolveOpenerRowId}
                              onToggleCollapsed={toggleLocalProjectCollapsed}
                              onToggleFullList={handleToggleLocalProjectFullList}
                              onRequestRemoval={(request) => {
                                void handleRequestRemoval(request);
                              }}
                            />
                          );
                        })}
                      </div>
                    </SortableContext>
                  </DndContext>
                  {renderProjectGroupList(
                    section.machineId
                      ? projectGroupPlacement.byMachine.get(section.machineId)
                      : undefined
                  )}
                </>
              )}
            </div>
          );
        })}
      </div>
    );

  // Compute repos array from persisted state
  const repos = useMemo<SessionListRepoState[]>(() => {
    const repoSet = new Set(repoFullNames);
    const result: SessionListRepoState[] = [];
    const seen = new Set<string>();

    // First, add repos in persisted order (if they still exist)
    for (const repoFullName of repoOrder) {
      if (repoSet.has(repoFullName) && !seen.has(repoFullName)) {
        seen.add(repoFullName);
        result.push({
          repoFullName,
          collapsed: repoCollapseState[repoFullName] ?? false,
        });
      }
    }

    // Then, add any new repos not in the persisted order
    for (const repoFullName of repoFullNames) {
      if (!seen.has(repoFullName)) {
        seen.add(repoFullName);
        result.push({
          repoFullName,
          collapsed: repoCollapseState[repoFullName] ?? false,
        });
      }
    }

    return result;
  }, [repoFullNames, repoOrder, repoCollapseState]);

  // Append-only sync: register newly discovered repos into `repoOrder`, but
  // never remove. Removing on transient disappearance (scope/visibility/sync
  // races) would corrupt persisted positions and could ping-pong adjacent
  // repos every time they flicker in and out.
  const repoOrderRef = useRef(repoOrder);
  repoOrderRef.current = repoOrder;
  useEffect(() => {
    if (sessionsListLoading) return;
    if (repoFullNames.length === 0) return;
    const prevOrder = repoOrderRef.current;
    const known = new Set(prevOrder);
    const newRepos: string[] = [];
    for (const repoFullName of repoFullNames) {
      if (!known.has(repoFullName)) {
        known.add(repoFullName);
        newRepos.push(repoFullName);
      }
    }
    if (newRepos.length === 0) return;
    setRepoOrder([...prevOrder, ...newRepos]);
  }, [repoFullNames, sessionsListLoading, setRepoOrder]);

  const [chatsCollapsed, setChatsCollapsed] = useAtom(chatsCollapsedAtom);
  const handleToggleChatsCollapsed = useCallback(() => {
    setChatsCollapsed((prev) => !prev);
  }, [setChatsCollapsed]);
  const [pinnedSectionCollapsed, setPinnedSectionCollapsed] = useAtom(pinnedSectionCollapsedAtom);
  const handleTogglePinnedSection = useCallback(() => {
    setPinnedSectionCollapsed((prev) => !prev);
  }, [setPinnedSectionCollapsed]);
  const [githubWorktreesSectionCollapsed, setGithubWorktreesSectionCollapsed] = useAtom(
    githubWorktreesSectionCollapsedAtom
  );
  const handleToggleGithubWorktreesSection = useCallback(() => {
    setGithubWorktreesSectionCollapsed((prev) => !prev);
  }, [setGithubWorktreesSectionCollapsed]);
  const paidPlanTiers = useCloudQuery(cloudOperations.billing.getMyPaidWorkspacePlanTiers, {});
  const planTierByWorkspaceId = useMemo(
    () => new Map((paidPlanTiers ?? []).map((entry) => [entry.workspaceId, entry.planTier])),
    [paidPlanTiers]
  );
  const workspaces = useMemo<LoroSidebarWorkspace[]>(() => {
    return workspaceNavigation.workspaces
      .filter((org) => Boolean(org))
      .map((org) => ({
        id: org.id,
        slug: org.slug,
        name: org.name,
        logo: resolveWorkspaceIdentityLogo(org.logo, multiWorkspaceAvailable),
        planTier: planTierByWorkspaceId.get(org.id) ?? null,
        memberCount:
          org.id === activeOrganization?.id ? (activeOrganization.members?.length ?? null) : null,
      }));
  }, [
    activeOrganization,
    multiWorkspaceAvailable,
    workspaceNavigation.workspaces,
    planTierByWorkspaceId,
  ]);

  const handleHomeClicked = useCallback(() => {
    if (!workspaceSlug) return;
    closeMobileDrawer();
    void router.navigate({ to: '/$workspaceName/chat', params: { workspaceName: workspaceSlug } });
  }, [closeMobileDrawer, router, workspaceSlug]);

  const handleArchiveClicked = useCallback(() => {
    if (!workspaceSlug) return;
    closeMobileDrawer();
    if (activeNav === 'archive') {
      if (typeof window !== 'undefined' && window.history.length > 1) {
        window.history.back();
        return;
      }
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
      });
      return;
    }
    void router.navigate({
      to: '/$workspaceName/archive',
      params: { workspaceName: workspaceSlug },
    });
  }, [activeNav, closeMobileDrawer, router, workspaceSlug]);

  const handleDocsClicked = useCallback(() => {
    closeMobileDrawer();
    if (typeof window === 'undefined') return;

    // Always build an absolute URL so Electron's shell.openExternal (and
    // Capacitor's Browser plugin) receive a usable href. A relative path like
    // "/docs" resolves to the renderer's own origin (file:// or localhost in
    // dev), so `window.open` would be silently denied by Electron's window
    // open handler without ever reaching the docs site.
    const docsPath = language === 'zh_CN' ? '/zh/docs' : '/docs';
    const targetUrl = new URL(docsPath, getDocsLinkOrigin()).toString();
    void openExternalUrl(targetUrl);
  }, [closeMobileDrawer, language]);

  const handleGithubClicked = useCallback(() => {
    closeMobileDrawer();
    void openExternalUrl('https://github.com/LodyAI/Lody');
  }, [closeMobileDrawer]);

  const setJoinCommunityDialogOpen = useSetAtom(joinCommunityDialogOpenAtom);
  const handleJoinCommunityClicked = useCallback(() => {
    closeMobileDrawer();
    setJoinCommunityDialogOpen(true);
  }, [closeMobileDrawer, setJoinCommunityDialogOpen]);

  const handleFeedbackClicked = useCallback(() => {
    closeMobileDrawer();
    void openExternalUrl('https://github.com/LodyAI/Lody/issues');
  }, [closeMobileDrawer]);

  const setBugReportDialogOpen = useSetAtom(bugReportDialogOpenAtom);
  const handleBugReportClicked = useCallback(() => {
    closeMobileDrawer();
    setBugReportDialogOpen(true);
  }, [closeMobileDrawer, setBugReportDialogOpen]);

  const handleDismissUpdateBanner = useCallback(() => {
    if (!updateBanner) return;
    if (updateBanner.stage === 'downloading') {
      setDismissedDownloadingVersion(updateBanner.version);
      return;
    }
    setDismissedUpdaterVersion(updateBanner.version);
    try {
      localStorage.setItem('lody:dismissedUpdaterVersion', updateBanner.version);
    } catch {
      // Ignore storage errors
    }
  }, [updateBanner]);

  const handleOpenChangelogSite = useCallback(() => {
    void openExternalUrl(getChangelogUrl(resolvedLanguage));
  }, [resolvedLanguage]);

  const handleApplyDownloadedUpdate = useCallback(async () => {
    if (!isElectron || typeof window === 'undefined') return;
    if (!getIpcServices()) {
      return;
    }

    setIsInstallingUpdate(true);
    const result = await getIpcServices()!.updater.quitAndInstall();
    if (result.ok) {
      return;
    }

    setIsInstallingUpdate(false);
    toast.error(
      result.error ??
        t('sidebar.updateReady.installFailed', 'Failed to restart and install update.')
    );
  }, [t]);

  const handleWorkspaceSelected = workspaceNavigation.select;

  const labels: Partial<LoroSidebarLabels> = useMemo(() => {
    return {
      schedules: t('schedules.title', 'Schedules'),
      home: t('sidebar.home', 'Home'),
      docs: t('sidebar.docs', 'Docs'),
      joinCommunity: t('sidebar.joinCommunity', 'Join community'),
      feedback: t('sidebar.feedback', 'Feedback'),
      bugReport: t('sidebar.bugReport', 'Report bug'),
      myChats: t('sessions.sidebar.my', 'My Tasks'),
      teamChats: t('sessions.sidebar.team', 'All Tasks'),
      onlyChats: t('sessions.sidebar.noRepo', 'No Repo'),
      switchWorkspace: t('organization.workspaces', 'Switch workspace'),
      createWorkspace: t('organization.createWorkspace', 'Create workspace'),
      inviteMembers: t('organization.inviteMembers', 'Invite members'),
      connectGithubRepo: t('sidebar.connectGithubRepo', 'Connect GitHub repo'),
      planPlus: t('billing.plan.plus', 'Plus'),
      planEnterprise: t('billing.plan.enterprise', 'Enterprise'),
      planFree: t('billing.plan.free', 'Free'),
      pinned: t('sidebar.pinned', 'Pinned'),
      connectionLoading: t('chat.mobileHome.connectionBanner.loading', 'Connecting…'),
      connectionReconnecting: t('chat.mobileHome.connectionBanner.reconnecting', 'Reconnecting…'),
      connectionOffline: t('chat.mobileHome.connectionBanner.offline', 'Offline'),
      workspaceSyncing: t('sidebar.workspace.syncing', 'Syncing workspace…'),
      filter: filterLabels,
    };
  }, [t, filterLabels]);

  const sidebarBottomFloatingContent = useMemo(() => {
    if (!isElectron) return null;
    if (!updateBanner) return null;
    const dismissedVersion =
      updateBanner.stage === 'downloading' ? dismissedDownloadingVersion : dismissedUpdaterVersion;
    if (dismissedVersion === updateBanner.version) return null;

    return (
      <SidebarUpdateBanner
        stage={updateBanner.stage}
        version={updateBanner.version}
        percent={updateBanner.percent}
        isRestarting={isInstallingUpdate}
        onViewChangelog={() => setIsChangelogOpen(true)}
        onRestart={() => {
          void handleApplyDownloadedUpdate();
        }}
        onLater={handleDismissUpdateBanner}
      />
    );
  }, [
    dismissedDownloadingVersion,
    dismissedUpdaterVersion,
    handleApplyDownloadedUpdate,
    handleDismissUpdateBanner,
    isInstallingUpdate,
    updateBanner,
  ]);

  const githubWorktreesLabel = useMemo(() => t('sidebar.githubWorktrees', 'GitHub Worktrees'), [t]);
  const githubWorktreesCollapsedActivity = useMemo(
    () =>
      githubWorktreesSectionCollapsed
        ? summarizeSidebarGroupActivity(
            withSessionSendStates(workspaceRepoSessions, (row) => row.sessionId, sendStates)
          )
        : null,
    [githubWorktreesSectionCollapsed, sendStates, workspaceRepoSessions]
  );
  const sidebarTopContent = hasWorkspaceSidebarTopContent(
    localProjectSections.length,
    showGithubWorktrees
  ) ? (
    // Sections carry their own bottom margin: 12px expanded (wider than the
    // 10px between repo groups and the 2-4px between a section header and its
    // content, so headers bind to the list below them), 4px collapsed so a
    // stack of folded sections reads as one compact block.
    <div>
      {localProjectsTopContent}

      {showGithubWorktrees ? (
        <SidebarSectionHeader
          label={githubWorktreesLabel}
          collapsed={githubWorktreesSectionCollapsed}
          activity={githubWorktreesCollapsedActivity}
          isMobile={isMobile}
          toggleLabel={toggleLabel}
          onToggleCollapsed={handleToggleGithubWorktreesSection}
          action={
            localProjectSections.length === 0 ? (firstSectionFilterAction ?? undefined) : undefined
          }
        />
      ) : null}
    </div>
  ) : null;

  // Chats renders after the GitHub Worktrees list so it reads as the last
  // section in Workspace mode.
  const sidebarChatsContent = showChats ? (
    <SessionList
      className={
        stylex.props(chatsCollapsed ? appStyles.groupCollapsedSpacing : appStyles.chatsOpenSpacing)
          .className
      }
      sessions={workspaceChatSessions}
      repos={[]}
      isLoading={sessionsListLoading}
      chatsCollapsed={chatsCollapsed}
      headerAction={
        localProjectSections.length === 0 && !showGithubWorktrees
          ? (firstSectionFilterAction ?? undefined)
          : undefined
      }
      selectedSessionId={selectedSessionId}
      activeGroupKey={activeNewSessionGroup}
      onSelectSession={handleNavigateToSession}
      onNavigateSessionTab={handleNavigateToSession}
      onArchiveSession={handleArchiveSession}
      onMarkSessionUnread={handleMarkSessionUnread}
      onRenameSession={handleRenameSession}
      onTogglePinSession={handleTogglePinSession}
      onCopySessionUrl={handleCopySessionUrl}
      onShareSessionWithTeam={handleRequestShareSession}
      onToggleChatsCollapsed={handleToggleChatsCollapsed}
      getSessionHref={getSessionHref}
    />
  ) : null;

  const handleToggleRepoCollapsed = useCallback(
    (repoFullName: string) => {
      setRepoCollapseState((prev) => ({
        ...prev,
        [repoFullName]: !prev[repoFullName],
      }));
    },
    [setRepoCollapseState]
  );

  const handleMoveRepo = useCallback(
    (move: SessionListRepoMove) => {
      // Drag reorders only currently-visible repos. Preserve repos that exist
      // in the persisted order but aren't visible right now (e.g. no active
      // session) by keeping them after the visible ones so their positions
      // aren't lost when they reappear.
      const visibleOrder = move.nextRepos.map((r) => r.repoFullName);
      const visibleSet = new Set(visibleOrder);
      const hiddenRepos = repoOrderRef.current.filter((r) => !visibleSet.has(r));
      setRepoOrder([...visibleOrder, ...hiddenRepos]);
    },
    [setRepoOrder]
  );

  const sidebarSessionListProps = useMemo(
    () => ({
      sessions: githubWorktreesSectionCollapsed
        ? []
        : [...workspaceRepoSessions, ...projectGroupPlacement.anywhere.sessions],
      repos: githubWorktreesSectionCollapsed ? [] : repos,
      projectGroups: githubWorktreesSectionCollapsed ? [] : projectGroupPlacement.anywhere.states,
      onToggleProjectGroupCollapsed: handleToggleProjectGroupCollapsed,
      onNewInProjectGroup: handleNewInProjectGroup,
      onOpenProjectGroupSettings: handleOpenProjectGroupSettings,
      onDeleteProjectGroup: handleDeleteProjectGroup,
      onArchiveProjectGroupChats: handleArchiveProjectChats,
      onMoveProjectGroup: isMobile ? undefined : handleMoveProjectGroup,
      onEditRepoProject: handleEditRepoProject,
      onArchiveRepoChats: handleArchiveProjectChats,
      isLoading: githubWorktreesSectionCollapsed ? false : sessionsListLoading,
      selectedSessionId: selectedSessionId,
      activeGroupKey: activeNewSessionGroup,
      onSelectSession: handleNavigateToSession,
      onNavigateSessionTab: handleNavigateToSession,
      onArchiveSession: handleArchiveSession,
      onMarkSessionUnread: handleMarkSessionUnread,
      onRenameSession: handleRenameSession,
      onTogglePinSession: handleTogglePinSession,
      onCopySessionUrl: handleCopySessionUrl,
      onShareSessionWithTeam: handleRequestShareSession,
      onToggleRepoCollapsed: handleToggleRepoCollapsed,
      onMoveRepo: handleMoveRepo,
      onOpenPullRequest: handleOpenTaskPullRequest,
      onNavigateToNewSession: handleNavigateToNewSession,
      getSessionHref,
    }),
    [
      activeNewSessionGroup,
      getSessionHref,
      githubWorktreesSectionCollapsed,
      handleArchiveSession,
      handleMarkSessionUnread,
      handleCopySessionUrl,
      handleRenameSession,
      handleRequestShareSession,
      handleTogglePinSession,
      handleMoveRepo,
      handleNavigateToNewSession,
      handleOpenTaskPullRequest,
      handleNavigateToSession,
      handleToggleRepoCollapsed,
      handleArchiveProjectChats,
      handleEditRepoProject,
      handleMoveProjectGroup,
      handleNewInProjectGroup,
      handleOpenProjectGroupSettings,
      handleDeleteProjectGroup,
      handleToggleProjectGroupCollapsed,
      isMobile,
      projectGroupPlacement,
      workspaceRepoSessions,
      repos,
      selectedSessionId,
      sessionsListLoading,
    ]
  );

  const updatedSelectedItemId = selectedSessionId ?? null;
  const handleSelectUpdatedItem = handleNavigateToSession;

  const [updatedBucketCollapseState, setUpdatedBucketCollapseState] = useAtom(
    sidebarUpdatedBucketCollapseStateAtom
  );
  const handleToggleUpdatedBucket = useCallback(
    (key: SidebarUpdatedBucketKey) => {
      setUpdatedBucketCollapseState((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
    },
    [setUpdatedBucketCollapseState]
  );
  const [updatedBucketShowFullState, setUpdatedBucketShowFullState] = useAtom(
    sidebarUpdatedBucketShowFullStateAtom
  );
  const handleToggleUpdatedShowFullBucket = useCallback(
    (key: SidebarUpdatedBucketKey) => {
      setUpdatedBucketShowFullState((prev) => ({ ...prev, [key]: !(prev[key] ?? false) }));
    },
    [setUpdatedBucketShowFullState]
  );
  const handleOpenUpdatedItemPullRequest = handleOpenTaskPullRequest;

  const handleCreateWorkspaceClicked = useCallback(() => {
    closeMobileDrawer();
    void router.navigate({ to: '/workspace/create', search: { allowExisting: true } });
  }, [closeMobileDrawer, router]);

  const handleSettingsClicked = useCallback(() => {
    if (!workspaceSlug) return;
    closeMobileDrawer();
    openSettings();
  }, [closeMobileDrawer, openSettings, workspaceSlug]);

  const handleInviteClicked = useCallback(() => {
    if (!workspaceSlug) return;
    closeMobileDrawer();
    openSettings('account');
  }, [closeMobileDrawer, openSettings, workspaceSlug]);

  const handleLinkRepoClicked = useCallback(() => {
    if (!workspaceSlug) return;
    closeMobileDrawer();
    openSettings('github');
  }, [closeMobileDrawer, openSettings, workspaceSlug]);

  // --- Keyboard navigation integration ---
  const keyboardNavLocalSections = useMemo<SidebarNavigationLocalSection[]>(() => {
    const result: SidebarNavigationLocalSection[] = [];
    for (const section of localProjectSections) {
      const machineId = section.machineId;
      if (!machineId) continue;
      const projects: SidebarNavigationLocalSection['projects'] = [];
      for (const project of section.projects) {
        const projectKey = `${machineId}:${project.id}`;
        const collapsed = localProjectCollapseState[projectKey] ?? false;
        const sessionsForProject = workspaceLocalProjectSessionsByKey.get(projectKey) ?? [];
        projects.push({
          machineId,
          localProjectId: project.id,
          collapsed,
          showFull:
            showFullSessionGroups[getLocalProjectSessionGroupKey(machineId, project.id)] ?? false,
          // Mirror exactly what LocalProjectItem renders: same nesting target and
          // the same group ranking, or arrow keys drift from the visible order.
          sessions: sessionsForProject.map((s) => ({
            id: s.id,
            openedByRowSessionId:
              s.openedByRootSessionId ?? resolveOpenerRowId(s.openedBySessionId),
            rootRankMs: getEffectiveLatestMessageAt(s, childSessionsByParent),
          })),
        });
      }
      const groups = projectGroupPlacement.byMachine.get(machineId);
      result.push({
        collapsed:
          localProjectsSectionCollapseState[section.sectionKey] ?? section.defaultCollapsed,
        projects,
        projectGroups: groups?.states,
        projectGroupSessions: groups?.sessions,
      });
    }
    return result;
  }, [
    childSessionsByParent,
    localProjectSections,
    localProjectCollapseState,
    localProjectsSectionCollapseState,
    projectGroupPlacement,
    resolveOpenerRowId,
    showFullSessionGroups,
    workspaceLocalProjectSessionsByKey,
  ]);

  const activeNavRef = useRef(activeNav);
  activeNavRef.current = activeNav;
  const activeNewSessionGroupRef = useRef(activeNewSessionGroup);
  activeNewSessionGroupRef.current = activeNewSessionGroup;
  const tasksRef = useRef(tasks);
  tasksRef.current = tasks;
  const pinnedItemsRef = useRef(pinnedItems);
  pinnedItemsRef.current = pinnedItems;
  const localSectionsRef = useRef(keyboardNavLocalSections);
  localSectionsRef.current = keyboardNavLocalSections;

  const keyboardNavCallbacks = useMemo<import('@/atoms/focus-layer').SidebarNavCallbacks>(
    () => ({
      onNavigateToSession: handleNavigateToSession,
      onNavigateToNewSession: handleNavigateToNewSession,
      onToggleRepoCollapsed: handleToggleRepoCollapsed,
      onToggleChatsCollapsed: handleToggleChatsCollapsed,
      onToggleLocalProjectCollapsed: (machineId: string, localProjectId: string) =>
        toggleLocalProjectCollapsed(machineId as MachineId, localProjectId as LocalProjectId),
      getSelectedSessionId: () => selectedSessionIdRef.current,
      getSessionGroupKey: (sessionId: string) => {
        if (pinnedItemsRef.current.some((item) => item.id === sessionId)) {
          return '__pinned__';
        }
        // Check cloud tasks
        const task = tasksRef.current.find((taskItem) => taskItem.sessionId === sessionId);
        if (task) {
          if (task.projectGroup) return getProjectGroupSessionGroupKey(task.projectGroup.id);
          const repo = task.repoFullName?.trim();
          return repo || ONLY_CHATS_KEY;
        }
        // Check local project sessions
        for (const section of localSectionsRef.current) {
          for (const project of section.projects) {
            for (const session of project.sessions) {
              if (session.id === sessionId) {
                return getLocalProjectSessionGroupKey(project.machineId, project.localProjectId);
              }
            }
          }
        }
        return null;
      },
      isChatLanding: () => {
        // A "chat landing" is any /chat route without an active session (i.e. the composer
        // is shown but there's no session to browse). activeNav === 'home' only covers
        // /chat without query params; activeNewSessionGroup covers /chat?context=... routes.
        return activeNavRef.current === 'home' || activeNewSessionGroupRef.current !== null;
      },
    }),
    [
      handleNavigateToSession,
      handleNavigateToNewSession,
      handleToggleRepoCollapsed,
      handleToggleChatsCollapsed,
      toggleLocalProjectCollapsed,
    ]
  );

  const sidebarNavigationItems = useMemo(
    () =>
      buildSidebarNavigationItems({
        organizeMode,
        showFullSessionGroups,
        collapsedOpenedBySessions: collapsedOpenedBySessionIds,
        pinnedItems,
        pinnedSectionCollapsed,
        workspace: {
          localSections: keyboardNavLocalSections,
          githubSectionCollapsed: githubWorktreesSectionCollapsed,
          repoSessions: [...workspaceRepoSessions, ...projectGroupPlacement.anywhere.sessions],
          projectGroups: projectGroupPlacement.anywhere.states,
          repos,
          chatSessions: workspaceChatSessions,
          chatsCollapsed,
        },
        updated: {
          items: updatedItems,
          collapsed: updatedBucketCollapseState.all ?? false,
          showFull: updatedBucketShowFullState.all ?? false,
        },
      }),
    [
      chatsCollapsed,
      collapsedOpenedBySessionIds,
      githubWorktreesSectionCollapsed,
      projectGroupPlacement,
      keyboardNavLocalSections,
      organizeMode,
      pinnedItems,
      pinnedSectionCollapsed,
      repos,
      showFullSessionGroups,
      updatedBucketCollapseState.all,
      updatedBucketShowFullState.all,
      updatedItems,
      workspaceChatSessions,
      workspaceRepoSessions,
    ]
  );

  const handleSidebarItemFocus = useCallback(
    (item: HTMLElement) => {
      const sessionId = item.dataset.sidebarSessionId?.trim();
      if (sessionId) handleNavigateToSession(sessionId);
    },
    [handleNavigateToSession]
  );
  useListKeyboardNavigation({
    enabled: !isMobile,
    onItemFocus: handleSidebarItemFocus,
    scopeId: WORKSPACE_FOCUS_SCOPES.sidebar,
  });

  // Use cached workspace name for offline-first display, fallback to slug
  const cachedName = workspaceSlug ? getCachedWorkspaceName(workspaceSlug) : null;
  const resolvedWorkspaceName =
    expectedWorkspaceName ??
    cachedName ??
    workspaceSlug ??
    activeOrganization?.name ??
    t('organization.workspace', 'Workspace');
  const resolvedWorkspaceId = expectedWorkspaceId ?? workspaceId ?? '';

  return (
    <FocusScope
      id={WORKSPACE_FOCUS_SCOPES.sidebar}
      className={cn(
        stylex.props(appStyles.focusScope).className,
        'data-[scope-active]:ring-2 data-[scope-active]:ring-ring/30 data-[scope-active]:ring-inset',
        className
      )}
    >
      <SidebarVisibilityGate
        disableWhenHidden={pauseSidebarSourcesWhenHidden}
        onHidden={closeFilterOnHide}
      >
        <VisibleSidebarEagerSync sessions={sessions} allActiveSessions={allActiveSessions} />
        <SidebarKeyboardNavReporter
          items={sidebarNavigationItems}
          callbacks={keyboardNavCallbacks}
        />
      </SidebarVisibilityGate>
      {!isMobile ? <WindowDragStrip /> : null}
      <LoroSidebar
        className={cn(
          stylex.props(
            appStyles.shellFill,
            !isMobile && appStyles.desktopFill,
            isElectron && !isElectronFullscreen && appStyles.electronShell
          ).className
        )}
        workspaceName={resolvedWorkspaceName}
        userEmail={user?.email ?? ''}
        workspaces={workspaces}
        currentWorkspaceId={resolvedWorkspaceId}
        scrollStateKey={workspaceSlug}
        workspaceSwitcherEnabled={multiWorkspaceAvailable}
        connectionUiState={connectionUiState}
        workspaceSyncing={sessionsListLoading}
        isElectron={isElectron}
        // Traffic lights auto-hide in native fullscreen — drop the reserved
        // header inset so the sidebar's first row aligns with the top bar.
        isElectronMacOS={isElectronMacOS && !isElectronFullscreen}
        activeNav={activeNav}
        topContent={sidebarTopContent ?? undefined}
        desktopFilterAction={sidebarFilterPopover ?? undefined}
        afterSessionListContent={sidebarChatsContent ?? undefined}
        bottomFloatingContent={sidebarBottomFloatingContent ?? undefined}
        labels={labels}
        sessionListProps={sidebarSessionListProps}
        organizeMode={organizeMode}
        chatScope={chatScope}
        pinnedItems={pinnedItems}
        pinnedSectionCollapsed={pinnedSectionCollapsed}
        updatedItems={updatedItems}
        updatedSelectedItemId={updatedSelectedItemId}
        updatedBucketsCollapsed={updatedBucketCollapseState}
        updatedShowFullBuckets={updatedBucketShowFullState}
        updatedIsLoading={organizeMode === 'updated' && sessionsListLoading}
        onOrganizeModeChange={handleOrganizeModeChange}
        showUpdatedProjectNames={showUpdatedProjectNames}
        onShowUpdatedProjectNamesChange={handleShowUpdatedProjectNamesChange}
        showBranchNames={showBranchNames}
        onShowBranchNamesChange={handleShowBranchNamesChange}
        onChatScopeChange={handleChatScopeChanged}
        onSelectUpdatedItem={handleSelectUpdatedItem}
        onTogglePinnedSection={handleTogglePinnedSection}
        onToggleUpdatedBucket={handleToggleUpdatedBucket}
        onToggleUpdatedShowFullBucket={handleToggleUpdatedShowFullBucket}
        onArchiveUpdatedItem={handleArchiveSession}
        onMarkUpdatedItemUnread={handleMarkSessionUnread}
        onRenameUpdatedItem={handleRenameSession}
        onToggleUpdatedItemPinned={handleTogglePinSession}
        onCopyUpdatedItemUrl={handleCopySessionUrl}
        onShareUpdatedItemWithTeam={handleRequestShareSession}
        onOpenUpdatedItemPullRequest={handleOpenUpdatedItemPullRequest}
        getUpdatedItemHref={getSessionHref}
        defaultWidth={sidebarLastWidth > 0 ? sidebarLastWidth : undefined}
        onWidthChange={setSidebarLastWidth}
        onRequestCollapse={() => setSidebarCollapsed(true)}
        onWorkspaceSelected={handleWorkspaceSelected}
        onCreateWorkspaceClicked={handleCreateWorkspaceClicked}
        onHomeClicked={handleHomeClicked}
        onArchiveClicked={handleArchiveClicked}
        onSchedulesClicked={() => {
          if (workspaceSlug) {
            closeMobileDrawer();
            void router.navigate({
              to: '/$workspaceName/schedules',
              params: { workspaceName: workspaceSlug },
            });
          }
        }}
        onDocsClicked={handleDocsClicked}
        onGithubClicked={handleGithubClicked}
        onJoinCommunityClicked={handleJoinCommunityClicked}
        onFeedbackClicked={handleFeedbackClicked}
        onBugReportClicked={handleBugReportClicked}
        onSettingsClicked={handleSettingsClicked}
        onInviteClicked={handleInviteClicked}
        onLinkRepoClicked={handleLinkRepoClicked}
        overlay={overlay}
      />

      <SessionShareDialog
        open={showSessionSharing && pendingSessionShare != null}
        sessionTitle={pendingSessionShare?.title ?? defaultSessionTitle}
        state={showSessionSharing ? (pendingSessionShare?.sharing ?? null) : null}
        isSharing={isSharingSession}
        onOpenChange={(open) => {
          if (!open && !isSharingSession) setPendingSessionShare(null);
        }}
        onConfirm={() => {
          void handleConfirmSessionShare();
        }}
      />

      {updateBanner ? (
        <UpdateChangelogDialog
          open={isChangelogOpen}
          onOpenChange={setIsChangelogOpen}
          version={updateBanner.version}
          releaseDate={updaterState?.releaseDate}
          notes={updateReleaseNotes}
          onOpenChangelogSite={handleOpenChangelogSite}
        />
      ) : null}
    </FocusScope>
  );
}
