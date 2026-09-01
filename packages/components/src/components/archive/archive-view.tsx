import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@tanstack/react-router';
import { toast } from 'sonner';
import {
  Archive,
  ArrowDownAZ,
  ArrowUpDown,
  ChevronDown,
  CircleAlert,
  Clock,
  Folder,
  Github,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Layers,
  List,
  MessageCircle,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';
import { currentWorkspaceSlugAtom, setMobileDrawerOpenAtom, userAtom } from '@/atoms';
import { getAgentMetaByIdAtomFamily } from '@/atoms/agents';
import { archiveScopeAtom } from '@/atoms/sidebar-state';
import { getMachineMetaMapAtom } from '@/atoms/machines';
import { localMachineIdAtom } from '@/atoms/local-probe';
import {
  isArchivedLocalProjectRestoreUnavailableError,
  useSessionActions,
} from '@/hooks/use-session-actions';
import { useIsMobile } from '@/hooks/use-mobile';
import { useOrganization } from '@/hooks/useOrganization';
import { useVisibleArchivedSessionMetas } from '@/hooks/use-visible-session-metas';
import { AgentIcon } from '@/components/icons/agent-icon';
import { SwipeActionRow } from '@/components/shared/swipe-action-row';
import { UserAvatar } from '@/components/user-avatar';
import { MobileArchiveScreen } from '@/components/mobile/mobile-archive-screen';
import { WebArchiveScreen } from './web-archive-screen';
import {
  getMachineFlockLocalProjects,
  getSessionLaunchConfigLegacyFields,
  getSessionPullRequestLegacyFields,
  parseGitHubPrNumber,
  type MachineId,
  type PrStatus,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { useMachineFlockRowsByMachineIds } from '@/hooks/use-machine-flock-rows';
import { buildArchivedSessionTree } from '@/lib/archived-session-tree';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';

export type ArchivedSessionGroup = {
  key: string;
  kind: 'repo' | 'chat' | 'local';
  label: string;
  local?: {
    name: string;
    path?: string | null;
    title?: string | null;
    available: boolean;
  };
  sessions: SessionMeta[];
  collapsed: boolean;
};

type PrStatusMeta = {
  icon: LucideIcon;
  className: string;
  label: string;
};

function SessionAgentIcon({ session, className }: { session: SessionMeta; className?: string }) {
  const agentConfig = useAtomValue(getAgentMetaByIdAtomFamily(session.agentConfigId));
  return (
    <AgentIcon
      cliType={session.cliType}
      agentType={session.agentType}
      env={agentConfig?.env ?? getSessionLaunchConfigLegacyFields(session)?.env}
      className={className}
    />
  );
}

const PR_STATUS_META: Record<PrStatus, PrStatusMeta> = {
  open: {
    icon: GitPullRequest,
    className: 'text-github-open',
    label: 'Open',
  },
  merged: {
    icon: GitMerge,
    className: 'text-github-merged',
    label: 'Merged',
  },
  closed: {
    icon: GitPullRequestClosed,
    className: 'text-github-closed',
    label: 'Closed',
  },
  draft: {
    icon: GitPullRequestDraft,
    className: 'text-github-draft',
    label: 'Draft',
  },
};

function formatRelativeTime(dateValue: number | string | undefined, now: Date): string {
  if (!dateValue) return '--';

  const date = typeof dateValue === 'number' ? new Date(dateValue) : new Date(dateValue);
  if (!Number.isFinite(date.getTime())) return '--';

  const diffMs = Math.max(0, now.getTime() - date.getTime());
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;

  const weeks = Math.floor(days / 7);
  if (weeks < 4) return `${weeks}w`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;

  const years = Math.floor(days / 365);
  return `${years}y`;
}

type ArchiveSortMode = 'newest' | 'oldest' | 'title';
type ArchiveGroupMode = 'project' | 'flat';

function sessionActivityTime(session: SessionMeta): number {
  return typeof session.lastMessageAt === 'number' ? session.lastMessageAt : 0;
}

function sessionTitle(session: SessionMeta): string {
  return session.title?.trim() || 'Untitled session';
}

function sortArchivedSessions(
  sessions: readonly SessionMeta[],
  sortMode: ArchiveSortMode
): SessionMeta[] {
  const copy = [...sessions];
  if (sortMode === 'title') {
    return copy.sort((a, b) => sessionTitle(a).localeCompare(sessionTitle(b)));
  }
  const newestFirst = sortMode === 'newest';
  return copy.sort((a, b) => {
    const delta = sessionActivityTime(b) - sessionActivityTime(a);
    return newestFirst ? delta : -delta;
  });
}

function sessionMatchesArchiveQuery(
  session: SessionMeta,
  query: string,
  localProjectLabelByKey: Map<
    string,
    { name: string; path?: string | null; title?: string | null; available: boolean }
  >
): boolean {
  if (!query) return true;
  const haystacks: string[] = [
    sessionTitle(session),
    session.repoFullName ?? '',
    session.branchName ?? '',
    session.userId ?? '',
  ];
  const project = session.project;
  if (project?.kind === 'local') {
    const key = `local:${session.machineId}:${project.localProjectId}`;
    const localLabel = localProjectLabelByKey.get(key);
    if (localLabel) {
      haystacks.push(localLabel.name, localLabel.path ?? '', localLabel.title ?? '');
    }
  }
  return haystacks.some((value) => value.toLowerCase().includes(query));
}

function groupSessionsForArchive({
  sessions,
  localProjectLabelByKey,
  groupMode,
  sortMode,
  flatLabel,
}: {
  sessions: SessionMeta[];
  localProjectLabelByKey: Map<
    string,
    { name: string; path?: string | null; title?: string | null; available: boolean }
  >;
  groupMode: ArchiveGroupMode;
  sortMode: ArchiveSortMode;
  flatLabel: string;
}): Omit<ArchivedSessionGroup, 'collapsed'>[] {
  if (groupMode === 'flat') {
    return [
      {
        key: '__all__',
        kind: 'chat',
        label: flatLabel,
        sessions: sortArchivedSessions(sessions, sortMode),
      },
    ];
  }

  const groups = new Map<string, SessionMeta[]>();
  const localGroups = new Map<string, SessionMeta[]>();
  const noRepoSessions: SessionMeta[] = [];

  for (const session of sessions) {
    const project = session.project;
    if (project?.kind === 'local') {
      const key = `local:${session.machineId}:${project.localProjectId}`;
      const existing = localGroups.get(key);
      if (existing) existing.push(session);
      else localGroups.set(key, [session]);
      continue;
    }

    const repoFullName = session.repoFullName?.trim();
    if (repoFullName) {
      const existing = groups.get(repoFullName);
      if (existing) {
        existing.push(session);
      } else {
        groups.set(repoFullName, [session]);
      }
    } else {
      noRepoSessions.push(session);
    }
  }

  const result: Omit<ArchivedSessionGroup, 'collapsed'>[] = [];

  const sortedLocalKeys = [...localGroups.keys()].sort((a, b) => a.localeCompare(b));
  for (const key of sortedLocalKeys) {
    const groupSessions = localGroups.get(key);
    if (!groupSessions) continue;
    const localLabel = localProjectLabelByKey.get(key);
    result.push({
      key,
      kind: 'local',
      label: localLabel?.path?.trim() || localLabel?.name || 'Local project',
      local: localLabel ?? { name: 'Local project', available: false },
      sessions: sortArchivedSessions(groupSessions, sortMode),
    });
  }

  const sortedRepoNames = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const repoFullName of sortedRepoNames) {
    const repoSessions = groups.get(repoFullName);
    if (repoSessions) {
      result.push({
        key: repoFullName,
        kind: 'repo',
        label: repoFullName,
        sessions: sortArchivedSessions(repoSessions, sortMode),
      });
    }
  }

  if (noRepoSessions.length > 0) {
    result.push({
      key: '__chats__',
      kind: 'chat',
      label: 'Chats',
      sessions: sortArchivedSessions(noRepoSessions, sortMode),
    });
  }

  return result;
}

type ArchivedSessionItemViewModel = {
  title: string;
  relativeTime: string;
  branchName: string;
  diffStats: NonNullable<SessionMeta['diffStats']>;
  hasChanges: boolean;
  prUrl: string | null;
  prStatusMeta: PrStatusMeta | null;
  PrIcon: LucideIcon | null;
  prTooltipLabel: string;
};

function getArchivedSessionItemViewModel(
  session: SessionMeta,
  now: Date
): ArchivedSessionItemViewModel {
  const title = session.title?.trim() || 'Untitled session';
  const relativeTime = formatRelativeTime(session.lastMessageAt, now);
  const branchName = session.branchName?.trim() || '';
  const diffStats = session.diffStats ?? { allChange: { add: 0, del: 0 } };
  const hasChanges = diffStats.allChange.add !== 0 || diffStats.allChange.del !== 0;

  const pullRequests = session.pullRequests ?? [];
  const latestPr =
    pullRequests.length > 0
      ? pullRequests.some((pr) => getSessionPullRequestLegacyFields(pr).reportedAt)
        ? [...pullRequests].sort((a, b) =>
            (getSessionPullRequestLegacyFields(b).reportedAt ?? '').localeCompare(
              getSessionPullRequestLegacyFields(a).reportedAt ?? ''
            )
          )[0]
        : pullRequests[pullRequests.length - 1]
      : null;
  const prUrl = latestPr?.url?.trim() || null;
  const prStatus = latestPr?.status ?? 'open';
  const prNumber = prUrl ? parseGitHubPrNumber(prUrl) : null;
  const prStatusMeta = prUrl ? PR_STATUS_META[prStatus] : null;
  const PrIcon = prStatusMeta?.icon ?? null;
  const prTooltipLabel = prNumber
    ? `${prStatusMeta?.label} PR #${prNumber}`
    : prStatusMeta?.label
      ? `${prStatusMeta.label} PR`
      : '';

  return {
    title,
    relativeTime,
    branchName,
    diffStats,
    hasChanges,
    prUrl,
    prStatusMeta,
    PrIcon,
    prTooltipLabel,
  };
}

type ArchivedSessionItemBaseProps = {
  session: SessionMeta;
  depth: 0 | 1;
  now: Date;
  onRestore: (sessionId: SessionId) => void;
  onDelete: (session: SessionMeta) => void;
  onNavigate: (sessionId: SessionId) => void;
  restoreLabel: string;
  restoreAvailable: boolean;
  restoreUnavailableLabel: string;
  removedProjectLabel: string;
  deleteLabel: string;
  isMultiSelectMode: boolean;
  isSelected: boolean;
  onToggleSelect: (sessionId: SessionId) => void;
  onEnterMultiSelect: (sessionId: SessionId) => void;
  owner?: { name?: string | null; image?: string | null } | null;
};

type MobileArchivedSessionItemProps = ArchivedSessionItemBaseProps & {
  restoreActionLabel: string;
  deleteActionLabel: string;
  hideActionLabels: boolean;
};

function DesktopArchivedSessionItem({
  session,
  depth,
  now,
  onRestore,
  onDelete,
  onNavigate,
  restoreLabel,
  restoreAvailable,
  restoreUnavailableLabel,
  deleteLabel,
  isMultiSelectMode,
  isSelected,
  onToggleSelect,
  onEnterMultiSelect,
  owner,
}: ArchivedSessionItemBaseProps) {
  const {
    title,
    relativeTime,
    branchName,
    diffStats,
    hasChanges,
    prUrl,
    prStatusMeta,
    PrIcon,
    prTooltipLabel,
  } = getArchivedSessionItemViewModel(session, now);

  const handleRowClick = useCallback(() => {
    if (isMultiSelectMode) {
      onToggleSelect(session.id);
      return;
    }
    onNavigate(session.id);
  }, [isMultiSelectMode, onNavigate, onToggleSelect, session.id]);

  return (
    <div
      className={cn(
        'group relative flex w-full min-w-0 items-center gap-2 rounded-md py-1.5 pl-6 pr-2',
        depth === 1 && 'pl-10',
        'border border-transparent bg-transparent',
        'hover:bg-hover hover:text-hover-foreground',
        'focus-within:ring-2 focus-within:ring-ring/60',
        isSelected && 'bg-selection text-selection-foreground hover:bg-selection',
        'cursor-pointer',
        'transition-colors'
      )}
      data-session-depth={depth}
      onClick={handleRowClick}
    >
      {isMultiSelectMode ? (
        <div className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect(session.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${title}`}
          />
        </div>
      ) : (
        <div className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-150">
          <Checkbox
            checked={false}
            onCheckedChange={() => onEnterMultiSelect(session.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${title}`}
          />
        </div>
      )}

      <div className="w-5 shrink-0 flex items-center justify-center">
        <SessionAgentIcon session={session} className="h-3.5 w-3.5 text-muted-foreground" />
      </div>

      <div className="min-w-0 flex-1">
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <span
              role="button"
              tabIndex={0}
              aria-pressed={isMultiSelectMode ? isSelected : undefined}
              data-id={`archive-session:${session.id}`}
              data-scope-item="row"
              className="block w-full truncate text-left text-sm text-foreground/85 outline-hidden"
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                handleRowClick();
              }}
            >
              {title}
            </span>
          </TooltipTrigger>
          <TooltipContent side="top">{title}</TooltipContent>
        </Tooltip>
      </div>

      <div className="flex w-5 shrink-0 items-center justify-center">
        {prUrl && PrIcon && prStatusMeta && (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'inline-flex h-5 w-5 items-center justify-center rounded-sm',
                  'transition-colors hover:bg-muted/30',
                  prStatusMeta.className
                )}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  window.open(prUrl, '_blank', 'noopener,noreferrer');
                }}
              >
                <PrIcon className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{prTooltipLabel}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div className="hidden min-w-0 max-w-[12rem] shrink basis-40 sm:block">
        {branchName ? (
          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <span className="block truncate text-xs text-muted-foreground">{branchName}</span>
            </TooltipTrigger>
            <TooltipContent side="top">{branchName}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>

      <span className="w-10 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
        {relativeTime}
      </span>

      <div className="flex w-20 shrink-0 items-center justify-end gap-1.5 text-xs tabular-nums">
        {hasChanges ? (
          <>
            <span className="text-code-added">+{diffStats.allChange.add}</span>
            <span className="text-code-removed">-{diffStats.allChange.del}</span>
          </>
        ) : null}
      </div>

      <div className="w-5 shrink-0 flex items-center justify-center">
        {owner && (
          <Tooltip delayDuration={500}>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <UserAvatar
                  user={owner}
                  className="h-4 w-4"
                  fallbackClassName="text-[8px] font-medium"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">{owner.name ?? 'Unknown'}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <div
        className={cn(
          'flex items-center gap-0.5 shrink-0',
          'opacity-0 pointer-events-none',
          !isMultiSelectMode && 'group-hover:opacity-100 group-hover:pointer-events-auto',
          'transition-opacity duration-100'
        )}
      >
        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex h-6 w-6 items-center justify-center rounded-sm',
                'text-muted-foreground/70 transition-colors',
                'hover:text-foreground hover:bg-muted/50',
                'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground/70',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60'
              )}
              aria-label={restoreAvailable ? restoreLabel : restoreUnavailableLabel}
              disabled={!restoreAvailable}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onRestore(session.id);
              }}
            >
              <Undo2 className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {restoreAvailable ? restoreLabel : restoreUnavailableLabel}
          </TooltipContent>
        </Tooltip>

        <Tooltip delayDuration={300}>
          <TooltipTrigger asChild>
            <button
              type="button"
              className={cn(
                'inline-flex h-6 w-6 items-center justify-center rounded-sm',
                'text-muted-foreground/70 transition-colors',
                'hover:text-destructive hover:bg-destructive/10',
                'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring/60'
              )}
              aria-label={deleteLabel}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                onDelete(session);
              }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="top">{deleteLabel}</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}

