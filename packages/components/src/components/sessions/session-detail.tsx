import {
  Archive,
  ArchiveRestore,
  ArrowLeft,
  ChevronLeft,
  Copy,
  Ellipsis,
  FileText,
  Folder,
  GitBranch,
  GitFork,
  Github,
  Link,
  LockKeyhole,
  Loader2,
  Monitor,
  PanelBottom,
  PanelLeft,
  PanelRight,
  Pencil,
  Search,
  Trash2,
  Users,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/ui/button';
import { useRouter } from '@tanstack/react-router';
import { useComposerNavigationFocus } from '../chat/submission/use-composer-navigation-focus';
import { usePostHog } from '@posthog/react';
import {
  buildPendingUserHistoryEntry,
  getAcpCapabilityCacheKey,
  getProjectRefBranch,
  getServerNow,
  getSessionPullRequestLegacyFields,
  getSessionRoomId,
  getAcpCapabilityCacheEntryAuthority,
  resolveProjectGitHubRepo,
  SessionForkOperationSchema,
  type CommentReferencePayload,
  type LocalProjectHistoryProvider,
  type LocalProjectId,
  type LocalProjectMeta,
  type PrStatus,
  type ProjectRef,
  type SessionId,
  type SessionMeta,
  type SessionStatus,
  type VisualAnnotationReferencePayload,
  type WorkspaceId,
} from '@lody/shared';
import {
  SessionChatInterface,
  type SessionChatInterfaceHandle,
} from '@/components/sessions/session-chat-interface';
import { WorktreeIcon } from '@/components/icons/worktree-icon';
import {
  getSessionForkDestinationOptions,
  type SessionForkDestination,
  type SessionForkWorktreeAvailability,
} from '@/components/sessions/session-fork-destination-menu';
import {
  clearSessionChatInputDrafts,
  setSessionChatInputTextDraft,
} from '@/components/sessions/session-chat-input-area';
import {
  RenameSessionDialog,
  type RenameSessionDialogTarget,
} from '@/components/sessions/rename-session-dialog';
import {
  DraftSessionChatInterface,
  type DraftSessionChatInterfaceHandle,
  type DraftSessionSendPayload,
} from '@/components/sessions/draft-session-chat-interface';
import { SessionMentionDropLayer } from '@/components/sessions/session-mention-drop-layer';
import { BaseHeader } from '@/components/page-headers/base-header';
import { useIsMobile } from '@/hooks/use-mobile';
import { usePublishSessionViewing } from '@/hooks/use-publish-session-viewing';
import { useFireOncePerKey } from '@/hooks/use-fire-once';
import { useMachineOnlineStatus } from '@/hooks/use-machine-online-status';
import { useStableCallback } from '@/hooks/use-stable-callback';
import { atom, useAtomValue, useSetAtom, useStore } from 'jotai';
import { selectAtom } from 'jotai/utils';
import {
  terminalControllerAtom,
  terminalDockAvailableAtom,
  terminalDockCanCreateAtom,
  terminalDockOpenAtom,
} from '@/components/terminal/terminal-controller';
import { isElectronRenderer, isMacOSElectronRenderer, useElectronFullscreen } from '@/lib/electron';
import { useWindowsCaptionPadClass } from '@/ui/window-drag-region';
import {
  getZenAwarePanelToggleState,
  navigationSidebarHiddenAtom,
  showNavigationSidebarAtom,
  zenLayoutModeAtom,
} from '@/atoms/layout-state';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useDocumentTitle } from '@/hooks/use-document-title';
import { useTabStatus, type TabStatus } from '@/hooks/use-tab-status';
import {
  currentWorkspaceIdAtom,
  currentWorkspaceSlugAtom,
  activeWorkspaceRuntimeAtom,
  runtimeInitializingAtom,
} from '@/atoms';
import { lodyControlConnectionStateAtom } from '@/atoms/control-connection';
import { localHomeDirAtom, localMachineIdAtom } from '@/atoms/local-probe';
import {
  sessionMetaAtomFamily,
  childSessionsAtomFamily,
  archivedChildSessionsAtomFamily,
  sideSessionsAtomFamily,
  docMetaCacheReadyAtom,
} from '@/atoms/doc-meta';
import { sessionLiveStatusAtomFamily } from '@/atoms/presence';
import { SessionTabBar, type ViewerTabItem } from './session-tab-bar';
import {
  getSideChatLauncherState,
  getSidePanelTabSelection,
  getSidePanelTabCloseFallback,
  getSidePanelTabStateAfterClose,
  getSideSessionPanelTabId,
  isViewerTabId,
  parseSideSessionPanelTabId,
  SessionSidePanelEmptyState,
  SessionSidePanelTabBar,
  type SessionSidePanelOption,
  type SessionSidePanelTabItem,
} from './session-side-panel-tab-bar';
import { getSessionTabCloseTarget, type SessionTabFocusRegion } from './session-tab-close-target';
import {
  MobileSessionTabButton,
  MobileSessionTabSheet,
  hasBackgroundUnread,
  type ConversationTabEntry,
  type ViewerTabEntry,
} from '@/components/mobile/mobile-session-tab-sheet';
import {
  MobileSessionMenuSheet,
  type MobileSessionMenuAction,
  type MobileSessionMenuInfoRow,
} from '@/components/mobile/mobile-session-menu-sheet';
import { MobileFileViewerDrawer } from '@/components/mobile/mobile-file-viewer-drawer';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
import { toast } from 'sonner';

import { SessionConversationDiffPanel } from './session-conversation-diff-panel';
import { SessionFileContentView, type SessionFileSaveViewState } from './session-file-content-view';
import { SessionFileQuickOpen } from './session-file-quick-open';
import { PrTabContainer } from './pr-tab-container';
import { SessionBrowserPanel } from './session-browser-panel';
import { deletePrCacheEntriesForSession } from '@/lib/github-pr-cache';
import { FileTreeView } from './components/file-tree-view';
import { useSessionFileActions } from '@/hooks/use-session-file-actions';
import { SessionFileActionsMenu } from './session-file-actions-menu';
import {
  MobileProjectFileBrowser,
  type MobileProjectFileBrowserHandle,
} from '@/components/files/mobile-project-file-browser';
import { getAppShareUrl } from '@/lib/app-location';
import { getCommandKeybindings, useCommand } from '@/lib/commands';
import { useDesktopTabCloser } from '@/lib/desktop-tab-or-window-close';
import { cn, getBasename } from '@/lib';

import {
  resolveSessionFileOpenTarget,
  type SessionFileOpenPathKind,
} from '@/lib/session-file-open-target';
import { isSessionMarkdownPath } from '@/lib/session-file-language';
import { SessionNotFound } from './session-not-found';
import { SessionSyncingIndicator } from './session-syncing-indicator';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/ui/sheet';
import { Drawer, DrawerContent, DrawerTitle } from '@/ui/drawer';
import { VaulDrawerBody } from '@/components/mobile/vaul-drawer-edge-back-zone';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import { SessionCreateBillingError, useSessionActions } from '@/hooks/use-session-actions';
import { useWorkspaceMembers } from '@/hooks/use-workspace-members';
import { useResolvedMachineMeta } from '@/hooks/use-resolved-machine-meta';
import { useOpenSettings } from '@/hooks/use-open-settings';
import { areStringArraysEqual } from './session-diff-summary';
import {
  areDiffCommentFocusTargetsEqual,
  getDiffCommentFocusTargetFromReference,
  type DiffCommentFocusTarget,
} from './session-conversation-diff-types';
import { useSessionDiffSummary } from './use-session-diff-summary';
import { userAtom } from '@/atoms';
import {
  appendTabOrderId,
  createDraftSessionTab,
  filterPendingPromotedChildSessions,
  getDraftTabLabel,
  isDraftSessionTabId,
  mergeTabOrderGroup,
  readPersistedDraftTabs,
  readStoredLastActiveTabState,
  readStoredTabOrder,
  removeTabOrderId,
  replaceTabOrderId,
  writePersistedDraftTabs,
  writeStoredLastActiveTabState,
  writeStoredTabOrder,
  type DraftSessionTab,
  type PersistedSidePanelTab,
} from '@/lib/session-draft-tabs';
import {
  getPullRequestNumber,
  getPullRequestRepoFullName,
  getSessionGitHubState,
} from '@/lib/session-github-state';
import {
  resolveMachineDotlodyPath,
  resolveSessionWorkspacePath,
} from '@/lib/session-workspace-path';
import {
  formatExplicitSessionTabSearch,
  formatSessionTabSearch,
  parseSessionTabSearch,
  resolveActiveSessionTab,
  type ParsedSessionTabSearch,
} from '@/lib/session-tab-url';
import {
  getSessionNavigationLocation,
  type SessionNavigationTarget,
} from '@/lib/session-navigation';
import { getSessionDetailInitialTabState } from '@/lib/session-detail-initial-state';
import { recordSessionRenderTrace, shortTraceId } from '@/lib/session-render-trace';
/* Relative, not `@/providers/*`: the Electron web tsconfig maps only an
   allowlist of `@/` subpaths and has no `@/providers/*` entry, so the alias
   spelling type-checks here but breaks `@lody/electron`. */
import { useWorkspaceRouteTargetSlug } from '../../providers/workspace-route-target';
import {
  resolveSessionFileProviderOpenPath,
  type SessionFileProviderOpenPathResolution,
} from '@/lib/session-file-provider-symlink';
import {
  getProviderFileViewerTabId as getFileViewerTabId,
  refreshPinnedProviderFileViewerTab,
} from '@/lib/session-file-provider-open-result';
import { canOpenHistoricalSessionDiffs } from '@/lib/session-file-provider';
import { useSessionDoc, useSessionDocSyncState } from '@/hooks/use-session-doc';
import { useDelayedFlag } from '@/hooks/use-delayed-flag';
import { isSyncingRoomSyncState } from '@/lib/room-sync-state';
import {
  CODE_COLLAB_CHECKING_MESSAGE,
  useCodeCollabSessionFileProvider,
} from '@/hooks/use-code-collab-session-file-provider';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';
import { resolveEffectiveCodeCollabWorkspaceId } from '@/lib/code-collab-workspace-id';
import { LoadingPlaceholder } from '@/components/loading-placeholder';
import { DesktopSessionDetailLayout } from './desktop-session-detail-layout';
import { TerminalDockHost } from '@/components/terminal-dock-host';
import {
  resolveSessionDetailPresenceState,
  resolveSessionDetailVisibilityState,
} from '@/lib/session-detail-presence';
import {
  getSessionDetailSkipTargetId,
  getSessionDetailTouchIconButtonClassName,
} from '@/lib/session-detail-a11y';
import {
  canUseProjectHistoryProjectControl,
  importProjectHistoryForLocalProject,
} from '@/lib/project-history-control-client';
import {
  getExternalHistoryProviderLabel,
  getExternalHistoryRefreshKey,
  shouldRefreshExternalHistoryOnOpen,
} from '@/lib/external-history-refresh';
import { useSessionSharing } from '@/hooks/use-session-sharing';
import {
  getSessionSharingDescription,
  getSessionSharingLabel,
  SessionShareDialog,
} from '@/components/session-sharing';
import type { SessionSharingState } from '@/lib/session-sharing';
import {
  EMPTY_COMMENT_REFERENCE_KEYS,
  getCommentReferenceKey,
} from '@/components/chat/comment-reference-state';
import {
  EMPTY_VISUAL_ANNOTATION_REFERENCE_KEYS,
  getVisualAnnotationReferenceKey,
} from '@/components/chat/visual-annotation-reference-state';
import { isNativeAppShell } from '@/lib/native-platform';
import {
  capturePostHogEvent,
  createThrottledCapture,
  getDurationSinceMs,
  getPerformanceNowMs,
} from '@/lib/posthog-analytics';
import {
  SESSION_ACP_CONFIG_USED_EVENT,
  buildSessionCreateAcpAnalyticsProperties,
} from '@/lib/session-create-analytics';
import { persistAgentSessionDefaults } from '@/lib/local-storage-cache';
import { SessionChangesSidebar } from './session-changes-sidebar';

type SidebarTab = PersistedSidePanelTab;

type ViewerTab =
  | {
      id: string;
      type: 'file';
      filePath: string;
      fileId?: string;
      label: string;
      startLine?: number;
      endLine?: number;
      focusRequestSeq?: number;
      /** One-shot request to enter the executable HTML preview after opening. */
      htmlPreviewRequestSeq?: number;
    }
  | {
      id: string;
      type: 'diff';
      turnId: string;
      filePaths: string[];
      focusFilePath: string | null;
      focusComment?: DiffCommentFocusTarget | null;
      focusRequestSeq: number;
      mode?: 'conversation' | 'base';
      label: string;
    };

type SessionDetailOpenFileOptions = {
  /** Analytics only. */
  readonly source?:
    | 'file_tree'
    | 'conversation_file_diff'
    | 'lsp'
    | 'diff_header'
    | 'html_attachment';
  /** Defaults to `markdown-href`; see `lib/session-file-open-target.ts`. */
  readonly pathKind?: SessionFileOpenPathKind;
  /** Explicit 1-based anchor, for callers that have one without encoding it in the path. */
  readonly startLine?: number;
  readonly endLine?: number;
  /** Enter rendered HTML after the file snapshot becomes available. */
  readonly previewHtml?: boolean;
};

/** Mobile diff sheet state */
type MobileDiffState = {
  turnId: string;
  filePaths: string[];
  focusFilePath: string | null;
  focusComment?: DiffCommentFocusTarget | null;
  focusRequestSeq: number;
  mode?: 'conversation' | 'base';
} | null;

type PendingSessionShare = {
  session: SessionMeta;
  sharing: SessionSharingState;
};

type ExternalHistoryRefreshViewState = {
  key: string;
  provider: LocalProjectHistoryProvider;
};

type PendingForkState = Record<
  string,
  {
    turnId: string;
    targetSessionId: SessionId;
    phase: 'requesting' | 'awaiting-history';
    placement: 'tab' | 'side-panel' | 'worktree';
  }
>;

const getPendingWorktreeForkStorageKey = (sessionId: SessionId) =>
  `lody:session:${sessionId}:pending-worktree-forks`;

function readPendingWorktreeForks(sessionId: SessionId): PendingForkState {
  if (typeof window === 'undefined') return {};
  try {
    const value = JSON.parse(
      localStorage.getItem(getPendingWorktreeForkStorageKey(sessionId)) ?? '{}'
    );
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, PendingForkState[string]] => {
        const pending = entry[1] as Partial<PendingForkState[string]> | null;
        return (
          !!pending &&
          pending.placement === 'worktree' &&
          pending.phase === 'awaiting-history' &&
          typeof pending.turnId === 'string' &&
          typeof pending.targetSessionId === 'string'
        );
      })
    );
  } catch {
    return {};
  }
}

function writePendingWorktreeForks(sessionId: SessionId, pendingForks: PendingForkState): void {
  if (typeof window === 'undefined') return;
  const durablePending = Object.fromEntries(
    Object.entries(pendingForks).filter(
      ([, pending]) => pending.placement === 'worktree' && pending.phase === 'awaiting-history'
    )
  );
  const key = getPendingWorktreeForkStorageKey(sessionId);
  if (Object.keys(durablePending).length === 0) {
    localStorage.removeItem(key);
    return;
  }
  localStorage.setItem(key, JSON.stringify(durablePending));
}

type ViewerTabSaveState = SessionFileSaveViewState & {
  readonly saveRequestSeq: number;
  readonly copyMarkdownRequestSeq: number;
};

const EMPTY_VIEWER_TAB_SAVE_STATE: ViewerTabSaveState = {
  dirty: false,
  canSave: false,
  saving: false,
  conflict: false,
  error: false,
  saveRequestSeq: 0,
  copyMarkdownRequestSeq: 0,
};

/* Top inset for mobile full-screen drawer edge-swipe strips (PR / Browser /
   Files). Sized for the tallest fixed header (`pr-tab-view.tsx` /
   Files header at `3.5rem + safe-area-top`) so the strip never covers a
   back control; shorter bars (browser toolbar) simply get a small gap. */
const MOBILE_DRAWER_HEADER_INSET = 'calc(3.5rem + var(--safe-area-top))';

/* Synthetic ids for the mobile tab sheet's Viewer group entries that aren't
   real viewer tabs — Files / PR / Browser open their own full-screen surface.
   Namespaced so they never collide with a real file/diff `ViewerTabItem.id`. */
const EMPTY_LOCAL_PROJECTS: Record<LocalProjectId, LocalProjectMeta> = {};
const MOBILE_PR_VIEWER_ID = 'mobile-viewer:pr';
const MOBILE_BROWSER_VIEWER_ID = 'mobile-viewer:browser';
const MOBILE_FILES_VIEWER_ID = 'mobile-viewer:files';

/* Minimum width the desktop right sidebar gets when the PR tab opens into a
   collapsed or empty panel — PR content (title + branch row + merge action +
   conversation) is unreadably cramped at the default ~25% split. Honored only
   when the window is wide enough; see DesktopSessionDetailLayout. */
const PR_SIDEBAR_MIN_WIDTH_PX = 500;

const selectSessionDetailMeta = (meta: SessionMeta | undefined): SessionMeta | undefined => meta;

const sessionDetailMetaEqual = (
  left: SessionMeta | undefined,
  right: SessionMeta | undefined
): boolean => left === right || JSON.stringify(left) === JSON.stringify(right);

function PendingWorktreeForkObserver({
  targetSessionId,
  onCompleted,
  onFailed,
}: {
  targetSessionId: SessionId;
  onCompleted: () => void;
  onFailed: (message: string) => void;
}) {
  const { doc, ready } = useSessionDoc(targetSessionId, { syncEnabled: true });
  const terminalRef = useRef(false);
  useEffect(() => {
    if (!ready || terminalRef.current) return;
    const operation = SessionForkOperationSchema.safeParse(doc.forkOperation);
    if (operation.success && operation.data.state === 'failed') {
      terminalRef.current = true;
      onFailed(operation.data.error?.message ?? 'Unable to create the fork worktree');
      return;
    }
    const completed = doc.history.some((entry) =>
      (entry.items ?? []).some(
        (item) => item.type === 'system_notice' && item.name === 'session_fork_origin'
      )
    );
    if (!operation.success && completed) {
      terminalRef.current = true;
      onCompleted();
    }
  }, [doc.forkOperation, doc.history, onCompleted, onFailed, ready]);
  return null;
}

const areViewerTabsEquivalent = (prev: ViewerTab, next: ViewerTab): boolean => {
  if (prev.id !== next.id || prev.type !== next.type || prev.label !== next.label) {
    return false;
  }

  if (prev.type === 'file' && next.type === 'file') {
    return (
      prev.fileId === next.fileId &&
      prev.filePath === next.filePath &&
      prev.startLine === next.startLine &&
      prev.endLine === next.endLine &&
      prev.focusRequestSeq === next.focusRequestSeq &&
      prev.htmlPreviewRequestSeq === next.htmlPreviewRequestSeq
    );
  }

  if (prev.type === 'diff' && next.type === 'diff') {
    return (
      prev.turnId === next.turnId &&
      prev.mode === next.mode &&
      prev.focusFilePath === next.focusFilePath &&
      areDiffCommentFocusTargetsEqual(prev.focusComment, next.focusComment) &&
      prev.focusRequestSeq === next.focusRequestSeq &&
      areStringArraysEqual(prev.filePaths, next.filePaths)
    );
  }

  return false;
};

const getSortedUniqueDiffFilePaths = (filePaths: readonly string[]): string[] =>
  Array.from(new Set(filePaths.map((filePath) => filePath.trim()).filter(Boolean))).toSorted(
    (left, right) => left.localeCompare(right)
  );

const getSessionProjectAnalytics = (project: {
  kind: ProjectRef['kind'] | null;
  repoFullName: string | null;
  githubRepoFullName: string | null;
  localProjectId: LocalProjectId | null;
  sessionRepoFullName: string | undefined;
}) => {
  const trimRepoFullName = (repoFullName: string | null | undefined): string | undefined => {
    const trimmed = repoFullName?.trim();
    return trimmed ? trimmed : undefined;
  };
  const resolvedProjectRepo =
    project.kind === 'github'
      ? project.repoFullName
      : project.kind === 'local'
        ? project.githubRepoFullName
        : null;
  const repoFullName =
    trimRepoFullName(resolvedProjectRepo) ?? trimRepoFullName(project.sessionRepoFullName) ?? null;
  const projectKind =
    project.kind === 'local'
      ? 'local'
      : project.kind === 'github' || repoFullName
        ? 'github'
        : 'chat';

  return {
    project_kind: projectKind,
    repo_full_name: repoFullName,
    local_project_id: project.kind === 'local' ? project.localProjectId : null,
  };
};

const getFileExtension = (filePath: string): string | null => {
  const basename = getBasename(filePath);
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === basename.length - 1) {
    return null;
  }
  return basename.slice(dotIndex + 1).toLowerCase();
};

const MobileProjectInfo = memo(function MobileProjectInfo({
  session,
  localProjectMeta,
  isSyncing,
}: {
  session: SessionMeta;
  localProjectMeta?: { name?: string; rootPath?: string } | null;
  isSyncing?: boolean;
}) {
  const project = session.project as
    | { kind: 'github'; repoFullName?: string; branch?: string }
    | { kind: 'local'; localProjectId?: string; branch?: string; githubRepoFullName?: string }
    | undefined;
  const repoFullName = (resolveProjectGitHubRepo(project) ?? session.repoFullName)?.trim() ?? '';
  const isGitHub = project?.kind === 'github' || !!repoFullName;
  const contextLabel = repoFullName || localProjectMeta?.name || '';
  const sessionTitle = session.title?.trim() ?? '';

  if (!sessionTitle && !contextLabel) {
    return isSyncing ? <SessionSyncingIndicator /> : null;
  }

  // Session title is the primary line (the header's headline); the project /
  // repo / chat identity is the muted subtitle beneath it. When there is no
  // title yet, the context label falls back up to the primary line so the
  // header is never blank.
  const primary = sessionTitle || contextLabel;
  const showSubtitle = !!sessionTitle && !!contextLabel;

  return (
    <span className="flex min-w-0 flex-col justify-center leading-tight">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[0.95rem] font-semibold text-foreground">{primary}</span>
        {isSyncing && <SessionSyncingIndicator />}
      </span>
      {showSubtitle && (
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="inline-flex shrink-0 items-center">
            {isGitHub ? <Github className="h-3 w-3" /> : <Folder className="h-3 w-3" />}
          </span>
          <span className="truncate">{contextLabel}</span>
        </span>
      )}
    </span>
  );
});

/* Glass back chevron for the mobile floating header. `onBack` leaves the
   session route, which closes the `MobileWorkspaceStack` drawer — Vaul then
   plays the slide-out and the home/project base beneath is revealed. */
function MobileSessionHeaderBackButton({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  return (
    /* -ml-1: glass disc is 36px inside a 44px hit target, so without this the
       disc sits 4px right of the conversation gutter. Shift so the disc's left
       edge lines up with the agent avatar below (ConversationColumn px-3). */
    <GlassIconButton label={t('common.back', 'Back')} onClick={onBack} className="-ml-1">
      <ChevronLeft className="h-5 w-5 text-current" strokeWidth={1.75} />
    </GlassIconButton>
  );
}

// Toggles the bottom terminal dock, which is hidden by default and only mounted
// in the desktop app (Electron). Shown only when a terminal-capable local session
// is active — the dock publishes its controller only for local projects on this
// machine, which flips `terminalDockAvailableAtom`. Kept as its own small
// component so the frequent open/close state (`terminalDockOpenAtom`) re-renders
// just this button, not the large SessionDetail tree. The controller is read
// imperatively at click time, per the guidance in terminal-controller.ts.
const TerminalDockToggleButton = memo(function TerminalDockToggleButton() {
  const { t } = useTranslation();
  const store = useStore();
  const isOpen = useAtomValue(terminalDockOpenAtom);
  const isAvailable = useAtomValue(terminalDockAvailableAtom);
  const canCreate = useAtomValue(terminalDockCanCreateAtom);
  if (!isElectronRenderer() || !isAvailable) return null;
  // Visible for any local session, but disabled until a terminal can actually be
  // created (the local daemon is still starting right after launch) so the toggle
  // never silently dead-ends.
  const label = !canCreate
    ? t(
        'sessions.terminal.unavailable',
        'Terminal unavailable — the local daemon is still starting'
      )
    : isOpen
      ? t('sessions.terminal.hide', 'Hide terminal panel')
      : t('sessions.terminal.show', 'Show terminal panel');
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      disabled={!canCreate}
      onClick={() => store.get(terminalControllerAtom)?.toggleOpen()}
      aria-label={label}
      title={label}
      className={cn('h-7 w-7 shrink-0 text-muted-foreground', isOpen && 'text-foreground')}
    >
      <PanelBottom className="h-4 w-4" />
    </Button>
  );
});

/**
 * Session detail page component.
 * Displays the chat interface for a single session.
 */
