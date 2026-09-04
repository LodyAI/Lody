import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { startSessionMentionDrag } from '@/lib/session-mention-drag';
import { useSidebarKeyboardNav } from '@/hooks/use-sidebar-keyboard-nav';
import { useLocation, useRouter } from '@tanstack/react-router';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import {
  findFreshSessionPresenceState,
  machineSupportsLocalProjectRemovalProtocol,
  resolveProjectGitHubRepo,
  type LocalProjectId,
  type LocalProjectMeta,
  type LocalProjectWorktreeCleanupPreflightResult,
  type MachineId,
  type PrStatus,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
  type WorkspaceId,
} from '@lody/shared';
import { useTranslation } from 'react-i18next';
import { cloudOperations } from '@/lib/cloud-api-operations';
import { useAppCapability } from '@/lib/app-platform';
import { useCloudQuery } from '@lody/platform/react';
import { resolveWorkspaceIdentityLogo } from '@/lib/workspace-identity';
import { cn } from '@/lib/utils';
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
  bugReportDialogOpenAtom,
  joinCommunityDialogOpenAtom,
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  setWorkspaceContextAtom,
} from '@/atoms';
import { docMetaCacheScopeAtom } from '@/atoms/doc-meta';
import { useWorkspaceRouteTargetSlug } from '../providers/workspace-route-target';
import { resolveWorkspaceDataScope } from '@/lib/workspace-data-scope';