function MobileArchivedSessionItem({
  session,
  depth,
  now,
  onRestore,
  onDelete,
  onNavigate,
  restoreLabel,
  restoreAvailable,
  removedProjectLabel,
  restoreActionLabel,
  deleteLabel,
  deleteActionLabel,
  hideActionLabels,
  isMultiSelectMode,
  isSelected,
  onToggleSelect,
  onEnterMultiSelect,
  owner,
}: MobileArchivedSessionItemProps) {
  const {
    title,
    relativeTime,
    branchName,
    diffStats,
    hasChanges,
    prUrl,
    prStatusMeta,
    PrIcon,
    prTooltipLabel,
  } = getArchivedSessionItemViewModel(session, now);

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  const handleTouchStart = useCallback(() => {
    if (isMultiSelectMode) return;
    longPressFiredRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      longPressFiredRef.current = true;
      onEnterMultiSelect(session.id);
    }, 500);
  }, [isMultiSelectMode, onEnterMultiSelect, session.id]);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  useEffect(() => clearLongPressTimer, [clearLongPressTimer]);

  const handleRowClick = useCallback(() => {
    if (longPressFiredRef.current) {
      longPressFiredRef.current = false;
      return;
    }
    if (isMultiSelectMode) {
      onToggleSelect(session.id);
      return;
    }
    onNavigate(session.id);
  }, [isMultiSelectMode, onNavigate, onToggleSelect, session.id]);

  const row = (
    <div
      className={cn(
        'group relative flex w-full min-w-0 items-center gap-2 rounded-md py-1 pl-6 pr-2',
        depth === 1 && 'pl-10',
        'border border-transparent bg-transparent',
        'focus-within:ring-2 focus-within:ring-ring/60',
        'cursor-pointer',
        'transition-colors'
      )}
      data-session-depth={depth}
      onClick={handleRowClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={clearLongPressTimer}
      onTouchMove={clearLongPressTimer}
    >
      {isMultiSelectMode && (
        <div className="absolute left-1.5 top-1/2 -translate-y-1/2 flex items-center justify-center">
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect(session.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${title}`}
          />
        </div>
      )}

      <div className={cn('min-w-0 flex-1 flex items-start gap-2', isMultiSelectMode && 'pl-2')}>
        <div className="mt-0.5 shrink-0 flex items-center justify-center w-4 h-4">
          <SessionAgentIcon session={session} className="h-3.5 w-3.5 text-muted-foreground" />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span
              role="button"
              tabIndex={0}
              aria-pressed={isMultiSelectMode ? isSelected : undefined}
              data-id={`archive-session:${session.id}`}
              data-scope-item="row"
              className="truncate text-sm text-foreground/85 flex-1 outline-hidden"
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                handleRowClick();
              }}
            >
              {title}
            </span>
            {hasChanges && (
              <div className="flex items-center gap-1 tabular-nums shrink-0 text-xs">
                <span className="text-code-added">+{diffStats.allChange.add}</span>
                <span className="text-code-removed">-{diffStats.allChange.del}</span>
              </div>
            )}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {relativeTime}
            </span>
            {owner && (
              <Tooltip delayDuration={500}>
                <TooltipTrigger asChild>
                  <span className="inline-flex shrink-0">
                    <UserAvatar
                      user={owner}
                      className="h-4 w-4"
                      fallbackClassName="text-[8px] font-medium"
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top">{owner.name ?? 'Unknown'}</TooltipContent>
              </Tooltip>
            )}
          </div>

          <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
            {!restoreAvailable ? (
              <span className="inline-flex shrink-0 items-center gap-1 text-muted-foreground">
                <CircleAlert className="h-3 w-3" aria-hidden="true" />
                {removedProjectLabel}
              </span>
            ) : null}
            {prUrl && PrIcon && prStatusMeta && (
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    className={cn(
                      'inline-flex h-4 w-4 items-center justify-center rounded-sm shrink-0',
                      prStatusMeta.className
                    )}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      window.open(prUrl, '_blank', 'noopener,noreferrer');
                    }}
                  >
                    <PrIcon className="h-3 w-3" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{prTooltipLabel}</TooltipContent>
              </Tooltip>
            )}
            {branchName && (
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <span className="truncate max-w-[120px]">{branchName}</span>
                </TooltipTrigger>
                <TooltipContent side="top">{branchName}</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );

  if (isMultiSelectMode) {
    return row;
  }

  return (
    <SwipeActionRow
      enabled
      className="rounded-md"
      contentClassName="bg-background"
      actions={[
        ...(restoreAvailable
          ? [
              {
                key: 'restore',
                label: restoreActionLabel,
                ariaLabel: restoreLabel,
                icon: <Undo2 className="h-4 w-4" />,
                hideLabel: hideActionLabels,
                className: 'bg-muted text-foreground',
                onClick: () => onRestore(session.id),
              },
            ]
          : []),
        {
          key: 'delete',
          label: deleteActionLabel,
          ariaLabel: deleteLabel,
          icon: <Trash2 className="h-4 w-4" />,
          hideLabel: hideActionLabels,
          className: 'bg-destructive text-destructive-foreground',
          onClick: () => onDelete(session),
        },
      ]}
    >
      {row}
    </SwipeActionRow>
  );
}

export type ArchivedSessionGroupSectionProps = {
  group: ArchivedSessionGroup;
  now: Date;
  onRestore: (sessionId: SessionId) => void;
  onDelete: (session: SessionMeta) => void;
  onNavigate: (sessionId: SessionId) => void;
  onToggleCollapse: () => void;
  restoreLabel: string;
  restoreUnavailableLabel: string;
  removedProjectLabel: string;
  restoreActionLabel: string;
  deleteLabel: string;
  deleteActionLabel: string;
  chatLabel: string;
  isMobile: boolean;
  isMultiSelectMode: boolean;
  selectedIds: Set<SessionId>;
  onToggleSelect: (sessionId: SessionId) => void;
  onToggleGroupSelect: (groupKey: string, sessionIds: SessionId[]) => void;
  onEnterMultiSelect: (sessionId: SessionId) => void;
  membersByUserId: Map<string, { name?: string | null; image?: string | null }>;
  /** Flat list mode: hide the project/repo section header. */
  hideGroupHeader?: boolean;
};

export function ArchivedSessionGroupSection({
  group,
  now,
  onRestore,
  onDelete,
  onNavigate,
  onToggleCollapse,
  restoreLabel,
  restoreUnavailableLabel,
  removedProjectLabel,
  restoreActionLabel,
  deleteLabel,
  deleteActionLabel,
  chatLabel,
  isMobile,
  isMultiSelectMode,
  selectedIds,
  onToggleSelect,
  onToggleGroupSelect,
  onEnterMultiSelect,
  membersByUserId,
  hideGroupHeader = false,
}: ArchivedSessionGroupSectionProps) {
  const isChat = group.kind === 'chat';
  const isLocal = group.kind === 'local';
  const restoreAvailable = !isLocal || group.local?.available === true;
  const HeaderIcon = isChat ? MessageCircle : isLocal ? Folder : Github;
  const label = isChat ? chatLabel : group.label;
  const groupKey = group.key;

  const groupSessionIds = useMemo(() => group.sessions.map((s) => s.id), [group.sessions]);
  const selectedInGroup = useMemo(
    () => groupSessionIds.filter((id) => selectedIds.has(id)).length,
    [groupSessionIds, selectedIds]
  );
  const allSelected = selectedInGroup === group.sessions.length && group.sessions.length > 0;
  const someSelected = selectedInGroup > 0 && !allSelected;

  const groupCheckboxState: boolean | 'indeterminate' = allSelected
    ? true
    : someSelected
      ? 'indeterminate'
      : false;

  const showHeader = !hideGroupHeader;
  const showSessions = hideGroupHeader || !group.collapsed;
  const sessionTree = useMemo(() => buildArchivedSessionTree(group.sessions), [group.sessions]);

  return (
    <div className={cn('mb-4 w-full min-w-0', group.collapsed && showHeader ? 'mb-2' : '')}>
      {showHeader ? (
        <button
          type="button"
          data-id={`archive-group:${groupKey}`}
          data-scope-item="row"
          onClick={onToggleCollapse}
          className={cn(
            'group/header relative flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5',
            'text-sm font-medium text-foreground/80',
            'cursor-pointer transition-colors hover:bg-hover/40'
          )}
        >
          {isMultiSelectMode && (
            <div
              className="absolute left-1.5 top-1/2 z-10 flex -translate-y-1/2 items-center justify-center"
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
              }}
            >
              <Checkbox
                checked={groupCheckboxState}
                onCheckedChange={() => onToggleGroupSelect(groupKey, groupSessionIds)}
                aria-label={`Select all in ${label}`}
              />
            </div>
          )}
          <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
            <HeaderIcon
              className={cn(
                'absolute h-4 w-4 text-muted-foreground/80 transition-opacity duration-100',
                isMultiSelectMode ? 'opacity-0' : 'group-hover/header:opacity-0'
              )}
            />
            <ChevronDown
              className={cn(
                'absolute h-4 w-4 text-muted-foreground/70 opacity-0',
                'transition-[opacity,translate,scale] duration-100',
                isMultiSelectMode ? '' : 'group-hover/header:opacity-100',
                group.collapsed ? '-rotate-90' : 'rotate-0'
              )}
            />
          </span>
          {isLocal ? (
            <span className="min-w-0 flex-1 truncate text-left">
              <span className="flex min-w-0 items-baseline gap-2">
                <span className="max-w-[40%] shrink-0 truncate">{group.local?.name ?? label}</span>
                <span
                  className="min-w-0 flex-1 truncate font-normal text-muted-foreground/60 [direction:rtl] [unicode-bidi:plaintext]"
                  title={group.local?.title ?? undefined}
                >
                  {group.local?.path ?? label}
                </span>
              </span>
            </span>
          ) : (
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          )}
          <span className="text-xs tabular-nums text-muted-foreground/60">
            ({group.sessions.length})
          </span>
          {!restoreAvailable ? (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              <CircleAlert className="h-3 w-3" aria-hidden="true" />
              {removedProjectLabel}
            </span>
          ) : null}
        </button>
      ) : null}

      {showSessions ? (
        <div className={cn('flex w-full min-w-0 flex-col', showHeader && 'mt-1')}>
          {sessionTree.map(({ item: session, depth }) =>
            isMobile ? (
              <MobileArchivedSessionItem
                key={session.id}
                session={session}
                depth={depth}
                now={now}
                onRestore={onRestore}
                onDelete={onDelete}
                onNavigate={onNavigate}
                restoreLabel={restoreLabel}
                restoreAvailable={restoreAvailable}
                restoreUnavailableLabel={restoreUnavailableLabel}
                removedProjectLabel={removedProjectLabel}
                restoreActionLabel={restoreActionLabel}
                deleteLabel={deleteLabel}
                deleteActionLabel={deleteActionLabel}
                hideActionLabels={group.kind !== 'repo'}
                isMultiSelectMode={isMultiSelectMode}
                isSelected={selectedIds.has(session.id)}
                onToggleSelect={onToggleSelect}
                onEnterMultiSelect={onEnterMultiSelect}
                owner={membersByUserId.get(session.userId)}
              />
            ) : (
              <DesktopArchivedSessionItem
                key={session.id}
                session={session}
                depth={depth}
                now={now}
                onRestore={onRestore}
                onDelete={onDelete}
                onNavigate={onNavigate}
                restoreLabel={restoreLabel}
                restoreAvailable={restoreAvailable}
                restoreUnavailableLabel={restoreUnavailableLabel}
                removedProjectLabel={removedProjectLabel}
                deleteLabel={deleteLabel}
                isMultiSelectMode={isMultiSelectMode}
                isSelected={selectedIds.has(session.id)}
                onToggleSelect={onToggleSelect}
                onEnterMultiSelect={onEnterMultiSelect}
                owner={membersByUserId.get(session.userId)}
              />
            )
          )}
        </div>
      ) : null}
    </div>
  );
}

export function ArchiveView() {
  const { t } = useTranslation();
  const listScopeId = useId();
  useListKeyboardNavigation({ scopeId: listScopeId });
  const router = useRouter();
  const isMobile = useIsMobile();
  const user = useAtomValue(userAtom);
  const workspaceSlug = useAtomValue(currentWorkspaceSlugAtom);
  const { archivedSessions } = useVisibleArchivedSessionMetas();
  const { restoreSession, deleteArchivedSession } = useSessionActions();
  const openMobileDrawer = useSetAtom(setMobileDrawerOpenAtom);
  const [deleteConfirmSession, setDeleteConfirmSession] = useState<SessionMeta | null>(null);
  const [archiveScope, setArchiveScope] = useAtom(archiveScopeAtom);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortMode, setSortMode] = useState<ArchiveSortMode>('newest');
  const [groupMode, setGroupMode] = useState<ArchiveGroupMode>('project');
  const { activeOrganization } = useOrganization();
  const machineMetaMap = useAtomValue(getMachineMetaMapAtom);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const archivedLocalSessionMachineIds = useMemo(
    () =>
      Array.from(
        new Set(
          archivedSessions
            .filter((session) => session.project?.kind === 'local')
            .map((session) => session.machineId as MachineId)
        )
      ),
    [archivedSessions]
  );
  const machineFlockRowsByMachineId = useMachineFlockRowsByMachineIds(
    archivedLocalSessionMachineIds,
    { families: ['localProject'] }
  );

  const now = useMemo(() => new Date(), []);
  const removedProjectLabel = t('archive.localProject.removed', 'Project removed');
  const removedProjectGroupLabel = t('archive.localProject.removedGroup', 'Removed local project');
  const restoreUnavailableLabel = t(
    'archive.localProject.restoreUnavailable',
    'Re-add this local project to restore its conversations.'
  );

  // Build member lookup map for creator avatars
  const membersByUserId = useMemo(() => {
    const map = new Map<string, { name?: string | null; image?: string | null }>();
    const members = activeOrganization?.members;
    if (members) {
      for (const member of members) {
        if (member.user) {
          map.set(member.userId, {
            name: member.user.name,
            image: member.user.image,
          });
        }
      }
    }
    return map;
  }, [activeOrganization?.members]);

  // Filter archived sessions based on scope (my/team + local privacy).
  const scopedArchivedSessions = useMemo(() => {
    const userId = user?.id ?? null;
    const base =
      archiveScope === 'my'
        ? userId
          ? archivedSessions.filter((session) => session.userId === userId)
          : []
        : archivedSessions;

    // Local projects are private per-user: never show other users' local sessions.
    if (!userId) {
      return base.filter((session) => session.project?.kind !== 'local');
    }

    return base.filter((session) => {
      if (session.project?.kind !== 'local') return true;

      // Always allow local machine sessions (even if machine meta is missing ownerUserId due to older data).
      if (localMachineId && session.machineId === localMachineId) return true;

      const machine = machineMetaMap.get(session.machineId);
      if (machine?.ownerUserId === userId) return true;

      // My scope is already filtered by userId; keep local sessions visible even if owner meta hasn't updated yet.
      if (archiveScope === 'my' && session.userId === userId) return true;

      return false;
    });
  }, [archivedSessions, archiveScope, localMachineId, machineMetaMap, user?.id]);

  const localProjectLabelByKey = useMemo(() => {
    const map = new Map<
      string,
      {
        name: string;
        path?: string | null;
        title?: string | null;
        available: boolean;
      }
    >();

    for (const session of scopedArchivedSessions) {
      const project = session.project;
      if (!project || project.kind !== 'local') continue;
      const key = `local:${session.machineId}:${project.localProjectId}`;
      if (map.has(key)) continue;

      const machineMeta = machineMetaMap.get(session.machineId);
      const machineFlockRows = machineFlockRowsByMachineId.get(session.machineId as MachineId);
      const localProjects = {
        ...(machineMeta?.localProjects ?? {}),
        ...(machineFlockRows ? getMachineFlockLocalProjects(machineFlockRows) : {}),
      };
      const projectMeta = localProjects[project.localProjectId];
      const name = projectMeta?.name || removedProjectGroupLabel;
      const rootPath =
        typeof projectMeta?.rootPath === 'string' && projectMeta.rootPath.trim()
          ? projectMeta.rootPath.trim()
          : null;

      map.set(key, {
        name,
        path: rootPath,
        title: rootPath,
        available: Boolean(projectMeta),
      });
    }

    return map;
  }, [
    machineFlockRowsByMachineId,
    machineMetaMap,
    removedProjectGroupLabel,
    scopedArchivedSessions,
  ]);

  const canRestoreArchivedSession = useCallback(
    (session: SessionMeta): boolean => {
      const project = session.project;
      if (project?.kind !== 'local') return true;
      const key = `local:${session.machineId}:${project.localProjectId}`;
      return localProjectLabelByKey.get(key)?.available === true;
    },
    [localProjectLabelByKey]
  );

  const normalizedSearchQuery = searchQuery.trim().toLowerCase();

  const filteredArchivedSessions = useMemo(() => {
    if (!normalizedSearchQuery) return scopedArchivedSessions;
    return scopedArchivedSessions.filter((session) =>
      sessionMatchesArchiveQuery(session, normalizedSearchQuery, localProjectLabelByKey)
    );
  }, [localProjectLabelByKey, normalizedSearchQuery, scopedArchivedSessions]);

  const baseGroups = useMemo(() => {
    return groupSessionsForArchive({
      sessions: filteredArchivedSessions,
      localProjectLabelByKey,
      groupMode,
      sortMode,
      flatLabel: t('archive.allSessions', 'All sessions'),
    }).map((group) => {
      if (groupMode === 'flat') return group;
      if (group.kind !== 'chat') return group;
      return { ...group, label: t('archive.chats', 'Chats') };
    });
  }, [filteredArchivedSessions, groupMode, localProjectLabelByKey, sortMode, t]);

  // Track collapsed state for each group
  const [collapsedState, setCollapsedState] = useState<Record<string, boolean>>({});

  const groupedSessions: ArchivedSessionGroup[] = useMemo(() => {
    return baseGroups.map((group) => ({
      ...group,
      collapsed: collapsedState[group.key] ?? false,
    }));
  }, [baseGroups, collapsedState]);

  const handleToggleCollapse = (groupKey: string) => {
    setCollapsedState((prev) => ({
      ...prev,
      [groupKey]: !prev[groupKey],
    }));
  };

  const handleRestore = (sessionId: SessionId) => {
    const session = scopedArchivedSessions.find((candidate) => candidate.id === sessionId);
    if (!session || !canRestoreArchivedSession(session)) {
      toast.info(restoreUnavailableLabel);
      return;
    }
    void restoreSession(sessionId).catch((error: unknown) => {
      if (isArchivedLocalProjectRestoreUnavailableError(error)) {
        toast.info(restoreUnavailableLabel);
        return;
      }
      console.error('Failed to restore archived conversation', error);
      toast.error(t('archive.restoreFailed', 'Failed to restore conversation.'));
    });
  };

  const handleDelete = (session: SessionMeta) => {
    setDeleteConfirmSession(session);
  };

  const showPermanentDeleteError = useCallback(
    (error: unknown) => {
      console.error('Failed to permanently delete session', error);
      toast.error(t('archive.deleteFailed'));
    },
    [t]
  );

  const handleDeleteConfirm = useCallback(async () => {
    const sessionId = deleteConfirmSession?.id;
    setDeleteConfirmSession(null);
    if (!sessionId) return;
    try {
      await deleteArchivedSession(sessionId);
    } catch (error) {
      showPermanentDeleteError(error);
    }
  }, [deleteArchivedSession, deleteConfirmSession?.id, showPermanentDeleteError]);

  const handleNavigateToSession = useCallback(
    (sessionId: SessionId) => {
      if (!workspaceSlug) return;
      void router.navigate({
        to: '/$workspaceName/sessions/$sessionId',
        params: { workspaceName: workspaceSlug, sessionId },
      });
    },
    [router, workspaceSlug]
  );

  // --- Multi-select state ---
  const [selectedIds, setSelectedIds] = useState<Set<SessionId>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);
  const [bulkDeleteConfirmOpen, setBulkDeleteConfirmOpen] = useState(false);
  const [bulkActionInFlight, setBulkActionInFlight] = useState<'restore' | 'delete' | null>(null);

  const selectedCount = selectedIds.size;
  const isBulkActionBusy = bulkActionInFlight !== null;

  // Check if any selected session has a repoFullName (for delete confirm message).
  // Use scoped (pre-search) sessions so hidden-by-search selections still warn correctly.
  const hasCodeSessionInSelection = useMemo(() => {
    if (selectedCount === 0) return false;
    return scopedArchivedSessions.some((s) => selectedIds.has(s.id) && s.repoFullName);
  }, [scopedArchivedSessions, selectedIds, selectedCount]);
  const hasUnrestorableSessionInSelection = useMemo(() => {
    if (selectedCount === 0) return false;
    return scopedArchivedSessions.some(
      (session) => selectedIds.has(session.id) && !canRestoreArchivedSession(session)
    );
  }, [canRestoreArchivedSession, scopedArchivedSessions, selectedCount, selectedIds]);

  const exitMultiSelect = useCallback(() => {
    setIsMultiSelectMode(false);
    setSelectedIds(new Set());
  }, []);

  const handleEnterMultiSelect = useCallback((sessionId: SessionId) => {
    setIsMultiSelectMode(true);
    setSelectedIds(new Set([sessionId]));
  }, []);

  const handleToggleSelect = useCallback((sessionId: SessionId) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      // Auto-exit multi-select mode when no items are selected
      if (next.size === 0) {
        setIsMultiSelectMode(false);
      }
      return next;
    });
  }, []);

  const handleToggleGroupSelect = useCallback((_groupKey: string, sessionIds: SessionId[]) => {
    setSelectedIds((prev) => {
      const allInGroup = sessionIds.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allInGroup) {
        // Deselect all in group
        for (const id of sessionIds) {
          next.delete(id);
        }
      } else {
        // Select all in group
        for (const id of sessionIds) {
          next.add(id);
        }
      }
      // Auto-exit multi-select mode when no items are selected
      if (next.size === 0) {
        setIsMultiSelectMode(false);
      }
      return next;
    });
  }, []);

  const handleBulkRestore = useCallback(async () => {
    if (isBulkActionBusy || hasUnrestorableSessionInSelection) return;
    const sessionIds = Array.from(selectedIds);
    if (sessionIds.length === 0) return;

    setBulkActionInFlight('restore');
    try {
      const failedSessionIds: SessionId[] = [];
      // Serialize queue updates to avoid overwriting machine queue entries.
      for (const sessionId of sessionIds) {
        try {
          await restoreSession(sessionId);
        } catch {
          failedSessionIds.push(sessionId);
        }
      }

      if (failedSessionIds.length > 0) {
        setSelectedIds(new Set(failedSessionIds));
        setIsMultiSelectMode(true);
        return;
      }

      exitMultiSelect();
    } finally {
      setBulkActionInFlight(null);
    }
  }, [
    exitMultiSelect,
    hasUnrestorableSessionInSelection,
    isBulkActionBusy,
    restoreSession,
    selectedIds,
  ]);

  const handleBulkDeleteConfirm = useCallback(async () => {
    if (isBulkActionBusy) return;
    const sessionIds = Array.from(selectedIds);
    if (sessionIds.length === 0) return;

    setBulkActionInFlight('delete');
    try {
      const failedSessionIds: SessionId[] = [];
      let firstError: unknown;
      // Serialize queue updates to avoid overwriting machine queue entries.
      for (const sessionId of sessionIds) {
        try {
          await deleteArchivedSession(sessionId);
        } catch (error) {
          firstError ??= error;
          failedSessionIds.push(sessionId);
        }
      }

      if (failedSessionIds.length > 0) {
        showPermanentDeleteError(firstError);
        setSelectedIds(new Set(failedSessionIds));
        setIsMultiSelectMode(true);
        setBulkDeleteConfirmOpen(false);
        return;
      }

      setBulkDeleteConfirmOpen(false);
      exitMultiSelect();
    } finally {
      setBulkActionInFlight(null);
    }
  }, [
    isBulkActionBusy,
    selectedIds,
    deleteArchivedSession,
    exitMultiSelect,
    showPermanentDeleteError,
  ]);

  // Clean up selection when archived sessions leave scope (restored/deleted or scope change).
  // Validate against scoped (pre-search) sessions so text search does not drop selections.
  useEffect(() => {
    const validIds = new Set(scopedArchivedSessions.map((s) => s.id));
    let changed = false;
    for (const id of selectedIds) {
      if (!validIds.has(id)) {
        changed = true;
        break;
      }
    }
    if (!changed) return;

    const cleaned = new Set<SessionId>();
    for (const id of selectedIds) {
      if (validIds.has(id)) {
        cleaned.add(id);
      }
    }
    setSelectedIds(cleaned);
    if (cleaned.size === 0 && isMultiSelectMode) {
      setIsMultiSelectMode(false);
    }
  }, [scopedArchivedSessions, selectedIds, isMultiSelectMode]);

  const restoreLabel = t('archive.restore', 'Restore session');
  const restoreActionLabel = t('archive.multiSelect.restore', 'Restore');
  const deleteLabel = t('archive.delete', 'Delete permanently');
  const deleteButtonLabel = t('common.delete', 'Delete');
  const deleteActionLabel = t('common.delete', 'Delete');
  const chatLabel = t('archive.chats', 'Chats');
  const emptyLabel = normalizedSearchQuery
    ? t('archive.emptySearch', 'No matching archived sessions')
    : t('archive.empty', 'No archived sessions');
  const emptyDescription = normalizedSearchQuery
    ? t('archive.emptySearchDescription', 'Try a different search or clear filters.')
    : t('archive.emptyDescription', 'Sessions you archive will appear here.');

  const sortLabel =
    sortMode === 'oldest'
      ? t('archive.sort.oldest', 'Oldest first')
      : sortMode === 'title'
        ? t('archive.sort.title', 'Title A–Z')
        : t('archive.sort.newest', 'Newest first');
  const groupLabel =
    groupMode === 'flat'
      ? t('archive.group.flat', 'One list')
      : t('archive.group.project', 'By project');
  const scopeLabel =
    archiveScope === 'my'
      ? t('sessions.sidebar.my', 'My Tasks')
      : t('sessions.sidebar.team', 'All Tasks');

  /* Mobile: scope sits after search (was in the header). Desktop keeps
     scope in the WebArchiveScreen header and only group/sort here. */
  const archiveToolbar = (
    <div className="mb-3 flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <div className="relative min-w-0 flex-1">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            type="search"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={t('archive.searchPlaceholder', 'Search archived sessions…')}
            aria-label={t('archive.search', 'Search archive')}
            className="h-8 border-foreground/[0.10] bg-background pl-8 text-sm shadow-none dark:border-input-border dark:bg-input"
          />
        </div>
        {isMobile ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0 gap-1.5 border-foreground/[0.10] bg-background px-2.5 text-xs font-medium shadow-none dark:border-input-border"
              >
                <span className="max-w-[6.5rem] truncate">{scopeLabel}</span>
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-44">
              <DropdownMenuRadioGroup
                value={archiveScope}
                onValueChange={(value) => {
                  if (value === 'my' || value === 'team') setArchiveScope(value);
                }}
              >
                <DropdownMenuRadioItem value="my">
                  {t('sessions.sidebar.my', 'My Tasks')}
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="team">
                  {t('sessions.sidebar.team', 'All Tasks')}
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-foreground/[0.10] bg-background px-2.5 text-xs font-medium shadow-none dark:border-input-border"
            >
              {groupMode === 'flat' ? (
                <List className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              ) : (
                <Layers className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="max-w-[7rem] truncate">{groupLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuRadioGroup
              value={groupMode}
              onValueChange={(value) => {
                if (value === 'project' || value === 'flat') setGroupMode(value);
              }}
            >
              <DropdownMenuRadioItem value="project">
                {t('archive.group.project', 'By project')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="flat">
                {t('archive.group.flat', 'One list')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 border-foreground/[0.10] bg-background px-2.5 text-xs font-medium shadow-none dark:border-input-border"
            >
              {sortMode === 'title' ? (
                <ArrowDownAZ className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              ) : sortMode === 'oldest' ? (
                <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              ) : (
                <ArrowUpDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              )}
              <span className="max-w-[7.5rem] truncate">{sortLabel}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuRadioGroup
              value={sortMode}
              onValueChange={(value) => {
                if (value === 'newest' || value === 'oldest' || value === 'title') {
                  setSortMode(value);
                }
              }}
            >
              <DropdownMenuRadioItem value="newest">
                {t('archive.sort.newest', 'Newest first')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="oldest">
                {t('archive.sort.oldest', 'Oldest first')}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="title">
                {t('archive.sort.title', 'Title A–Z')}
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );

  const archiveContent = (
    <div className="box-border w-full min-w-full px-4 py-4 sm:px-6">
      {archiveToolbar}
      {groupedSessions.length === 0 || filteredArchivedSessions.length === 0 ? (
        <div className="flex w-full flex-col items-center justify-center py-12 text-center">
          <Archive className="h-12 w-12 text-muted-foreground/40" />
          <p className="mt-4 text-sm font-medium text-muted-foreground">{emptyLabel}</p>
          <p className="mt-1 text-xs text-muted-foreground/70">{emptyDescription}</p>
        </div>
      ) : (
        <FocusScope id={listScopeId} className="flex w-full min-w-0 flex-col">
          {groupedSessions.map((group) => (
            <ArchivedSessionGroupSection
              key={group.key}
              group={group}
              now={now}
              onRestore={handleRestore}
              onDelete={handleDelete}
              onNavigate={handleNavigateToSession}
              onToggleCollapse={() => handleToggleCollapse(group.key)}
              restoreLabel={restoreLabel}
              restoreUnavailableLabel={restoreUnavailableLabel}
              removedProjectLabel={removedProjectLabel}
              restoreActionLabel={restoreActionLabel}
              deleteLabel={deleteLabel}
              deleteActionLabel={deleteActionLabel}
              chatLabel={chatLabel}
              isMobile={isMobile}
              isMultiSelectMode={isMultiSelectMode}
              selectedIds={selectedIds}
              onToggleSelect={handleToggleSelect}
              onToggleGroupSelect={handleToggleGroupSelect}
              onEnterMultiSelect={handleEnterMultiSelect}
              membersByUserId={membersByUserId}
              hideGroupHeader={groupMode === 'flat'}
            />
          ))}
        </FocusScope>
      )}
    </div>
  );

  const archiveDialogs = (
    <>
      {/* Single-item delete confirm dialog */}
      <Dialog
        open={deleteConfirmSession != null}
        onOpenChange={(open) => setDeleteConfirmSession(open ? deleteConfirmSession : null)}
      >
        <DialogContent className={cn(isMobile ? '' : 'max-w-sm')}>
          <DialogHeader>
            <DialogTitle>{t('archive.deleteConfirm.title', 'Delete permanently?')}</DialogTitle>
            <DialogDescription>
              {deleteConfirmSession?.repoFullName
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
            <Button variant="outline" onClick={() => setDeleteConfirmSession(null)}>
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                void handleDeleteConfirm();
              }}
            >
              {deleteButtonLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Bulk delete confirm dialog */}
      <Dialog
        open={bulkDeleteConfirmOpen}
        onOpenChange={(open) => {
          if (bulkActionInFlight === 'delete') return;
          setBulkDeleteConfirmOpen(open);
        }}
      >
        <DialogContent className={cn(isMobile ? '' : 'max-w-sm')}>
          <DialogHeader>
            <DialogTitle>
              {t('archive.bulkDeleteConfirm.title', 'Delete {{count}} sessions permanently?', {
                count: selectedCount,
              })}
            </DialogTitle>
            <DialogDescription>
              {hasCodeSessionInSelection
                ? t(
                    'archive.bulkDeleteConfirm.description.mixed',
                    'This will delete the selected sessions. Code sessions will also have their worktree directories removed from your machine.'
                  )
                : t(
                    'archive.bulkDeleteConfirm.description.chatOnly',
                    'This will permanently delete the selected sessions.'
                  )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={bulkActionInFlight === 'delete'}
              onClick={() => setBulkDeleteConfirmOpen(false)}
            >
              {t('common.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={selectedCount === 0 || isBulkActionBusy}
              onClick={() => {
                void handleBulkDeleteConfirm();
              }}
            >
              {deleteButtonLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );

  if (isMobile) {
    return (
      <MobileArchiveScreen
        isMultiSelectMode={isMultiSelectMode}
        selectedCount={selectedCount}
        isBulkActionBusy={isBulkActionBusy}
        bulkRestoreDisabled={hasUnrestorableSessionInSelection}
        bulkRestoreDisabledReason={restoreUnavailableLabel}
        onExitMultiSelect={exitMultiSelect}
        onBulkRestore={() => {
          void handleBulkRestore();
        }}
        onRequestBulkDelete={() => setBulkDeleteConfirmOpen(true)}
        onOpenMobileDrawer={() => openMobileDrawer(true)}
        dialogs={archiveDialogs}
      >
        {archiveContent}
      </MobileArchiveScreen>
    );
  }

  return (
    <WebArchiveScreen
      archiveScope={archiveScope}
      isMultiSelectMode={isMultiSelectMode}
      selectedCount={selectedCount}
      isBulkActionBusy={isBulkActionBusy}
      bulkRestoreDisabled={hasUnrestorableSessionInSelection}
      bulkRestoreDisabledReason={restoreUnavailableLabel}
      onArchiveScopeChange={setArchiveScope}
      onExitMultiSelect={exitMultiSelect}
      onBulkRestore={() => {
        void handleBulkRestore();
      }}
      onRequestBulkDelete={() => setBulkDeleteConfirmOpen(true)}
      dialogs={archiveDialogs}
    >
      {archiveContent}
    </WebArchiveScreen>
  );
}