const SessionDetail = ({
  sessionId,
  urlTab,
  urlPrNumber,
  urlBrowser,
  onMobileBack,
}: {
  sessionId: SessionId;
  urlTab?: string;
  urlPrNumber?: number;
  urlBrowser?: boolean;
  onMobileBack?: () => void;
}) => {
  const { t } = useTranslation();
  const router = useRouter();
  const claimNavigationFocus = useComposerNavigationFocus(sessionId);
  const postHog = usePostHog();
  const isMobile = useIsMobile();
  const isZenLayoutMode = useAtomValue(zenLayoutModeAtom);
  const setZenLayoutMode = useSetAtom(zenLayoutModeAtom);
  const hidesBillingUi = isMobile || isNativeAppShell();
  const { openSettings } = useOpenSettings();
  const isElectronFullscreen = useElectronFullscreen();
  const windowsCaptionPadClass = useWindowsCaptionPadClass();
  // Publish ephemeral "viewing this session" presence (drives the owning
  // machine's PR poller priority); actively cleared on switch/hide/unmount.
  usePublishSessionViewing(sessionId);
  const chatRefsMap = useRef<
    Map<string, SessionChatInterfaceHandle | DraftSessionChatInterfaceHandle | null>
  >(new Map());
  const commentReferenceChangeHandlersRef = useRef<
    Map<string, (references: CommentReferencePayload[]) => void>
  >(new Map());
  const visualAnnotationReferenceChangeHandlersRef = useRef<
    Map<string, (references: VisualAnnotationReferencePayload[]) => void>
  >(new Map());
  const sendingDraftIdsRef = useRef<Set<DraftSessionTab['id']>>(new Set());
  const desktopTabFocusRegionRef = useRef<SessionTabFocusRegion>('conversation');
  const initialTabState = getSessionDetailInitialTabState(sessionId, urlTab, {
    oneActiveSurface: isMobile,
  });
  const [isSidebarOpen, setIsSidebarOpen] = useState(() => initialTabState.sidePanel.open);
  const isSidebarVisible = isSidebarOpen && !isZenLayoutMode;
  const revealRightSidebar = useCallback(() => {
    setZenLayoutMode(false);
    setIsSidebarOpen(true);
  }, [setZenLayoutMode]);
  /* Bumped whenever `isSidebarOpen` changes because side-panel state was
     RESTORED (session switch, `?pr=` deep link) rather than toggled by the
     user, so the desktop layout snaps the panel to its target width instead of
     animating a transition nobody asked for. See
     DesktopSessionDetailLayout.sidebarRestoreSeq. */
  const [sidebarRestoreSeq, setSidebarRestoreSeq] = useState(0);
  /* The `?pr=` restore below applies once per (session, PR number) — a STATE
     guard for a render-phase adjustment, keyed by session id so no separate
     session-switch reset is needed. */
  const [restoredPrSidebar, setRestoredPrSidebar] = useState<{
    sessionId: SessionId;
    prNumber: number;
  } | null>(null);
  const [activeSidebarTab, setActiveSidebarTab] = useState<SidebarTab | null>(
    () => initialTabState.sidePanel.tab
  );
  const [activeSideSessionId, setActiveSideSessionId] = useState<SessionId | null>(
    () => initialTabState.sidePanel.sideSessionId
  );
  const [openedSidebarTabs, setOpenedSidebarTabs] = useState<SidebarTab[]>(
    () => initialTabState.sidePanel.tabs
  );
  /* One-shot request for DesktopSessionDetailLayout to widen the sidebar for
     the PR tab; `seq` bumps per request so repeats are not dropped. */
  const [prSidebarWidthRequest, setPrSidebarWidthRequest] = useState<{
    seq: number;
    minWidthPx: number;
  } | null>(null);
  const [browserCandidateNavigationRequest, setBrowserCandidateNavigationRequest] = useState<{
    sessionId: SessionId;
    id: number;
  } | null>(null);
  const browserCandidateNavigationSequenceRef = useRef(0);
  const [viewerTabs, setViewerTabs] = useState<ViewerTab[]>(() => initialTabState.viewerTabs);
  const [activeViewerTabId, setActiveViewerTabId] = useState<string | null>(
    () => initialTabState.activeViewerTabId
  );
  const selectSidePanelTab = useCallback((tabId: string | null) => {
    if (tabId !== null) {
      desktopTabFocusRegionRef.current = 'side-panel';
    }
    const selection = getSidePanelTabSelection(tabId);
    setActiveSidebarTab(selection.activeSidebarTabId as SidebarTab | null);
    setActiveSideSessionId(selection.activeSideSessionId as SessionId | null);
    setActiveViewerTabId(selection.activeViewerTabId);
  }, []);
  const activateSidebarTab = useCallback(
    (tabId: SidebarTab) => {
      setOpenedSidebarTabs((current) => (current.includes(tabId) ? current : [...current, tabId]));
      selectSidePanelTab(tabId);
    },
    [selectSidePanelTab]
  );
  const [viewerTabSaveStates, setViewerTabSaveStates] = useState<
    Record<string, ViewerTabSaveState>
  >({});
  const [isFileQuickOpenOpen, setIsFileQuickOpenOpen] = useState(false);
  const [fileProviderRequestedByInteraction, setFileProviderRequestedByInteraction] =
    useState(false);
  const [mobileDiffState, setMobileDiffState] = useState<MobileDiffState>(null);
  const [mobileFilesBrowserOpen, setMobileFilesBrowserOpen] = useState(false);
  const [mobileFileViewerTabId, setMobileFileViewerTabId] = useState<string | null>(null);
  const [mobileFileViewerOpen, setMobileFileViewerOpen] = useState(false);
  const mobileFilesBrowserRef = useRef<MobileProjectFileBrowserHandle>(null);
  const [localStateSessionId, setLocalStateSessionId] = useState(sessionId);
  const [commentReferenceKeysBySession, setCommentReferenceKeysBySession] = useState<
    Record<string, string[]>
  >({});
  const [visualAnnotationReferenceKeysBySession, setVisualAnnotationReferenceKeysBySession] =
    useState<Record<string, string[]>>({});
  const focusRequestSeqRef = useRef(0);
  const attemptedExternalHistoryRefreshKeysRef = useRef<Set<string>>(new Set());
  const [externalHistoryRefreshBySessionId, setExternalHistoryRefreshBySessionId] = useState<
    Record<string, ExternalHistoryRefreshViewState>
  >({});
  /* The render-phase route target wins over the atom. During a
     cross-workspace client navigation, `currentWorkspaceSlugAtom` still holds
     the PREVIOUS workspace's non-null slug until the ancestor `$workspaceName`
     route's own effect publishes the new one — a `?tab`/`?pr` write issued in
     that window with the atom slug navigates back into the old workspace.
     Every consumer here builds a URL for the CURRENT route, so all of them
     use the effective slug (same rule as `LoroAppSidebar`); the atom is only
     the fallback for hosts mounted without `WorkspaceRouteTargetProvider`. */
  const routeTargetWorkspaceSlug = useWorkspaceRouteTargetSlug();
  const atomWorkspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const workspaceSlug = routeTargetWorkspaceSlug ?? atomWorkspaceSlug;
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom) as WorkspaceId | null;
  const isLeftSidebarHidden = useAtomValue(navigationSidebarHiddenAtom);
  const showNavigationSidebar = useSetAtom(showNavigationSidebarAtom);
  const runtime = useAtomValue(activeWorkspaceRuntimeAtom);
  const runtimeInitializing = useAtomValue(runtimeInitializingAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const localHomeDir = useAtomValue(localHomeDirAtom);
  const user = useAtomValue(userAtom);
  const {
    accessByMachineId: sharingMachineAccessById,
    accessByProjectKey: sharingProjectAccessByKey,
    machineVisibilityLoading,
    localProjectVisibilityLoading,
    showSessionSharing,
    resolve: resolveSessionSharing,
    shareWithTeam: shareSessionWithTeam,
  } = useSessionSharing();
  const controlConnectionState = useAtomValue(lodyControlConnectionStateAtom);
  // The local-token route can render before Convex workspace access fills
  // currentWorkspaceIdAtom. The workspace runtime already resolved the same id
  // from the cached slug, so Code Collab should not stay in bootstrap checking.
  const effectiveCodeCollabWorkspaceId = resolveEffectiveCodeCollabWorkspaceId({
    currentWorkspaceId,
    runtimeWorkspaceId: runtime?.workspaceId,
  });
  const sessionRoomId = getSessionRoomId(sessionId);
  const sessionMetaAtom = useMemo(
    () =>
      selectAtom(
        sessionMetaAtomFamily(sessionRoomId),
        selectSessionDetailMeta,
        sessionDetailMetaEqual
      ),
    [sessionRoomId]
  );
  const session = useAtomValue(sessionMetaAtom);
  const docMetaCacheReady = useAtomValue(docMetaCacheReadyAtom);
  const activeSession = session ?? null;
  const activeSessionSharing = useMemo(
    () => (showSessionSharing && activeSession ? resolveSessionSharing(activeSession) : null),
    [activeSession, resolveSessionSharing, showSessionSharing]
  );
  const [pendingSessionShare, setPendingSessionShare] = useState<PendingSessionShare | null>(null);
  const [isSharingSession, setIsSharingSession] = useState(false);

  useEffect(() => {
    if (!showSessionSharing) setPendingSessionShare(null);
  }, [showSessionSharing]);
  const activeSessionLiveStatus = useAtomValue(
    sessionLiveStatusAtomFamily((activeSession?.id ?? '__no_session__') as SessionId)
  );
  const codeCollabRequestedRole = useCodeCollabRequestedRole();
  const hasFileProviderViewerTabs = useMemo(
    () => viewerTabs.some((tab) => tab.type === 'file' || tab.type === 'diff'),
    [viewerTabs]
  );
  const isFileProviderSidebarActive =
    isSidebarVisible && (activeSidebarTab === 'files' || activeSidebarTab === 'changes');
  const isSessionStateCurrent = localStateSessionId === sessionId;
  const activeSessionFileProviderRequested = Boolean(
    activeSession &&
    isSessionStateCurrent &&
    (isFileQuickOpenOpen ||
      hasFileProviderViewerTabs ||
      mobileDiffState !== null ||
      /* The mobile files drawer is the only tree surface on that platform:
         `isFileProviderSidebarActive` needs the desktop side panel, which
         the mobile branch never renders, so without this the drawer would
         open against a provider that was never built. */
      mobileFilesBrowserOpen ||
      isFileProviderSidebarActive ||
      fileProviderRequestedByInteraction)
  );
  const activeSessionFileProviderEnabled = Boolean(
    activeSessionFileProviderRequested && effectiveCodeCollabWorkspaceId
  );
  const activeSessionCodeCollabFiles = useCodeCollabSessionFileProvider({
    workspaceId: effectiveCodeCollabWorkspaceId,
    sessionId: activeSession?.id ?? sessionId,
    enabled: activeSessionFileProviderEnabled,
    requestedRole: codeCollabRequestedRole,
    machineId: activeSession?.machineId,
    requestedByUserId: user?.id ?? activeSession?.userId,
    githubRepoFullName:
      (resolveProjectGitHubRepo(activeSession?.project) ?? activeSession?.repoFullName)?.trim() ??
      null,
    debugLabel: 'session-detail:file-provider',
  });
  const activeSessionFileProvider = activeSessionCodeCollabFiles.provider;
  const canOpenHistoricalDiffs = canOpenHistoricalSessionDiffs(activeSessionFileProvider);
  const activeSessionFileProviderBootstrapPending = Boolean(
    activeSessionFileProviderRequested && activeSession && !effectiveCodeCollabWorkspaceId
  );
  const activeSessionFileProviderPending =
    activeSessionFileProviderRequested &&
    !activeSessionFileProvider &&
    (activeSessionFileProviderBootstrapPending ||
      activeSessionCodeCollabFiles.status === 'checking' ||
      activeSessionCodeCollabFiles.status === 'loading');
  const activeSessionFileProviderMessage = activeSessionFileProviderBootstrapPending
    ? CODE_COLLAB_CHECKING_MESSAGE
    : activeSessionCodeCollabFiles.message;
  const parsedUrlTab = useMemo(() => parseSessionTabSearch(urlTab), [urlTab]);

  // Multi-tab: load child sessions
  const childSessionsAtom = useMemo(() => childSessionsAtomFamily(sessionId), [sessionId]);
  const childSessions = useAtomValue(childSessionsAtom);
  const sideSessionsAtom = useMemo(() => sideSessionsAtomFamily(sessionId), [sessionId]);
  const sideSessions = useAtomValue(sideSessionsAtom);
  const archivedChildSessionsAtom = useMemo(
    () => archivedChildSessionsAtomFamily(sessionId),
    [sessionId]
  );
  const archivedChildSessions = useAtomValue(archivedChildSessionsAtom);
  const [draftTabs, setDraftTabsState] = useState<DraftSessionTab[]>(() =>
    readPersistedDraftTabs(sessionId)
  );
  const [pendingDraftChildSessionIds, setPendingDraftChildSessionIds] = useState<
    Partial<Record<DraftSessionTab['id'], SessionId>>
  >({});
  const [pendingForks, setPendingForks] = useState<PendingForkState>(() =>
    readPendingWorktreeForks(sessionId)
  );
  const [worktreeAvailabilityBySessionId, setWorktreeAvailabilityBySessionId] = useState<
    Partial<Record<string, 'available' | 'unavailable' | 'checking'>>
  >({});
  const worktreeAvailabilityRequestRef = useRef<Set<string>>(new Set());
  const [dirtyForkConfirmation, setDirtyForkConfirmation] = useState<{
    source: SessionMeta;
    turnId: string;
    targetSessionId: SessionId;
  } | null>(null);
  const [closingSideSessionIds, setClosingSideSessionIds] = useState<Set<SessionId>>(
    () => new Set()
  );
  // Every side chat is a durable tab, so mounting them all would open one Loro
  // session doc per side chat on every session-detail mount — even for a user
  // who never expands the panel. A side chat mounts when it is first selected
  // and stays mounted afterwards, so switching panels never tears down its state.
  const [mountedSideSessionIds, setMountedSideSessionIds] = useState<Set<SessionId>>(
    () => new Set()
  );
  const [tabOrder, setTabOrderState] = useState<string[]>(() => readStoredTabOrder(sessionId));
  const detailLoadStartMsRef = useRef(getPerformanceNowMs());
  const fireDetailNotFoundOnce = useFireOncePerKey<SessionId>();

  if (localStateSessionId !== sessionId) {
    const nextInitialTabState = getSessionDetailInitialTabState(sessionId, urlTab, {
      oneActiveSurface: isMobile,
    });
    detailLoadStartMsRef.current = getPerformanceNowMs();
    sendingDraftIdsRef.current.clear();
    desktopTabFocusRegionRef.current = 'conversation';
    setLocalStateSessionId(sessionId);
    setSidebarRestoreSeq((seq) => seq + 1);
    setIsSidebarOpen(nextInitialTabState.sidePanel.open);
    setActiveSidebarTab(nextInitialTabState.sidePanel.tab);
    setActiveSideSessionId(nextInitialTabState.sidePanel.sideSessionId);
    setOpenedSidebarTabs(nextInitialTabState.sidePanel.tabs);
    setDraftTabsState(readPersistedDraftTabs(sessionId));
    setPendingDraftChildSessionIds({});
    setPendingForks(readPendingWorktreeForks(sessionId));
    setWorktreeAvailabilityBySessionId({});
    worktreeAvailabilityRequestRef.current = new Set();
    setDirtyForkConfirmation(null);
    setClosingSideSessionIds(new Set());
    setMountedSideSessionIds(new Set());
    setTabOrderState(readStoredTabOrder(sessionId));
    setViewerTabs(nextInitialTabState.viewerTabs);
    setActiveViewerTabId(nextInitialTabState.activeViewerTabId);
    setViewerTabSaveStates({});
    setMobileDiffState(null);
    setMobileFilesBrowserOpen(false);
    setFileProviderRequestedByInteraction(false);
  }

  const setDraftTabs = useCallback(
    (
      updater: DraftSessionTab[] | ((prev: DraftSessionTab[]) => DraftSessionTab[])
    ): DraftSessionTab[] => {
      let nextDraftTabs: DraftSessionTab[] = [];
      setDraftTabsState((prev) => {
        nextDraftTabs = typeof updater === 'function' ? updater(prev) : updater;
        return nextDraftTabs;
      });
      return nextDraftTabs;
    },
    []
  );

  // Child meta can appear before startSession() or fork RPC resolves. Hide a
  // requesting target until its RPC succeeds. Once acknowledged, mount the
  // child tab in the background and keep its source button loading until the
  // child conversation surface has durable history ready to paint.
  const requestingForkTargetIds = useMemo(
    () =>
      new Set(
        Object.values(pendingForks)
          .filter((pending) => pending.phase === 'requesting')
          .map((pending) => pending.targetSessionId)
      ),
    [pendingForks]
  );
  const visibleChildSessions = useMemo(
    () =>
      filterPendingPromotedChildSessions(
        childSessions,
        draftTabs,
        pendingDraftChildSessionIds
      ).filter((child) => !requestingForkTargetIds.has(child.id)),
    [childSessions, draftTabs, pendingDraftChildSessionIds, requestingForkTargetIds]
  );
  const visibleSideSessions = useMemo(
    () => sideSessions.filter((sideSession) => !requestingForkTargetIds.has(sideSession.id)),
    [requestingForkTargetIds, sideSessions]
  );

  const sessionGroupIds = useMemo(
    () => [
      ...visibleChildSessions.map((childSession) => childSession.id),
      ...draftTabs.map((draft) => draft.id),
    ],
    [visibleChildSessions, draftTabs]
  );
  const sessionTabOrder = useMemo(
    () => tabOrder.filter((tabId) => !isViewerTabId(tabId)),
    [tabOrder]
  );
  useEffect(() => {
    setViewerTabSaveStates((prev) => {
      const liveIds = new Set(viewerTabs.map((tab) => tab.id));
      const next: Record<string, ViewerTabSaveState> = {};
      let changed = false;
      for (const [tabId, state] of Object.entries(prev)) {
        if (liveIds.has(tabId)) {
          next[tabId] = state;
        } else {
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [viewerTabs]);
  const orderedSessionTabIds = useMemo(() => {
    const orderedIds: string[] = [sessionId];
    const knownTabIds = new Set<string>([
      ...visibleChildSessions.map((childSession) => childSession.id),
      ...draftTabs.map((draft) => draft.id),
    ]);
    const seen = new Set<string>(orderedIds);

    for (const tabId of sessionTabOrder) {
      if (!knownTabIds.has(tabId) || seen.has(tabId)) {
        continue;
      }
      orderedIds.push(tabId);
      seen.add(tabId);
    }

    for (const childSession of visibleChildSessions) {
      if (!seen.has(childSession.id)) {
        orderedIds.push(childSession.id);
        seen.add(childSession.id);
      }
    }
    for (const draft of draftTabs) {
      if (!seen.has(draft.id)) {
        orderedIds.push(draft.id);
      }
    }

    return orderedIds;
  }, [draftTabs, sessionId, sessionTabOrder, visibleChildSessions]);

  const handleSessionTabReorder = useCallback(
    (orderedTabIds: string[]) => {
      setTabOrderState((prev) => mergeTabOrderGroup(prev, orderedTabIds, sessionGroupIds));
    },
    [sessionGroupIds]
  );

  useEffect(() => {
    writeStoredTabOrder(sessionId, tabOrder);
  }, [sessionId, tabOrder]);

  useEffect(() => {
    writePendingWorktreeForks(sessionId, pendingForks);
  }, [pendingForks, sessionId]);

  useEffect(() => {
    writePersistedDraftTabs(sessionId, draftTabs);
  }, [draftTabs, sessionId]);

  // The `?tab` search value is the single source of truth for the active
  // conversation tab; tab activation navigates instead of setting state, so
  // there is no second store to reconcile and no URL/state feedback loop
  // (#193). `resolveActiveSessionTab` owns the derivation rule: the URL is
  // taken at its word, so a named child whose meta has not reached the local
  // replica yet stays active (a pending surface renders below) instead of
  // bouncing the user back to the parent conversation.
  const activeTabSessionId = useMemo(
    () =>
      resolveActiveSessionTab(parsedUrlTab, {
        parentSessionId: sessionId,
        // Side chats never own a top tab, so a URL addressing one (an
        // opened-by link to a side-chat session) renders the parent.
        childSessionIdsResolvedToParent: [
          ...archivedChildSessions.map((s) => s.id),
          ...sideSessions.map((s) => s.id),
        ],
        draftTabIds: draftTabs.map((draft) => draft.id),
        promotedChildSessionIdsByDraftId: pendingDraftChildSessionIds,
      }),
    [
      parsedUrlTab,
      archivedChildSessions,
      draftTabs,
      pendingDraftChildSessionIds,
      sessionId,
      sideSessions,
    ]
  );
  // A URL-named child the meta replica has not delivered yet: keep it active
  // and render a pending surface instead of silently showing the parent.
  const activeTabIsPendingChild =
    activeTabSessionId !== sessionId &&
    !isDraftSessionTabId(activeTabSessionId) &&
    !visibleChildSessions.some((s) => s.id === activeTabSessionId);
  // The ordinary pending window (a just-promoted draft) lasts one replica
  // tick; the delayed flag keeps that from flashing a spinner.
  const showPendingChildTabState = useDelayedFlag(activeTabIsPendingChild, 300);
  const activeSessionTabId = useMemo<SessionId | null>(() => {
    if (activeTabSessionId === sessionId) return sessionId;
    return visibleChildSessions.find((s) => s.id === activeTabSessionId)?.id ?? null;
  }, [activeTabSessionId, sessionId, visibleChildSessions]);
  // The session meta for the currently active tab (may be parent or a child)
  const activeTabSession = useMemo(() => {
    if (activeTabSessionId === sessionId) return activeSession;
    return visibleChildSessions.find((s) => s.id === activeTabSessionId) ?? activeSession;
  }, [activeTabSessionId, sessionId, activeSession, visibleChildSessions]);
  const activeTabSessionMachineOnlineStatus = useMachineOnlineStatus(activeTabSession?.machineId);
  const activeDraftTab = useMemo(
    () => draftTabs.find((draft) => draft.id === activeTabSessionId) ?? null,
    [activeTabSessionId, draftTabs]
  );
  // A draft tab is not a session: mentioning the parent there is valid. Do not
  // fall back to `activeTabSession.id` — that resolves drafts to the parent.
  const sessionMentionExcludeId = activeDraftTab ? null : activeTabSessionId;
  const activeCommentReferenceKeys =
    commentReferenceKeysBySession[activeTabSessionId] ?? EMPTY_COMMENT_REFERENCE_KEYS;

  // Active session doc sync state for the visible top headers. The header
  // spinner only covers active catch-up (degraded states surface in the
  // composer status strip), with a short delay against session-switch flicker.
  const { syncState: activeSessionDocSyncState } = useSessionDocSyncState(
    activeSessionTabId ?? sessionId,
    {
      enabled: activeSessionTabId !== null,
    }
  );
  const activeSessionDocIsSyncing = useDelayedFlag(
    activeSessionTabId !== null && isSyncingRoomSyncState(activeSessionDocSyncState),
    400
  );
  // Resolve local project metadata for header display
  const activeSessionMachineId = activeSession?.machineId ?? null;
  const { machine: sessionMachine, machineFlockRows } =
    useResolvedMachineMeta(activeSessionMachineId);
  const canForkSession = useCallback(
    (target: SessionMeta): boolean => {
      if (target.isArchived || !target.agentConfigId) return false;
      const capability =
        sessionMachine?.acpCapabilities?.[getAcpCapabilityCacheKey(target.agentConfigId)];
      return (
        getAcpCapabilityCacheEntryAuthority(capability, undefined) === 'authoritative' &&
        capability?.sessionFork === true
      );
    },
    [sessionMachine?.acpCapabilities]
  );
  const canForkSessionToWorktree = useCallback(
    (target: SessionMeta): boolean => {
      if (
        !target.agentConfigId ||
        !target.project ||
        (target.project.kind !== 'local' && target.project.kind !== 'github')
      ) {
        return false;
      }
      const capability =
        sessionMachine?.acpCapabilities?.[getAcpCapabilityCacheKey(target.agentConfigId)];
      return (
        getAcpCapabilityCacheEntryAuthority(capability, undefined) === 'authoritative' &&
        capability?.sessionForkWorktree === true
      );
    },
    [sessionMachine?.acpCapabilities]
  );
  const handleForkAssistant = useCallback(
    async (
      source: SessionMeta,
      turnId: string,
      placement: 'tab' | 'side-panel' | 'worktree' = 'tab',
      options: { targetSessionId?: SessionId; acknowledgeDirtySource?: true } = {}
    ) => {
      if (
        !runtime ||
        !user?.id ||
        !canForkSession(source) ||
        (pendingForks[source.id] && !options.targetSessionId)
      )
        return;
      const targetSessionId = options.targetSessionId ?? (crypto.randomUUID() as SessionId);
      setPendingForks((current) => ({
        ...current,
        [source.id]: { turnId, targetSessionId, phase: 'requesting', placement },
      }));
      const request = {
        sourceSessionId: source.id,
        sourceTurnId: turnId,
        targetSessionId,
        requestedByUserId: user.id,
        ...(placement === 'worktree'
          ? {
              targetContext: {
                kind: 'new-worktree' as const,
                ...(options.acknowledgeDirtySource
                  ? { acknowledgeDirtySource: true as const }
                  : {}),
              },
            }
          : {}),
        ...(placement === 'side-panel' ? { targetPlacement: 'side-panel' as const } : {}),
      };
      const requestOptions = { timeoutMs: placement === 'worktree' ? 15_000 : 120_000 };
      let response = await runtime.requestSessionFork(source.machineId, request, requestOptions);
      if (
        placement === 'worktree' &&
        !response?.success &&
        response?.error?.code === 'INTERNAL_ERROR'
      ) {
        response = await runtime.requestSessionFork(source.machineId, request, requestOptions);
      }
      if (response?.disposition === 'confirmation-required') {
        setDirtyForkConfirmation({ source, turnId, targetSessionId });
        return;
      }
      if (!response?.success) {
        setPendingForks((current) => {
          const next = { ...current };
          delete next[source.id];
          return next;
        });
        toast.error(response?.error?.message ?? t('sessions.forkFailed', 'Unable to fork session'));
        return;
      }
      capturePostHogEvent(postHog, 'session/fork_succeeded', {
        workspace_id: currentWorkspaceId ?? null,
        source_session_id: source.id,
        source_is_child: Boolean(source.parentSessionId),
        destination: placement,
        partial: response.partial,
      });
      setPendingForks((current) => {
        const pending = current[source.id];
        if (!pending || pending.targetSessionId !== targetSessionId) return current;
        return {
          ...current,
          [source.id]: { ...pending, phase: 'awaiting-history' },
        };
      });
      if (placement === 'tab') {
        setTabOrderState((current) =>
          appendTabOrderId(current, sessionGroupIds, targetSessionId)
        );
      }
      if (response.partial && response.warnings.length > 0) {
        toast.warning(
          t('sessions.forkPartial', 'Session forked with some historical content unavailable')
        );
      }
    },
    [canForkSession, currentWorkspaceId, pendingForks, postHog, runtime, sessionGroupIds, t, user?.id]
  );
  const pendingForkSourceByTargetSessionId = useMemo(() => {
    const sourceByTarget = new Map<SessionId, string>();
    for (const [sourceSessionId, pending] of Object.entries(pendingForks)) {
      if (pending.phase === 'awaiting-history') {
        sourceByTarget.set(pending.targetSessionId, sourceSessionId);
      }
    }
    return sourceByTarget;
  }, [pendingForks]);
  const getForkWorktreeAvailability = useCallback(
    (source: SessionMeta): SessionForkWorktreeAvailability => {
      if (!canForkSessionToWorktree(source)) return 'hidden';
      if (source.project?.kind === 'github') return 'available';
      const cached = worktreeAvailabilityBySessionId[source.id];
      if (cached === 'unavailable') return 'hidden';
      if (cached === 'available') return 'available';
      return 'checking';
    },
    [canForkSessionToWorktree, worktreeAvailabilityBySessionId]
  );
  const resolveForkWorktreeAvailability = useCallback(
    async (source: SessionMeta) => {
      if (!canForkSessionToWorktree(source) || source.project?.kind !== 'local') return;
      if (!runtime || !user?.id) return;
      if (worktreeAvailabilityRequestRef.current.has(source.id)) return;
      worktreeAvailabilityRequestRef.current.add(source.id);
      setWorktreeAvailabilityBySessionId((current) => ({
        ...current,
        [source.id]: 'checking',
      }));
      try {
        const gitState = await runtime.requestLocalProjectGitState(
          source.machineId,
          source.project.localProjectId,
          user.id,
          { timeoutMs: 15_000 }
        );
        const available = gitState?.success === true && gitState.state.git === true;
        setWorktreeAvailabilityBySessionId((current) => ({
          ...current,
          [source.id]: available ? 'available' : 'unavailable',
        }));
      } catch {
        worktreeAvailabilityRequestRef.current.delete(source.id);
        setWorktreeAvailabilityBySessionId((current) => {
          const next = { ...current };
          delete next[source.id];
          return next;
        });
      }
    },
    [canForkSessionToWorktree, runtime, user?.id]
  );
  const handleForkDestination = useCallback(
    (source: SessionMeta, turnId: string, destination: SessionForkDestination = 'shared') => {
      void handleForkAssistant(source, turnId, destination === 'new-worktree' ? 'worktree' : 'tab');
    },
    [handleForkAssistant]
  );
  useEffect(() => {
    if (activeTabSession) void resolveForkWorktreeAvailability(activeTabSession);
  }, [activeTabSession, resolveForkWorktreeAvailability]);
  // Claims the pending fork so exactly one of the two completion paths below
  // acts on it. Stable identity keeps the completion props from churning on
  // every fork state transition.
  const takePendingFork = useStableCallback(
    (sourceSessionId: string, targetSessionId: SessionId) => {
      const pending = pendingForks[sourceSessionId];
      if (
        !pending ||
        pending.phase !== 'awaiting-history' ||
        pending.targetSessionId !== targetSessionId
      ) {
        return null;
      }
      setPendingForks((current) => {
        if (current[sourceSessionId] !== pending) return current;
        const next = { ...current };
        delete next[sourceSessionId];
        return next;
      });
      return pending;
    }
  );

  const isActiveSessionLocalMachine = !!localMachineId && activeSessionMachineId === localMachineId;
  const machineDotlodyPath = useMemo(
    () =>
      resolveMachineDotlodyPath(
        machineFlockRows,
        isActiveSessionLocalMachine ? localHomeDir : null
      ),
    [isActiveSessionLocalMachine, localHomeDir, machineFlockRows]
  );
  // `useResolvedMachineMeta` already merged the Machine Flock local-project rows
  // (honouring deletions) into `sessionMachine`; do not re-scan the raw rows.
  const sessionMachineLocalProjects = sessionMachine?.localProjects ?? EMPTY_LOCAL_PROJECTS;
  const sessionMachineSupportsLocalProjectHistoryRpc =
    sessionMachine?.supportsLocalProjectHistoryRpc === true;
  const resolvedLocalProjectMeta = useMemo(() => {
    const proj = activeSession?.project as { kind?: string; localProjectId?: string } | undefined;
    if (proj?.kind !== 'local' || !proj.localProjectId) return null;
    return sessionMachineLocalProjects[proj.localProjectId as LocalProjectId] ?? null;
  }, [activeSession?.project, sessionMachineLocalProjects]);

  // The session displayed in the active tab
  const {
    ready: sessionDiffReady,
    synced: sessionDiffSynced,
    unavailableMessage: sessionDiffUnavailableMessage,
    revision: allChangesRefreshToken,
    summary: {
      changeEntries,
      changeFilePaths,
      diffFilePathsByTurn,
      diffEntriesByTurn,
      fileDiffsByTurn,
    },
  } = useSessionDiffSummary(activeSessionTabId ?? sessionId, {
    enabled: activeSessionTabId !== null,
    fileProvider: activeSessionFileProvider,
    fileProviderPending: activeSessionFileProviderPending,
  });
  const messageFileDiffEntriesByTurn = useMemo(
    () => (Object.keys(diffEntriesByTurn).length > 0 ? diffEntriesByTurn : undefined),
    [diffEntriesByTurn]
  );

  // Keep the info bar aligned with the left sidebar session row. Both surfaces
  // use the same durable session-meta snapshot instead of independently
  // totaling provider entries that can resolve at different times.
  const changesDiffStat = activeSession?.diffStats?.allChange ?? null;
  const activeBrowserSession = activeDraftTab ? null : activeTabSession;
  const workspaceOwnerSession = activeTabSession?.parentSessionId
    ? activeSession
    : activeTabSession;
  const activeSessionProject = activeSession?.project;
  const activeSessionProjectKind = activeSessionProject?.kind ?? null;
  const activeSessionProjectRepoFullName =
    activeSessionProject?.kind === 'github' ? activeSessionProject.repoFullName : null;
  const activeSessionProjectGithubRepoFullName =
    activeSessionProject?.kind === 'local'
      ? (activeSessionProject.githubRepoFullName ?? null)
      : null;
  const activeSessionProjectLocalProjectId =
    activeSessionProject?.kind === 'local' ? (activeSessionProject.localProjectId ?? null) : null;
  const sessionDetailProjectAnalytics = useMemo(
    () =>
      getSessionProjectAnalytics({
        kind: activeSessionProjectKind,
        repoFullName: activeSessionProjectRepoFullName,
        githubRepoFullName: activeSessionProjectGithubRepoFullName,
        localProjectId: activeSessionProjectLocalProjectId,
        sessionRepoFullName: activeSession?.repoFullName,
      }),
    [
      activeSession?.repoFullName,
      activeSessionProjectGithubRepoFullName,
      activeSessionProjectKind,
      activeSessionProjectLocalProjectId,
      activeSessionProjectRepoFullName,
    ]
  );
  const sessionDetailAnalyticsProperties = useMemo(
    () => ({
      workspace_id: currentWorkspaceId ?? null,
      session_id: sessionId,
      active_tab_session_id: activeTabSessionId,
      is_mobile: isMobile,
      child_session_count: childSessions.length,
      draft_tab_count: draftTabs.length,
      viewer_tab_count: viewerTabs.length,
      has_url_tab: parsedUrlTab.kind !== 'missing',
      url_tab_kind: parsedUrlTab.kind,
      ...sessionDetailProjectAnalytics,
    }),
    [
      activeTabSessionId,
      childSessions.length,
      currentWorkspaceId,
      draftTabs.length,
      isMobile,
      parsedUrlTab.kind,
      sessionDetailProjectAnalytics,
      sessionId,
      viewerTabs.length,
    ]
  );
  const captureSessionDetailEvent = useCallback(
    (event: string, properties?: Record<string, unknown>) => {
      capturePostHogEvent(postHog, event, {
        ...sessionDetailAnalyticsProperties,
        ...properties,
      });
    },
    [postHog, sessionDetailAnalyticsProperties]
  );
  const captureThrottledTabSelected = useMemo(
    () => createThrottledCapture(postHog, 'session/tab_selected', { intervalMs: 1000, tier: 'C' }),
    [postHog]
  );

  // Set document title based on session title
  useDocumentTitle(activeSession?.title);

  useEffect(() => {
    attemptedExternalHistoryRefreshKeysRef.current.clear();
  }, [sessionId]);

  useEffect(() => {
    if (!activeSession || !currentWorkspaceId || !user?.id) return;
    const externalHistory = activeSession.externalHistory;
    if (!shouldRefreshExternalHistoryOnOpen(externalHistory)) {
      return;
    }
    const project = activeSession.project;
    if (project?.kind !== 'local') return;
    if (
      !canUseProjectHistoryProjectControl({
        runtime,
        localMachineId,
        machineId: activeSession.machineId,
        supportsLocalProjectHistoryRpc: sessionMachineSupportsLocalProjectHistoryRpc,
      })
    ) {
      return;
    }

    const refreshKey = getExternalHistoryRefreshKey(activeSession.id, externalHistory);
    if (externalHistoryRefreshBySessionId[activeSession.id]?.key === refreshKey) return;
    if (attemptedExternalHistoryRefreshKeysRef.current.has(refreshKey)) return;
    attemptedExternalHistoryRefreshKeysRef.current.add(refreshKey);
    setExternalHistoryRefreshBySessionId((current) => ({
      ...current,
      [activeSession.id]: {
        key: refreshKey,
        provider: externalHistory.provider,
      },
    }));

    void importProjectHistoryForLocalProject({
      provider: externalHistory.provider,
      runtime,
      localMachineId,
      machineId: activeSession.machineId,
      workspaceId: currentWorkspaceId,
      localProjectId: project.localProjectId,
      acpSessionIds: [externalHistory.sourceAcpSessionId],
      requestedByUserId: user.id,
    })
      .then((result) => {
        void result;
      })
      .catch((error: unknown) => {
        toast.error(
          t('sessions.historyLoadFailed', {
            defaultValue: 'Failed to load {{provider}} conversation',
            provider: getExternalHistoryProviderLabel(externalHistory.provider),
          }),
          {
            description: error instanceof Error ? error.message : String(error),
          }
        );
      })
      .finally(() => {
        setExternalHistoryRefreshBySessionId((current) => {
          if (current[activeSession.id]?.key !== refreshKey) {
            return current;
          }
          const next = { ...current };
          delete next[activeSession.id];
          return next;
        });
      });
  }, [
    activeSession,
    currentWorkspaceId,
    externalHistoryRefreshBySessionId,
    localMachineId,
    runtime,
    sessionMachineSupportsLocalProjectHistoryRpc,
    t,
    user?.id,
  ]);

  // Reflect the active session's status in the favicon (web) or dock badge (electron).
  // Priority: waiting > working > unread > idle.
  const tabStatus = useMemo<TabStatus>(() => {
    if (!activeSession) return null;
    const lastMessageAt =
      typeof activeSession.lastMessageAt === 'number' ? activeSession.lastMessageAt : null;
    const lastReadAt =
      typeof activeSession.lastReadAt === 'number' ? activeSession.lastReadAt : null;
    const hasUnread = lastMessageAt !== null && (lastReadAt === null || lastMessageAt > lastReadAt);
    const isWaiting = activeSessionLiveStatus?.type === 'requestPermission';
    // CLI-reported presence is the fact source for "working"; persistent goal
    // state and meta dispatch pointers do not imply a prompt is running.
    const isWorking = activeSessionLiveStatus != null;
    if (isWaiting) return 'waiting';
    if (isWorking) return 'working';
    if (hasUnread) return 'unread';
    return 'idle';
  }, [activeSession, activeSessionLiveStatus]);
  useTabStatus(tabStatus);
  const { latestPr, repoFullName, canShowGitHubActions } = useMemo(
    () => getSessionGitHubState(activeTabSession, workspaceOwnerSession),
    [activeTabSession, workspaceOwnerSession]
  );
  const latestPrNumber = getPullRequestNumber(latestPr);
  const latestPrRepoFullName = getPullRequestRepoFullName(latestPr) ?? repoFullName;

  const writeSessionUrlTab = useCallback(
    (nextTab: string | undefined, { push = false }: { push?: boolean } = {}) => {
      if (!workspaceSlug) {
        return;
      }
      /* A `?tab` write is scoped to this session's route. An asynchronous
         caller resolving after the user already left (a draft send completing
         mid-switch, a queued replace) must be dropped, not allowed to yank the
         router back to the session it captured. */
      if (!router.state.location.pathname.includes(`/sessions/${sessionId}`)) {
        recordSessionRenderTrace(`nav-dropped s=${shortTraceId(sessionId)} tab=${nextTab ?? '∅'}`);
        return;
      }
      recordSessionRenderTrace(
        `nav s=${shortTraceId(sessionId)} tab=${nextTab ?? '∅'} ${push ? 'push' : 'replace'}`
      );

      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
        search: (prev) => {
          if (prev.tab === nextTab) {
            return prev;
          }

          if (nextTab === undefined) {
            if (prev.tab === undefined) {
              return prev;
            }

            const next = { ...prev };
            delete next.tab;
            return next;
          }

          return { ...prev, tab: nextTab };
        },
        replace: !push,
      });
    },
    [router, sessionId, workspaceSlug]
  );

  /* Activating a tab IS a navigation: the handlers below write the `?tab`
     search value and the active tab derives back out of it. Every in-session
     activation encodes explicitly — the parent as `session:<parentId>`, drafts
     as their full `draft:<id>` id — because the absent value is reserved for
     external entries, which the route restores from the last-active store.
     User-driven switches PUSH so tabs participate in history back; structural
     rewrites (draft promotion, closing a dead tab) replace. */
  const navigateToSessionTab = useCallback(
    (tabId: string, options?: { push?: boolean }) => {
      writeSessionUrlTab(formatExplicitSessionTabSearch(tabId), options);
    },
    [writeSessionUrlTab]
  );

  const replaceSessionUrlPr = useCallback(
    (nextPrNumber: number | undefined, { push = false }: { push?: boolean } = {}) => {
      if (!workspaceSlug) {
        return;
      }

      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
        search: (prev) => {
          if (prev.pr === nextPrNumber) {
            return prev;
          }
          if (nextPrNumber === undefined) {
            if (prev.pr === undefined) {
              return prev;
            }
            const next = { ...prev };
            delete next.pr;
            return next;
          }
          return { ...prev, pr: nextPrNumber };
        },
        replace: !push,
      });
    },
    [router, sessionId, workspaceSlug]
  );

  const replaceSessionUrlBrowser = useCallback(
    (nextBrowser: boolean, { push = false }: { push?: boolean } = {}) => {
      if (!workspaceSlug) {
        return;
      }

      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
        search: (prev) => {
          const currentBrowser = prev.browser === true;
          if (currentBrowser === nextBrowser) {
            return prev;
          }
          if (!nextBrowser) {
            if (prev.browser === undefined) {
              return prev;
            }
            const next = { ...prev };
            delete next.browser;
            return next;
          }
          return { ...prev, browser: true };
        },
        replace: !push,
      });
    },
    [router, sessionId, workspaceSlug]
  );
  // Multi-tab: create a new child session
  const {
    startSession,
    requestSessionDispatch,
    touchSessionActivity,
    updateSessionTitle,
    archiveSession,
    restoreSession,
    deleteSessions,
    deleteArchivedSession,
    setSessionPinned,
    transferSessionOwner,
  } = useSessionActions();
  const { members: workspaceMembers, isMultiMember: isMultiMemberWorkspace } =
    useWorkspaceMembers();
  const handleTransferSessionOwner = useCallback(
    async (targetSessionId: SessionId, nextUserId: string) => {
      try {
        await transferSessionOwner(targetSessionId, nextUserId);
        const name =
          workspaceMembers.find((member) => member.userId === nextUserId)?.name ?? nextUserId;
        toast.success(t('sessions.owner.changed', 'Session owner is now {{name}}', { name }));
      } catch (error) {
        console.error('Failed to transfer session owner', error);
        toast.error(t('sessions.owner.changeFailed', 'Could not change the session owner'));
      }
    },
    [t, transferSessionOwner, workspaceMembers]
  );
  const setChatTabRef = useCallback(
    (tabId: string, ref: SessionChatInterfaceHandle | DraftSessionChatInterfaceHandle | null) => {
      chatRefsMap.current.set(tabId, ref);
    },
    []
  );

  const handleInsertDroppedSessionMention = useCallback(
    (droppedSessionId: string) => {
      chatRefsMap.current.get(activeTabSessionId)?.insertSessionMention(droppedSessionId);
    },
    [activeTabSessionId]
  );

  const handleSessionCommentReferencesChange = useCallback(
    (targetSessionId: string, references: CommentReferencePayload[]) => {
      const keys = references.map(getCommentReferenceKey);
      setCommentReferenceKeysBySession((prev) => {
        const previousKeys = prev[targetSessionId] ?? [];
        if (areStringArraysEqual(previousKeys, keys)) {
          return prev;
        }
        if (keys.length === 0) {
          const { [targetSessionId]: _removed, ...rest } = prev;
          return rest;
        }
        return { ...prev, [targetSessionId]: keys };
      });
    },
    []
  );

  const getCommentReferencesChangeHandler = useCallback(
    (targetSessionId: string) => {
      const cached = commentReferenceChangeHandlersRef.current.get(targetSessionId);
      if (cached) {
        return cached;
      }
      const handler = (references: CommentReferencePayload[]) => {
        handleSessionCommentReferencesChange(targetSessionId, references);
      };
      commentReferenceChangeHandlersRef.current.set(targetSessionId, handler);
      return handler;
    },
    [handleSessionCommentReferencesChange]
  );

  const handleSessionVisualAnnotationReferencesChange = useCallback(
    (targetSessionId: string, references: VisualAnnotationReferencePayload[]) => {
      const keys = references.map(getVisualAnnotationReferenceKey);
      setVisualAnnotationReferenceKeysBySession((prev) => {
        const previousKeys = prev[targetSessionId] ?? [];
        if (areStringArraysEqual(previousKeys, keys)) {
          return prev;
        }
        if (keys.length === 0) {
          const { [targetSessionId]: _removed, ...rest } = prev;
          return rest;
        }
        return { ...prev, [targetSessionId]: keys };
      });
    },
    []
  );

  const getVisualAnnotationReferencesChangeHandler = useCallback(
    (targetSessionId: string) => {
      const cached = visualAnnotationReferenceChangeHandlersRef.current.get(targetSessionId);
      if (cached) {
        return cached;
      }
      const handler = (references: VisualAnnotationReferencePayload[]) => {
        handleSessionVisualAnnotationReferencesChange(targetSessionId, references);
      };
      visualAnnotationReferenceChangeHandlersRef.current.set(targetSessionId, handler);
      return handler;
    },
    [handleSessionVisualAnnotationReferencesChange]
  );

  const markSubmittedVisualAnnotationReferences = useCallback(
    async (targetSessionId: SessionId, references: VisualAnnotationReferencePayload[]) => {
      if (references.length === 0 || !runtime) {
        return;
      }

      try {
        await runtime.writer.mutatePreviewVisualComments(targetSessionId, {
          kind: 'mark-submitted',
          commentIds: references.map((reference) => reference.commentId),
          submittedAt: getServerNow(),
        });
      } catch (error) {
        console.error('Failed to mark preview visual comments submitted', {
          sessionId: targetSessionId,
          error,
        });
        toast.error(
          t(
            'sessions.preview.annotation.submitStateFailed',
            'Failed to update preview comment status'
          )
        );
      }
    },
    [runtime, t]
  );

  const getVisualAnnotationReferencesSubmittedHandler = useCallback(
    (targetSessionId: SessionId) => {
      return (references: VisualAnnotationReferencePayload[]) => {
        void markSubmittedVisualAnnotationReferences(targetSessionId, references);
      };
    },
    [markSubmittedVisualAnnotationReferences]
  );

  const handleAddCommentReferenceToActiveChatInput = useCallback(
    (reference: CommentReferencePayload) => {
      const chatRef = chatRefsMap.current.get(activeTabSessionId);
      return chatRef && 'addCommentReference' in chatRef
        ? chatRef.addCommentReference(reference)
        : false;
    },
    [activeTabSessionId]
  );

  const handleTogglePreviewAnnotationInChat = useCallback(
    (targetSessionId: SessionId, reference: VisualAnnotationReferencePayload) => {
      const chatRef = chatRefsMap.current.get(targetSessionId);
      if (chatRef && 'toggleVisualAnnotationReference' in chatRef) {
        return chatRef.toggleVisualAnnotationReference(reference);
      }
      toast.error(t('sessions.preview.annotation.chatUnavailable', 'Open the session chat first'));
      return false;
    },
    [t]
  );

  const handleAddPreviewAnnotationToChat = useCallback(
    (targetSessionId: SessionId, reference: VisualAnnotationReferencePayload) => {
      const chatRef = chatRefsMap.current.get(targetSessionId);
      if (chatRef && 'addVisualAnnotationReference' in chatRef) {
        return chatRef.addVisualAnnotationReference(reference);
      }
      toast.error(t('sessions.preview.annotation.chatUnavailable', 'Open the session chat first'));
      return false;
    },
    [t]
  );

  const handleNewTab = useCallback(() => {
    if (!activeSession) return;
    const draft = createDraftSessionTab({
      agentConfigId: activeSession.agentConfigId,
      cliType: activeSession.cliType,
      agentType: activeSession.agentType,
      modeId: null,
      modelId: null,
    });
    setDraftTabs((prev) => [...prev, draft]);
    setTabOrderState((prev) => appendTabOrderId(prev, sessionGroupIds, draft.id));
    if (isMobile) {
      setActiveViewerTabId(null);
    }
    navigateToSessionTab(draft.id, { push: true });
    captureSessionDetailEvent('session/tab_draft_created', {
      draft_tab_id: draft.id,
      source_session_id: activeSession.id,
    });
  }, [
    activeSession,
    captureSessionDetailEvent,
    isMobile,
    navigateToSessionTab,
    sessionGroupIds,
    setDraftTabs,
  ]);

  const handleDraftChange = useCallback(
    (draftId: DraftSessionTab['id'], patch: Partial<DraftSessionTab>) => {
      setDraftTabs((prev) =>
        prev.map((draft) => (draft.id === draftId ? { ...draft, ...patch } : draft))
      );
    },
    [setDraftTabs]
  );

  const closeDraftTab = useCallback(
    (draftId: DraftSessionTab['id']) => {
      setDraftTabs((prev) => prev.filter((draft) => draft.id !== draftId));
      setTabOrderState((prev) => removeTabOrderId(prev, draftId));
      if (activeTabSessionId === draftId) {
        // Explicit parent, replacing the dead draft URL in place.
        navigateToSessionTab(sessionId);
      }
      captureSessionDetailEvent('session/tab_draft_closed', {
        draft_tab_id: draftId,
      });
    },
    [activeTabSessionId, captureSessionDetailEvent, navigateToSessionTab, sessionId, setDraftTabs]
  );

  const handleSendDraft = useCallback(
    async (payload: DraftSessionSendPayload): Promise<boolean> => {
      if (!activeSession || !user) {
        toast.error(t('sessions.sendError'));
        return false;
      }
      if (sendingDraftIdsRef.current.has(payload.draftId)) {
        captureSessionDetailEvent('session/tab_draft_send_blocked', {
          draft_tab_id: payload.draftId,
          reason: 'already_sending',
        });
        return false;
      }

      sendingDraftIdsRef.current.add(payload.draftId);
      const startedAtMs = getPerformanceNowMs();
      const imageCount = payload.inputBlocks.filter((block) => block.type === 'image').length;
      const prompt = payload.inputConfig.prompt ?? '';
      const acpAnalyticsProperties = buildSessionCreateAcpAnalyticsProperties({
        cliType: payload.cliType,
        agentType: payload.agentType,
        modeId: payload.inputConfig.modeId,
        modelId: payload.inputConfig.modelId,
        configOptionValues: payload.inputConfig.configOptionValues,
        configOptionSelectors: payload.configOptionSelectors,
      });
      captureSessionDetailEvent('session/tab_draft_send_requested', {
        draft_tab_id: payload.draftId,
        prompt_length: prompt.length,
        has_preserved_input: Boolean(payload.preservedInputText?.trim()),
        cli_type: payload.cliType,
        agent_type: payload.agentType,
        agent_config_id: payload.agentConfigId ?? null,
        ...acpAnalyticsProperties,
        image_count: imageCount,
      });
      const childSessionId = payload.sessionId;
      try {
        const draftTitle = getDraftTabLabel({ prompt }, '').trim();
        const pendingHistoryEntry = buildPendingUserHistoryEntry({
          userId: user.id,
          inputBlocks: payload.inputBlocks,
          timestamp: new Date().toISOString(),
          inputConfig: payload.inputConfig,
        });
        if (!pendingHistoryEntry) {
          toast.error(t('sessions.sendError'));
          return false;
        }
        setPendingDraftChildSessionIds((prev) => ({
          ...prev,
          [payload.draftId]: childSessionId,
        }));

        // Meta and the first user turn are one accept unit: the draft is only
        // promoted after both are durable locally, so a half-created child (a
        // tab whose message never entered the session doc) cannot exist. The
        // dispatch RPC below only accelerates; the durable pointer written by
        // requestSessionDispatch remains recovery truth.
        const { historyEntry } = await startSession(
          {
            sessionId: childSessionId,
            machineId: activeSession.machineId,
            userId: user.id,
            cliType: payload.cliType,
            agentType: payload.agentType,
            agentConfigId: payload.agentConfigId,
            customAcp: payload.customAcp,
            runtimeOverrides: payload.runtimeOverrides,
            project: activeSession.project,
            repoFullName: activeSession.repoFullName,
            baseBranch: activeSession.baseBranch,
            parentSessionId: activeSession.id,
            title: draftTitle || undefined,
            titleSource: draftTitle ? 'draft' : undefined,
            ...(payload.agentRoleId && typeof payload.agentRoleRevision === 'number'
              ? {
                  agentRoleId: payload.agentRoleId,
                  agentRoleRevision: payload.agentRoleRevision,
                }
              : {}),
          },
          pendingHistoryEntry
        );
        // Marks the first message read for the sender and bubbles activity to
        // the parent session, matching the ordinary send path. The child's own
        // lastMessageAt is already durable inside the startSession accept unit.
        touchSessionActivity(childSessionId).catch((err: unknown) => {
          console.warn('Failed to update child session activity after start', err);
        });
        persistAgentSessionDefaults(payload.agentConfigId, {
          modeId: payload.inputConfig.modeId,
          modelId: payload.inputConfig.modelId,
          configOptionValues: payload.inputConfig.configOptionValues,
        });

        captureSessionDetailEvent(SESSION_ACP_CONFIG_USED_EVENT, {
          session_id: childSessionId,
          source_session_id: activeSession.id,
          draft_tab_id: payload.draftId,
          child_session_id: childSessionId,
          cli_type: payload.cliType,
          agent_type: payload.agentType,
          agent_config_id: payload.agentConfigId ?? null,
          ...acpAnalyticsProperties,
          entrypoint: 'session_child_tab',
        });

        // Draft tabs reuse the future child session id. Clear input caches before promotion;
        // waiting for the old draft input to clear lets the newly mounted child input hydrate
        // from stale text/image drafts. Preserved text is handed over through the
        // same cache the promoted composer hydrates from on mount.
        clearSessionChatInputDrafts(childSessionId);
        if (payload.preservedInputText?.trim()) {
          setSessionChatInputTextDraft(childSessionId, payload.preservedInputText);
        }
        setDraftTabs((prev) => prev.filter((draft) => draft.id !== payload.draftId));
        setTabOrderState((prev) =>
          replaceTabOrderId(
            appendTabOrderId(prev, sessionGroupIds, payload.draftId),
            payload.draftId,
            childSessionId
          )
        );
        if (isMobile) {
          setActiveViewerTabId(null);
        }
        /* One replace navigation swaps `draft:<id>` for `session:<child>`.
           The `pendingDraftChildSessionIds` entry deliberately SURVIVES the
           promotion as a resolution alias: React commits the draft removal
           before the router commits the new `?tab`, and in that window (and
           until the child meta reaches the local replica) the URL must keep
           resolving to the new conversation, never bounce back to the parent.
           The map resets with the session-switch state reset. */
        navigateToSessionTab(childSessionId);
        void requestSessionDispatch(childSessionId, historyEntry.id, {
          inputConfig: payload.inputConfig,
          machineId: activeSession.machineId,
        }).catch((dispatchError: unknown) => {
          // The turn is already durable; the watcher retries once the machine
          // syncs. Surface the failure instead of looking stuck silently.
          console.error('Failed to request child session dispatch', dispatchError);
          toast.error(t('sessions.sendError'));
        });
        captureSessionDetailEvent('session/tab_child_created', {
          draft_tab_id: payload.draftId,
          child_session_id: childSessionId,
          duration_ms: getDurationSinceMs(startedAtMs),
          prompt_length: prompt.length,
          has_initial_prompt: Boolean(prompt.trim()),
          image_count: imageCount,
          has_restored_input: Boolean(payload.preservedInputText?.trim()),
          cli_type: payload.cliType,
          agent_type: payload.agentType,
          agent_config_id: payload.agentConfigId ?? null,
          ...acpAnalyticsProperties,
        });
        return true;
      } catch (error) {
        console.error('Failed to create child tab session', error);
        try {
          await deleteSessions([childSessionId]);
        } catch (cleanupError) {
          console.warn('Failed to clean up child tab session after create failure', cleanupError);
        } finally {
          setPendingDraftChildSessionIds((prev) => {
            const { [payload.draftId]: _removed, ...rest } = prev;
            return rest;
          });
        }
        captureSessionDetailEvent('session/tab_child_create_failed', {
          draft_tab_id: payload.draftId,
          duration_ms: getDurationSinceMs(startedAtMs),
          cli_type: payload.cliType,
          agent_type: payload.agentType,
          agent_config_id: payload.agentConfigId ?? null,
          ...acpAnalyticsProperties,
          error_name: error instanceof Error ? error.name : typeof error,
          error_message: error instanceof Error ? error.message : String(error),
        });
        if (error instanceof SessionCreateBillingError) {
          if (error.code === 'workspace_payment_required') {
            toast.error(
              t(
                hidesBillingUi
                  ? 'sessions.workspaceUnavailableMobileTitle'
                  : 'sessions.workspaceCheckoutPendingTitle'
              ),
              {
                description: t(
                  hidesBillingUi
                    ? 'sessions.workspaceUnavailableMobileDescription'
                    : 'sessions.workspaceCheckoutPendingDescription'
                ),
              }
            );
          } else {
            toast.error(t('sessions.freeSessionLimitReachedTitle'), {
              description: t(
                hidesBillingUi
                  ? 'sessions.freeSessionLimitReachedMobileDescription'
                  : 'sessions.freeSessionLimitReachedDescription',
                {
                  limit: error.limit,
                  current: error.current,
                }
              ),
              ...(hidesBillingUi
                ? {}
                : {
                    action: {
                      label: t('sessions.freeTurnLimitUpgrade'),
                      onClick: () => openSettings('billing'),
                    },
                  }),
            });
          }
        } else {
          toast.error(t('sessions.sendError'));
        }
        return false;
      } finally {
        sendingDraftIdsRef.current.delete(payload.draftId);
      }
    },
    [
      activeSession,
      captureSessionDetailEvent,
      deleteSessions,
      hidesBillingUi,
      isMobile,
      navigateToSessionTab,
      openSettings,
      requestSessionDispatch,
      sessionGroupIds,
      setDraftTabs,
      startSession,
      t,
      touchSessionActivity,
      user,
    ]
  );

  const handleTabRename = useCallback(
    async (tabSessionId: SessionId, title: string) => {
      await updateSessionTitle(tabSessionId, title);
    },
    [updateSessionTitle]
  );

  const handleTabClose = useCallback(
    async (tabId: string) => {
      if (isDraftSessionTabId(tabId)) {
        closeDraftTab(tabId);
        return;
      }
      const tabSessionId = tabId as SessionId;
      captureSessionDetailEvent('session/tab_close_requested', {
        tab_session_id: tabSessionId,
        is_active_tab: tabSessionId === activeTabSessionId,
      });
      // If the tab has never had a message, just delete it instead of archiving
      const tabMeta = childSessions.find((s) => s.id === tabSessionId);
      try {
        if (tabMeta && !tabMeta.lastMessageAt) {
          await deleteSessions([tabSessionId]);
          captureSessionDetailEvent('session/tab_deleted_empty', {
            tab_session_id: tabSessionId,
          });
        } else {
          await archiveSession(tabSessionId);
          captureSessionDetailEvent('session/tab_archived', {
            tab_session_id: tabSessionId,
          });
        }
        // Switch to the parent tab only once the close is durable; a failed
        // close keeps the tab selected instead of yanking the user off it.
        // Explicit parent, replacing the closed tab's URL in place.
        if (tabSessionId === activeTabSessionId) {
          navigateToSessionTab(sessionId);
        }
      } catch (error) {
        // A silent failure reads as "the close button does nothing" — surface
        // it and leave the tab where it was.
        console.error('Failed to close session tab', { tabSessionId, error });
        toast.error(t('sessions.tabCloseFailed', 'Could not close this tab'));
        captureSessionDetailEvent('session/tab_close_failed', {
          tab_session_id: tabSessionId,
          error_name: error instanceof Error ? error.name : typeof error,
          error_message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [
      activeTabSessionId,
      archiveSession,
      captureSessionDetailEvent,
      childSessions,
      closeDraftTab,
      deleteSessions,
      navigateToSessionTab,
      sessionId,
      t,
    ]
  );

  const handleTabRestore = useCallback(
    async (tabSessionId: SessionId) => {
      captureSessionDetailEvent('session/tab_restore_requested', {
        tab_session_id: tabSessionId,
      });
      await restoreSession(tabSessionId);
      captureSessionDetailEvent('session/tab_restored', {
        tab_session_id: tabSessionId,
      });
    },
    [captureSessionDetailEvent, restoreSession]
  );

  // Navigate back to session list.
  const handleBackToList = useCallback(() => {
    if (!workspaceSlug) {
      return;
    }
    void router.navigate({
      to: '/$workspaceName/chat',
      params: { workspaceName: workspaceSlug },
    });
  }, [workspaceSlug, router]);

  const redirectToParentSessionUrl = useCallback(
    (parentSessionId: SessionId, childSessionId: SessionId) => {
      if (!workspaceSlug) {
        return;
      }

      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId: parentSessionId },
        search: (prev) => ({
          ...prev,
          tab: formatSessionTabSearch(childSessionId, parentSessionId),
        }),
        replace: true,
      });
    },
    [router, workspaceSlug]
  );

  // Archive the parent session from the header menu (desktop)
  const handleArchiveCurrentSession = useCallback(async () => {
    if (!activeSession) return;
    await archiveSession(activeSession.id);
    handleBackToList();
  }, [activeSession, archiveSession, handleBackToList]);

  // Archive the active tab (mobile more menu) — archives child if child is active, parent otherwise
  const handleArchiveActiveTab = useCallback(async () => {
    if (!activeSession) return;
    if (activeDraftTab) {
      closeDraftTab(activeDraftTab.id);
      return;
    }
    if (activeTabSessionId && activeTabSessionId !== sessionId) {
      // Archiving a child tab — delegate to tab close logic
      await handleTabClose(activeTabSessionId);
    } else {
      // Archiving the parent
      await archiveSession(activeSession.id);
      handleBackToList();
    }
  }, [
    activeDraftTab,
    activeSession,
    activeTabSessionId,
    archiveSession,
    closeDraftTab,
    handleBackToList,
    handleTabClose,
    sessionId,
  ]);

  // Restore the current archived session from the header menu
  const handleRestoreCurrentSession = useCallback(async () => {
    if (!activeSession) return;
    await restoreSession(activeSession.id);
  }, [activeSession, restoreSession]);

  // Confirmation state for permanently deleting the current archived session
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

  // Confirmation state for archiving the current chat via the keyboard shortcut. The
  // shortcut is easy to fire by accident, so it asks before archiving (Enter confirms,
  // Esc cancels). Menu/button archive actions stay immediate.
  const [archiveConfirmOpen, setArchiveConfirmOpen] = useState(false);
  const archiveConfirmButtonRef = useRef<HTMLButtonElement>(null);

  // Rename dialog target for the mobile header more menu
  const [renameDialogTarget, setRenameDialogTarget] = useState<RenameSessionDialogTarget | null>(
    null
  );

  const handleRequestDeleteCurrentSession = useCallback(() => {
    if (!activeSession) return;
    setDeleteConfirmOpen(true);
  }, [activeSession]);

  const handleConfirmDeleteCurrentSession = useCallback(async () => {
    if (!activeSession) return;
    const sessionToDelete = activeSession.id;
    const pullRequestsToClear = activeSession.pullRequests ?? [];
    const wsId = currentWorkspaceId;
    setDeleteConfirmOpen(false);
    try {
      await deleteArchivedSession(sessionToDelete);
    } catch (error) {
      console.error('Failed to permanently delete session', error);
      toast.error(t('archive.deleteFailed'));
      return;
    }
    if (wsId) {
      await deletePrCacheEntriesForSession({
        workspaceId: wsId,
        prs: pullRequestsToClear.map((pr) => ({
          repository: getPullRequestRepoFullName(pr) ?? undefined,
          number: getPullRequestNumber(pr),
        })),
        defaultRepoFullName: repoFullName ?? undefined,
      });
    }
    handleBackToList();
  }, [activeSession, currentWorkspaceId, deleteArchivedSession, handleBackToList, repoFullName, t]);

  const handleCopyUrl = useCallback(
    async (successMessage?: string, failureMessage?: string) => {
      try {
        await navigator.clipboard.writeText(getAppShareUrl());
        captureSessionDetailEvent('session/share_link_copied');
        toast.success(successMessage ?? t('sessions.urlCopied', 'Session URL copied to clipboard'));
      } catch {
        captureSessionDetailEvent('session/share_link_copy_failed');
        toast.error(failureMessage ?? t('sessions.copyFailed', 'Unable to copy'));
      }
    },
    [captureSessionDetailEvent, t]
  );

  const handleRequestShareSession = useCallback(
    (targetSession: SessionMeta) => {
      if (!showSessionSharing) return;
      const sharing = resolveSessionSharing(targetSession);
      if (sharing.visibility !== 'private') return;
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
      setPendingSessionShare({ session: targetSession, sharing });
    },
    [resolveSessionSharing, showSessionSharing, t]
  );

  const handleConfirmSessionShare = useCallback(async () => {
    const pending = pendingSessionShare;
    if (!showSessionSharing || !pending || isSharingSession) return;
    setIsSharingSession(true);
    try {
      await shareSessionWithTeam(pending.sharing);
      await handleCopyUrl(
        t('sessions.sharing.sharedAndCopied', 'Shared with team and copied link'),
        t('sessions.sharing.sharedCopyFailed', "Shared with team, but couldn't copy the link")
      );
      setPendingSessionShare(null);
    } catch (error) {
      toast.error(t('sessions.sharing.shareFailed', "Couldn't share this conversation"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setIsSharingSession(false);
    }
  }, [
    handleCopyUrl,
    isSharingSession,
    pendingSessionShare,
    shareSessionWithTeam,
    showSessionSharing,
    t,
  ]);

  const handleCopyText = useCallback(
    (text: string, successMessage?: string) => {
      void navigator.clipboard
        .writeText(text)
        .then(() => {
          if (successMessage) toast.success(successMessage);
        })
        .catch(() => toast.error(t('sessions.shareFailed', 'Unable to share link')));
    },
    [t]
  );

  // Branch info for mobile menu
  const mobileBranchInfo = useMemo(() => {
    const project = activeSession?.project as
      | { kind: 'github'; repoFullName?: string; branch?: string }
      | { kind: 'local'; localProjectId?: string; branch?: string; githubRepoFullName?: string }
      | undefined;
    const isGitHub = project?.kind === 'github' || !!repoFullName;
    const baseBranch = activeSession?.baseBranch?.trim() || getProjectRefBranch(project) || '';
    const currentBranch = activeSession?.branchName?.trim() || '';
    const showBranchInfo = Boolean(
      (isGitHub || project?.kind === 'local') && (baseBranch || currentBranch)
    );
    const localPath = resolvedLocalProjectMeta?.rootPath ?? '';
    return { showBranchInfo, baseBranch, currentBranch, localPath };
  }, [activeSession, repoFullName, resolvedLocalProjectMeta]);
  const activeSessionWorkspacePath = useMemo(() => {
    if (!activeSession) return null;
    return resolveSessionWorkspacePath({
      sessionId: activeSession.id,
      ownerSessionId: activeSession.parentSessionId,
      isWorktree: activeSession.isWorktree,
      dotlodyPath: machineDotlodyPath,
      localProjectRootPath: resolvedLocalProjectMeta?.rootPath,
      repoFullName: resolveProjectGitHubRepo(activeSession.project) ?? activeSession.repoFullName,
      legacyWorkspacePath: sessionMachine?.workspacePaths?.[activeSession.id],
    });
  }, [activeSession, machineDotlodyPath, resolvedLocalProjectMeta?.rootPath, sessionMachine]);

  const handleCopyConversationHistory = useCallback(() => {
    if (activeDraftTab) {
      return;
    }
    const activeChatRef = chatRefsMap.current.get(activeTabSessionId);
    if (!activeChatRef || !('copyConversationHistory' in activeChatRef)) {
      captureSessionDetailEvent('session/history_copy_blocked', {
        reason: 'unavailable_tab',
        tab_session_id: activeTabSessionId,
      });
      toast.error(
        t(
          'sessions.copyConversationHistoryUnavailable',
          'Conversation history is unavailable for this tab'
        )
      );
      return;
    }
    void activeChatRef.copyConversationHistory();
  }, [activeDraftTab, activeTabSessionId, captureSessionDetailEvent, t]);

  const handleOpenSearch = useCallback(() => {
    if (activeDraftTab) {
      return;
    }
    const activeChatRef = chatRefsMap.current.get(activeTabSessionId);
    if (activeChatRef && 'openSearch' in activeChatRef) {
      captureSessionDetailEvent('session/search_open_requested', {
        tab_session_id: activeTabSessionId,
        source: 'session_detail_menu',
      });
      activeChatRef.openSearch();
    }
  }, [activeDraftTab, activeTabSessionId, captureSessionDetailEvent]);

  // Single fork entry point for every launcher: the header/footer action forks
  // into a top tab, the side-panel launcher forks into a right-hand panel.
  const forkActiveConversation = useCallback(
    (placement: 'tab' | 'side-panel' | 'worktree' = 'tab') => {
      const sourceSession = activeDraftTab ? null : activeTabSession;
      if (!sourceSession || !canForkSession(sourceSession) || pendingForks[sourceSession.id]) {
        return;
      }
      const activeChatRef = chatRefsMap.current.get(activeTabSessionId);
      const turnId =
        activeChatRef && 'getLastAssistantTurnId' in activeChatRef
          ? activeChatRef.getLastAssistantTurnId()
          : null;
      if (!turnId) {
        toast.error(t('sessions.forkNoAssistant', 'No assistant response is available to fork'));
        return;
      }
      void handleForkAssistant(sourceSession, turnId, placement);
    },
    [
      activeDraftTab,
      activeTabSession,
      activeTabSessionId,
      canForkSession,
      handleForkAssistant,
      pendingForks,
      t,
    ]
  );
  const handleForkCurrentSession = useCallback(
    (destination?: SessionForkDestination) => {
      forkActiveConversation(destination === 'new-worktree' ? 'worktree' : 'tab');
    },
    [forkActiveConversation]
  );
  const isCreatingSideSession = useMemo(
    () => Object.values(pendingForks).some((pending) => pending.placement === 'side-panel'),
    [pendingForks]
  );
  const handleCreateSideSession = useCallback(
    () => forkActiveConversation('side-panel'),
    [forkActiveConversation]
  );

  useEffect(() => {
    if (activeSidebarTab === 'pr' && (!latestPr || !repoFullName)) {
      setActiveSidebarTab(null);
    }
  }, [activeSidebarTab, latestPr, repoFullName]);

  useEffect(() => {
    if (activeSidebarTab === 'browser' && !activeBrowserSession) {
      setActiveSidebarTab(null);
    }
  }, [activeBrowserSession, activeSidebarTab]);

  // The ?browser=1 URL param is only meaningful for the mobile full-screen
  // drawer. On desktop the browser lives in the resizable sidebar (no URL
  // state), so strip the flag to keep the URL consistent and avoid a stale
  // "open" intent if the user resizes from mobile to desktop while the
  // drawer is open.
  useEffect(() => {
    if (!isMobile && urlBrowser) {
      replaceSessionUrlBrowser(false);
    }
  }, [isMobile, replaceSessionUrlBrowser, urlBrowser]);

  /* Sync ?pr=<number> into the desktop sidebar. The mobile path reads
     `urlPrNumber` directly for its full-screen drawer.

     The restore is a RENDER-PHASE state adjustment ("adjusting state when a
     prop changes" — react.dev/learn/you-might-not-need-an-effect), not an
     effect: as a sibling effect it armed in the same commit as the clear below
     — the first where `latestPr` resolved — and the clear then read the
     restore's target state BEFORE it landed (sidebar still closed, persisted
     viewer tab still active), stripping a fresh `?pr` deep link. Adjusted
     during render, the restored sidebar state is COMMITTED before any effect
     can observe it, so the ordering race is unrepresentable — and the restore
     lands in the same commit as `sidebarRestoreSeq`, which the layout
     invariant requires anyway. Applied once per (session, PR number) via a
     STATE guard (an aborted concurrent render retries instead of consuming
     the restore); re-applying on every `latestPr` identity change would
     reopen a panel the user had closed. */
  if (!isMobile && urlPrNumber !== undefined) {
    if (
      latestPr &&
      repoFullName &&
      urlPrNumber === latestPrNumber &&
      (restoredPrSidebar?.sessionId !== sessionId || restoredPrSidebar.prNumber !== urlPrNumber)
    ) {
      setRestoredPrSidebar({ sessionId, prNumber: urlPrNumber });
      setSidebarRestoreSeq((seq) => seq + 1);
      setIsSidebarOpen(true);
      activateSidebarTab('pr');
    }
  } else if (restoredPrSidebar !== null) {
    setRestoredPrSidebar(null);
  }

  // The PR restore token is committed with the open panel and restore sequence.
  // Clear the transient Zen override before paint without writing Jotai during render.
  useLayoutEffect(() => {
    if (restoredPrSidebar !== null) setZenLayoutMode(false);
  }, [restoredPrSidebar, setZenLayoutMode]);

  // Once restored, a user switching away from the PR tab (or closing the
  // sidebar) clears `?pr` so the URL stays consistent. The URL write must be
  // an effect, but it can never observe pre-restore state: the render-phase
  // adjustment above commits the restored sidebar in the same render that
  // arms this effect.
  useEffect(() => {
    if (isMobile) return;
    if (urlPrNumber === undefined) return;
    if (!latestPr || !repoFullName || urlPrNumber !== latestPrNumber) return;
    if (!isSidebarOpen || activeSidebarTab !== 'pr' || activeViewerTabId !== null) {
      replaceSessionUrlPr(undefined);
    }
  }, [
    activeSidebarTab,
    activeViewerTabId,
    isMobile,
    isSidebarOpen,
    latestPr,
    latestPrNumber,
    repoFullName,
    replaceSessionUrlPr,
    urlPrNumber,
  ]);

  /* A child session's root URL redirects to its parent. Corrupted meta can
     hold a parentSessionId CYCLE (X↔P): following it unguarded redirects
     forever, remounting every chat surface per hop until React's nested
     update limit crashes the renderer (#185). A reverse hop of the redirect
     just taken is always such a cycle — a parent that is itself a child is
     invalid nesting — so it stays put (the parent-guard early return above
     renders null) instead of looping. */
  const lastParentRedirectRef = useRef<{ from: SessionId; to: SessionId } | null>(null);
  useEffect(() => {
    const parentSessionId = activeSession?.parentSessionId;
    if (!parentSessionId || parentSessionId === sessionId) {
      return;
    }
    const last = lastParentRedirectRef.current;
    if (last && last.from === parentSessionId && last.to === sessionId) {
      recordSessionRenderTrace(
        `parent-cycle s=${shortTraceId(sessionId)} parent=${shortTraceId(parentSessionId)}`
      );
      console.error('Session parentSessionId cycle detected; not following it', {
        sessionId,
        parentSessionId,
      });
      return;
    }
    lastParentRedirectRef.current = { from: sessionId, to: parentSessionId };
    recordSessionRenderTrace(
      `parent-redirect s=${shortTraceId(sessionId)} parent=${shortTraceId(parentSessionId)}`
    );
    redirectToParentSessionUrl(parentSessionId, sessionId);
  }, [activeSession?.parentSessionId, redirectToParentSessionUrl, sessionId]);

  /* Entry-scoped last-active-tab restoration lives in the session ROUTE's
     `beforeLoad` (one replace redirect before anything renders), not here:
     the route has this navigation's own params, so the workspace-slug
     staleness dance and the one-shot claim ref are gone with it. */

  /* Mobile keeps one active surface: a `?tab` change dismisses the file
     viewer, matching what explicit tab selection does. Ref-compared so the
     session-entry run cannot clobber viewer state the entry just restored. */
  const lastUrlTabSyncRef = useRef<{ sessionId: SessionId; parsed: ParsedSessionTabSearch }>({
    sessionId,
    parsed: parsedUrlTab,
  });
  useEffect(() => {
    const last = lastUrlTabSyncRef.current;
    lastUrlTabSyncRef.current = { sessionId, parsed: parsedUrlTab };
    if (last.sessionId !== sessionId || last.parsed === parsedUrlTab) {
      return;
    }
    if (isMobile) {
      setActiveViewerTabId(null);
    }
  }, [isMobile, parsedUrlTab, sessionId]);

  const resolveDiffFilePaths = useCallback(
    (turnId: string): string[] => diffFilePathsByTurn[turnId] ?? [],
    [diffFilePathsByTurn]
  );
  const resolveTurnFileDiffs = useCallback(
    (turnId: string) => fileDiffsByTurn[turnId] ?? [],
    [fileDiffsByTurn]
  );

  const upsertViewerTab = useCallback(
    (tab: ViewerTab) => {
      setViewerTabs((prev) => {
        const idx = prev.findIndex((item) => item.id === tab.id);
        if (idx === -1) {
          return [...prev, tab];
        }
        const existing = prev[idx];
        if (!existing) {
          return prev;
        }
        if (areViewerTabsEquivalent(existing, tab)) {
          return prev;
        }
        const next = [...prev];
        next[idx] = tab;
        return next;
      });
      if (isMobile && tab.type === 'file') {
        setActiveViewerTabId(null);
        setMobileFileViewerTabId(tab.id);
        setMobileFileViewerOpen(true);
      } else if (isMobile) {
        setActiveViewerTabId((prevActiveId) => (prevActiveId === tab.id ? prevActiveId : tab.id));
      } else {
        selectSidePanelTab(tab.id);
        revealRightSidebar();
      }
    },
    [isMobile, revealRightSidebar, selectSidePanelTab]
  );

  const nextFocusRequestSeq = useCallback(() => {
    focusRequestSeqRef.current += 1;
    return focusRequestSeqRef.current;
  }, []);

  const handleOpenFileDiff = useCallback(
    (turnId: string, filePath: string) => {
      setFileProviderRequestedByInteraction(true);
      const turnFilePaths = resolveDiffFilePaths(turnId);
      const filePaths = turnFilePaths.length > 0 ? turnFilePaths : [filePath];

      upsertViewerTab({
        id: `diff:${turnId}`,
        type: 'diff',
        turnId,
        filePaths,
        focusFilePath: filePath,
        focusComment: null,
        focusRequestSeq: nextFocusRequestSeq(),
        mode: 'conversation',
        label: t('sessions.diffTab'),
      });
      captureSessionDetailEvent('session/viewer_diff_opened', {
        source: 'conversation_file_diff',
        turn_id: turnId,
        file_count: filePaths.length,
        focus_file_extension: getFileExtension(filePath),
        surface: 'desktop',
      });
    },
    [captureSessionDetailEvent, nextFocusRequestSeq, resolveDiffFilePaths, t, upsertViewerTab]
  );

  const handleOpenFileDiffMobile = useCallback(
    (turnId: string, filePath: string) => {
      setFileProviderRequestedByInteraction(true);
      const turnFilePaths = resolveDiffFilePaths(turnId);
      const filePaths = turnFilePaths.length > 0 ? turnFilePaths : [filePath];

      setMobileDiffState({
        turnId,
        filePaths,
        focusFilePath: filePath,
        focusComment: null,
        focusRequestSeq: nextFocusRequestSeq(),
        mode: 'conversation',
      });
      captureSessionDetailEvent('session/viewer_diff_opened', {
        source: 'conversation_file_diff',
        turn_id: turnId,
        file_count: filePaths.length,
        focus_file_extension: getFileExtension(filePath),
        surface: 'mobile_sheet',
      });
    },
    [captureSessionDetailEvent, nextFocusRequestSeq, resolveDiffFilePaths]
  );
  const handleNavigateToCommentMobile = useCallback(
    (reference: CommentReferencePayload) => {
      setFileProviderRequestedByInteraction(true);
      const mode = reference.mode ?? (reference.turnId ? 'conversation' : 'base');
      const turnId = mode === 'base' ? 'all-changes' : (reference.turnId ?? null);
      if (!turnId) return;
      const filePaths =
        mode === 'base'
          ? getSortedUniqueDiffFilePaths(changeFilePaths)
          : resolveDiffFilePaths(turnId);
      const resolvedFilePaths =
        mode === 'conversation' && filePaths.length === 0 ? [reference.path] : filePaths;

      setMobileDiffState({
        turnId,
        filePaths: resolvedFilePaths,
        focusFilePath: reference.path,
        focusComment: getDiffCommentFocusTargetFromReference(reference),
        focusRequestSeq: nextFocusRequestSeq(),
        mode,
      });
      captureSessionDetailEvent('session/viewer_diff_opened', {
        source: 'comment_reference',
        turn_id: turnId,
        mode,
        file_count: resolvedFilePaths.length,
        focus_file_extension: getFileExtension(reference.path),
        has_github_thread: Boolean(reference.githubThreadId),
        surface: 'mobile_sheet',
      });
    },
    [captureSessionDetailEvent, changeFilePaths, nextFocusRequestSeq, resolveDiffFilePaths]
  );

  const handleNavigateToComment = useCallback(
    (reference: CommentReferencePayload) => {
      setFileProviderRequestedByInteraction(true);
      const mode = reference.mode ?? (reference.turnId ? 'conversation' : 'base');
      const turnId = mode === 'base' ? 'all-changes' : (reference.turnId ?? null);
      if (!turnId) return;
      const filePaths =
        mode === 'base'
          ? getSortedUniqueDiffFilePaths(changeFilePaths)
          : resolveDiffFilePaths(turnId);
      const resolvedFilePaths =
        mode === 'conversation' && filePaths.length === 0 ? [reference.path] : filePaths;
      upsertViewerTab({
        id: mode === 'base' ? 'diff:all-changes' : `diff:${turnId}`,
        type: 'diff',
        turnId,
        filePaths: resolvedFilePaths,
        focusFilePath: reference.path,
        focusComment: getDiffCommentFocusTargetFromReference(reference),
        focusRequestSeq: nextFocusRequestSeq(),
        mode,
        label: mode === 'base' ? t('sessions.diffTabAllChanges') : t('sessions.diffTab'),
      });
      captureSessionDetailEvent('session/viewer_diff_opened', {
        source: 'comment_reference',
        turn_id: turnId,
        mode,
        file_count: resolvedFilePaths.length,
        focus_file_extension: getFileExtension(reference.path),
        has_github_thread: Boolean(reference.githubThreadId),
      });
    },
    [
      captureSessionDetailEvent,
      changeFilePaths,
      nextFocusRequestSeq,
      resolveDiffFilePaths,
      t,
      upsertViewerTab,
    ]
  );

  const handleCloseMobileDiff = useCallback(() => {
    setMobileDiffState(null);
  }, []);

  useEffect(() => {
    const nextViewerTabs = viewerTabs.map((tab) => {
      if (tab.type !== 'diff') {
        return tab;
      }

      if (tab.mode === 'base' || tab.turnId === 'all-changes') {
        const nextFilePaths = getSortedUniqueDiffFilePaths(changeFilePaths);
        if (areStringArraysEqual(tab.filePaths, nextFilePaths)) {
          return tab;
        }
        return {
          ...tab,
          filePaths: nextFilePaths,
        };
      }

      const nextFilePaths = diffFilePathsByTurn[tab.turnId] ?? [];
      if (nextFilePaths.length === 0) {
        return tab;
      }
      if (areStringArraysEqual(tab.filePaths, nextFilePaths)) {
        return tab;
      }

      return {
        ...tab,
        filePaths: nextFilePaths,
      };
    });

    const hasViewerTabUpdates = nextViewerTabs.some((tab, index) => tab !== viewerTabs[index]);
    if (hasViewerTabUpdates) {
      setViewerTabs(nextViewerTabs);
    }
  }, [changeFilePaths, diffFilePathsByTurn, viewerTabs]);

  useEffect(() => {
    if (!mobileDiffState) {
      return;
    }
    if (mobileDiffState.mode === 'base' || mobileDiffState.turnId === 'all-changes') {
      const nextFilePaths = getSortedUniqueDiffFilePaths(changeFilePaths);
      if (areStringArraysEqual(mobileDiffState.filePaths, nextFilePaths)) {
        return;
      }
      setMobileDiffState({
        ...mobileDiffState,
        filePaths: nextFilePaths,
      });
      return;
    }

    const nextFilePaths = diffFilePathsByTurn[mobileDiffState.turnId] ?? [];
    if (nextFilePaths.length === 0) {
      return;
    }
    if (areStringArraysEqual(mobileDiffState.filePaths, nextFilePaths)) {
      return;
    }

    setMobileDiffState({
      ...mobileDiffState,
      filePaths: nextFilePaths,
    });
  }, [changeFilePaths, diffFilePathsByTurn, mobileDiffState]);

  const handleOpenChangesDiff = useCallback(
    (filePath: string, filePaths: string[]) => {
      setFileProviderRequestedByInteraction(true);
      const mergedFilePaths = getSortedUniqueDiffFilePaths(filePaths);
      upsertViewerTab({
        id: 'diff:all-changes',
        type: 'diff',
        turnId: 'all-changes',
        filePaths: mergedFilePaths,
        focusFilePath: filePath,
        focusComment: null,
        focusRequestSeq: nextFocusRequestSeq(),
        mode: 'base',
        label: t('sessions.diffTabAllChanges'),
      });
      captureSessionDetailEvent('session/viewer_diff_opened', {
        source: 'changes_sidebar',
        turn_id: 'all-changes',
        mode: 'base',
        file_count: mergedFilePaths.length,
        focus_file_extension: getFileExtension(filePath),
      });
    },
    [captureSessionDetailEvent, nextFocusRequestSeq, t, upsertViewerTab]
  );

  const handleOpenAllChanges = useCallback(() => {
    setFileProviderRequestedByInteraction(true);
    const filePaths = getSortedUniqueDiffFilePaths(changeFilePaths);
    if (isMobile) {
      setMobileDiffState({
        turnId: 'all-changes',
        filePaths,
        focusFilePath: null,
        focusComment: null,
        focusRequestSeq: nextFocusRequestSeq(),
        mode: 'base',
      });
      captureSessionDetailEvent('session/viewer_diff_opened', {
        source: 'info_bar_diff_stat',
        turn_id: 'all-changes',
        mode: 'base',
        file_count: filePaths.length,
        surface: 'mobile_sheet',
      });
    } else {
      revealRightSidebar();
      activateSidebarTab('changes');
      captureSessionDetailEvent('session/sidebar_tab_selected', {
        source: 'info_bar_diff_stat',
        sidebar_tab: 'changes',
        change_file_count: filePaths.length,
      });
    }
  }, [
    activateSidebarTab,
    captureSessionDetailEvent,
    changeFilePaths,
    isMobile,
    nextFocusRequestSeq,
    revealRightSidebar,
  ]);

  const handleOpenPrTab = useCallback(
    (args: { prNumber: number; repoFullName: string; headCommitSha?: string }) => {
      replaceSessionUrlPr(args.prNumber, { push: true });
      if (!isMobile) {
        /* Expanding a collapsed sidebar restores the default/last panel size,
           and the empty state sits at whatever size it was left at — both are
           too narrow for PR content. Ask the layout for a real width (it
           checks the window can spare it); a panel already showing content
           keeps the user's chosen size. */
        const sidebarEmpty =
          activeSidebarTab === null && activeSideSessionId === null && activeViewerTabId === null;
        if (!isSidebarOpen || sidebarEmpty) {
          setPrSidebarWidthRequest((current) => ({
            seq: (current?.seq ?? 0) + 1,
            minWidthPx: PR_SIDEBAR_MIN_WIDTH_PX,
          }));
        }
        revealRightSidebar();
        activateSidebarTab('pr');
      }
      captureSessionDetailEvent('session/pr_tab_opened', {
        pr_number: args.prNumber,
        repo_full_name: args.repoFullName,
      });
    },
    [
      activateSidebarTab,
      activeSidebarTab,
      activeSideSessionId,
      activeViewerTabId,
      captureSessionDetailEvent,
      isMobile,
      isSidebarOpen,
      replaceSessionUrlPr,
      revealRightSidebar,
    ]
  );

  const handleClosePrTab = useCallback(() => {
    replaceSessionUrlPr(undefined);
  }, [replaceSessionUrlPr]);

  // When the PR tab resolves live GitHub details, push the canonical status
  // back into the owner session's persisted PR meta so the sidebar + session
  // header badges (which read that persisted value, not live details) reflect
  // reality — most visibly `draft`, which the webhook/CLI may not have
  // propagated yet. Best-effort and idempotent: only writes on a real change.
  // Durable session meta writes must go through the writer seam so Electron
  // local-first mode keeps the CLI as the sole author.
  const reconcilePersistedPrStatus = useCallback(
    (status: PrStatus) => {
      const ownerSession = workspaceOwnerSession;
      const prNumber = latestPrNumber;
      if (!runtime || !ownerSession || prNumber == null) return;
      const list = ownerSession.pullRequests ?? [];
      if (
        !list.some(
          (pr) =>
            (getPullRequestNumber(pr) === prNumber || pr.url === latestPr?.url) &&
            pr.status !== status
        )
      )
        return;
      const next = list.map((pr) =>
        getPullRequestNumber(pr) === prNumber || pr.url === latestPr?.url
          ? { url: pr.url, status }
          : pr
      );
      void runtime.writer
        .upsertDocMeta(getSessionRoomId(ownerSession.id), {
          pullRequests: next,
        } satisfies Partial<SessionMeta>)
        .catch((error: unknown) => {
          // Best-effort: the PR tab badge still shows live truth regardless.
          console.error('Failed to reconcile persisted PR status', error);
        });
    },
    [latestPr?.url, latestPrNumber, runtime, workspaceOwnerSession]
  );

  const handleOpenBrowser = useCallback(
    (tabSessionId?: SessionId, navigateCandidate = false) => {
      const browserSessionId = tabSessionId ?? activeBrowserSession?.id;
      if (tabSessionId) {
        navigateToSessionTab(tabSessionId, { push: true });
      }
      if (browserSessionId && navigateCandidate) {
        setBrowserCandidateNavigationRequest({
          sessionId: browserSessionId,
          id: ++browserCandidateNavigationSequenceRef.current,
        });
      }
      if (isMobile) {
        replaceSessionUrlBrowser(true, { push: true });
      } else {
        revealRightSidebar();
        activateSidebarTab('browser');
      }
      captureSessionDetailEvent('session/browser_tab_opened', {
        tab_session_id: tabSessionId ?? activeTabSessionId,
      });
    },
    [
      activeBrowserSession?.id,
      activeTabSessionId,
      activateSidebarTab,
      captureSessionDetailEvent,
      isMobile,
      navigateToSessionTab,
      revealRightSidebar,
      replaceSessionUrlBrowser,
    ]
  );

  const handleBrowserCandidateNavigationRequestHandled = useCallback((requestId: number) => {
    setBrowserCandidateNavigationRequest((current) => (current?.id === requestId ? null : current));
  }, []);

  const handleCloseBrowserTab = useCallback(() => {
    replaceSessionUrlBrowser(false);
  }, [replaceSessionUrlBrowser]);

  const handleOpenFile = useStableCallback(
    (filePath: string, options: SessionDetailOpenFileOptions = {}) => {
      setFileProviderRequestedByInteraction(true);
      void (async () => {
        // Where the path came from decides whether it may be rewritten at all;
        // `resolveSessionFileOpenTarget` owns that rule and documents why.
        const target = resolveSessionFileOpenTarget({
          rawPath: filePath,
          pathKind: options.pathKind ?? 'markdown-href',
          workspacePath: activeSessionWorkspacePath,
          ...(options.startLine === undefined ? {} : { startLine: options.startLine }),
          ...(options.endLine === undefined ? {} : { endLine: options.endLine }),
        });
        const resolution = await resolveSessionFileProviderOpenPath(
          activeSessionFileProvider,
          target.filePath
        ).catch(
          (): SessionFileProviderOpenPathResolution => ({
            path: target.filePath,
            redirected: false,
          })
        );
        const resolvedFilePath = resolution.path;

        const requestSeq = nextFocusRequestSeq();
        upsertViewerTab({
          id: getFileViewerTabId(resolvedFilePath, resolution.fileId),
          type: 'file',
          filePath: resolvedFilePath,
          ...(resolution.fileId === undefined ? {} : { fileId: resolution.fileId }),
          label: getBasename(resolvedFilePath),
          startLine: target.startLine,
          endLine: target.endLine,
          focusRequestSeq: requestSeq,
          ...(options.previewHtml ? { htmlPreviewRequestSeq: requestSeq } : {}),
        });
        captureSessionDetailEvent('session/viewer_file_opened', {
          source: target.fromMarkdownLink ? 'markdown_link' : (options.source ?? 'file_tree'),
          file_extension: getFileExtension(resolvedFilePath),
          has_line_anchor: target.startLine != null,
          line_suffix_format: target.lineSuffixFormat ?? null,
          symlink_redirected: resolution.redirected,
        });
      })();
    }
  );

  const handleOpenHtmlFile = useStableCallback((filePath: string) => {
    handleOpenFile(filePath, {
      pathKind: 'canonical',
      source: 'html_attachment',
      previewHtml: true,
    });
  });

  /**
   * Every entry point whose path came from the file index. Kept stable so the
   * file tree's memoized rows do not re-render on each parent commit.
   */
  const handleOpenIndexedFile = useStableCallback((filePath: string) => {
    handleOpenFile(filePath, { pathKind: 'canonical' });
  });

  const handleOpenFileFromDiff = useStableCallback((filePath: string) => {
    handleOpenFile(filePath, { pathKind: 'canonical', source: 'diff_header' });
  });

  const handleOpenFileDiffForChat = useStableCallback((turnId: string, filePath: string) => {
    setFileProviderRequestedByInteraction(true);
    handleOpenFileDiff(turnId, filePath);
  });

  const handleOpenFileDiffMobileForChat = useStableCallback((turnId: string, filePath: string) => {
    setFileProviderRequestedByInteraction(true);
    handleOpenFileDiffMobile(turnId, filePath);
  });

  useEffect(() => {
    if (!activeSessionFileProvider || viewerTabs.length === 0) {
      return undefined;
    }

    let cancelled = false;
    void (async () => {
      const resolutions = await Promise.all(
        viewerTabs.map(async (tab) => {
          if (tab.type !== 'file') {
            return { tab, next: tab };
          }

          if (tab.fileId) {
            const entry = await activeSessionFileProvider.getFile(tab.fileId).catch(() => null);
            return { tab, next: refreshPinnedProviderFileViewerTab(tab, entry) };
          }

          const resolution = await resolveSessionFileProviderOpenPath(
            activeSessionFileProvider,
            tab.filePath
          ).catch(
            (): SessionFileProviderOpenPathResolution => ({
              path: tab.filePath,
              redirected: false,
            })
          );
          if (!resolution.redirected || resolution.path === tab.filePath) {
            return { tab, next: tab };
          }
          const next: ViewerTab = {
            ...tab,
            id: getFileViewerTabId(resolution.path, resolution.fileId ?? tab.fileId),
            filePath: resolution.path,
            ...(resolution.fileId === undefined ? {} : { fileId: resolution.fileId }),
            label: getBasename(resolution.path),
          };
          return { tab, next };
        })
      );

      if (cancelled) {
        return;
      }

      const changed = resolutions.some(({ tab, next }) => tab !== next);
      if (!changed) {
        return;
      }

      const nextIdByPreviousId = new Map(
        resolutions
          .filter(({ tab, next }) => tab.id !== next.id)
          .map(({ tab, next }) => [tab.id, next.id])
      );

      const nextTabByPreviousId = new Map(
        resolutions.map(({ tab, next }) => [tab.id, next] as const)
      );
      setViewerTabs((current) => {
        let didUpdate = false;
        const nextTabs = current.map((tab) => {
          const next = nextTabByPreviousId.get(tab.id);
          if (!next || areViewerTabsEquivalent(tab, next)) {
            return tab;
          }
          didUpdate = true;
          return next;
        });
        return didUpdate ? nextTabs : current;
      });
      setActiveViewerTabId((current) =>
        current == null ? current : (nextIdByPreviousId.get(current) ?? current)
      );
    })();

    return () => {
      cancelled = true;
    };
  }, [activeSessionFileProvider, viewerTabs]);

  const handleFileQuickOpenChange = useCallback((open: boolean) => {
    if (open) {
      setFileProviderRequestedByInteraction(true);
    }
    setIsFileQuickOpenOpen(open);
  }, []);

  useEffect(() => {
    if (!activeSession) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) {
        return;
      }
      const isMod = event.metaKey || event.ctrlKey;
      if (!isMod || event.altKey || event.shiftKey || event.key.toLowerCase() !== 'p') {
        return;
      }
      event.preventDefault();
      handleFileQuickOpenChange(true);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeSession, handleFileQuickOpenChange]);

  // Session tabs and viewer tabs are independent on desktop; mobile keeps one active surface.
  const handleSessionTabSelect = useCallback(
    (tabId: string) => {
      desktopTabFocusRegionRef.current = 'conversation';
      // A user-driven switch PUSHES so tabs participate in history back.
      navigateToSessionTab(tabId, { push: true });
      if (isMobile) {
        setActiveViewerTabId(null);
      }
      captureThrottledTabSelected({
        ...sessionDetailAnalyticsProperties,
        tab_id: tabId,
        tab_kind: isDraftSessionTabId(tabId) ? 'draft' : tabId === sessionId ? 'parent' : 'child',
      });
    },
    [
      captureThrottledTabSelected,
      isMobile,
      navigateToSessionTab,
      sessionDetailAnalyticsProperties,
      sessionId,
    ]
  );

  const handleForkedConversationPrepared = useCallback(
    (sourceSessionId: string, targetSessionId: SessionId) => {
      const taken = takePendingFork(sourceSessionId, targetSessionId);
      if (!taken) return;
      if (taken.placement === 'side-panel') {
        selectSidePanelTab(getSideSessionPanelTabId(targetSessionId));
        revealRightSidebar();
        return;
      }
      if (taken.placement === 'worktree') {
        if (!workspaceSlug) return;
        void router.navigate({
          to: '/$workspaceName/sessions/$sessionId',
          params: { workspaceName: workspaceSlug, sessionId: targetSessionId },
          search: { tab: undefined },
        });
        return;
      }
      handleSessionTabSelect(targetSessionId);
    },
    [
      handleSessionTabSelect,
      revealRightSidebar,
      router,
      selectSidePanelTab,
      takePendingFork,
      workspaceSlug,
    ]
  );
  const handleForkedConversationPrepareError = useCallback(
    (sourceSessionId: string, targetSessionId: SessionId) => {
      if (!takePendingFork(sourceSessionId, targetSessionId)) return;
      toast.error(
        t('sessions.forkOpenFailed', 'Session forked, but its conversation could not be loaded')
      );
    },
    [t, takePendingFork]
  );
  const handleNavigateSession = useCallback(
    (target: SessionNavigationTarget) => {
      const location = getSessionNavigationLocation(target);
      if (location.sessionId === sessionId) {
        handleSessionTabSelect(target.tabSessionId ?? target.sessionId);
        return;
      }

      if (!workspaceSlug) return;
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId: location.sessionId },
        search: { tab: location.tab },
      });
    },
    [handleSessionTabSelect, router, sessionId, workspaceSlug]
  );

  // When a viewer tab is selected, activate the viewer surface for the current session.
  const handleViewerTabSelect = useCallback(
    (tabId: string) => {
      if (isMobile) {
        setActiveViewerTabId(tabId);
      } else {
        selectSidePanelTab(tabId);
        revealRightSidebar();
      }
      captureSessionDetailEvent('session/viewer_tab_selected', {
        viewer_tab_id: tabId,
        viewer_tab_type: tabId.startsWith('file:') ? 'file' : 'diff',
      });
    },
    [captureSessionDetailEvent, isMobile, revealRightSidebar, selectSidePanelTab]
  );

  const handleSidebarTabSelect = useCallback(
    (tabId: SidebarTab) => {
      if (!isMobile) {
        desktopTabFocusRegionRef.current = 'side-panel';
      }
      activateSidebarTab(tabId);
      if (tabId === 'pr' && latestPrNumber != null) {
        replaceSessionUrlPr(latestPrNumber, { push: true });
      }
      captureSessionDetailEvent('session/sidebar_tab_selected', {
        sidebar_tab: tabId,
        change_file_count: changeEntries.length,
      });
    },
    [
      activateSidebarTab,
      captureSessionDetailEvent,
      changeEntries.length,
      isMobile,
      latestPrNumber,
      replaceSessionUrlPr,
    ]
  );

  // Fixed panels are persistable side-panel tabs; Side Chat is an action that
  // creates a new durable session instead, so the two lists stay separate and
  // only merge for display.
  const sidePanelFixedOptions = useMemo<(SessionSidePanelOption & { id: SidebarTab })[]>(() => {
    const options: (SessionSidePanelOption & { id: SidebarTab })[] = [
      {
        id: 'files',
        label: t('sessions.detailTabs.files', 'Files'),
        kind: 'files',
      },
      {
        id: 'changes',
        label: t('sessions.detailTabs.allChanges', 'All Changes'),
        kind: 'changes',
      },
    ];
    if (activeBrowserSession) {
      options.push({
        id: 'browser',
        label: t('sessions.detailTabs.browser', 'Browser'),
        kind: 'browser',
      });
    }
    if (latestPr && repoFullName && latestPrNumber != null) {
      options.push({
        id: 'pr',
        label: t('sessions.detailTabs.pr', 'PR'),
        kind: 'pr',
      });
    }
    return options;
  }, [activeBrowserSession, latestPr, latestPrNumber, repoFullName, t]);
  const sideChatOption = useMemo<SessionSidePanelOption | null>(() => {
    const launcherState = getSideChatLauncherState({
      providerSupportsFork: Boolean(
        !activeDraftTab && activeTabSession && canForkSession(activeTabSession)
      ),
      machineOffline: activeTabSessionMachineOnlineStatus === 'offline',
    });
    if (launcherState === 'hidden') return null;
    return {
      id: 'side-session',
      label: t('sessions.detailTabs.sideSession', 'Side Chat'),
      kind: 'session',
      pending: isCreatingSideSession,
      disabled: launcherState === 'disabled' || isCreatingSideSession,
    };
  }, [
    activeDraftTab,
    activeTabSession,
    activeTabSessionMachineOnlineStatus,
    canForkSession,
    isCreatingSideSession,
    t,
  ]);
  const sidePanelOptions = useMemo<SessionSidePanelOption[]>(
    () => (sideChatOption ? [sideChatOption, ...sidePanelFixedOptions] : sidePanelFixedOptions),
    [sideChatOption, sidePanelFixedOptions]
  );

  const handleSidePanelOptionOpen = useCallback(
    (panelId: SessionSidePanelOption['id']) => {
      if (panelId === 'side-session') {
        handleCreateSideSession();
        return;
      }
      handleSidebarTabSelect(panelId);
    },
    [handleCreateSideSession, handleSidebarTabSelect]
  );

  const visibleOpenedSidebarTabs = useMemo(() => {
    const availableTabIds = new Set(sidePanelFixedOptions.map((option) => option.id));
    return openedSidebarTabs.filter((tabId) => availableTabIds.has(tabId));
  }, [openedSidebarTabs, sidePanelFixedOptions]);

  // Shared viewer metadata powers the mobile switcher and desktop side-panel tabs.
  const viewerTabItems: ViewerTabItem[] = useMemo(
    () =>
      viewerTabs.map((tab) => ({
        id: tab.id,
        type: tab.type,
        label: tab.label,
        filePath: tab.type === 'file' ? tab.filePath : undefined,
        dirty: tab.type === 'file' ? viewerTabSaveStates[tab.id]?.dirty === true : false,
        saving: tab.type === 'file' ? viewerTabSaveStates[tab.id]?.saving === true : false,
        conflict:
          tab.type === 'file'
            ? viewerTabSaveStates[tab.id]?.conflict === true ||
              viewerTabSaveStates[tab.id]?.error === true
            : false,
      })),
    [viewerTabSaveStates, viewerTabs]
  );

  // The rendered side-panel tab strip, in strip order: fixed panels, then side
  // chats, then viewers. This is the ONLY statement of that order — every close
  // handler picks its fallback neighbour from `sidePanelTabIds`, so a new tab
  // kind cannot silently fall out of the "select the previous sibling" rule.
  const sidePanelTabs = useMemo<SessionSidePanelTabItem[]>(() => {
    const optionById = new Map(sidePanelFixedOptions.map((option) => [option.id, option]));
    const fixedTabs = visibleOpenedSidebarTabs.flatMap((tabId) => {
      const option = optionById.get(tabId);
      return option ? [{ ...option, closeable: true }] : [];
    });
    return [
      ...fixedTabs,
      ...visibleSideSessions.map(
        (sideSession): SessionSidePanelTabItem => ({
          id: getSideSessionPanelTabId(sideSession.id),
          label: sideSession.title?.trim() || t('sessions.detailTabs.sideSession', 'Side Chat'),
          kind: 'session',
          closeable: true,
          pending: closingSideSessionIds.has(sideSession.id),
        })
      ),
      ...viewerTabItems.map(
        (tab): SessionSidePanelTabItem => ({
          ...tab,
          kind: tab.type,
          closeable: true,
        })
      ),
    ];
  }, [
    closingSideSessionIds,
    sidePanelFixedOptions,
    t,
    viewerTabItems,
    visibleOpenedSidebarTabs,
    visibleSideSessions,
  ]);
  const sidePanelTabIds = useMemo(() => sidePanelTabs.map((tab) => tab.id), [sidePanelTabs]);

  const handleCloseSidebarTab = useCallback(
    (tabId: SidebarTab) => {
      const { fallbackTabId, sidebarOpen } = getSidePanelTabStateAfterClose(sidePanelTabIds, tabId);
      const fallbackSidebarTabId = getSidePanelTabCloseFallback(
        visibleOpenedSidebarTabs,
        tabId
      ) as SidebarTab | null;
      setOpenedSidebarTabs((current) => current.filter((candidate) => candidate !== tabId));
      if (!sidebarOpen) {
        setIsSidebarOpen(false);
      }
      if (activeSidebarTab === tabId) {
        if (activeViewerTabId === null) {
          selectSidePanelTab(fallbackTabId);
        } else {
          setActiveSidebarTab(fallbackSidebarTabId);
        }
      }
      if (tabId === 'pr') {
        replaceSessionUrlPr(undefined);
      }
      if (tabId === 'browser') {
        setBrowserCandidateNavigationRequest(null);
      }
    },
    [
      activeSidebarTab,
      activeViewerTabId,
      replaceSessionUrlPr,
      selectSidePanelTab,
      sidePanelTabIds,
      visibleOpenedSidebarTabs,
    ]
  );

  const handleViewerTabSaveStateChange = useCallback(
    (tabId: string, state: SessionFileSaveViewState) => {
      setViewerTabSaveStates((prev) => {
        const previous = prev[tabId] ?? EMPTY_VIEWER_TAB_SAVE_STATE;
        const next: ViewerTabSaveState = {
          ...previous,
          dirty: state.dirty,
          canSave: state.canSave,
          saving: state.saving,
          conflict: state.conflict,
          error: state.error,
        };
        if (
          previous.dirty === next.dirty &&
          previous.canSave === next.canSave &&
          previous.saving === next.saving &&
          previous.conflict === next.conflict &&
          previous.error === next.error
        ) {
          return prev;
        }
        return { ...prev, [tabId]: next };
      });
    },
    []
  );

  const handleToggleSidebar = useCallback(() => {
    const next = getZenAwarePanelToggleState({
      zenMode: isZenLayoutMode,
      panelOpen: isSidebarOpen,
    });
    captureSessionDetailEvent(
      next.panelOpen ? 'session/sidebar_opened' : 'session/sidebar_closed',
      {
        default_tab: activeSidebarTab,
        change_file_count: changeEntries.length,
      }
    );
    setZenLayoutMode(next.zenMode);
    setIsSidebarOpen(next.panelOpen);
  }, [
    activeSidebarTab,
    captureSessionDetailEvent,
    changeEntries.length,
    isSidebarOpen,
    isZenLayoutMode,
    setZenLayoutMode,
  ]);

  const handleCloseViewerTab = useCallback(
    (tabId: string) => {
      const saveState = viewerTabSaveStates[tabId];
      if (saveState?.dirty && typeof window !== 'undefined') {
        const tabLabel = viewerTabs.find((tab) => tab.id === tabId)?.label ?? tabId;
        const shouldClose = window.confirm(
          t(
            'sessions.fileViewer.closeDirtyConfirm',
            'Close {{fileName}} without saving your changes?',
            { fileName: tabLabel }
          )
        );
        if (!shouldClose) {
          return;
        }
      }
      const existingIndex = viewerTabs.findIndex((tab) => tab.id === tabId);
      if (existingIndex >= 0) {
        const { sidebarOpen } = getSidePanelTabStateAfterClose(sidePanelTabIds, tabId);
        if (!sidebarOpen) {
          setIsSidebarOpen(false);
        }
        captureSessionDetailEvent('session/viewer_tab_closed', {
          viewer_tab_id: tabId,
          viewer_tab_type: tabId.startsWith('file:') ? 'file' : 'diff',
          remaining_viewer_tab_count: Math.max(0, viewerTabs.length - 1),
        });
      }
      setViewerTabSaveStates((prev) => {
        if (!Object.prototype.hasOwnProperty.call(prev, tabId)) return prev;
        const next = { ...prev };
        delete next[tabId];
        return next;
      });
      setTabOrderState((prev) => removeTabOrderId(prev, tabId));
      if (mobileFileViewerTabId === tabId) {
        setMobileFileViewerOpen(false);
        setMobileFileViewerTabId(null);
      }
      setViewerTabs((prev) => {
        const idx = prev.findIndex((tab) => tab.id === tabId);
        if (idx === -1) {
          return prev;
        }
        const next = prev.filter((tab) => tab.id !== tabId);
        if (activeViewerTabId === tabId) {
          selectSidePanelTab(getSidePanelTabCloseFallback(sidePanelTabIds, tabId));
        }
        return next;
      });
    },
    [
      activeViewerTabId,
      captureSessionDetailEvent,
      mobileFileViewerTabId,
      selectSidePanelTab,
      sidePanelTabIds,
      t,
      viewerTabSaveStates,
      viewerTabs,
    ]
  );

  // Fixed side-panel tabs remain selectable even while viewer tabs stay mounted.
  const effectiveActiveViewerTabId = useMemo(() => {
    if (activeViewerTabId && viewerTabs.some((tab) => tab.id === activeViewerTabId)) {
      return activeViewerTabId;
    }
    return null;
  }, [activeViewerTabId, viewerTabs]);
  const activeViewerTab = useMemo(() => {
    if (!effectiveActiveViewerTabId) {
      return null;
    }
    return viewerTabs.find((tab) => tab.id === effectiveActiveViewerTabId) ?? null;
  }, [effectiveActiveViewerTabId, viewerTabs]);
  const activeViewerTabSaveState = effectiveActiveViewerTabId
    ? viewerTabSaveStates[effectiveActiveViewerTabId]
    : undefined;
  // One resolver for what this client can do with the session's files, shared
  // by the Files tree's right-click menu and the side panel's ⋯ menu so the two
  // can never offer different sets. It decides local-host vs remote itself.
  const activeSessionFileActions = useSessionFileActions({
    session: activeSession,
    fileProvider: activeSessionFileProvider,
  });
  const activeViewerFilePath = activeViewerTab?.type === 'file' ? activeViewerTab.filePath : null;
  const handleSaveCurrentFile = useCallback(() => {
    if (!effectiveActiveViewerTabId || activeViewerTab?.type !== 'file') {
      return;
    }
    setViewerTabSaveStates((prev) => {
      const previous = prev[effectiveActiveViewerTabId] ?? EMPTY_VIEWER_TAB_SAVE_STATE;
      return {
        ...prev,
        [effectiveActiveViewerTabId]: {
          ...previous,
          saveRequestSeq: previous.saveRequestSeq + 1,
        },
      };
    });
  }, [activeViewerTab?.type, effectiveActiveViewerTabId]);

  const currentBranch = useMemo(() => {
    const targetSession = activeDraftTab ? null : activeTabSession;
    return targetSession?.branchName?.trim() || '';
  }, [activeDraftTab, activeTabSession]);

  const handleCopyCurrentBranch = useCallback(() => {
    if (!currentBranch) {
      toast.error(t('sessions.currentBranchUnavailable', 'No current branch to copy'));
      return;
    }
    handleCopyText(
      currentBranch,
      t('sessions.currentBranchCopied', 'Current branch name copied to clipboard')
    );
    captureSessionDetailEvent('session/current_branch_copied', {
      tab_session_id: activeTabSessionId,
    });
  }, [activeTabSessionId, captureSessionDetailEvent, currentBranch, handleCopyText, t]);

  const handleFocusActiveInput = useCallback(() => {
    if (isMobile) {
      setActiveViewerTabId(null);
    }

    requestAnimationFrame(() => {
      chatRefsMap.current.get(activeTabSessionId)?.focusInput();
    });
  }, [activeTabSessionId, isMobile]);

  const handleRenameCurrentSession = useCallback(() => {
    const targetSession = activeDraftTab ? null : activeTabSession;
    if (!targetSession || targetSession.isArchived) {
      return;
    }
    setRenameDialogTarget({
      sessionId: targetSession.id,
      initialTitle: targetSession.title ?? '',
    });
  }, [activeDraftTab, activeTabSession]);

  const handleToggleCurrentSessionPinned = useCallback(() => {
    const targetSession = activeDraftTab ? null : activeTabSession;
    if (!targetSession || targetSession.isArchived) {
      return;
    }
    void setSessionPinned(targetSession.id, !targetSession.isPinned).catch((error: unknown) => {
      console.error('Failed to update session pin state', error);
      toast.error(t('sessions.pin.updateFailed', 'Failed to update pinned state'));
    });
  }, [activeDraftTab, activeTabSession, setSessionPinned, t]);

  const handleSwitchSessionTab = useCallback(
    (direction: 1 | -1) => {
      if (orderedSessionTabIds.length <= 1) {
        return;
      }
      const currentIndex = orderedSessionTabIds.indexOf(activeTabSessionId);
      const safeCurrentIndex = currentIndex >= 0 ? currentIndex : 0;
      const nextIndex =
        (safeCurrentIndex + direction + orderedSessionTabIds.length) % orderedSessionTabIds.length;
      const nextTabId = orderedSessionTabIds[nextIndex];
      if (!nextTabId || nextTabId === activeTabSessionId) {
        return;
      }
      void handleSessionTabSelect(nextTabId);
    },
    [activeTabSessionId, handleSessionTabSelect, orderedSessionTabIds]
  );

  useCommand({
    id: 'session.archiveCurrent',
    title: t('commands.session.archiveCurrent', 'Archive Current Chat'),
    category: 'Session',
    keybindings: getCommandKeybindings('session.archiveCurrent'),
    when: () => Boolean(activeSession) && activeSession?.isArchived !== true,
    run: () => {
      setArchiveConfirmOpen(true);
    },
  });

  useCommand({
    id: 'session.toggleCurrentPinned',
    title: t('commands.session.toggleCurrentPinned', 'Toggle Current Chat Pinned'),
    category: 'Session',
    keybindings: getCommandKeybindings('session.toggleCurrentPinned'),
    /* While the URL-named child is still pending, `activeTabSession` falls
       back to the parent for display; mutating commands must not take that
       fallback as their target while the UI says a child is active. */
    when: () =>
      Boolean(activeTabSession) &&
      !activeDraftTab &&
      !activeTabIsPendingChild &&
      activeTabSession?.isArchived !== true,
    run: handleToggleCurrentSessionPinned,
  });

  useCommand({
    id: 'session.searchCurrent',
    title: t('commands.session.searchCurrent', 'Find in Current Chat'),
    category: 'Session',
    keybindings: getCommandKeybindings('session.searchCurrent'),
    when: () => Boolean(activeTabSession) && !activeDraftTab,
    run: handleOpenSearch,
  });

  useCommand({
    id: 'session.focusInput',
    title: t('commands.session.focusInput', 'Focus Current Input'),
    category: 'Editor',
    keybindings: getCommandKeybindings('session.focusInput'),
    when: () => Boolean(chatRefsMap.current.get(activeTabSessionId)),
    run: handleFocusActiveInput,
  });

  useCommand({
    id: 'session.saveCurrentFile',
    title: t('commands.session.saveCurrentFile', 'Save Current File'),
    category: 'Editor',
    keybindings: getCommandKeybindings('session.saveCurrentFile'),
    when: () => activeViewerTab?.type === 'file' && activeViewerTabSaveState?.canSave === true,
    run: handleSaveCurrentFile,
  });

  useCommand({
    id: 'session.toggleExplorerSidebar',
    title: t('commands.session.toggleExplorerSidebar', 'Toggle Files and Changes Sidebar'),
    category: 'View',
    keybindings: getCommandKeybindings('session.toggleExplorerSidebar'),
    when: () => !isMobile && Boolean(activeSession),
    run: handleToggleSidebar,
  });

  const jotaiStore = useStore();
  useCommand({
    id: 'session.newTabOrTerminal',
    title: t('commands.session.newTabOrTerminal', 'New Tab or Terminal'),
    category: 'Session',
    keybindings: getCommandKeybindings('session.newTabOrTerminal'),
    when: () => Boolean(activeSession),
    run: () => {
      // ⌥N: a new terminal when the terminal is focused, otherwise a new tab.
      const controller = jotaiStore.get(terminalControllerAtom);
      const terminalFocused = Boolean(
        typeof document !== 'undefined' && document.activeElement?.closest('.lody-terminal-panel')
      );
      if (controller && terminalFocused) {
        controller.openNewTerminal();
      } else {
        handleNewTab();
      }
    },
  });

  useCommand({
    id: 'session.toggleTerminal',
    title: t('commands.session.toggleTerminal', 'Toggle Terminal'),
    category: 'View',
    keybindings: getCommandKeybindings('session.toggleTerminal'),
    // Only available while a terminal-capable session has published its controls.
    when: () => Boolean(jotaiStore.get(terminalControllerAtom)),
    run: () => jotaiStore.get(terminalControllerAtom)?.toggleOpen(),
  });

  useCommand({
    id: 'session.copyCurrentBranch',
    title: t('commands.session.copyCurrentBranch', 'Copy Current Branch'),
    category: 'Session',
    keybindings: getCommandKeybindings('session.copyCurrentBranch'),
    when: () => currentBranch.length > 0,
    run: handleCopyCurrentBranch,
  });

  useCommand({
    id: 'session.copyUrl',
    title: t('commands.session.copyUrl', 'Copy Current URL'),
    category: 'Session',
    keybindings: getCommandKeybindings('session.copyUrl'),
    when: () => Boolean(activeSession),
    run: () => {
      void handleCopyUrl();
    },
  });

  useCommand({
    id: 'session.renameCurrent',
    title: t('commands.session.renameCurrent', 'Rename Current Chat'),
    category: 'Session',
    keybindings: getCommandKeybindings('session.renameCurrent'),
    /* Same pending-child rule as toggleCurrentPinned above. */
    when: () =>
      Boolean(activeTabSession) &&
      !activeDraftTab &&
      !activeTabIsPendingChild &&
      activeTabSession?.isArchived !== true,
    run: handleRenameCurrentSession,
  });

  useCommand({
    id: 'session.nextTab',
    title: t('commands.session.nextTab', 'Switch to Next Tab'),
    category: 'Navigation',
    keybindings: getCommandKeybindings('session.nextTab'),
    when: () => orderedSessionTabIds.length > 1,
    run: () => handleSwitchSessionTab(1),
  });

  useCommand({
    id: 'session.previousTab',
    title: t('commands.session.previousTab', 'Switch to Previous Tab'),
    category: 'Navigation',
    keybindings: getCommandKeybindings('session.previousTab'),
    when: () => orderedSessionTabIds.length > 1,
    run: () => handleSwitchSessionTab(-1),
  });

  useEffect(() => {
    /* Only a RESOLVED tab is worth remembering as last-active: persisting a
       still-syncing child would make the next entry restore a tab that may
       never resolve. Panel and viewer changes made while it loads are still
       the user's, so the write happens regardless — the conversation slot
       just keeps its previously stored value until the child resolves. */
    const persistedSessionTabId = activeTabIsPendingChild
      ? (readStoredLastActiveTabState(sessionId)?.sessionTabId ?? sessionId)
      : activeTabSessionId;
    writeStoredLastActiveTabState(sessionId, {
      sessionTabId: persistedSessionTabId,
      viewerTab: activeViewerTab,
      sidePanel: {
        open: isSidebarOpen,
        tab: activeSidebarTab,
        tabs: openedSidebarTabs,
        sideSessionId: activeSideSessionId,
      },
    });
  }, [
    activeSidebarTab,
    activeSideSessionId,
    activeTabIsPendingChild,
    activeTabSessionId,
    activeViewerTab,
    isSidebarOpen,
    openedSidebarTabs,
    sessionId,
  ]);

  // Side Chat always stays available: it launches another session rather than
  // toggling an already-open panel.
  const availableSidePanelOptions = useMemo(() => {
    const opened = new Set(openedSidebarTabs);
    const unopened = sidePanelFixedOptions.filter((option) => !opened.has(option.id));
    return sideChatOption ? [sideChatOption, ...unopened] : unopened;
  }, [openedSidebarTabs, sideChatOption, sidePanelFixedOptions]);

  const effectiveActiveSideSessionId = useMemo(
    () =>
      activeSideSessionId &&
      visibleSideSessions.some((sideSession) => sideSession.id === activeSideSessionId)
        ? activeSideSessionId
        : null,
    [activeSideSessionId, visibleSideSessions]
  );
  useEffect(() => {
    if (!effectiveActiveSideSessionId || mountedSideSessionIds.has(effectiveActiveSideSessionId)) {
      return;
    }
    setMountedSideSessionIds((current) => new Set(current).add(effectiveActiveSideSessionId));
  }, [effectiveActiveSideSessionId, mountedSideSessionIds]);
  useEffect(() => {
    if (
      !docMetaCacheReady ||
      !activeSideSessionId ||
      effectiveActiveSideSessionId ||
      Object.values(pendingForks).some((pending) => pending.targetSessionId === activeSideSessionId)
    ) {
      return;
    }
    setActiveSideSessionId(null);
  }, [activeSideSessionId, docMetaCacheReady, effectiveActiveSideSessionId, pendingForks]);
  const handleCloseSideSession = useCallback(
    async (sideSessionId: SessionId) => {
      if (!runtime || closingSideSessionIds.has(sideSessionId)) {
        return;
      }
      const sideSession = visibleSideSessions.find((candidate) => candidate.id === sideSessionId);
      if (!sideSession) {
        return;
      }
      setClosingSideSessionIds((current) => new Set(current).add(sideSessionId));
      try {
        const termination = await runtime.requestSessionTerminate(
          sideSession.machineId,
          sideSessionId,
          { timeoutMs: 30_000 }
        );
        if (!termination?.success) {
          throw new Error(termination?.error ?? 'Side session termination failed');
        }
        await deleteSessions([sideSessionId]);
        const { fallbackTabId, sidebarOpen } = getSidePanelTabStateAfterClose(
          sidePanelTabIds,
          getSideSessionPanelTabId(sideSessionId)
        );
        if (!sidebarOpen) {
          setIsSidebarOpen(false);
        }
        if (activeSideSessionId === sideSessionId) {
          selectSidePanelTab(fallbackTabId);
        }
      } catch (error) {
        console.error('Failed to close side session', { sideSessionId, error });
        toast.error(t('sessions.sideSession.closeFailed', 'Unable to close side chat'));
      } finally {
        setClosingSideSessionIds((current) => {
          const next = new Set(current);
          next.delete(sideSessionId);
          return next;
        });
      }
    },
    [
      activeSideSessionId,
      closingSideSessionIds,
      deleteSessions,
      runtime,
      selectSidePanelTab,
      sidePanelTabIds,
      t,
      visibleSideSessions,
    ]
  );

  const handleSidePanelTabSelect = useCallback(
    (tabId: string) => {
      desktopTabFocusRegionRef.current = 'side-panel';
      if (isViewerTabId(tabId)) {
        handleViewerTabSelect(tabId);
        return;
      }
      if (parseSideSessionPanelTabId(tabId)) {
        selectSidePanelTab(tabId);
        return;
      }
      handleSidebarTabSelect(tabId as SidebarTab);
    },
    [handleSidebarTabSelect, handleViewerTabSelect, selectSidePanelTab]
  );

  const handleSidePanelTabClose = useCallback(
    (tabId: string) => {
      const sideSessionId = parseSideSessionPanelTabId(tabId) as SessionId | null;
      if (sideSessionId) {
        void handleCloseSideSession(sideSessionId);
        return;
      }
      if (isViewerTabId(tabId)) {
        handleCloseViewerTab(tabId);
        return;
      }
      handleCloseSidebarTab(tabId as SidebarTab);
    },
    [handleCloseSideSession, handleCloseSidebarTab, handleCloseViewerTab]
  );

  const activeSidePanelTabId =
    effectiveActiveViewerTabId ??
    (effectiveActiveSideSessionId
      ? getSideSessionPanelTabId(effectiveActiveSideSessionId)
      : activeSidebarTab);
  const resolveFocusedTabCloseTarget = useCallback(
    () =>
      getSessionTabCloseTarget({
        focusRegion: desktopTabFocusRegionRef.current,
        sidePanelOpen: isSidebarVisible,
        activeSidePanelTabId,
        activeConversationTabId: activeTabSessionId,
        parentConversationTabId: sessionId,
        conversationTabCount: orderedSessionTabIds.length,
      }),
    [
      activeSidePanelTabId,
      activeTabSessionId,
      isSidebarVisible,
      orderedSessionTabIds.length,
      sessionId,
    ]
  );

  useDesktopTabCloser(
    () => {
      const target = resolveFocusedTabCloseTarget();
      if (!target) return 'handled';
      if (target.kind === 'landing') {
        handleBackToList();
        return 'handled';
      }
      if (target.kind === 'side-panel') {
        handleSidePanelTabClose(target.tabId);
        return 'handled';
      }
      void handleTabClose(target.tabId);
      return 'handled';
    },
    !isMobile && Boolean(activeSession)
  );

  useEffect(() => {
    if (
      activeSidebarTab !== null ||
      effectiveActiveSideSessionId !== null ||
      effectiveActiveViewerTabId !== null ||
      sidePanelTabs.length === 0
    ) {
      return;
    }
    selectSidePanelTab(sidePanelTabs.at(-1)?.id ?? null);
  }, [
    activeSidebarTab,
    effectiveActiveSideSessionId,
    effectiveActiveViewerTabId,
    selectSidePanelTab,
    sidePanelTabs,
  ]);

  // Mobile diff viewers still replace the conversation surface. File viewers
  // open in their own drawer and therefore never hide the conversation.
  const hasActiveViewerTab =
    effectiveActiveViewerTabId !== null && (!isMobile || activeViewerTab?.type !== 'file');
  const mobileSkipTargetId = getSessionDetailSkipTargetId(hasActiveViewerTab);

  /* ── Mobile tab-switcher sheet (replaces the mobile SessionTabBar) ──
     All hooks live here (above the `if (isMobile)` early return) and after
     every dependency they read (orderedSessionTabIds, viewerTabItems, PR /
     browser state, live status). */
  const [mobileTabSheetOpen, setMobileTabSheetOpen] = useState(false);
  const [mobileMenuSheetOpen, setMobileMenuSheetOpen] = useState(false);
  useEffect(() => {
    if (mobileMenuSheetOpen && activeTabSession) {
      void resolveForkWorktreeAvailability(activeTabSession);
    }
  }, [activeTabSession, mobileMenuSheetOpen, resolveForkWorktreeAvailability]);
  // Reactive per-conversation live status. Rules-of-hooks forbids calling
  // useAtomValue per tab in a map, so read them all through ONE derived atom
  // keyed on the (memoized) real-session id list (drafts have no live status).
  // The sheet needs the status TYPE, not just presence: a tab blocked on a
  // permission request must read as "needs you", not as one more spinner.
  const conversationSessionIds = useMemo(
    () => orderedSessionTabIds.filter((id) => !isDraftSessionTabId(id)),
    [orderedSessionTabIds]
  );
  const conversationLiveStatusAtom = useMemo(
    () =>
      atom((get) => {
        const map: Record<string, SessionStatus | null> = {};
        for (const id of conversationSessionIds) {
          map[id] = get(sessionLiveStatusAtomFamily(id as SessionId));
        }
        return map;
      }),
    [conversationSessionIds]
  );
  const conversationLiveStatusMap = useAtomValue(conversationLiveStatusAtom);

  const mobileConversations = useMemo<ConversationTabEntry[]>(() => {
    const conversationTabActive = effectiveActiveViewerTabId == null;
    return orderedSessionTabIds.map((tabId) => {
      const meta =
        tabId === sessionId
          ? activeSession
          : (visibleChildSessions.find((s) => s.id === tabId) ?? null);
      const draft = meta ? null : (draftTabs.find((d) => d.id === tabId) ?? null);
      const lastMessageAt = typeof meta?.lastMessageAt === 'number' ? meta.lastMessageAt : null;
      const lastReadAt = typeof meta?.lastReadAt === 'number' ? meta.lastReadAt : null;
      const liveStatus = meta != null ? (conversationLiveStatusMap[tabId] ?? null) : null;
      return {
        id: tabId,
        title:
          meta?.title ||
          draft?.prompt?.split('\n')[0]?.trim() ||
          t('sessions.tabs.newTab', 'New Tab'),
        active: conversationTabActive && tabId === activeTabSessionId,
        main: tabId === sessionId,
        running: liveStatus != null,
        waitingPermission: liveStatus?.type === 'requestPermission',
        unread:
          meta != null &&
          lastMessageAt !== null &&
          (lastReadAt === null || lastMessageAt > lastReadAt),
        lastActivityAt: lastMessageAt,
      };
    });
  }, [
    orderedSessionTabIds,
    sessionId,
    activeSession,
    visibleChildSessions,
    draftTabs,
    activeTabSessionId,
    effectiveActiveViewerTabId,
    conversationLiveStatusMap,
    t,
  ]);

  const mobileViewers = useMemo<ViewerTabEntry[]>(() => {
    const list: ViewerTabEntry[] = [];
    /* Files leads the group and is unconditional: it is the mobile
       counterpart of the desktop Files side panel, and it is the only way
       to reach a file the conversation never mentioned. Availability is
       the browser's story to tell (loading / unavailable states), not a
       reason to hide the entry. */
    list.push({
      id: MOBILE_FILES_VIEWER_ID,
      label: t('sessions.detailTabs.files', 'Files'),
      kind: 'files',
      active: false,
    });
    if (activeBrowserSession) {
      list.push({
        id: MOBILE_BROWSER_VIEWER_ID,
        label: t('sessions.browser.title', 'Browser'),
        kind: 'browser',
        active: false,
      });
    }
    if (canShowGitHubActions && latestPr && latestPrNumber != null && latestPrRepoFullName) {
      list.push({
        id: MOBILE_PR_VIEWER_ID,
        label: `#${latestPrNumber}`,
        kind: 'pr',
        active: false,
      });
    }
    for (const v of viewerTabItems) {
      list.push({
        id: v.id,
        label: v.label,
        kind: v.type,
        active:
          v.type === 'file'
            ? mobileFileViewerOpen && mobileFileViewerTabId === v.id
            : effectiveActiveViewerTabId === v.id,
      });
    }
    return list;
  }, [
    canShowGitHubActions,
    latestPr,
    latestPrNumber,
    latestPrRepoFullName,
    activeBrowserSession,
    viewerTabItems,
    effectiveActiveViewerTabId,
    mobileFileViewerOpen,
    mobileFileViewerTabId,
    t,
  ]);

  // Archived child conversations for the tab sheet's collapsed Archived group
  // (most recent activity first, mirroring the desktop archived-tabs popover).
  const mobileArchivedConversations = useMemo(
    () =>
      archivedChildSessions
        .map((archivedSession) => {
          const lastMessageAt =
            typeof archivedSession.lastMessageAt === 'number'
              ? archivedSession.lastMessageAt
              : null;
          const createdAtMs = Date.parse(archivedSession.createdAt);
          return {
            id: archivedSession.id as string,
            title: archivedSession.title ?? '',
            lastActivityAt: lastMessageAt ?? (Number.isFinite(createdAtMs) ? createdAtMs : null),
          };
        })
        .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0)),
    [archivedChildSessions]
  );

  // Restore an archived conversation from the tab sheet and switch to it.
  const handleMobileRestoreConversation = useCallback(
    (id: string) => {
      void (async () => {
        await handleTabRestore(id as SessionId);
        handleSessionTabSelect(id as SessionId);
      })();
    },
    [handleTabRestore, handleSessionTabSelect]
  );

  const handleMobileViewerSelect = useCallback(
    (id: string) => {
      if (id === MOBILE_PR_VIEWER_ID) {
        if (latestPrNumber != null && latestPrRepoFullName) {
          handleOpenPrTab({
            prNumber: latestPrNumber,
            repoFullName: latestPrRepoFullName,
            headCommitSha: getSessionPullRequestLegacyFields(latestPr).headCommitSha,
          });
        }
        return;
      }
      if (id === MOBILE_BROWSER_VIEWER_ID) {
        if (activeBrowserSession) handleOpenBrowser(activeBrowserSession.id);
        return;
      }
      if (id === MOBILE_FILES_VIEWER_ID) {
        setMobileFilesBrowserOpen(true);
        return;
      }
      const viewerTab = viewerTabs.find((tab) => tab.id === id);
      if (viewerTab?.type === 'file') {
        setActiveViewerTabId(null);
        setMobileFileViewerTabId(id);
        setMobileFileViewerOpen(true);
        return;
      }
      handleViewerTabSelect(id);
    },
    [
      latestPr,
      latestPrNumber,
      latestPrRepoFullName,
      activeBrowserSession,
      handleOpenPrTab,
      handleOpenBrowser,
      handleViewerTabSelect,
      viewerTabs,
    ]
  );

  const visibleMachineIds = useMemo(
    () => new Set(sharingMachineAccessById.keys()),
    [sharingMachineAccessById]
  );
  const visibleLocalProjectKeys = useMemo(
    () => new Set(sharingProjectAccessByKey.keys()),
    [sharingProjectAccessByKey]
  );

  const sessionPresenceState = useMemo(() => {
    const base = resolveSessionDetailPresenceState({
      hasActiveSession: activeSession !== null,
      docMetaCacheReady,
      runtimeInitializing,
      runtimeWorkspaceId: runtime?.workspaceId ?? null,
      currentWorkspaceId,
      controlConnectionState,
    });
    return resolveSessionDetailVisibilityState({
      baseState: base,
      session: activeSession,
      visibleMachineIds,
      visibleLocalProjectKeys,
      machineVisibilityLoading,
      localProjectVisibilityLoading,
      currentUserId: user?.id ?? null,
    });
  }, [
    activeSession,
    controlConnectionState,
    currentWorkspaceId,
    docMetaCacheReady,
    localProjectVisibilityLoading,
    machineVisibilityLoading,
    runtime?.workspaceId,
    runtimeInitializing,
    user?.id,
    visibleLocalProjectKeys,
    visibleMachineIds,
  ]);

  /* One compact line per SessionDetail render into the crash-report ring
     buffer (`session-render-trace.ts`): a React #185 report shows only where
     the nested-update limit tripped; this shows what oscillated. Consecutive
     identical lines collapse, so steady-state renders cost one repeat bump. */
  recordSessionRenderTrace(
    `detail s=${shortTraceId(sessionId)} tab=${urlTab ?? '∅'} active=${shortTraceId(
      activeTabSessionId
    )}${activeTabIsPendingChild ? '(pending)' : ''} children=[${visibleChildSessions
      .map((s) => shortTraceId(s.id))
      .join(',')}] side=${sideSessions.length} archived=${archivedChildSessions.length} drafts=${
      draftTabs.length
    } meta=${activeSession ? 'y' : 'n'} presence=${sessionPresenceState} ready=${
      docMetaCacheReady ? 'y' : 'n'
    }`
  );

  useEffect(() => {
    if (sessionPresenceState === 'loading') {
      return;
    }

    if (sessionPresenceState === 'not-found') {
      if (!fireDetailNotFoundOnce(sessionId)) {
        return;
      }
      capturePostHogEvent(postHog, 'session/detail_not_found', {
        workspace_id: currentWorkspaceId ?? null,
        session_id: sessionId,
        route_ready_ms: getDurationSinceMs(detailLoadStartMsRef.current),
        is_mobile: isMobile,
        runtime_initializing: runtimeInitializing,
        doc_meta_cache_ready: docMetaCacheReady,
      });
      return;
    }
  }, [
    currentWorkspaceId,
    docMetaCacheReady,
    fireDetailNotFoundOnce,
    isMobile,
    postHog,
    runtimeInitializing,
    sessionId,
    sessionPresenceState,
  ]);

  if (sessionPresenceState === 'loading') {
    return (
      <LoadingPlaceholder
        title={t('sessions.route.loadingTitle', 'Loading session')}
        description={t('sessions.route.loadingDescription', 'Preparing conversation history.')}
      />
    );
  }

  if (sessionPresenceState === 'not-found') {
    return <SessionNotFound onBack={handleBackToList} />;
  }

  if (!activeSession) {
    return (
      <LoadingPlaceholder
        title={t('sessions.route.loadingTitle', 'Loading session')}
        description={t('sessions.route.loadingDescription', 'Preparing conversation history.')}
      />
    );
  }

  if (activeSession.parentSessionId && activeSession.parentSessionId !== sessionId) {
    return null;
  }

  /* The URL names a child tab whose meta has not reached this replica yet
     (a just-promoted draft, or a tab still syncing from another device).
     The tab STAYS active — bouncing to the parent is exactly the bug this
     replaces — and this surface holds the space until its meta arrives. */
  const pendingChildTabSurface = activeTabIsPendingChild ? (
    <div className="absolute inset-0 flex h-full flex-col items-center justify-center gap-3">
      {showPendingChildTabState ? (
        <>
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {t('sessions.tabWaitingForSync', 'Waiting for this conversation to sync…')}
          </p>
          <Button variant="ghost" size="sm" onClick={() => handleSessionTabSelect(sessionId)}>
            {t('sessions.tabBackToMain', 'Back to main conversation')}
          </Button>
        </>
      ) : null}
    </div>
  ) : null;

  const deleteConfirmDialog = (
    <Dialog open={deleteConfirmOpen} onOpenChange={(open) => setDeleteConfirmOpen(open)}>
      <DialogContent className={cn(isMobile ? '' : 'max-w-sm')}>
        <DialogHeader>
          <DialogTitle>{t('archive.deleteConfirm.title', 'Delete permanently?')}</DialogTitle>
          <DialogDescription>
            {activeSession?.repoFullName
              ? t(
                  'archive.deleteConfirm.description.codeSession',
                  "This will delete the session and remove the session branch's worktree directory on your machine."
                )
              : t(
                  'archive.deleteConfirm.description.chatSession',
                  'This will permanently delete the chat session.'
                )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setDeleteConfirmOpen(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              void handleConfirmDeleteCurrentSession();
            }}
          >
            {t('archive.delete', 'Delete permanently')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const archiveConfirmDialog = (
    <Dialog open={archiveConfirmOpen} onOpenChange={setArchiveConfirmOpen}>
      <DialogContent
        className={cn(isMobile ? '' : 'max-w-sm')}
        // Focus the confirm button on open so Enter archives; Esc still cancels (Radix
        // default close-on-escape). Rejected onKeyDown-on-content: it double-fires when a
        // button already has focus.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          archiveConfirmButtonRef.current?.focus();
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('sessions.archiveConfirm.title', 'Archive chat?')}</DialogTitle>
          <DialogDescription>
            {t(
              'sessions.archiveConfirm.description',
              'This chat will move to the archive. You can restore it later.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => setArchiveConfirmOpen(false)}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            ref={archiveConfirmButtonRef}
            onClick={() => {
              setArchiveConfirmOpen(false);
              void handleArchiveActiveTab();
            }}
          >
            {t('sessions.archiveConfirm.confirm', 'Archive')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const worktreeForkObservers = Object.entries(pendingForks)
    .filter(
      ([, pending]) => pending.placement === 'worktree' && pending.phase === 'awaiting-history'
    )
    .map(([sourceSessionId, pending]) => (
      <PendingWorktreeForkObserver
        key={pending.targetSessionId}
        targetSessionId={pending.targetSessionId}
        onCompleted={() =>
          handleForkedConversationPrepared(sourceSessionId, pending.targetSessionId)
        }
        onFailed={(message) => {
          if (!takePendingFork(sourceSessionId, pending.targetSessionId)) return;
          toast.error(message);
        }}
      />
    ));

  const cancelDirtyFork = () => {
    const confirmation = dirtyForkConfirmation;
    setDirtyForkConfirmation(null);
    if (!confirmation) return;
    setPendingForks((current) => {
      const next = { ...current };
      delete next[confirmation.source.id];
      return next;
    });
  };

  const dirtyForkDialog = (
    <Dialog
      open={dirtyForkConfirmation !== null}
      onOpenChange={(open) => {
        if (!open) cancelDirtyFork();
      }}
    >
      <DialogContent className={cn(isMobile ? '' : 'max-w-md')}>
        <DialogHeader>
          <DialogTitle>{t('sessions.forkDirty.title', 'Uncommitted changes found')}</DialogTitle>
          <DialogDescription>
            {t(
              'sessions.forkDirty.description',
              'The new worktree starts from the latest committed HEAD. Uncommitted and untracked files will not be copied.'
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={cancelDirtyFork}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button
            onClick={() => {
              const confirmation = dirtyForkConfirmation;
              setDirtyForkConfirmation(null);
              if (!confirmation) return;
              void handleForkAssistant(confirmation.source, confirmation.turnId, 'worktree', {
                targetSessionId: confirmation.targetSessionId,
                acknowledgeDirtySource: true,
              });
            }}
          >
            {t('sessions.forkDirty.confirm', 'Continue from committed HEAD')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  const fileQuickOpenDialog = (
    <SessionFileQuickOpen
      open={isFileQuickOpenOpen}
      onOpenChange={handleFileQuickOpenChange}
      provider={activeSessionFileProvider}
      providerPending={activeSessionFileProviderPending}
      providerMessage={activeSessionFileProviderMessage}
      fallbackPaths={changeFilePaths}
      onOpenFile={handleOpenIndexedFile}
    />
  );

  const renderViewerTabContent = (tab: ViewerTab, className = 'h-full', active = true) =>
    tab.type === 'file' ? (
      <SessionFileContentView
        key={`${activeSession.id}:${tab.id}`}
        sessionId={activeSession.id}
        session={activeSession}
        filePath={tab.filePath}
        {...(tab.fileId === undefined ? {} : { fileId: tab.fileId })}
        startLine={tab.startLine}
        endLine={tab.endLine}
        focusRequestSeq={tab.focusRequestSeq}
        htmlPreviewRequestSeq={tab.htmlPreviewRequestSeq}
        saveRequestSeq={viewerTabSaveStates[tab.id]?.saveRequestSeq ?? 0}
        copyMarkdownRequestSeq={viewerTabSaveStates[tab.id]?.copyMarkdownRequestSeq ?? 0}
        preferNativeMarkdownSelection={isMobile}
        fileProvider={activeSessionFileProvider}
        fileProviderPending={activeSessionFileProviderPending}
        fileProviderMessage={activeSessionFileProviderMessage}
        active={active}
        {...(activeSessionCodeCollabFiles.role === undefined
          ? {}
          : { fileProviderRole: activeSessionCodeCollabFiles.role })}
        onSaveStateChange={(state) => handleViewerTabSaveStateChange(tab.id, state)}
        visualAnnotationReferenceKeys={
          visualAnnotationReferenceKeysBySession[activeSession.id] ??
          EMPTY_VISUAL_ANNOTATION_REFERENCE_KEYS
        }
        onAddVisualAnnotationToChat={(reference) =>
          handleAddPreviewAnnotationToChat(activeSession.id, reference)
        }
        onToggleVisualAnnotationInChat={(reference) =>
          handleTogglePreviewAnnotationInChat(activeSession.id, reference)
        }
        onOpenFile={(target) => {
          // The LSP locator travels as structured fields, never encoded into
          // the path. Round-tripping it through a `:L<line>` suffix meant the
          // path had to be re-parsed, and a filename that legitimately ends in
          // `:<digits>` lost its tail. The viewer scrolls by line, so the
          // column has nowhere to go and is dropped here rather than encoded.
          handleOpenFile(target.filePath, {
            pathKind: 'canonical',
            // Was reported as `markdown_link` only because the locator used to
            // ride in the path as a `:L<n>` suffix; name the real source now.
            source: 'lsp',
            ...(target.line === undefined ? {} : { startLine: target.line + 1 }),
          });
        }}
        className={className}
      />
    ) : (
      <SessionConversationDiffPanel
        sessionId={activeSession.id}
        turnId={tab.turnId}
        filePaths={tab.filePaths}
        focusFilePath={tab.focusFilePath}
        focusComment={tab.focusComment}
        focusRequestSeq={tab.focusRequestSeq}
        mode={tab.mode ?? 'conversation'}
        refreshToken={(tab.mode ?? 'conversation') === 'base' ? allChangesRefreshToken : undefined}
        fileDiffs={(tab.mode ?? 'conversation') === 'base' ? [] : resolveTurnFileDiffs(tab.turnId)}
        fileDiffsPending={!sessionDiffReady}
        session={activeSession}
        workspaceSession={workspaceOwnerSession}
        onSendToChat={handleAddCommentReferenceToActiveChatInput}
        commentReferenceKeys={activeCommentReferenceKeys}
        fileProvider={
          (tab.mode ?? 'conversation') === 'base' ||
          canOpenHistoricalDiffs ||
          activeSessionFileProviderRequested
            ? activeSessionFileProvider
            : null
        }
        fileProviderPending={
          (tab.mode ?? 'conversation') === 'base' ||
          canOpenHistoricalDiffs ||
          activeSessionFileProviderRequested
            ? activeSessionFileProviderPending
            : false
        }
        onOpenFile={handleOpenFileFromDiff}
        className={className}
      />
    );

  // Mobile layout
  if (isMobile) {
    const handleMobileSessionBack = () => {
      if (onMobileBack) {
        onMobileBack();
      } else if (workspaceSlug) {
        void router.navigate({
          to: '/$workspaceName/chat',
          params: { workspaceName: workspaceSlug },
        });
      }
    };

    // "…" menu sheet content (replaces the old dropdown; a flat sheet so the
    // Copy submenu can't overflow narrow screens). Info block first (machine +
    // branches / path — tap to copy), then the flat action list.
    const mobileMenuInfoRows: MobileSessionMenuInfoRow[] = [];
    if (sessionMachine?.name) {
      mobileMenuInfoRows.push({
        id: 'machine',
        icon: <Monitor className="h-3.5 w-3.5" />,
        label: t('chat.mobileNewChat.machineLabel', 'Machine'),
        value: sessionMachine.name,
      });
    }
    if (mobileBranchInfo.showBranchInfo) {
      if (mobileBranchInfo.baseBranch) {
        mobileMenuInfoRows.push({
          id: 'base-branch',
          icon: <GitBranch className="h-3.5 w-3.5" />,
          label: t('sessions.baseBranch', 'Base branch'),
          value: mobileBranchInfo.baseBranch,
          onCopy: () =>
            handleCopyText(
              mobileBranchInfo.baseBranch,
              t('sessions.baseBranchCopied', 'Base branch name copied to clipboard')
            ),
        });
      }
      if (
        mobileBranchInfo.currentBranch &&
        mobileBranchInfo.currentBranch !== mobileBranchInfo.baseBranch
      ) {
        mobileMenuInfoRows.push({
          id: 'current-branch',
          icon: <GitBranch className="h-3.5 w-3.5" />,
          label: t('sessions.currentBranch', 'Current branch'),
          value: mobileBranchInfo.currentBranch,
          onCopy: () =>
            handleCopyText(
              mobileBranchInfo.currentBranch,
              t('sessions.currentBranchCopied', 'Current branch name copied to clipboard')
            ),
        });
      }
    } else if (mobileBranchInfo.localPath) {
      mobileMenuInfoRows.push({
        id: 'project-path',
        icon: <Folder className="h-3.5 w-3.5" />,
        label: t('sessions.projectPath', 'Project path'),
        value: mobileBranchInfo.localPath,
        onCopy: () =>
          handleCopyText(
            mobileBranchInfo.localPath,
            t('sessions.projectPathCopied', 'Project path copied to clipboard')
          ),
      });
    }
    if (activeSessionSharing) {
      mobileMenuInfoRows.push({
        id: 'visibility',
        icon:
          activeSessionSharing.visibility === 'team' ? (
            <Users className="h-3.5 w-3.5" />
          ) : activeSessionSharing.visibility === 'private' ? (
            <LockKeyhole className="h-3.5 w-3.5" />
          ) : (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ),
        label: t('sessions.sharing.visibility', 'Visibility'),
        value: `${getSessionSharingLabel(t, activeSessionSharing)} — ${getSessionSharingDescription(t, activeSessionSharing)}`,
      });
    }

    const mobileMenuActions: MobileSessionMenuAction[] = [];
    if (!activeDraftTab) {
      mobileMenuActions.push({
        id: 'find',
        icon: <Search className="h-3.5 w-3.5" />,
        label: t('sessions.findInConversation', 'Find in session'),
        onClick: handleOpenSearch,
      });
    }
    if (!activeSession?.isArchived) {
      if (!activeDraftTab && activeTabSession && canForkSession(activeTabSession)) {
        const pendingFork = pendingForks[activeTabSession.id];
        const worktreeAvailability = getForkWorktreeAvailability(activeTabSession);
        if (worktreeAvailability === 'hidden') {
          mobileMenuActions.push({
            id: 'fork',
            icon: pendingFork ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <GitFork className="h-3.5 w-3.5" />
            ),
            label: t('sessions.forkSession', 'Fork session'),
            onClick: handleForkCurrentSession,
            disabled: pendingFork !== undefined,
          });
        } else {
          for (const option of getSessionForkDestinationOptions(t, worktreeAvailability)) {
            mobileMenuActions.push({
              id: `fork-${option.id}`,
              icon:
                option.id === 'new-worktree' ? (
                  <WorktreeIcon className="h-3.5 w-3.5" />
                ) : (
                  <Folder className="h-3.5 w-3.5" />
                ),
              label: option.label,
              onClick: () => handleForkCurrentSession(option.id),
              disabled: pendingFork !== undefined || option.disabled,
            });
          }
        }
      }
      mobileMenuActions.push({
        id: 'rename',
        icon: <Pencil className="h-3.5 w-3.5" />,
        label: t('sidebar.renameChat.title', 'Rename Chat'),
        onClick: () =>
          setRenameDialogTarget({
            sessionId: activeSession.id,
            initialTitle: activeSession.title ?? '',
          }),
      });
    }
    mobileMenuActions.push(
      {
        id: 'copy-path',
        icon: <Copy className="h-3.5 w-3.5" />,
        label: t('sessions.copyPath', 'Copy path'),
        onClick: () =>
          handleCopyText(
            activeSessionWorkspacePath ?? '',
            t('sessions.workspacePathCopied', 'Session workspace path copied to clipboard')
          ),
        disabled: !activeSessionWorkspacePath,
        separatorBefore: true,
      },
      {
        id: 'copy-md',
        icon: <FileText className="h-3.5 w-3.5" />,
        label: t('sessions.copyAsMarkdown', 'Copy as Markdown'),
        onClick: () => handleCopyConversationHistory(),
        disabled: !!activeDraftTab,
      }
    );
    mobileMenuActions.push({
      id: 'copy-url',
      icon: <Link className="h-3.5 w-3.5" />,
      label: t('sessions.copyUrl', 'Copy URL'),
      onClick: () => {
        void handleCopyUrl();
      },
    });
    // Copy URL stays available for private sessions (the link still works for
    // the owner); sharing is a separate action shown only while the
    // conversation isn't team-visible.
    if (activeSessionSharing && activeSessionSharing.visibility !== 'team') {
      mobileMenuActions.push({
        id: 'share-with-team',
        icon:
          activeSessionSharing.visibility === 'unknown' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : activeSessionSharing.privateReason === 'machine-not-registered' ? (
            <Monitor className="h-3.5 w-3.5" />
          ) : activeSessionSharing.canManage ? (
            <Users className="h-3.5 w-3.5" />
          ) : (
            <LockKeyhole className="h-3.5 w-3.5" />
          ),
        label:
          activeSessionSharing.visibility === 'unknown'
            ? t('sessions.sharing.loadingAction', 'Checking sharing…')
            : activeSessionSharing.privateReason === 'machine-not-registered'
              ? t('sessions.sharing.registerDeviceToShare', 'Register this device before sharing')
              : activeSessionSharing.canManage
                ? t('sessions.sharing.shareWithTeam', 'Share with team…')
                : t('sessions.sharing.onlyOwnerCanShare', 'Only the device owner can share'),
        onClick: () => {
          handleRequestShareSession(activeSession);
        },
        disabled:
          activeSessionSharing.visibility === 'unknown' ||
          activeSessionSharing.privateReason === 'machine-not-registered' ||
          (activeSessionSharing.visibility === 'private' && !activeSessionSharing.canManage),
      });
    }
    if (activeSession?.isArchived) {
      mobileMenuActions.push(
        {
          id: 'restore',
          icon: <ArchiveRestore className="h-3.5 w-3.5" />,
          label: t('archive.restore', 'Restore session'),
          onClick: () => {
            void handleRestoreCurrentSession();
          },
          separatorBefore: true,
        },
        {
          id: 'delete',
          icon: <Trash2 className="h-3.5 w-3.5" />,
          label: t('archive.delete', 'Delete permanently'),
          onClick: () => handleRequestDeleteCurrentSession(),
          destructive: true,
        }
      );
    } else {
      mobileMenuActions.push({
        id: 'archive',
        icon: <Archive className="h-3.5 w-3.5" />,
        label: t('sessions.archive', 'Archive session'),
        onClick: () => {
          void handleArchiveActiveTab();
        },
        separatorBefore: true,
      });
    }

    // Floating frosted header: absolutely positioned over the conversation so
    // content scrolls UNDER it and gets frosted by the backdrop blur. The
    // conversation scroll + viewer panels read `--conversation-top-inset` so
    // their content clears the header at rest (see ai-gui/view.tsx VList).
    const mobileHeaderInset = isNativeAppShell()
      ? 'calc(3rem + var(--safe-area-top, 0px))'
      : '3rem';
    return (
      // The slide / swipe-to-dismiss and the base layer beneath are owned by
      // `MobileWorkspaceStack` (this renders inside its Vaul right-drawer), so
      // here we only need the session's own flex column.
      <div
        className="relative flex h-full flex-col bg-background"
        style={{ '--conversation-top-inset': mobileHeaderInset } as CSSProperties}
      >
        <BaseHeader
          truncateTitle={false}
          hideMenuButton
          className="absolute inset-x-0 top-0 z-30 border-b-0 bg-background/55 backdrop-blur-xl"
          style={{ height: mobileHeaderInset, paddingTop: 'var(--safe-area-top, 0px)' }}
          leading={<MobileSessionHeaderBackButton onBack={handleMobileSessionBack} />}
          title={
            <MobileProjectInfo
              session={activeSession}
              localProjectMeta={resolvedLocalProjectMeta}
              isSyncing={activeSessionDocIsSyncing}
            />
          }
          actions={
            /* Extra -mr beyond the 4px disc/hit-target offset: the large
               glass radius reads optically left of the hard right gutter
               (user avatar + composer), so nudge ~8px total. */
            <div className="-mr-2 flex shrink-0 items-center gap-1">
              {/* Files, PR, and Browser entries live in the mobile tab sheet
                  (mobileViewers), not the header. */}
              <MobileSessionTabButton
                hasUnread={hasBackgroundUnread(mobileConversations)}
                onOpen={() => setMobileTabSheetOpen(true)}
              />
              <GlassIconButton
                label={t('sessions.moreActions', 'More actions')}
                onClick={() => setMobileMenuSheetOpen(true)}
              >
                <Ellipsis className="h-5 w-5 text-current" strokeWidth={1.75} />
              </GlassIconButton>
            </div>
          }
        />
        <MobileSessionTabSheet
          open={mobileTabSheetOpen}
          onOpenChange={setMobileTabSheetOpen}
          conversations={mobileConversations}
          archivedConversations={mobileArchivedConversations}
          viewers={mobileViewers}
          onSelectConversation={handleSessionTabSelect}
          onNewConversation={handleNewTab}
          onSelectViewer={handleMobileViewerSelect}
          onRestoreConversation={handleMobileRestoreConversation}
        />
        <MobileSessionMenuSheet
          open={mobileMenuSheetOpen}
          onOpenChange={setMobileMenuSheetOpen}
          infoRows={mobileMenuInfoRows}
          actions={mobileMenuActions}
          owner={
            isMultiMemberWorkspace && !activeSession.isArchived
              ? {
                  members: workspaceMembers,
                  ownerUserId: activeSession.userId,
                  onSelect: (userId) => {
                    void handleTransferSessionOwner(activeSession.id, userId);
                  },
                }
              : undefined
          }
        />
        <div
          id={mobileSkipTargetId}
          role="main"
          tabIndex={-1}
          className="flex-1 overflow-hidden relative"
        >
          {/* Keep inactive tabs mounted for fast switching; only the active tab holds room sync. */}
          {[activeSession, ...visibleChildSessions].map((tabSession) => {
            const isActive = !hasActiveViewerTab && tabSession.id === activeTabSessionId;
            const pendingForkSourceId = pendingForkSourceByTargetSessionId.get(tabSession.id);
            const externalHistoryRefresh = externalHistoryRefreshBySessionId[tabSession.id];
            const externalHistoryProviderLabel = externalHistoryRefresh
              ? getExternalHistoryProviderLabel(externalHistoryRefresh.provider)
              : undefined;
            return (
              <div
                key={tabSession.id}
                className={isActive ? 'h-full' : 'hidden h-full'}
                aria-hidden={!isActive}
              >
                <SessionChatInterface
                  ref={(el) => setChatTabRef(tabSession.id, el)}
                  claimNavigationFocus={
                    isActive && tabSession.id === sessionId ? claimNavigationFocus : undefined
                  }
                  session={tabSession}
                  workspaceSession={activeSession}
                  className="h-full"
                  hideHeader
                  syncEnabled={isActive || pendingForkSourceId !== undefined}
                  isVisible={isActive}
                  isChildTab={tabSession.id !== sessionId}
                  isExternalHistoryRefreshing={externalHistoryRefresh !== undefined}
                  externalHistoryProviderLabel={externalHistoryProviderLabel}
                  messageFileDiffEntriesByTurn={
                    tabSession.id === activeSessionTabId ? messageFileDiffEntriesByTurn : undefined
                  }
                  onFileDiffClick={handleOpenFileDiffMobileForChat}
                  onFilePathClick={handleOpenFile}
                  onOpenHtmlFile={handleOpenHtmlFile}
                  onNavigateToComment={handleNavigateToCommentMobile}
                  onCommentReferencesChange={getCommentReferencesChangeHandler(tabSession.id)}
                  onVisualAnnotationReferencesChange={getVisualAnnotationReferencesChangeHandler(
                    tabSession.id
                  )}
                  onVisualAnnotationReferencesSubmitted={getVisualAnnotationReferencesSubmittedHandler(
                    tabSession.id
                  )}
                  onOpenPrTab={handleOpenPrTab}
                  onOpenAllChanges={handleOpenAllChanges}
                  onOpenBrowser={() => handleOpenBrowser(tabSession.id, true)}
                  onOpenExistingBrowser={() => handleOpenBrowser(tabSession.id, false)}
                  changesDiffStat={changesDiffStat}
                  onForkLastAssistant={
                    canForkSession(tabSession)
                      ? (turnId, destination) =>
                          handleForkDestination(tabSession, turnId, destination)
                      : undefined
                  }
                  forkWorktreeAvailability={getForkWorktreeAvailability(tabSession)}
                  forkingAssistantMessageId={pendingForks[tabSession.id]?.turnId}
                  onNavigateSession={handleNavigateSession}
                  onConversationPrepared={
                    pendingForkSourceId
                      ? () => handleForkedConversationPrepared(pendingForkSourceId, tabSession.id)
                      : undefined
                  }
                  onConversationPrepareError={
                    pendingForkSourceId
                      ? () =>
                          handleForkedConversationPrepareError(pendingForkSourceId, tabSession.id)
                      : undefined
                  }
                />
              </div>
            );
          })}
          {draftTabs.map((draft) => {
            const isActive = !hasActiveViewerTab && draft.id === activeTabSessionId;
            return (
              <div
                key={draft.id}
                className={isActive ? 'h-full' : 'hidden h-full'}
                aria-hidden={!isActive}
              >
                <DraftSessionChatInterface
                  ref={(el) => setChatTabRef(draft.id, el)}
                  draft={draft}
                  parentSession={activeSession}
                  commandsEnabled={isActive}
                  onDraftChange={handleDraftChange}
                  onSendDraft={handleSendDraft}
                  onCommentReferencesChange={getCommentReferencesChangeHandler(draft.id)}
                />
              </div>
            );
          })}
          {!hasActiveViewerTab ? pendingChildTabSurface : null}
          {/* Viewer content — shown when a viewer tab is active (mobile). Solid
              top padding (not scroll-under) so viewer toolbars clear the
              floating frosted header. */}
          {viewerTabs
            .filter((tab) => tab.type !== 'file')
            .map((tab) => {
              const isActive = tab.id === effectiveActiveViewerTabId;
              return (
                <div
                  key={tab.id}
                  className={isActive ? 'h-full' : 'hidden h-full'}
                  style={{ paddingTop: 'var(--conversation-top-inset, 0px)' }}
                  aria-hidden={!isActive}
                >
                  {renderViewerTabContent(tab, 'h-full', isActive)}
                </div>
              );
            })}
        </div>

        {/* Mobile diff sheet */}
        <Sheet
          open={mobileDiffState !== null}
          onOpenChange={(open) => !open && handleCloseMobileDiff()}
        >
          <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
            <SheetHeader className="shrink-0 border-b border-border px-4 py-3">
              <SheetTitle className="text-sm font-medium">
                {t('sessions.diffTab', 'Changes')}
              </SheetTitle>
            </SheetHeader>
            <div className="flex-1 min-h-0 overflow-hidden">
              {mobileDiffState && (
                <SessionConversationDiffPanel
                  sessionId={activeSession.id}
                  turnId={mobileDiffState.turnId}
                  filePaths={mobileDiffState.filePaths}
                  focusFilePath={mobileDiffState.focusFilePath}
                  focusComment={mobileDiffState.focusComment}
                  focusRequestSeq={mobileDiffState.focusRequestSeq}
                  mode={mobileDiffState.mode ?? 'conversation'}
                  refreshToken={
                    (mobileDiffState.mode ?? 'conversation') === 'base'
                      ? allChangesRefreshToken
                      : undefined
                  }
                  fileDiffs={
                    (mobileDiffState.mode ?? 'conversation') === 'base'
                      ? []
                      : resolveTurnFileDiffs(mobileDiffState.turnId)
                  }
                  fileDiffsPending={!sessionDiffReady}
                  session={activeSession}
                  workspaceSession={workspaceOwnerSession}
                  onSendToChat={handleAddCommentReferenceToActiveChatInput}
                  commentReferenceKeys={activeCommentReferenceKeys}
                  fileProvider={
                    (mobileDiffState.mode ?? 'conversation') === 'base' ||
                    canOpenHistoricalDiffs ||
                    activeSessionFileProviderRequested
                      ? activeSessionFileProvider
                      : null
                  }
                  fileProviderPending={
                    (mobileDiffState.mode ?? 'conversation') === 'base' ||
                    canOpenHistoricalDiffs ||
                    activeSessionFileProviderRequested
                      ? activeSessionFileProviderPending
                      : false
                  }
                  onOpenFile={handleOpenFileFromDiff}
                  className="h-full"
                />
              )}
            </div>
          </SheetContent>
        </Sheet>
        {viewerTabs
          .filter((tab): tab is Extract<ViewerTab, { type: 'file' }> => tab.type === 'file')
          .map((tab) => {
            const open = mobileFileViewerOpen && mobileFileViewerTabId === tab.id;
            return (
              <MobileFileViewerDrawer
                key={tab.id}
                open={open}
                onOpenChange={(nextOpen) => {
                  if (mobileFileViewerTabId === tab.id) {
                    setMobileFileViewerOpen(nextOpen);
                  }
                }}
                filePath={tab.filePath}
                onCopyPath={() =>
                  handleCopyText(
                    tab.filePath,
                    t('sessions.fileViewer.pathCopied', 'File path copied')
                  )
                }
                onCopyMarkdown={
                  isSessionMarkdownPath(tab.filePath)
                    ? () => {
                        setViewerTabSaveStates((prev) => {
                          const previous = prev[tab.id] ?? EMPTY_VIEWER_TAB_SAVE_STATE;
                          return {
                            ...prev,
                            [tab.id]: {
                              ...previous,
                              copyMarkdownRequestSeq: previous.copyMarkdownRequestSeq + 1,
                            },
                          };
                        });
                      }
                    : undefined
                }
              >
                {renderViewerTabContent(tab, 'h-full', open)}
              </MobileFileViewerDrawer>
            );
          })}
        {/* Mobile Files full-screen drawer — the counterpart of the desktop
           Files side panel, which the mobile branch never renders. Opened from
           the tab sheet's Files viewer entry.

           Back layering (deliberate, and it falls out of the z-indexes): inside
           a folder the browser mounts its own edge zone at z-60, so an edge
           swipe pops one directory level; at the root it mounts none, leaving
           only `VaulDrawerBody`'s z-30 strip, so the same gesture closes the
           drawer. That is the iOS drill-out order — keep the two z values apart
           if either zone moves.

           Files open through `handleOpenFile` (the browser's `onOpenFile`
           delegate) rather than the browser's built-in preview, so a file
           reached from the tree lands in the same viewer tab — with save, LSP
           and tab persistence — as one tapped in the conversation. */}
        <Drawer
          direction="right"
          repositionInputs={isNativeAppShell()}
          open={mobileFilesBrowserOpen}
          onOpenChange={setMobileFilesBrowserOpen}
        >
          <DrawerContent
            className="w-full! max-w-none! inset-0 border-0 border-l-0! rounded-none"
            data-sidebar-swipe-open-disabled
          >
            <DrawerTitle className="sr-only">{t('sessions.detailTabs.files', 'Files')}</DrawerTitle>
            <VaulDrawerBody topInset={MOBILE_DRAWER_HEADER_INSET}>
              <div className="flex h-full flex-col">
                <header className="flex h-[calc(3.5rem+var(--safe-area-top))] shrink-0 items-center gap-2 border-b border-border px-3 pt-[var(--safe-area-top)]">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className={getSessionDetailTouchIconButtonClassName('-ml-1')}
                    /* Same order as the edge swipe: pop a directory level
                       first, close the drawer only at the root. */
                    onClick={() => {
                      if (mobileFilesBrowserRef.current?.canGoBack()) {
                        mobileFilesBrowserRef.current.goBack();
                        return;
                      }
                      setMobileFilesBrowserOpen(false);
                    }}
                    aria-label={t('common.back', 'Back')}
                  >
                    <ArrowLeft className="h-4 w-4" />
                  </Button>
                  <span className="min-w-0 flex-1 truncate text-sm font-medium">
                    {t('sessions.detailTabs.files', 'Files')}
                  </span>
                </header>
                <div className="relative min-h-0 flex-1">
                  <MobileProjectFileBrowser
                    ref={mobileFilesBrowserRef}
                    provider={activeSessionFileProvider}
                    pending={activeSessionFileProviderPending}
                    message={activeSessionFileProviderMessage}
                    onOpenFile={(filePath) => {
                      setMobileFilesBrowserOpen(false);
                      handleOpenIndexedFile(filePath);
                    }}
                    /* No bottom tab bar over this drawer — only the safe area
                       needs clearing. */
                    bottomTabBarVisible={false}
                  />
                </div>
              </div>
            </VaulDrawerBody>
          </DrawerContent>
        </Drawer>
        {/* Mobile PR full-screen drawer. Edge-only interactive back: Vaul drives
           the drag but only from the left-edge zone (the body is wrapped in
           `data-vaul-no-drag`), so PR diffs scroll horizontally without dragging
           the drawer toward dismissal. The zone clears the fixed header so the
           back button stays tappable. See mobile-workspace-stack.tsx. */}
        {/* repositionInputs is platform-scoped: off on mobile web (vaul captures
           the shrunk viewport and never restores it, #2761), on natively where the
           keyboard overlays the content and vaul is what lifts/restores inputs.
           See mobile-workspace-stack.tsx + context/mobile-keyboard.md. */}
        <Drawer
          direction="right"
          repositionInputs={isNativeAppShell()}
          open={Boolean(urlPrNumber && latestPr && repoFullName && urlPrNumber === latestPrNumber)}
          onOpenChange={(open) => {
            if (!open) handleClosePrTab();
          }}
        >
          <DrawerContent
            className="w-full! max-w-none! inset-0 border-0 border-l-0! rounded-none"
            data-sidebar-swipe-open-disabled
          >
            <DrawerTitle className="sr-only">
              {t('sessions.detailTabs.pullRequest', 'Pull Request')}
            </DrawerTitle>
            <VaulDrawerBody topInset={MOBILE_DRAWER_HEADER_INSET}>
              {latestPr && repoFullName && urlPrNumber === latestPrNumber && latestPrNumber && (
                <PrTabContainer
                  repoFullName={latestPrRepoFullName}
                  prNumber={latestPrNumber}
                  headCommitSha={getSessionPullRequestLegacyFields(latestPr).headCommitSha}
                  onResolvedPrStatus={reconcilePersistedPrStatus}
                  className="h-full"
                  leadingSlot={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={getSessionDetailTouchIconButtonClassName('-ml-1')}
                      onClick={handleClosePrTab}
                      aria-label={t('common.back', 'Back')}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                  }
                />
              )}
            </VaulDrawerBody>
          </DrawerContent>
        </Drawer>
        {/* Mobile Browser full-screen drawer — same stack as session ↔ PR:
           right-sliding Vaul surface over the conversation, edge-swipe / back
           to reveal the layer beneath. Do NOT portal a sibling `fixed z-50`
           panel to `document.body`: the session itself is already a Vaul
           drawer at the same z-index, so the browser ends up underneath the
           conversation (invisible until the session drawer closes and flashes
           a few frames). Managed preview iframes survive remount via
           `managed-preview-frame-cache.ts`. */}
        {/* repositionInputs is platform-scoped: off on mobile web (vaul captures
           the shrunk viewport and never restores it, #2761), on natively where the
           keyboard overlays the content and vaul is what lifts/restores inputs.
           See mobile-workspace-stack.tsx + context/mobile-keyboard.md. */}
        <Drawer
          direction="right"
          repositionInputs={isNativeAppShell()}
          open={Boolean(urlBrowser && activeBrowserSession)}
          onOpenChange={(open) => {
            if (!open) handleCloseBrowserTab();
          }}
        >
          <DrawerContent
            className="w-full! max-w-none! inset-0 border-0 border-l-0! rounded-none"
            data-sidebar-swipe-open-disabled
          >
            <DrawerTitle className="sr-only">{t('sessions.browser.title', 'Browser')}</DrawerTitle>
            <VaulDrawerBody topInset={MOBILE_DRAWER_HEADER_INSET}>
              {activeBrowserSession && (
                <SessionBrowserPanel
                  session={activeBrowserSession}
                  active={Boolean(urlBrowser)}
                  className="h-full"
                  candidateNavigationRequestId={
                    browserCandidateNavigationRequest?.sessionId === activeBrowserSession.id
                      ? browserCandidateNavigationRequest.id
                      : 0
                  }
                  onCandidateNavigationRequestHandled={
                    handleBrowserCandidateNavigationRequestHandled
                  }
                  visualAnnotationReferenceKeys={
                    visualAnnotationReferenceKeysBySession[activeBrowserSession.id] ??
                    EMPTY_VISUAL_ANNOTATION_REFERENCE_KEYS
                  }
                  onAddVisualAnnotationToChat={(reference) =>
                    handleAddPreviewAnnotationToChat(activeBrowserSession.id, reference)
                  }
                  onToggleVisualAnnotationInChat={(reference) =>
                    handleTogglePreviewAnnotationInChat(activeBrowserSession.id, reference)
                  }
                  leadingSlot={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className={getSessionDetailTouchIconButtonClassName('-ml-1')}
                      onClick={handleCloseBrowserTab}
                      aria-label={t('common.back', 'Back')}
                    >
                      <ArrowLeft className="h-4 w-4" />
                    </Button>
                  }
                />
              )}
            </VaulDrawerBody>
          </DrawerContent>
        </Drawer>
        {fileQuickOpenDialog}
        {deleteConfirmDialog}
        {archiveConfirmDialog}
        {dirtyForkDialog}
        {worktreeForkObservers}
        <SessionShareDialog
          open={showSessionSharing && pendingSessionShare != null}
          sessionTitle={
            pendingSessionShare?.session.title?.trim() || t('sessions.untitled', 'Untitled session')
          }
          state={showSessionSharing ? (pendingSessionShare?.sharing ?? null) : null}
          isSharing={isSharingSession}
          onOpenChange={(open) => {
            if (!open && !isSharingSession) setPendingSessionShare(null);
          }}
          onConfirm={() => {
            void handleConfirmSessionShare();
          }}
        />
        <RenameSessionDialog
          target={renameDialogTarget}
          onClose={() => setRenameDialogTarget(null)}
        />
      </div>
    );
  }

  // Traffic lights auto-hide in native fullscreen — no inset to reserve then.
  const hasMacOSTitlebarInset =
    !isNativeAppShell() && isMacOSElectronRenderer() && !isElectronFullscreen;

  const nonBrowserSidebarContent =
    activeSidebarTab === 'files' ? (
      <FileTreeView
        session={activeSession}
        handleOpenFile={handleOpenIndexedFile}
        fileProvider={activeSessionFileProvider}
        fileProviderPending={activeSessionFileProviderPending}
        fileProviderMessage={activeSessionFileProviderMessage}
        autoCodeCollab={false}
        fileMenuItems={activeSessionFileActions.menuItems}
        changedFilePaths={changeFilePaths}
        // Opening a file selects its viewer tab, which unmounts this tree. Key
        // its expanded folders per session so returning to Files restores them.
        viewStateKey={`session-files:${activeSession.id}`}
      />
    ) : activeSidebarTab === 'pr' && latestPr && repoFullName && latestPrNumber ? (
      <PrTabContainer
        repoFullName={latestPrRepoFullName}
        prNumber={latestPrNumber}
        headCommitSha={getSessionPullRequestLegacyFields(latestPr).headCommitSha}
        onResolvedPrStatus={reconcilePersistedPrStatus}
        className="bg-background"
        // The side panel stays mounted while collapsed, so GitHub polling has
        // to be paused explicitly — same signal SessionBrowserPanel takes.
        visible={isSidebarVisible}
      />
    ) : activeSidebarTab === 'changes' ? (
      <SessionChangesSidebar
        ready={sessionDiffReady}
        synced={sessionDiffSynced}
        unavailableMessage={sessionDiffUnavailableMessage}
        changeEntries={changeEntries}
        changeFilePaths={changeFilePaths}
        onOpenChangesDiff={handleOpenChangesDiff}
      />
    ) : null;

  // Keep the browser mounted while another sidebar tab is selected. Managed
  // pages retain DOM state and Electron's native view is only hidden, so tab
  // switching behaves like a browser rather than rebuilding the page.
  const sidebarContent = (
    <div className="relative h-full min-h-0">
      {activeBrowserSession && openedSidebarTabs.includes('browser') ? (
        <div
          className={cn(
            'absolute inset-0',
            activeSidebarTab !== 'browser' && 'invisible pointer-events-none'
          )}
          aria-hidden={activeSidebarTab !== 'browser'}
        >
          <SessionBrowserPanel
            session={activeBrowserSession}
            active={activeSidebarTab === 'browser' && isSidebarVisible}
            candidateNavigationRequestId={
              browserCandidateNavigationRequest?.sessionId === activeBrowserSession.id
                ? browserCandidateNavigationRequest.id
                : 0
            }
            onCandidateNavigationRequestHandled={handleBrowserCandidateNavigationRequestHandled}
            visualAnnotationReferenceKeys={
              visualAnnotationReferenceKeysBySession[activeBrowserSession.id] ??
              EMPTY_VISUAL_ANNOTATION_REFERENCE_KEYS
            }
            onAddVisualAnnotationToChat={(reference) =>
              handleAddPreviewAnnotationToChat(activeBrowserSession.id, reference)
            }
            onToggleVisualAnnotationInChat={(reference) =>
              handleTogglePreviewAnnotationInChat(activeBrowserSession.id, reference)
            }
          />
        </div>
      ) : null}
      {activeSidebarTab !== 'browser' ? (
        <div className="absolute inset-0">{nonBrowserSidebarContent}</div>
      ) : null}
    </div>
  );

  // Viewers and side chats render their own absolutely positioned surfaces on
  // top; the fixed-panel body only shows when neither owns the panel.
  const showFixedSidePanelBody =
    effectiveActiveViewerTabId === null && effectiveActiveSideSessionId === null;
  const defaultSizes = showFixedSidePanelBody
    ? { main: 75, sidebar: 25 }
    : { main: 60, sidebar: 40 };

  const sidebarToggleButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={handleToggleSidebar}
      aria-label={
        isSidebarVisible
          ? t('sessions.sidebar.hide', 'Hide sidebar')
          : t('sessions.sidebar.show', 'Show sidebar')
      }
      className={cn('h-7 w-7 shrink-0 text-muted-foreground', !isSidebarVisible && 'mr-[9px]')}
    >
      <PanelRight className="h-4 w-4" />
    </Button>
  );

  const leftSidebarExpandButton = isLeftSidebarHidden ? (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={() => showNavigationSidebar()}
      aria-label={t('sessions.leftSidebar.show', 'Show navigation sidebar')}
      className="h-7 w-7 shrink-0 text-muted-foreground"
    >
      <PanelLeft className="h-4 w-4" />
    </Button>
  ) : null;

  /* Right-side window controls for the merged top bar: the parent session's
     header toolbar (IDE launcher / preview / "…" menu) + the sidebar toggle.
     Rendered by SessionChatInterface (headerVariant="toolbar") so the menu
     keeps root-scoped presentation while selected-tab actions are delegated. */
  const desktopHeaderToolbar = (
    <SessionChatInterface
      session={activeSession}
      workspaceSession={activeSession}
      className="h-full shrink-0"
      headerVariant="toolbar"
      headerEndSlot={
        <>
          <TerminalDockToggleButton />
          {!isSidebarVisible ? sidebarToggleButton : null}
        </>
      }
      titleSyncing={activeSessionDocIsSyncing}
      hideMessageArea
      onArchiveSession={handleArchiveCurrentSession}
      onRestoreSession={handleRestoreCurrentSession}
      onDeleteSession={handleRequestDeleteCurrentSession}
      onOpenSearch={handleOpenSearch}
      onCopyConversationHistory={handleCopyConversationHistory}
      onRequestRename={!activeDraftTab ? handleRenameCurrentSession : undefined}
      onForkSession={
        !activeDraftTab && activeTabSession && canForkSession(activeTabSession)
          ? handleForkCurrentSession
          : undefined
      }
      forkWorktreeAvailability={
        activeTabSession ? getForkWorktreeAvailability(activeTabSession) : 'hidden'
      }
      onForkWorktreeMenuOpen={
        activeTabSession
          ? () => {
              void resolveForkWorktreeAvailability(activeTabSession);
            }
          : undefined
      }
      forkingAssistantMessageId={
        activeTabSession ? pendingForks[activeTabSession.id]?.turnId : null
      }
      sharing={activeSessionSharing ?? undefined}
      onShareWithTeam={
        showSessionSharing ? () => handleRequestShareSession(activeSession) : undefined
      }
      onOpenPrTab={handleOpenPrTab}
      onNavigateSession={handleNavigateSession}
      browserActionSession={activeBrowserSession}
      onOpenBrowser={() => {
        if (activeBrowserSession) {
          handleOpenBrowser(activeBrowserSession.id);
        }
      }}
    />
  );

  /* Single-row desktop top bar: [sidebar expand] [session tabs …] [toolbar].
     Replaces the old two-row header (repo title row + tab bar) — repo identity
     lives in the context strip above the composer and in the "…" menu. */
  const tabBar = (
    <SessionTabBar
      variant="session"
      parentSession={activeSession}
      childSessions={visibleChildSessions}
      draftTabs={draftTabs}
      tabOrder={sessionTabOrder}
      activeTabSessionId={activeTabSessionId}
      onTabSelect={handleSessionTabSelect}
      onNewTab={handleNewTab}
      onTabRename={handleTabRename}
      onTabClose={handleTabClose}
      archivedChildSessions={archivedChildSessions}
      onTabRestore={handleTabRestore}
      onTabReorder={handleSessionTabReorder}
      onMentionSession={handleInsertDroppedSessionMention}
      leftSlot={leftSidebarExpandButton}
      rightSlot={desktopHeaderToolbar}
      className={cn(
        // The macOS traffic lights sit over the LEFT sidebar (or, when it is
        // collapsed, over the horizontally-cleared `pl-[4.5rem]` gap below),
        // never over this top bar — so it must not reserve vertical inset.
        //
        // `mt-0.5`, not `mt-2`: the tab pills share a top border line with the
        // sidebar and side-panel cards, and both of those sit at `mt-2` (8px).
        // The h-8 pills are centered inside this h-11 row, so the row must start
        // 6px higher for them to land on that same line: 2 + (44 - 32) / 2 = 8.
        // Re-derive this if the row or the pill height changes.
        'mt-0.5 h-11',
        isLeftSidebarHidden && hasMacOSTitlebarInset && 'pl-[4.5rem]',
        !isSidebarVisible && windowsCaptionPadClass
      )}
    />
  );
  // Props every mounted conversation surface needs, whether it renders as a top
  // tab or as a right-panel side chat. Surface-specific props stay at the call
  // site so what each variant deliberately omits is visible there.
  const getSharedChatSurfaceProps = (
    chatSession: SessionMeta,
    isActive: boolean,
    // Selected is not the same as on screen: a side chat stays mounted while the
    // whole right panel is collapsed. Only a visible surface may clear unread.
    isVisible: boolean = isActive
  ) => {
    const pendingForkSourceId = pendingForkSourceByTargetSessionId.get(chatSession.id);
    return {
      ref: (element: SessionChatInterfaceHandle | null) => setChatTabRef(chatSession.id, element),
      claimNavigationFocus:
        isActive && chatSession.id === sessionId ? claimNavigationFocus : undefined,
      session: chatSession,
      workspaceSession: activeSession,
      className: 'h-full',
      hideHeader: true,
      syncEnabled: isActive || pendingForkSourceId !== undefined,
      isVisible,
      onFileDiffClick: handleOpenFileDiffForChat,
      onFilePathClick: handleOpenFile,
      onOpenHtmlFile: handleOpenHtmlFile,
      onOpenBrowser: () => handleOpenBrowser(chatSession.id, true),
      onOpenExistingBrowser: () => handleOpenBrowser(chatSession.id, false),
      onNavigateToComment: handleNavigateToComment,
      onCommentReferencesChange: getCommentReferencesChangeHandler(chatSession.id),
      onVisualAnnotationReferencesChange: getVisualAnnotationReferencesChangeHandler(
        chatSession.id
      ),
      onVisualAnnotationReferencesSubmitted: getVisualAnnotationReferencesSubmittedHandler(
        chatSession.id
      ),
      onOpenPrTab: handleOpenPrTab,
      onOpenAllChanges: handleOpenAllChanges,
      onNavigateSession: handleNavigateSession,
      onConversationPrepared: pendingForkSourceId
        ? () => handleForkedConversationPrepared(pendingForkSourceId, chatSession.id)
        : undefined,
      onConversationPrepareError: pendingForkSourceId
        ? () => handleForkedConversationPrepareError(pendingForkSourceId, chatSession.id)
        : undefined,
    };
  };

  const desktopChatSurfaces = (
    <SessionMentionDropLayer
      enabled
      excludeSessionId={sessionMentionExcludeId}
      onDropSessionId={handleInsertDroppedSessionMention}
    >
      {[activeSession, ...visibleChildSessions].map((tabSession) => {
        const isActive = tabSession.id === activeTabSessionId;
        const externalHistoryRefresh = externalHistoryRefreshBySessionId[tabSession.id];
        const externalHistoryProviderLabel = externalHistoryRefresh
          ? getExternalHistoryProviderLabel(externalHistoryRefresh.provider)
          : undefined;
        return (
          <div
            key={tabSession.id}
            className={cn('absolute inset-0', !isActive && 'hidden')}
            aria-hidden={!isActive}
          >
            <SessionChatInterface
              {...getSharedChatSurfaceProps(tabSession, isActive)}
              paintSessionMentionOverlay={false}
              isChildTab={tabSession.id !== sessionId}
              isExternalHistoryRefreshing={externalHistoryRefresh !== undefined}
              externalHistoryProviderLabel={externalHistoryProviderLabel}
              messageFileDiffEntriesByTurn={
                tabSession.id === activeSessionTabId ? messageFileDiffEntriesByTurn : undefined
              }
              onOpenBrowser={() => handleOpenBrowser(tabSession.id, true)}
              changesDiffStat={changesDiffStat}
              onForkLastAssistant={
                canForkSession(tabSession)
                  ? (turnId, destination) => handleForkDestination(tabSession, turnId, destination)
                  : undefined
              }
              forkWorktreeAvailability={getForkWorktreeAvailability(tabSession)}
              forkingAssistantMessageId={pendingForks[tabSession.id]?.turnId}
            />
          </div>
        );
      })}
      {draftTabs.map((draft) => {
        const isActive = draft.id === activeTabSessionId;
        return (
          <div
            key={draft.id}
            className={cn('absolute inset-0', !isActive && 'hidden')}
            aria-hidden={!isActive}
          >
            <DraftSessionChatInterface
              ref={(el) => setChatTabRef(draft.id, el)}
              draft={draft}
              parentSession={activeSession}
              commandsEnabled={isActive}
              onDraftChange={handleDraftChange}
              onSendDraft={handleSendDraft}
              onCommentReferencesChange={getCommentReferencesChangeHandler(draft.id)}
            />
          </div>
        );
      })}
      {pendingChildTabSurface}
    </SessionMentionDropLayer>
  );

  const desktopViewerSurfaces = viewerTabs.map((tab) => {
    const isActive = tab.id === effectiveActiveViewerTabId;
    return (
      <div
        key={tab.id}
        className={isActive ? 'h-full' : 'hidden h-full'}
        aria-hidden={!isActive || !isSidebarVisible}
      >
        {renderViewerTabContent(tab, 'h-full', isActive && isSidebarVisible)}
      </div>
    );
  });

  const desktopSideSessionSurfaces = visibleSideSessions
    .filter(
      (sideSession) =>
        mountedSideSessionIds.has(sideSession.id) ||
        // A freshly forked target must mount to report durable history ready;
        // that report is what activates it.
        pendingForkSourceByTargetSessionId.has(sideSession.id)
    )
    .map((sideSession) => {
      const isActive = sideSession.id === effectiveActiveSideSessionId;
      return (
        <div
          key={sideSession.id}
          className={cn('absolute inset-0', !isActive && 'hidden')}
          aria-hidden={!isActive}
        >
          <SessionChatInterface
            {...getSharedChatSurfaceProps(sideSession, isActive, isActive && isSidebarVisible)}
            isChildTab
          />
        </div>
      );
    });

  // White reading surface (not bg-sidebar): the file editor/monaco canvas is
  // pure white, so a gray panel shell left a two-tone mismatch. Match the
  // surrounding cool-white chrome; keep a light border + soft shadow for card lift.
  const desktopSecondaryPanel = (
    <div
      data-lody-session-tab-region="side-panel"
      className="mx-2 mb-2 mt-2 flex h-[calc(100%_-_1rem)] min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-background shadow-[0_1px_3px_-1px_rgba(15,17,21,0.08),0_1px_2px_rgba(15,17,21,0.04)]"
    >
      <SessionSidePanelTabBar
        tabs={sidePanelTabs}
        activeTabId={activeSidePanelTabId}
        availablePanels={availableSidePanelOptions}
        onTabSelect={handleSidePanelTabSelect}
        onTabClose={handleSidePanelTabClose}
        onPanelOpen={handleSidePanelOptionOpen}
        addPanelLabel={t('sessions.sidebar.addPanel', 'Add panel')}
        closeTabLabel={(tabLabel) =>
          t('sessions.fileViewer.closeTab', 'Close {{fileName}}', { fileName: tabLabel })
        }
        moreSlot={
          <SessionFileActionsMenu
            filePath={activeViewerFilePath}
            items={activeSessionFileActions.menuItems}
          />
        }
        endSlot={sidebarToggleButton}
        className={cn(
          'border-b border-border/50 bg-background',
          // Right panel is never under the macOS traffic lights (top-left) —
          // it must not reserve the titlebar inset the left sidebar needs.
          'h-11',
          windowsCaptionPadClass
        )}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {showFixedSidePanelBody && activeSidebarTab !== null ? sidebarContent : null}
        {showFixedSidePanelBody && activeSidebarTab === null && sidePanelTabs.length === 0 ? (
          <SessionSidePanelEmptyState
            panels={sidePanelOptions}
            onPanelOpen={handleSidePanelOptionOpen}
            title={t('sessions.sidebar.emptyTitle', 'Open a panel')}
            description={t(
              'sessions.sidebar.emptyDescription',
              'Choose what you want to see in this sidebar.'
            )}
          />
        ) : null}
        {desktopSideSessionSurfaces}
        {desktopViewerSurfaces}
      </div>
    </div>
  );

  // Pointer capture is required because clicking non-focusable panel content leaves
  // document.activeElement in the previous region and would close the wrong tab.
  const handleDesktopTabRegionInteraction = (target: EventTarget | null, root: HTMLElement) => {
    if (!(target instanceof Element) || !root.contains(target)) return;
    desktopTabFocusRegionRef.current = target.closest('[data-lody-session-tab-region="side-panel"]')
      ? 'side-panel'
      : 'conversation';
  };

  return (
    <div
      className="h-full"
      onPointerDownCapture={(event) =>
        handleDesktopTabRegionInteraction(event.target, event.currentTarget)
      }
      onFocusCapture={(event) =>
        handleDesktopTabRegionInteraction(event.target, event.currentTarget)
      }
    >
      <DesktopSessionDetailLayout
        defaultSizes={defaultSizes}
        topBar={tabBar}
        chatSurfaces={desktopChatSurfaces}
        terminalDock={<TerminalDockHost />}
        secondaryPanel={desktopSecondaryPanel}
        sidebarOpen={isSidebarVisible}
        onSidebarCollapse={handleToggleSidebar}
        deleteConfirmDialog={deleteConfirmDialog}
        sidebarMinWidthRequest={prSidebarWidthRequest}
        sidebarRestoreSeq={sidebarRestoreSeq}
      />
      {/* These dialogs live at the desktop root too (the mobile branch renders its own
          copies) so the `session.renameCurrent` / `session.archiveCurrent` keyboard
          shortcuts have a mounted target on desktop. They portal out, so tree position
          doesn't matter. */}
      {archiveConfirmDialog}
      {dirtyForkDialog}
      {worktreeForkObservers}
      <SessionShareDialog
        open={showSessionSharing && pendingSessionShare != null}
        sessionTitle={
          pendingSessionShare?.session.title?.trim() || t('sessions.untitled', 'Untitled session')
        }
        state={showSessionSharing ? (pendingSessionShare?.sharing ?? null) : null}
        isSharing={isSharingSession}
        onOpenChange={(open) => {
          if (!open && !isSharingSession) setPendingSessionShare(null);
        }}
        onConfirm={() => {
          void handleConfirmSessionShare();
        }}
      />
      <RenameSessionDialog
        target={renameDialogTarget}
        onClose={() => setRenameDialogTarget(null)}
      />
    </div>
  );
};

export default SessionDetail;