import { tasksFeatureEnabledAtom } from '@/atoms/settings';
import { taskQuickAddOpenAtom, taskQuickAddStatusAtom } from '@/atoms/tasks';
import { lodyConnectionUiStateAtom } from '@/atoms/control-connection';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { getLocalProjectVisibilityKey } from '@/lib/visible-local-project-index';
import { selectAndWriteLocalProject } from '@/lib/local-project-import';
import { importSidebarLocalProject } from '@/components/sidebar-local-project-import';
import { lodyPresenceNowMsAtom, lodyPresenceStatesAtom } from '@/atoms/presence';
import {
  chatScopeAtom,
  chatsCollapsedAtom,
  githubWorktreesSectionCollapsedAtom,
  localProjectCollapseStateAtom,
  localProjectsSectionCollapseStateAtom,
  pinnedSectionCollapsedAtom,
  repoCollapseStateAtom,
  repoOrderAtom,
  sidebarCollapsedAtom,
  sidebarLastWidthAtom,
  sidebarOrganizeModeAtom,
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
import { useOrganization } from '@/hooks/useOrganization';
import { useVisibleSessionMetas } from '@/hooks/use-visible-session-metas';
import { useReportVisibleSessionsForEagerSync } from '@/hooks/use-report-visible-sessions-for-eager-sync';
import {
  LoroSidebar,
  type LoroSidebarLabels,
  type LoroSidebarWorkspace,
} from '@/components/loro-sidebar';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/ui/context-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';
import { SwipeActionRow } from '@/components/shared/swipe-action-row';
import {
  SessionList,
  shallowEqualExceptKeys,
  type SessionListPullRequestOpen,
  type SessionListRepoMove,
  type SessionListRepoState,
} from '@/components/session-list';
import {
  buildChildSessionsByParent,
  buildSessionListRows,
  buildSidebarOpenerRowResolver,
  getEffectiveSessionActivitySummary,
  getEffectiveLatestMessageAt,
  getLatestPullRequestInfo,
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
  Loader2,
  Mail,
  FolderOpen,
  Monitor,
  MoreHorizontal,
  Settings2,
  Pencil,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';
import { useOnlineMachineIds } from '@/hooks/use-machine-online-status';
import { useStableNow } from '@/hooks/use-stable-now';
import { writePreferredWorkspaceSlug } from '@/lib/workspace';
import {
  SessionOpenedByTreeRow,
  SessionPrIcon,
  SessionRowAuthorAvatar,
  SessionRowLeadingSlot,
  SessionRowWorktreeIndicator,
  SidebarRowArchiveButton,
  SidebarRowEndSlot,
  SidebarSectionHeader,
  SessionRowOpenedByMenuItems,
  buildSessionRowOpenedByTreeSlot,
  type SessionRowOpenedByTreeSlot,
} from '@/components/sidebar-row-shared';
import {
  buildOpenedBySessionTree,
  hasOpenedByTreeNesting,
  normalizeSessionRowId,
} from '@/lib/session-opened-by-tree';
import { SessionInfoHoverCard } from '@/components/session-info-hover-card';
import { SessionShareDialog } from '@/components/session-sharing';
import type { SessionSharingState } from '@/lib/session-sharing';
import { useSessionSharing } from '@/hooks/use-session-sharing';
import {
  buildSidebarNavigationItems,
  type SidebarNavigationLocalSection,
} from '@/components/sidebar-navigation-model';
import {
  RenameSessionDialogView,
  type RenameSessionDialogTarget,
} from '@/components/sessions/rename-session-dialog';

export type LoroAppSidebarProps = {
  className?: string;
};

export type PendingLocalProjectRemoval = {
  machineId: MachineId;
  localProjectId: LocalProjectId;
  name: string;
  pathLabel?: string | null;
  originalRootPath?: string | null;
  conversationCount: number;
  runningSessionCount: number;
};
type LocalProjectRemovalRequest = Omit<
  PendingLocalProjectRemoval,
  'conversationCount' | 'runningSessionCount'
>;

export type LocalProjectRemovalState = 'removing' | 'waiting_for_device';

export type RemoveLocalProjectDialogProps = {
  open: boolean;
  target: PendingLocalProjectRemoval | null;
  isRemote: boolean;
  machineName?: string | null;
  deviceOnline: boolean;
  canCleanupWorktrees: boolean;
  isRemoving: boolean;
  onOpenChange: (open: boolean) => void;
  onPreflightCleanup: () => Promise<LocalProjectWorktreeCleanupPreflightResult>;
  onConfirm: (options: { cleanupWorktrees: boolean }) => void;
};

type PendingSessionShare = {
  sessionId: string;
  title: string;
  sharing: SessionSharingState;
};

const DOCS_LINK_FALLBACK_ORIGIN = 'https://lody.ai';
const SIDEBAR_RELATIVE_TIME_REFRESH_MS = 30_000;
const EMPTY_SESSION_SHARING_BY_ID: ReadonlyMap<string, SessionSharingState> = new Map();

export function RemoveLocalProjectDialog({
  open,
  target,
  isRemote,
  machineName,
  deviceOnline,
  canCleanupWorktrees,
  isRemoving,
  onOpenChange,
  onPreflightCleanup,
  onConfirm,
}: RemoveLocalProjectDialogProps) {
  const { t } = useTranslation();
  const [cleanupWorktrees, setCleanupWorktrees] = useState(false);
  const [preflight, setPreflight] = useState(
    null as LocalProjectWorktreeCleanupPreflightResult | null
  );
  const [preflightError, setPreflightError] = useState(null as string | null);
  const [isPreflighting, setIsPreflighting] = useState(false);
  const preflightGeneration = useRef(0);

  useEffect(() => {
    preflightGeneration.current += 1;
    setCleanupWorktrees(false);
    setPreflight(null);
    setPreflightError(null);
    setIsPreflighting(false);
  }, [open, target?.localProjectId]);

  const setCleanup = useCallback(
    async (checked: boolean) => {
      const generation = ++preflightGeneration.current;
      setCleanupWorktrees(checked);
      setPreflight(null);
      setPreflightError(null);
      if (!checked) return;
      setIsPreflighting(true);
      try {
        const result = await onPreflightCleanup();
        if (preflightGeneration.current === generation) setPreflight(result);
      } catch (error) {
        if (preflightGeneration.current === generation) {
          setPreflightError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (preflightGeneration.current === generation) setIsPreflighting(false);
      }
    },
    [onPreflightCleanup]
  );

  const cleanupBlocked = cleanupWorktrees && (isPreflighting || !preflight);
  const device =
    machineName?.trim() ||
    t('sidebar.localProjects.remove.remoteFallbackDevice', 'the other device');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t('sidebar.localProjects.remove.title', 'Remove “{{name}}” from Lody?', {
              name: target?.name ?? '',
            })}
          </DialogTitle>
          <DialogDescription>
            {isRemote
              ? t('sidebar.localProjects.remove.remoteDescription', { device })
              : t(
                  'sidebar.localProjects.remove.description',
                  'This removes the project from Lody.'
                )}
            {isRemote && !deviceOnline ? ` ${t('sidebar.localProjects.remove.offline')}` : null}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm text-muted-foreground">
          <div className="space-y-1">
            <p className="text-foreground/85">
              {target && target.conversationCount > 0
                ? t('sidebar.localProjects.remove.archiveDescription', {
                    count: target.conversationCount,
                  })
                : t(
                    'sidebar.localProjects.remove.archiveDescriptionEmpty',
                    'Any conversations in this project will move to Archive.'
                  )}
            </p>
            {target && target.runningSessionCount > 0 ? (
              <p>
                {t('sidebar.localProjects.remove.runningSessionsSummary', {
                  count: target.runningSessionCount,
                })}
              </p>
            ) : null}
          </div>

          <div className="rounded-lg bg-muted/60 px-3.5 py-3">
            <p className="font-medium text-foreground/90">
              {t(
                'sidebar.localProjects.remove.originalDirectorySafe',
                'Lody never deletes the original project folder or its files.'
              )}
            </p>
            <p className="mt-1 break-all font-mono text-xs">
              {(target?.pathLabel ?? target?.name) || ''}
            </p>
          </div>

          <div className="rounded-lg border border-border/70 px-3.5 py-3">
            <label className="flex items-start gap-3">
              <Checkbox
                className="mt-0.5"
                checked={cleanupWorktrees}
                disabled={!canCleanupWorktrees || isRemoving}
                onCheckedChange={(checked) => void setCleanup(checked === true)}
              />
              <span>
                <span className="block font-medium text-foreground">
                  {t(
                    'sidebar.localProjects.remove.cleanupWorktrees',
                    'Also delete session worktrees created by Lody'
                  )}
                </span>
                <span className="mt-1 block text-xs leading-relaxed">
                  {canCleanupWorktrees
                    ? t(
                        'sidebar.localProjects.remove.cleanupWorktreesHelper',
                        'Only clean worktrees are deleted. Worktrees with changes stay on disk.'
                      )
                    : t(
                        'sidebar.localProjects.remove.cleanupUnavailable',
                        'Connect the device to inspect worktrees. You can still remove the project.'
                      )}
                </span>
              </span>
            </label>

            {cleanupWorktrees ? (
              <div className="mt-3 border-t pt-3 text-xs">
                {isPreflighting ? (
                  <p className="flex items-center gap-2">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t(
                      'sidebar.localProjects.remove.checkingWorktrees',
                      'Checking each worktree for changes…'
                    )}
                  </p>
                ) : preflightError ? (
                  <p className="text-destructive">{preflightError}</p>
                ) : preflight ? (
                  <div className="space-y-2">
                    <p>
                      {t('sidebar.localProjects.remove.cleanWorktreesSummary', {
                        count: preflight.clean.length,
                      })}
                    </p>
                    {preflight.dirty.length > 0 ? (
                      <div className="rounded-md bg-amber-500/10 p-2.5 text-amber-800 dark:text-amber-300">
                        <p className="font-medium">
                          {t('sidebar.localProjects.remove.dirtyWorktreesSummary', {
                            count: preflight.dirty.length,
                          })}
                        </p>
                        <p className="mt-1 break-words">
                          {preflight.dirty.map((item) => item.title).join(', ')}
                        </p>
                      </div>
                    ) : null}
                    {preflight.failed.length > 0 ? (
                      <p className="text-muted-foreground">
                        {t('sidebar.localProjects.remove.inspectFailedSummary', {
                          count: preflight.failed.length,
                        })}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isRemoving}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={isRemoving || cleanupBlocked}
            onClick={() => onConfirm({ cleanupWorktrees })}
          >
            {isRemoving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {isRemoving
              ? t('common.processing', 'Processing...')
              : t('sidebar.localProjects.remove.confirm', 'Remove project')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

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

function isTasksRoute(pathname: string, workspaceSlug: string | null): boolean {
  const workspacePrefix = workspaceSlug ? `/${workspaceSlug}` : '';
  const normalizedPath =
    workspaceSlug && pathname.startsWith(workspacePrefix)
      ? pathname.slice(workspacePrefix.length) || '/'
      : pathname;

  return normalizedPath.startsWith('/tasks');
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
  openedByTree,
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
  const titleContent = <span className="truncate">{title}</span>;
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
        'group w-full rounded-md px-2 text-left',
        'py-1',
        'border border-transparent bg-transparent',
        !showSelectedState &&
          !isMobile &&
          'hover:bg-sidebar-hover data-[menu-open]:bg-sidebar-hover',
        showSelectedState &&
          'border-sidebar-foreground/10 bg-sidebar-foreground/10 text-sidebar-foreground hover:bg-sidebar-foreground/10',
        showSelectedState
          ? 'text-sidebar-selection-foreground'
          : 'text-sidebar-foreground dark:text-sidebar-foreground/75'
      )}
      onClick={() => {
        onNavigate(session.id);
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        onNavigate(session.id);
      }}
    >
      <div className="flex items-center gap-1.5">
        <SessionRowLeadingSlot
          isWaitingPermission={isWaitingPermission}
          isWorking={isWorking}
          hasUnreadMessages={hasUnreadMessages}
          showMenuButton={hasContextMenuActions}
          menuLabel={moreActionsLabel}
          openedByTree={openedByTree}
        />
        <div
          className="min-w-0 flex-1 flex items-center gap-1 truncate text-sm text-current"
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
          {isPinned ? (
            <Pin aria-hidden="true" className="h-3 w-3 shrink-0 text-sidebar-foreground-muted/80" />
          ) : null}
          {titleContent}
        </div>
        {/* ③ A relative time on mobile only (no hover info card on touch); on desktop
            the time / branch live in the hover info card, so nothing sits here. */}
        {isMobile ? (
          <span className="ml-auto flex shrink-0 select-none items-center gap-1 text-xs tabular-nums text-muted-foreground">
            {relativeTime}
          </span>
        ) : null}
        {/* ④ Fixed end slot: the PR status sits here at rest when the session
            has one, with a faint worktree glyph just to its left; the Archive
            button replaces it on desktop hover. */}
        <SidebarRowEndSlot
          restIcon={
            showPr || showWorktreeIcon ? (
              <span className="flex items-center gap-1.5">
                <SessionRowWorktreeIndicator isWorktree={showWorktreeIcon} />
                {showPr ? <SessionPrIcon prStatus={prStatus} prCiState={prInfo.ciState} /> : null}
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
  );

  const menuRow = hasContextMenuActions ? (
    <ContextMenu onOpenChange={setRowMenuOpen}>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[180px]">
        <SessionRowOpenedByMenuItems
          opener={openedByOpener}
          goToOpener={
            openerSessionId
              ? () => onNavigate(openerRootSessionId ?? openerSessionId, openerSessionId)
              : undefined
          }
          goToOpenerLabel={contextMenuLabels.goToOpenerSession}
        />
        {canRename ? (
          <ContextMenuItem icon={<Pencil />} onSelect={beginRename}>
            {contextMenuLabels.rename}
          </ContextMenuItem>
        ) : null}
        {canTogglePinned ? (
          <ContextMenuItem
            icon={isPinned ? <PinOff /> : <Pin />}
            onSelect={() => {
              onTogglePinned?.(session.id, !isPinned);
            }}
          >
            {isPinned ? contextMenuLabels.unpin : contextMenuLabels.pin}
          </ContextMenuItem>
        ) : null}
        {canMarkUnread ? (
          <ContextMenuItem
            icon={<Mail />}
            onSelect={() => {
              onMarkUnread?.(session.id);
            }}
          >
            {contextMenuLabels.markUnread}
          </ContextMenuItem>
        ) : null}
        <ContextMenuItem
          icon={<Archive />}
          onSelect={() => {
            onArchive(session.id);
          }}
        >
          {contextMenuLabels.archive}
        </ContextMenuItem>
        {canCopyUrl || shareMenuState ? <ContextMenuSeparator /> : null}
        {canCopyUrl ? (
          <ContextMenuItem
            icon={<Link2 />}
            onSelect={() => {
              onCopyUrl?.(session.id);
            }}
          >
            {contextMenuLabels.copyUrl}
          </ContextMenuItem>
        ) : null}
        {shareMenuState ? (
          <ContextMenuItem
            disabled={shareMenuState !== 'share'}
            icon={
              shareMenuState === 'share' ? (
                <Users />
              ) : shareMenuState === 'loading' ? (
                <Loader2 className="animate-spin" />
              ) : (
                <LockKeyhole />
              )
            }
            onSelect={() => {
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
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
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
            icon: <Archive className="h-4 w-4" />,
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
  canNavigateProject: boolean;
  removalState?: LocalProjectRemovalState | null;
  collapsed: boolean;
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
  onRequestRemoval: (info: LocalProjectRemovalRequest) => void;
};

const hoverActionClassName = cn(
  'inline-flex h-5 w-5 items-center justify-center rounded-sm',
  'text-muted-foreground/70 transition-[opacity,background-color,color] duration-100',
  'opacity-0 pointer-events-none',
  'group-hover:opacity-100 group-hover:pointer-events-auto',
  'group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto',
  'hover:text-foreground hover:bg-muted/30 focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60'
);

// The trigger itself stays pressed-looking while its menu is open, not just the
// row around it. Only the ⋯ opens a menu — the compose button beside it does not.
const menuTriggerOpenClassName =
  'group-data-[menu-open]:bg-muted/30 group-data-[menu-open]:text-foreground';

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
  canNavigateProject,
  removalState = null,
  collapsed,
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
  onRequestRemoval,
}: LocalProjectItemProps) {
  const { t } = useTranslation();
  // Same opened-by presentation the GitHub/Chats groups use: MCP-opened
  // independent Sessions indent under the Session that created them, and a
  // list with no such relationship keeps its previous flat geometry.
  const sessionNodes = useMemo(
    () =>
      buildOpenedBySessionTree(sessionsForProject, {
        getId: (session) => session.id,
        // Nest under the opener's sidebar ROW, not necessarily the precise
        // opener: a Session created from a child Tab belongs under that Tab's
        // root Session, because child Tabs have no row here.
        getOpenedBySessionId: (session) =>
          session.openedByRootSessionId ?? resolveOpenerRowId(session.openedBySessionId),
        isCollapsed: (openerId) => collapsedOpenedBySessionIds[openerId] === true,
        // Same contract as the other lists: this section is sorted by latest
        // activity, so an opener is ranked by its freshest opened Session.
        rootRank: (session) => getEffectiveLatestMessageAt(session, childSessionsByParent),
      }),
    [childSessionsByParent, collapsedOpenedBySessionIds, resolveOpenerRowId, sessionsForProject]
  );
  const showTreeGutter = hasOpenedByTreeNesting(sessionNodes);
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
  const ariaLabel = removalStateLabel ? `${baseAriaLabel} · ${removalStateLabel}` : baseAriaLabel;
  const showSelectedState = isSelected && !isMobile;
  const handleNavigate = useCallback(() => {
    if (!canNavigateProject || removalState) return;
    onNavigateProject(machineId, project.id);
  }, [canNavigateProject, machineId, onNavigateProject, project.id, removalState]);
  const projectCanNavigate = canNavigateProject && removalState === null;
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
  const showProjectMenu =
    !isMobile &&
    (canRemoveProject ||
      Boolean(onOpenProjectSettings) ||
      Boolean(revealPath) ||
      Boolean(onArchiveProjectChats));
  const showNewChatButton = Boolean(onNewChatInProject) && projectCanNavigate && !isMobile;

  return (
    <div className="space-y-0.5">
      <div className="group flex items-center">
        <ContextMenu onOpenChange={setProjectMenuOpen}>
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <ContextMenuTrigger asChild disabled={!showProjectMenu}>
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
                    'group relative w-full rounded-md pl-2 pr-3 py-1 text-left',
                    'border border-transparent bg-transparent',
                    !showSelectedState &&
                      !isMobile &&
                      'hover:bg-sidebar-hover hover:text-sidebar-hover-foreground data-[menu-open]:bg-sidebar-hover data-[menu-open]:text-sidebar-hover-foreground',
                    showSelectedState &&
                      'border-sidebar-ring/30 bg-sidebar-selection hover:bg-sidebar-selection',
                    'flex min-w-0 flex-1 select-none items-center gap-2 text-xs font-semibold transition-colors',
                    projectCanNavigate ? 'cursor-pointer' : 'cursor-default',
                    removalState && 'text-muted-foreground',
                    showSelectedState
                      ? 'text-sidebar-selection-foreground'
                      : cn(
                          // Project folder names are content rather than section chrome,
                          // but still recede behind the conversation in dark mode.
                          'text-sidebar-foreground dark:text-sidebar-foreground/75',
                          !isMobile && 'hover:text-sidebar-hover-foreground'
                        )
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
                    className="relative -mr-1.5 flex h-5 w-5 shrink-0 items-center justify-center"
                    aria-label={toggleLabel}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      onToggleCollapsed(machineId, project.id);
                    }}
                  >
                    <Folder
                      className={cn(
                        'absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-current transition-opacity duration-100',
                        // Mobile: chevron is always visible so the folder icon must hide
                        // permanently to avoid stacking. Desktop keeps the hover swap.
                        isMobile ? 'opacity-0' : 'opacity-80 group-hover:opacity-0'
                      )}
                    />
                    <ChevronDown
                      className={cn(
                        'absolute left-0 top-1/2 h-4 w-4 -translate-y-1/2 text-current',
                        'transition-[opacity,translate,scale] duration-100',
                        isMobile ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                        collapsed ? '-rotate-90' : 'rotate-0'
                      )}
                    />
                  </button>
                  <span className="min-w-0 flex-1 truncate text-left">{project.name}</span>

                  {removalStateLabel ? (
                    <Tooltip delayDuration={300}>
                      <TooltipTrigger asChild>
                        <span className="inline-flex min-w-0 shrink-0 items-center gap-1 text-[10px] font-medium text-muted-foreground">
                          {removalState === 'waiting_for_device' ? (
                            <Clock3 className="h-3 w-3 shrink-0" aria-hidden="true" />
                          ) : (
                            <Loader2 className="h-3 w-3 shrink-0 animate-spin" aria-hidden="true" />
                          )}
                          <span className="max-w-24 truncate">{removalStateLabel}</span>
                        </span>
                      </TooltipTrigger>
                      <TooltipContent side="right">{removalStateLabel}</TooltipContent>
                    </Tooltip>
                  ) : showProjectMenu || showNewChatButton ? (
                    <div className="flex shrink-0 items-center gap-0.5">
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
                          <MoreHorizontal className="h-3.5 w-3.5" />
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
                          <SquarePen className="h-3.5 w-3.5" />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </ContextMenuTrigger>
            </TooltipTrigger>
            {formattedPath || trimmedMachineName ? (
              <TooltipContent side="right" align="start" className="max-w-[420px] break-all">
                <div className="flex flex-col gap-0.5 text-xs">
                  {trimmedMachineName ? (
                    <span className="text-muted-foreground">{trimmedMachineName}</span>
                  ) : null}
                  {formattedPath ? (
                    <span className="font-mono text-[11px] leading-snug">{formattedPath}</span>
                  ) : null}
                </div>
              </TooltipContent>
            ) : null}
          </Tooltip>
          {showProjectMenu ? (
            <ContextMenuContent className="min-w-[180px]">
              {onOpenProjectSettings ? (
                <ContextMenuItem
                  icon={<Settings2 />}
                  onSelect={() => {
                    onOpenProjectSettings(machineId, project.id);
                  }}
                >
                  {projectSettingsLabel}
                </ContextMenuItem>
              ) : null}
              {revealPath ? (
                <ContextMenuItem
                  icon={<FolderOpen />}
                  onSelect={() => {
                    onRevealProject?.(revealPath);
                  }}
                >
                  {revealProjectLabel}
                </ContextMenuItem>
              ) : null}
              {onArchiveProjectChats ? (
                <ContextMenuItem
                  disabled={archivableSessionIds.length === 0}
                  icon={<Archive />}
                  onSelect={() => {
                    onArchiveProjectChats(archivableSessionIds);
                  }}
                >
                  {archiveProjectChatsLabel}
                </ContextMenuItem>
              ) : null}
              {canRemoveProject &&
              (onOpenProjectSettings || revealPath || onArchiveProjectChats) ? (
                <ContextMenuSeparator />
              ) : null}
              {canRemoveProject ? (
                <ContextMenuItem
                  icon={<Trash2 />}
                  onSelect={() => {
                    onRequestRemoval({
                      machineId,
                      localProjectId: project.id,
                      name: project.name,
                      pathLabel: formattedPath,
                      originalRootPath: project.rootPath,
                    });
                  }}
                >
                  {removeProjectLabel}
                </ContextMenuItem>
              ) : null}
            </ContextMenuContent>
          ) : null}
        </ContextMenu>
      </div>

      {!collapsed ? (
        <div className="flex flex-col gap-px">
          {sessionNodes.map((node) => {
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
                  sharing={sessionSharingById.get(session.id)}
                  archiveTooltipLabel={archiveTooltipLabel}
                  archiveActionLabel={archiveActionLabel}
                  archiveConfirmLabel={archiveConfirmLabel}
                  isMobile={isMobile}
                />
              </SessionOpenedByTreeRow>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}, localProjectItemPropsEqual);

export function LoroAppSidebar({ className }: LoroAppSidebarProps) {
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
            docMetaScope,
            organizationsReady,
            expectedWorkspaceId,
          })
        : null,
    [docMetaScope, expectedWorkspaceId, organizationsReady, runtime, workspaceSlug]
  );
  const workspaceDataReady = workspaceDataScope?.status === 'ready';
  const scopedWorkspaceId = workspaceDataReady ? workspaceDataScope.workspaceId : null;
  const { sessions, allActiveSessions } = useVisibleSessionMetas({
    workspaceId: scopedWorkspaceId,
    enabled: workspaceDataReady,
  });
  useReportVisibleSessionsForEagerSync('loro-app-sidebar', sessions, allActiveSessions);
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
  const onlineMachineIds = useOnlineMachineIds();
  const visibleMachineIds = useMemo(() => Array.from(machineMetaMap.keys()), [machineMetaMap]);
  const pendingLocalProjectRemovals = usePendingLocalProjectRemovals(visibleMachineIds);
  useLocalProjectRemovalResultNotifications(visibleMachineIds);

  const selectedSessionId = useMemo(() => {
    return getSelectedSessionId(location.pathname, workspaceSlug);
  }, [location.pathname, workspaceSlug]);
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
    if (isTasksRoute(location.pathname, workspaceSlug)) return 'tasks';
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
  const sessionSidebarCodeChangesOnly = useAtomValue(sessionSidebarCodeChangesOnlyAtom);
  const { archiveSession, markSessionUnread, setSessionPinned, updateSessionTitle } =
    useSessionActions();
  const { removeLocalProject, preflightLocalProjectRemoval, getRemoveLocalProjectImpact } =
    useRemoveLocalProject();
  const presenceStates = useAtomValue(lodyPresenceStatesAtom);
  const presenceNowMs = useAtomValue(lodyPresenceNowMsAtom);

  const handleArchiveSession = useCallback(
    (sessionId: string) => {
      void archiveSession(sessionId as SessionId);
      if (!workspaceSlug) return;
      if (selectedSessionId !== sessionId) return;
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
      });
    },
    [archiveSession, router, selectedSessionId, workspaceSlug]
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
      if (!workspaceSlug) return;
      if (typeof window === 'undefined') return;
      const path = `/${workspaceSlug}/sessions/${sessionId}`;
      // Construct an absolute web URL even on Electron (where window.location.origin
      // is a `file://` URL). Falling back to the configured site origin keeps the
      // copied link openable on any device the user pastes it into.
      const electronOrigin = isElectronRenderer()
        ? import.meta.env.VITE_SITE_URL?.trim() || ''
        : '';
      const origin =
        electronOrigin ||
        (window.location.protocol === 'file:'
          ? import.meta.env.VITE_SITE_URL?.trim() || ''
          : window.location.origin);
      const url = origin ? `${origin}${path}` : path;
      await navigator.clipboard.writeText(url);
      toast.success(successMessage);
    },
    [workspaceSlug]
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

  const [pendingLocalProjectRemoval, setPendingLocalProjectRemoval] =
    useState<PendingLocalProjectRemoval | null>(null);
  const [isRemovingLocalProject, setIsRemovingLocalProject] = useState(false);
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
    return next;
  }, [allActiveSessions, presenceNowMs, presenceStates, sessions]);
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
    const filteredSessions = sourceSessions.filter((session) => session.project?.kind !== 'local');
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

  const chatSessions = useMemo(() => tasks.filter((task) => !task.repoFullName), [tasks]);
  const repoSessions = useMemo(() => tasks.filter((task) => Boolean(task.repoFullName)), [tasks]);
  const workspaceChatSessions = useMemo(
    () => chatSessions.filter((task) => !task.isPinned),
    [chatSessions]
  );
  const workspaceRepoSessions = useMemo(
    () => repoSessions.filter((task) => !task.isPinned),
    [repoSessions]
  );
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
  // Shared with SessionList (same atom) so an opener collapsed in one sidebar
  // surface stays collapsed in the other, and with the keyboard nav model so
  // arrow keys never visit a hidden row.
  const collapsedOpenedBySessionIds = useAtomValue(sidebarCollapsedOpenedBySessionsAtom);
  const handleToggleOpenedBySessions = useSetAtom(toggleSidebarCollapsedOpenedBySessionAtom);

  const toggleLocalProjectCollapsed = useCallback(
    (machineId: MachineId, localProjectId: LocalProjectId) => {
      const key = `${machineId}:${localProjectId}`;
      setLocalProjectCollapseState((prev) => ({
        ...prev,
        [key]: !(prev[key] ?? false),
      }));
    },
    [setLocalProjectCollapseState]
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

  // Unlike the row click, which keeps whatever draft the landing already holds,
  // this starts the project's chat from scratch via the landing's reset lever.
  const handleNewChatInProject = useCallback(
    (machineId: MachineId, localProjectId: string) => {
      if (!workspaceSlug) return;
      closeMobileDrawer();
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
        search: {
          context: 'local' as const,
          machine: machineId,
          project: localProjectId,
          resetDraftKey: Date.now().toString(36),
        },
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
          // Sequential: archiveSession read-modify-writes the machine doc's
          // needToArchiveSessions map, so concurrent calls drop entries.
          await archiveSession(sessionId as SessionId);
        }
      })();
      if (!workspaceSlug) return;
      if (!selectedSessionId || !sessionIds.includes(selectedSessionId)) return;
      void router.navigate({
        to: '/$workspaceName/chat',
        params: { workspaceName: workspaceSlug },
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

  const handleConfirmRemoveLocalProject = useCallback(
    async (options: { cleanupWorktrees: boolean }) => {
      const pending = pendingLocalProjectRemoval;
      if (!pending || isRemovingLocalProject) return;

      setIsRemovingLocalProject(true);
      try {
        const removed = await removeLocalProject(
          {
            machineId: pending.machineId,
            localProjectId: pending.localProjectId,
            projectName: pending.name,
            originalRootPath: pending.originalRootPath ?? undefined,
          },
          options
        );
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
        setPendingLocalProjectRemoval(null);
      } finally {
        setIsRemovingLocalProject(false);
      }
    },
    [
      isRemovingLocalProject,
      pendingLocalProjectRemoval,
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
      if (selectedSessionId === sessionId && tabSessionId === undefined) return;
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
    [closeMobileDrawer, router, selectedSessionId, workspaceSlug]
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

  const handleRequestRemoval = useCallback(
    (info: LocalProjectRemovalRequest) => {
      const impact = getRemoveLocalProjectImpact({
        machineId: info.machineId,
        localProjectId: info.localProjectId,
      });
      setPendingLocalProjectRemoval({
        ...info,
        conversationCount: impact.conversationCount,
        runningSessionCount: impact.runningSessionCount,
      });
    },
    [getRemoveLocalProjectImpact]
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
            sectionLabel: t('sidebar.localProjects', 'Local Projects'),
            machineDisplayName:
              typeof localMachineMeta?.name === 'string' && localMachineMeta.name.trim()
                ? localMachineMeta.name.trim()
                : null,
            canImport: isElectron,
            canNavigateProject: true,
            canRemoveProject: machineSupportsLocalProjectRemovalProtocol(localMachineMeta),
            projects: localProjects.map((entry) => entry.project),
          }
        : null;

    const remoteSections = Array.from(remoteProjectsByMachineId.entries())
      .sort((left, right) => left[1][0]!.machine.name.localeCompare(right[1][0]!.machine.name))
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
          sectionLabel: machine.name,
          machineDisplayName:
            typeof machine.name === 'string' && machine.name.trim() ? machine.name.trim() : null,
          canImport: false,
          canNavigateProject: isOwnMachine,
          // Only the machine owner can remove a remote device's projects; the
          // request is queued on that device's machine Flock doc.
          canRemoveProject: isOwnMachine && machineSupportsLocalProjectRemovalProtocol(machine),
          projects: entries.map((entry) => entry.project),
        };
      });

    // Hide any section that has no projects — empty placeholders/section labels
    // should not appear in the sidebar.
    const showLocalSection = localSection && localSection.projects.length > 0;

    return [...(showLocalSection ? [localSection] : []), ...remoteSections].map((section) => ({
      ...section,
      projects: [...section.projects].sort((a, b) => {
        const aTime = typeof a.createdAtMs === 'number' ? a.createdAtMs : 0;
        const bTime = typeof b.createdAtMs === 'number' ? b.createdAtMs : 0;
        if (aTime !== bTime) return aTime - bTime;
        return a.name.localeCompare(b.name);
      }),
    }));
  }, [
    localMachineId,
    machineMetaMap,
    pendingLocalProjectRemovals,
    sessionsListLoading,
    t,
    userId,
    visibleLocalProjectMap,
  ]);

  // Build one complete, mode-independent row model first. Pinned sessions are
  // split from this model below so Workspace and Updated cannot accidentally
  // disagree about which sessions belong in the dedicated top section.
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

    return items;
  }, [
    chatSessions,
    childSessionsByParent,
    defaultSessionTitle,
    localProjectSections,
    localProjectSessionsByKey,
    liveSessionStatuses,
    onlineMachineIds,
    repoSessions,
    resolveOpenerRowId,
    resolveSessionAuthor,
    sessionsListLoading,
    sessionSharingById,
    t,
  ]);
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
    (sectionKey: string) => {
      setLocalProjectsSectionCollapseState((prev) => ({
        ...prev,
        [sectionKey]: !(prev[sectionKey] ?? false),
      }));
    },
    [setLocalProjectsSectionCollapseState]
  );

  const showChats = sessionsListLoading || workspaceChatSessions.length > 0;
  const showGithubWorktrees = sessionsListLoading || workspaceRepoSessions.length > 0;
  const filterLabels = useMemo(
    () => ({
      triggerAriaLabel: t('sidebar.filter.trigger', 'Filter sidebar'),
      organizeHeading: t('sidebar.filter.organizeHeading', 'Organize'),
      showHeading: t('sidebar.filter.showHeading', 'Show'),
      organizeWorkspace: t('sidebar.filter.organizeWorkspace', 'Workspace'),
      organizeUpdated: t('sidebar.filter.organizeUpdated', 'Updated'),
      showMyTasks: t('sessions.sidebar.my', 'My Tasks'),
      showAllTasks: t('sessions.sidebar.team', 'All Tasks'),
    }),
    [t]
  );
  const sidebarFilterPlaceholder =
    !isMobile && pinnedItems.length === 0 ? (
      <span aria-hidden="true" className="block h-6 w-6" />
    ) : null;
  const localProjectsTopContent =
    localProjectSections.length === 0 ? null : (
      // Sections carry their own bottom margin (see sidebarTopContent): 12px
      // when expanded, 4px when collapsed so folded sections stack compactly.
      <div>
        {localProjectSections.map((section, sectionIndex) => {
          const sectionCollapsed = localProjectsSectionCollapseState[section.sectionKey] ?? false;
          const headerFilter = sectionIndex === 0 ? sidebarFilterPlaceholder : null;
          const dividerRight =
            section.canImport && isElectron ? (
              <button
                type="button"
                className={cn(
                  'inline-flex h-6 w-6 items-center justify-center rounded-sm',
                  'text-muted-foreground/80 hover:bg-muted/30 hover:text-foreground',
                  'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60'
                )}
                aria-label={importProjectLabel}
                onClick={(event) => {
                  event.stopPropagation();
                  void handleImportLocalProject();
                }}
              >
                <FolderPlus className="h-4 w-4" />
              </button>
            ) : undefined;
          const headerAction =
            dividerRight || headerFilter ? (
              <div className="flex items-center gap-1">
                {dividerRight}
                {headerFilter}
              </div>
            ) : undefined;

          return (
            <div
              key={section.sectionKey}
              className={cn('space-y-0.5', sectionCollapsed ? 'mb-1 last:mb-0' : 'mb-3 last:mb-0')}
            >
              <SidebarSectionHeader
                icon={
                  section.kind === 'remote' ? (
                    <Monitor className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden="true" />
                  ) : undefined
                }
                label={section.sectionLabel}
                collapsed={sectionCollapsed}
                action={headerAction}
                isMobile={isMobile}
                toggleLabel={toggleLabel}
                onToggleCollapsed={() => handleToggleLocalProjectsSection(section.sectionKey)}
              />

              {sectionCollapsed ? null : (
                <div className="space-y-1">
                  {section.projects.map((project) => {
                    const machineId = section.machineId;
                    if (!machineId) return null;
                    const projectKey = `${machineId}:${project.id}`;
                    const collapsed = localProjectCollapseState[projectKey] ?? false;
                    const sessionsForProject =
                      workspaceLocalProjectSessionsByKey.get(projectKey) ?? [];
                    const isSelected = projectKey === selectedLocalProjectKey;
                    const rootPath =
                      typeof project.rootPath === 'string' ? project.rootPath.trim() : '';
                    const formattedPath = rootPath ? rootPath : null;

                    return (
                      <LocalProjectItem
                        key={project.id}
                        machineId={machineId}
                        machineName={section.machineDisplayName}
                        project={project}
                        canRemoveProject={section.canRemoveProject}
                        canNavigateProject={section.canNavigateProject}
                        removalState={
                          pendingLocalProjectRemovals.has(projectKey)
                            ? onlineMachineIds.has(machineId)
                              ? 'removing'
                              : 'waiting_for_device'
                            : null
                        }
                        collapsed={collapsed}
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
                        onNewChatInProject={handleNewChatInProject}
                        onOpenProjectSettings={handleOpenProjectSettings}
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
                        onRequestRemoval={handleRequestRemoval}
                      />
                    );
                  })}
                </div>
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
    return (organizations ?? [])
      .filter((org) => Boolean(org))
      .map((org) => ({
        id: org.id,
        name: org.name,
        logo: resolveWorkspaceIdentityLogo(org.logo, multiWorkspaceAvailable),
        planTier: planTierByWorkspaceId.get(org.id) ?? null,
      }));
  }, [multiWorkspaceAvailable, organizations, planTierByWorkspaceId]);

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

  const tasksEnabled = useAtomValue(tasksFeatureEnabledAtom);

  const handleTasksClicked = useCallback(() => {
    if (!workspaceSlug) return;
    closeMobileDrawer();
    if (activeNav === 'tasks') {
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
      to: '/$workspaceName/tasks',
      params: { workspaceName: workspaceSlug },
    });
  }, [activeNav, closeMobileDrawer, router, workspaceSlug]);

  // Capture without navigating: the dialog is global (MainLayout), so the `+`
  // works from anywhere the sidebar is. Status is reset because the board's
  // per-column `+` leaves its own status behind in that atom.
  const openTaskQuickAdd = useSetAtom(taskQuickAddOpenAtom);
  const setTaskQuickAddStatus = useSetAtom(taskQuickAddStatusAtom);
  const handleNewTaskClicked = useCallback(() => {
    closeMobileDrawer();
    setTaskQuickAddStatus(null);
    openTaskQuickAdd(true);
  }, [closeMobileDrawer, openTaskQuickAdd, setTaskQuickAddStatus]);

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

  const setJoinCommunityDialogOpen = useSetAtom(joinCommunityDialogOpenAtom);
  const handleJoinCommunityClicked = useCallback(() => {
    closeMobileDrawer();
    setJoinCommunityDialogOpen(true);
  }, [closeMobileDrawer, setJoinCommunityDialogOpen]);

  const handleFeedbackClicked = useCallback(() => {
    closeMobileDrawer();
    window.open('https://feedback.lody.ai', '_blank', 'noopener,noreferrer');
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

  const handleWorkspaceSelected = useCallback(
    (nextWorkspaceId: string) => {
      const target = (organizations ?? []).find((org) => org.id === nextWorkspaceId);
      const slug = target?.slug;
      if (!slug) {
        return;
      }
      writePreferredWorkspaceSlug(slug);
      setWorkspaceContext({
        slug,
        workspaceId: target.id as WorkspaceId,
      });
      void switchOrganization(target.id);
      closeMobileDrawer();
      void router.navigate({ to: '/$workspaceName/chat', params: { workspaceName: slug } });
    },
    [closeMobileDrawer, organizations, router, setWorkspaceContext, switchOrganization]
  );

  const labels: Partial<LoroSidebarLabels> = useMemo(() => {
    return {
      home: t('sidebar.home', 'Home'),
      newTask: t('tasks.newTask', 'New task'),
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
  const sidebarTopContent = (
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
          count={workspaceRepoSessions.length}
          isMobile={isMobile}
          toggleLabel={toggleLabel}
          onToggleCollapsed={handleToggleGithubWorktreesSection}
          action={
            localProjectSections.length === 0 ? (sidebarFilterPlaceholder ?? undefined) : undefined
          }
        />
      ) : null}
    </div>
  );

  // Chats renders after the GitHub Worktrees list so it reads as the last
  // section in Workspace mode.
  const sidebarChatsContent = showChats ? (
    <SessionList
      className={chatsCollapsed ? 'mb-1' : 'mb-3'}
      sessions={workspaceChatSessions}
      repos={[]}
      isLoading={sessionsListLoading}
      chatsCollapsed={chatsCollapsed}
      headerAction={
        localProjectSections.length === 0 && !showGithubWorktrees
          ? (sidebarFilterPlaceholder ?? undefined)
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
      sessions: githubWorktreesSectionCollapsed ? [] : workspaceRepoSessions,
      repos: githubWorktreesSectionCollapsed ? [] : repos,
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
      result.push({
        collapsed: localProjectsSectionCollapseState[section.sectionKey] ?? false,
        projects,
      });
    }
    return result;
  }, [
    childSessionsByParent,
    localProjectSections,
    localProjectCollapseState,
    localProjectsSectionCollapseState,
    resolveOpenerRowId,
    workspaceLocalProjectSessionsByKey,
  ]);

  const selectedSessionIdRef = useRef(selectedSessionId);
  selectedSessionIdRef.current = selectedSessionId;
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
          const repo = task.repoFullName?.trim();
          return repo || ONLY_CHATS_KEY;
        }
        // Check local project sessions
        for (const section of localSectionsRef.current) {
          for (const project of section.projects) {
            for (const session of project.sessions) {
              if (session.id === sessionId) {
                return `${project.machineId}:${project.localProjectId}`;
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

  const showFullSessionGroups = useAtomValue(sidebarShowFullListAtom);
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
          repoSessions: workspaceRepoSessions,
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

  useSidebarKeyboardNav({
    items: sidebarNavigationItems,
    callbacks: keyboardNavCallbacks,
  });
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
        'relative flow-root bg-background data-[scope-active]:ring-2 data-[scope-active]:ring-ring/30 data-[scope-active]:ring-inset data-[scope-active]:rounded-2xl',
        className
      )}
    >
      {!isMobile ? <WindowDragStrip /> : null}
      <LoroSidebar
        className={cn(
          isMobile
            ? 'h-full w-full rounded-none border-0 shadow-none'
            : 'mb-2 ml-2 mr-1 mt-2 h-[calc(100%_-_1rem)] rounded-xl border border-sidebar-border/80 bg-sidebar shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]',
          isElectron && !isElectronFullscreen && 'z-20'
        )}
        workspaceName={resolvedWorkspaceName}
        userEmail={user?.email ?? ''}
        workspaces={workspaces}
        currentWorkspaceId={resolvedWorkspaceId}
        workspaceSwitcherEnabled={multiWorkspaceAvailable}
        connectionUiState={connectionUiState}
        workspaceSyncing={sessionsListLoading}
        isElectron={isElectron}
        // Traffic lights auto-hide in native fullscreen — drop the reserved
        // header inset so the sidebar's first row aligns with the top bar.
        isElectronMacOS={isElectronMacOS && !isElectronFullscreen}
        activeNav={activeNav}
        topContent={sidebarTopContent ?? undefined}
        desktopFilterPlaceholder={sidebarFilterPlaceholder ?? undefined}
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
        onTasksClicked={handleTasksClicked}
        onNewTaskClicked={handleNewTaskClicked}
        showTasks={tasksEnabled}
        onDocsClicked={handleDocsClicked}
        onJoinCommunityClicked={handleJoinCommunityClicked}
        onFeedbackClicked={handleFeedbackClicked}
        onBugReportClicked={handleBugReportClicked}
        onSettingsClicked={handleSettingsClicked}
        onInviteClicked={handleInviteClicked}
        onLinkRepoClicked={handleLinkRepoClicked}
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

      <RemoveLocalProjectDialog
        open={pendingLocalProjectRemoval != null}
        target={pendingLocalProjectRemoval}
        isRemote={
          pendingLocalProjectRemoval != null &&
          (!localMachineId || pendingLocalProjectRemoval.machineId !== localMachineId)
        }
        machineName={
          pendingLocalProjectRemoval
            ? machineMetaMap.get(pendingLocalProjectRemoval.machineId)?.name
            : null
        }
        deviceOnline={
          pendingLocalProjectRemoval != null &&
          onlineMachineIds.has(pendingLocalProjectRemoval.machineId)
        }
        canCleanupWorktrees={
          pendingLocalProjectRemoval != null &&
          onlineMachineIds.has(pendingLocalProjectRemoval.machineId) &&
          machineSupportsLocalProjectRemovalProtocol(
            machineMetaMap.get(pendingLocalProjectRemoval.machineId)
          )
        }
        isRemoving={isRemovingLocalProject}
        onOpenChange={(open) => {
          if (!open && !isRemovingLocalProject) setPendingLocalProjectRemoval(null);
        }}
        onPreflightCleanup={() => {
          if (!pendingLocalProjectRemoval) {
            return Promise.reject(new Error('No project selected.'));
          }
          return preflightLocalProjectRemoval({
            machineId: pendingLocalProjectRemoval.machineId,
            localProjectId: pendingLocalProjectRemoval.localProjectId,
          });
        }}
        onConfirm={(options) => {
          void handleConfirmRemoveLocalProject(options);
        }}
      />
    </FocusScope>
  );
}
