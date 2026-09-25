import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useRouter } from '@tanstack/react-router';
import { toast } from '@/lib/toast';
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
import * as stylex from '@stylexjs/stylex';
import { colors, shadow } from '@lody/ui/tokens/colors.stylex';
import { corner, duration, ease, focus, radius, space, text } from '@lody/ui/tokens/scales.stylex';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import { Checkbox } from '@lody/ui/checkbox';
import { Dialog } from '@/ui/dialog';
import { Menu } from '@/ui/menu';
import { Input } from '@lody/ui/input';
import { Tooltip } from '@lody/ui/tooltip';
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
import {
  flattenVisibleArchiveRows,
  type ArchiveVirtualRow,
} from '@/lib/archive-list-virtualization';
import { ArchiveListWindow } from './archive-list-window';

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
  tone: 'open' | 'merged' | 'closed' | 'draft';
  label: string;
};

const WIDE = '@media (min-width: 640px)';
const ROW_HOVER = `color-mix(in oklab, ${colors.elevatedBackground}, ${colors.label} 4%)`;
const ROW_FOCUS_RING = `inset 0 0 0 ${focus.ringWidth} ${colors.accent}`;
const ROW_RULE = `inset 0 1px 0 ${colors.separator}`;

const styles = stylex.create({
  /* A session row. On desktop it is one ruled line of its group's card, which
     `ArchiveListWindow` draws under the rows; its height is the virtualizer's
     estimate, so a static and a virtualized card are the same height. */
  row: {
    position: 'relative',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    height: '36px',
    paddingInlineStart: '28px',
    paddingInlineEnd: space[2],
    backgroundColor: { default: 'transparent', ':hover': ROW_HOVER },
    boxShadow: { default: 'none', ':focus-within': ROW_FOCUS_RING },
    cornerShape: corner.shape,
    cursor: 'pointer',
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  rowNested: { paddingInlineStart: '44px' },
  rowRuled: {
    boxShadow: { default: ROW_RULE, ':focus-within': ROW_FOCUS_RING },
  },
  rowFirst: {
    borderTopLeftRadius: radius.large,
    borderTopRightRadius: radius.large,
  },
  rowLast: {
    borderBottomLeftRadius: radius.large,
    borderBottomRightRadius: radius.large,
  },
  rowSelected: {
    backgroundColor: { default: colors.selectedFill, ':hover': colors.selectedFill },
  },
  /* A phone row sits flat on the page, inside its swipe row. */
  mobileRow: {
    position: 'relative',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    minHeight: '56px',
    paddingBlock: space[1],
    paddingInlineStart: space[6],
    paddingInlineEnd: space[2],
    borderRadius: radius.medium,
    cornerShape: corner.shape,
    boxShadow: { default: 'none', ':focus-within': ROW_FOCUS_RING },
    cursor: 'pointer',
  },
  mobileRowNested: { paddingInlineStart: '40px' },
  checkboxSlot: {
    position: 'absolute',
    left: space[2],
    top: '50%',
    transform: 'translateY(-50%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  mobileCheckboxSlot: { left: space[1.5] },
  /* Until a row is selected, its checkbox appears with the pointer. */
  revealOnRowHover: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      ':focus-within': 1,
    },
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  iconSlot: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
  },
  agentIcon: { width: '14px', height: '14px', color: colors.secondaryLabel },
  titleCell: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0 },
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'block',
    width: '100%',
    textAlign: 'start',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.label,
    outlineStyle: 'none',
  },
  prSlot: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '24px',
  },
  glyph: { width: '16px', height: '16px' },
  prOpen: { color: 'hsl(var(--github-open))' },
  prMerged: { color: 'hsl(var(--github-merged))' },
  prClosed: { color: 'hsl(var(--github-closed))' },
  prDraft: { color: 'hsl(var(--github-draft))' },
  branchCell: {
    display: { default: 'none', [WIDE]: 'block' },
    flexGrow: 0,
    flexShrink: 1,
    flexBasis: '160px',
    minWidth: 0,
    maxWidth: '192px',
  },
  meta: {
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.secondaryLabel,
  },
  truncate: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  time: {
    flexShrink: 0,
    width: '40px',
    textAlign: 'end',
    fontVariantNumeric: 'tabular-nums',
  },
  diffCell: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space[1.5],
    width: '80px',
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
  },
  added: { color: 'hsl(var(--code-added))' },
  removed: { color: 'hsl(var(--code-removed))' },
  avatarAnchor: { display: 'inline-flex', flexShrink: 0 },
  /* A row's actions answer the pointer on that row, or a keyboard inside them. */
  actions: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: '2px',
    opacity: 0,
    pointerEvents: 'none',
    transitionProperty: 'opacity',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  actionsLive: {
    opacity: {
      default: 0,
      [stylex.when.ancestor(':hover')]: 1,
      ':focus-within': 1,
    },
    pointerEvents: {
      default: 'none',
      [stylex.when.ancestor(':hover')]: 'auto',
      ':focus-within': 'auto',
    },
  },
  mobileBody: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'flex-start',
    gap: space[2],
    minWidth: 0,
  },
  mobileBodySelecting: { paddingInlineStart: space[2] },
  mobileIconSlot: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    marginTop: '2px',
  },
  mobileText: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0 },
  mobileLine: { display: 'flex', alignItems: 'center', gap: space[2], minWidth: 0 },
  mobileTitle: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontSize: text.bodySize,
    lineHeight: text.bodyLeading,
    color: colors.label,
    outlineStyle: 'none',
  },
  mobileDiff: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[1],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    fontVariantNumeric: 'tabular-nums',
  },
  mobileTime: { flexShrink: 0, fontVariantNumeric: 'tabular-nums' },
  mobileMetaLine: {
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    minWidth: 0,
    marginTop: '2px',
  },
  removedNote: { display: 'inline-flex', flexShrink: 0, alignItems: 'center', gap: space[1] },
  noteGlyph: { flexShrink: 0, width: '12px', height: '12px' },
  /* An inline PR mark on the phone's meta line: a glyph that opens a link. */
  mobilePrLink: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '16px',
    height: '16px',
    padding: 0,
    margin: 0,
    borderWidth: 0,
    borderRadius: radius.mini,
    cornerShape: corner.shape,
    backgroundColor: 'transparent',
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
  },
  mobileBranch: {
    minWidth: 0,
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  swipeRestore: { backgroundColor: colors.hoverFill, color: colors.label },
  swipeDelete: { backgroundColor: colors.destructive, color: colors.onDestructive },

  /* A group's heading, above its card: it names the group from outside it and
     folds it. The slot is the virtualizer's estimate, the heading sits at its foot. */
  headerSlot: {
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'flex-end',
    height: '36px',
    paddingBottom: space[1],
  },
  headerSlotLocal: { height: '40px' },
  header: {
    position: 'relative',
    boxSizing: 'border-box',
    display: 'flex',
    alignItems: 'center',
    gap: space[2],
    width: '100%',
    minWidth: 0,
    height: '32px',
    margin: 0,
    paddingInline: space[2],
    borderWidth: 0,
    borderRadius: radius.small,
    cornerShape: corner.shape,
    backgroundColor: { default: 'transparent', ':hover': colors.hoverFill },
    color: colors.label,
    fontFamily: 'inherit',
    fontSize: text.subheadlineSize,
    fontWeight: 500,
    lineHeight: text.subheadlineLeading,
    textAlign: 'start',
    cursor: 'pointer',
    outlineStyle: 'none',
    boxShadow: { default: 'none', ':focus-visible': `0 0 0 ${focus.ringWidth} ${colors.accent}` },
    transitionProperty: 'background-color',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  headerCheckbox: {
    position: 'absolute',
    left: space[2],
    top: '50%',
    transform: 'translateY(-50%)',
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  headerGlyphSlot: {
    position: 'relative',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    width: '20px',
    height: '20px',
  },
  headerGlyph: {
    position: 'absolute',
    width: '16px',
    height: '16px',
    color: colors.tertiaryLabel,
    transitionProperty: 'opacity, rotate',
    transitionDuration: duration.fast,
    transitionTimingFunction: ease.standard,
  },
  /* At rest the group's kind shows; the pointer swaps it for the fold chevron. */
  kindGlyph: { opacity: { default: 1, [stylex.when.ancestor(':hover')]: 0 } },
  foldGlyph: { opacity: { default: 0, [stylex.when.ancestor(':hover')]: 1 } },
  hidden: { opacity: 0 },
  folded: { rotate: '-90deg' },
  headerLabel: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerLocal: { display: 'flex', alignItems: 'baseline', gap: space[2], minWidth: 0 },
  headerLocalName: {
    flexShrink: 0,
    minWidth: 0,
    maxWidth: '40%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  headerLocalPath: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontWeight: 400,
    color: colors.tertiaryLabel,
    direction: 'rtl',
    unicodeBidi: 'plaintext',
  },
  headerCount: {
    flexShrink: 0,
    fontSize: text.footnoteSize,
    fontWeight: 400,
    fontVariantNumeric: 'tabular-nums',
    color: colors.tertiaryLabel,
  },
  badgeGlyph: { width: '100%', height: '100%' },

  section: { width: '100%', minWidth: 0, marginBottom: space[4] },
  sectionFolded: { marginBottom: space[2] },
  sessions: { display: 'flex', flexDirection: 'column', width: '100%', minWidth: 0 },
  sessionsCard: {
    backgroundColor: colors.elevatedBackground,
    boxShadow: shadow.card,
    borderRadius: radius.large,
    cornerShape: corner.shape,
  },

  content: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    height: '100%',
    minWidth: 0,
    minHeight: 0,
  },
  toolbarBand: {
    boxSizing: 'border-box',
    flexShrink: 0,
    width: '100%',
    paddingTop: space[4],
    paddingInline: { default: space[4], [WIDE]: space[6] },
  },
  toolbar: {
    display: 'flex',
    flexDirection: { default: 'column', [WIDE]: 'row' },
    alignItems: { default: 'stretch', [WIDE]: 'center' },
    gap: space[2],
    width: '100%',
    minWidth: 0,
    marginBottom: space[3],
  },
  toolbarSearchRow: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: space[1.5],
    minWidth: 0,
  },
  search: { flexGrow: 1, flexShrink: 1, flexBasis: '0%', minWidth: 0 },
  toolbarMenus: { display: 'flex', flexShrink: 0, alignItems: 'center', gap: space[1.5] },
  triggerGlyph: { flexShrink: 0, width: '14px', height: '14px', color: colors.tertiaryLabel },
  triggerLabel: {
    minWidth: 0,
    maxWidth: '120px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  triggerLabelShort: { maxWidth: '104px' },
  searchGlyph: { width: '14px', height: '14px' },
  empty: {
    boxSizing: 'border-box',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    width: '100%',
    minHeight: 0,
    overflowX: 'hidden',
    overflowY: 'auto',
    paddingBottom: space[4],
    paddingInline: { default: space[4], [WIDE]: space[6] },
    textAlign: 'center',
  },
  emptyGlyph: { width: '48px', height: '48px', color: colors.tertiaryLabel },
  emptyTitle: {
    margin: 0,
    marginTop: space[4],
    fontSize: text.bodySize,
    fontWeight: 500,
    lineHeight: text.bodyLeading,
    color: colors.secondaryLabel,
  },
  emptyDescription: {
    margin: 0,
    marginTop: space[1],
    fontSize: text.footnoteSize,
    lineHeight: text.footnoteLeading,
    color: colors.tertiaryLabel,
  },
});

const PR_TONE_STYLES = {
  open: styles.prOpen,
  merged: styles.prMerged,
  closed: styles.prClosed,
  draft: styles.prDraft,
} as const;

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
    tone: 'open',
    label: 'Open',
  },
  merged: {
    icon: GitMerge,
    tone: 'merged',
    label: 'Merged',
  },
  closed: {
    icon: GitPullRequestClosed,
    tone: 'closed',
    label: 'Closed',
  },
  draft: {
    icon: GitPullRequestDraft,
    tone: 'draft',
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

type DesktopArchivedSessionItemProps = ArchivedSessionItemBaseProps & {
  /** Where the row sits in its group's card: the first is not ruled, the ends are rounded. */
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
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
  isFirstInGroup,
  isLastInGroup,
}: DesktopArchivedSessionItemProps) {
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

  const prToneStyle = prStatusMeta ? PR_TONE_STYLES[prStatusMeta.tone] : null;
  const restoreText = restoreAvailable ? restoreLabel : restoreUnavailableLabel;

  return (
    <div
      {...stylex.props(
        stylex.defaultMarker(),
        styles.row,
        depth === 1 && styles.rowNested,
        !isFirstInGroup && styles.rowRuled,
        isFirstInGroup && styles.rowFirst,
        isLastInGroup && styles.rowLast,
        isSelected && styles.rowSelected
      )}
      data-session-depth={depth}
      onClick={handleRowClick}
    >
      {isMultiSelectMode ? (
        <div {...stylex.props(styles.checkboxSlot)}>
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect(session.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${title}`}
          />
        </div>
      ) : (
        <div {...stylex.props(styles.checkboxSlot, styles.revealOnRowHover)}>
          <Checkbox
            checked={false}
            onCheckedChange={() => onEnterMultiSelect(session.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${title}`}
          />
        </div>
      )}

      <div {...stylex.props(styles.iconSlot)}>
        <SessionAgentIcon session={session} className={stylex.props(styles.agentIcon).className} />
      </div>

      <div {...stylex.props(styles.titleCell)}>
        <Tooltip.Root>
          <Tooltip.Trigger
            delay={300}
            render={
              <span
                role="button"
                tabIndex={0}
                aria-pressed={isMultiSelectMode ? isSelected : undefined}
                data-id={`archive-session:${session.id}`}
                data-scope-item="row"
                {...stylex.props(styles.title)}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return;
                  event.preventDefault();
                  handleRowClick();
                }}
              >
                {title}
              </span>
            }
          />
          <Tooltip.Content side="top">{title}</Tooltip.Content>
        </Tooltip.Root>
      </div>

      <div {...stylex.props(styles.prSlot)}>
        {prUrl && PrIcon && prStatusMeta && (
          <Tooltip.Root>
            <Tooltip.Trigger
              delay={300}
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="mini"
                  icon
                  aria-label={prTooltipLabel}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    window.open(prUrl, '_blank', 'noopener,noreferrer');
                  }}
                >
                  <PrIcon {...stylex.props(styles.glyph, prToneStyle)} />
                </Button>
              }
            />
            <Tooltip.Content side="top">{prTooltipLabel}</Tooltip.Content>
          </Tooltip.Root>
        )}
      </div>

      <div {...stylex.props(styles.branchCell)}>
        {branchName ? (
          <Tooltip.Root>
            <Tooltip.Trigger
              delay={300}
              render={<span {...stylex.props(styles.meta, styles.truncate)}>{branchName}</span>}
            />
            <Tooltip.Content side="top">{branchName}</Tooltip.Content>
          </Tooltip.Root>
        ) : null}
      </div>

      <span {...stylex.props(styles.meta, styles.time)}>{relativeTime}</span>

      <div {...stylex.props(styles.diffCell)}>
        {hasChanges ? (
          <>
            <span {...stylex.props(styles.added)}>+{diffStats.allChange.add}</span>
            <span {...stylex.props(styles.removed)}>-{diffStats.allChange.del}</span>
          </>
        ) : null}
      </div>

      <div {...stylex.props(styles.iconSlot)}>
        {owner && (
          <Tooltip.Root>
            <Tooltip.Trigger
              delay={500}
              render={
                <span {...stylex.props(styles.avatarAnchor)}>
                  <UserAvatar user={owner} size="mini" />
                </span>
              }
            />
            <Tooltip.Content side="top">{owner.name ?? 'Unknown'}</Tooltip.Content>
          </Tooltip.Root>
        )}
      </div>

      <div {...stylex.props(styles.actions, !isMultiSelectMode && styles.actionsLive)}>
        <Tooltip.Root>
          <Tooltip.Trigger
            delay={300}
            render={
              <Button
                type="button"
                variant="ghost"
                size="mini"
                icon
                aria-label={restoreText}
                disabled={!restoreAvailable}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onRestore(session.id);
                }}
              >
                <Undo2 {...stylex.props(styles.glyph)} />
              </Button>
            }
          />
          <Tooltip.Content side="top">{restoreText}</Tooltip.Content>
        </Tooltip.Root>

        <Tooltip.Root>
          <Tooltip.Trigger
            delay={300}
            render={
              <Button
                type="button"
                variant="ghost"
                size="mini"
                icon
                tone="destructive"
                aria-label={deleteLabel}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onDelete(session);
                }}
              >
                <Trash2 {...stylex.props(styles.glyph)} />
              </Button>
            }
          />
          <Tooltip.Content side="top">{deleteLabel}</Tooltip.Content>
        </Tooltip.Root>
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
      {...stylex.props(styles.mobileRow, depth === 1 && styles.mobileRowNested)}
      data-session-depth={depth}
      onClick={handleRowClick}
      onTouchStart={handleTouchStart}
      onTouchEnd={clearLongPressTimer}
      onTouchMove={clearLongPressTimer}
    >
      {isMultiSelectMode && (
        <div {...stylex.props(styles.checkboxSlot, styles.mobileCheckboxSlot)}>
          <Checkbox
            checked={isSelected}
            onCheckedChange={() => onToggleSelect(session.id)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select ${title}`}
          />
        </div>
      )}

      <div {...stylex.props(styles.mobileBody, isMultiSelectMode && styles.mobileBodySelecting)}>
        <div {...stylex.props(styles.mobileIconSlot)}>
          <SessionAgentIcon
            session={session}
            className={stylex.props(styles.agentIcon).className}
          />
        </div>

        <div {...stylex.props(styles.mobileText)}>
          <div {...stylex.props(styles.mobileLine)}>
            <span
              role="button"
              tabIndex={0}
              aria-pressed={isMultiSelectMode ? isSelected : undefined}
              data-id={`archive-session:${session.id}`}
              data-scope-item="row"
              {...stylex.props(styles.mobileTitle)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.preventDefault();
                handleRowClick();
              }}
            >
              {title}
            </span>
            {hasChanges && (
              <div {...stylex.props(styles.mobileDiff)}>
                <span {...stylex.props(styles.added)}>+{diffStats.allChange.add}</span>
                <span {...stylex.props(styles.removed)}>-{diffStats.allChange.del}</span>
              </div>
            )}
            <span {...stylex.props(styles.meta, styles.mobileTime)}>{relativeTime}</span>
            {owner && (
              <Tooltip.Root>
                <Tooltip.Trigger
                  delay={500}
                  render={
                    <span {...stylex.props(styles.avatarAnchor)}>
                      <UserAvatar user={owner} size="mini" />
                    </span>
                  }
                />
                <Tooltip.Content side="top">{owner.name ?? 'Unknown'}</Tooltip.Content>
              </Tooltip.Root>
            )}
          </div>

          <div {...stylex.props(styles.meta, styles.mobileMetaLine)}>
            {!restoreAvailable ? (
              <span {...stylex.props(styles.removedNote)}>
                <CircleAlert {...stylex.props(styles.noteGlyph)} aria-hidden="true" />
                {removedProjectLabel}
              </span>
            ) : null}
            {prUrl && PrIcon && prStatusMeta && (
              <Tooltip.Root>
                <Tooltip.Trigger
                  delay={300}
                  render={
                    <button
                      type="button"
                      {...stylex.props(styles.mobilePrLink)}
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        window.open(prUrl, '_blank', 'noopener,noreferrer');
                      }}
                    >
                      <PrIcon
                        {...stylex.props(styles.noteGlyph, PR_TONE_STYLES[prStatusMeta.tone])}
                      />
                    </button>
                  }
                />
                <Tooltip.Content side="top">{prTooltipLabel}</Tooltip.Content>
              </Tooltip.Root>
            )}
            {branchName && (
              <Tooltip.Root>
                <Tooltip.Trigger
                  delay={300}
                  render={<span {...stylex.props(styles.mobileBranch)}>{branchName}</span>}
                />
                <Tooltip.Content side="top">{branchName}</Tooltip.Content>
              </Tooltip.Root>
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
      actions={[
        ...(restoreAvailable
          ? [
              {
                key: 'restore',
                label: restoreActionLabel,
                ariaLabel: restoreLabel,
                icon: <Undo2 {...stylex.props(styles.glyph)} />,
                hideLabel: hideActionLabels,
                className: stylex.props(styles.swipeRestore).className,
                onClick: () => onRestore(session.id),
              },
            ]
          : []),
        {
          key: 'delete',
          label: deleteActionLabel,
          ariaLabel: deleteLabel,
          icon: <Trash2 {...stylex.props(styles.glyph)} />,
          hideLabel: hideActionLabels,
          className: stylex.props(styles.swipeDelete).className,
          onClick: () => onDelete(session),
        },
      ]}
    >
      {row}
    </SwipeActionRow>
  );
}

type ArchivedSessionGroupHeaderProps = {
  group: ArchivedSessionGroup;
  chatLabel: string;
  removedProjectLabel: string;
  isMultiSelectMode: boolean;
  selectedIds: Set<SessionId>;
  onToggleCollapse: () => void;
  onToggleGroupSelect: (groupKey: string, sessionIds: SessionId[]) => void;
};

function ArchivedSessionGroupHeader({
  group,
  chatLabel,
  removedProjectLabel,
  isMultiSelectMode,
  selectedIds,
  onToggleCollapse,
  onToggleGroupSelect,
}: ArchivedSessionGroupHeaderProps) {
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

  return (
    <div {...stylex.props(styles.headerSlot, isLocal && styles.headerSlotLocal)}>
      <button
        type="button"
        data-id={`archive-group:${groupKey}`}
        data-scope-item="row"
        onClick={onToggleCollapse}
        {...stylex.props(stylex.defaultMarker(), styles.header)}
      >
        {isMultiSelectMode && (
          <div
            {...stylex.props(styles.headerCheckbox)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') e.stopPropagation();
            }}
          >
            <Checkbox
              checked={allSelected}
              indeterminate={someSelected}
              onCheckedChange={() => onToggleGroupSelect(groupKey, groupSessionIds)}
              aria-label={`Select all in ${label}`}
            />
          </div>
        )}
        <span {...stylex.props(styles.headerGlyphSlot)}>
          <HeaderIcon
            {...stylex.props(
              styles.headerGlyph,
              isMultiSelectMode ? styles.hidden : styles.kindGlyph
            )}
          />
          <ChevronDown
            {...stylex.props(
              styles.headerGlyph,
              isMultiSelectMode ? styles.hidden : styles.foldGlyph,
              group.collapsed && styles.folded
            )}
          />
        </span>
        {isLocal ? (
          <span {...stylex.props(styles.headerLabel)}>
            <span {...stylex.props(styles.headerLocal)}>
              <span {...stylex.props(styles.headerLocalName)}>{group.local?.name ?? label}</span>
              <span
                {...stylex.props(styles.headerLocalPath)}
                title={group.local?.title ?? undefined}
              >
                {group.local?.path ?? label}
              </span>
            </span>
          </span>
        ) : (
          <span {...stylex.props(styles.headerLabel)}>{label}</span>
        )}
        <span {...stylex.props(styles.headerCount)}>({group.sessions.length})</span>
        {!restoreAvailable ? (
          <Badge icon={<CircleAlert {...stylex.props(styles.badgeGlyph)} aria-hidden="true" />}>
            {removedProjectLabel}
          </Badge>
        ) : null}
      </button>
    </div>
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
  const showHeader = !hideGroupHeader;
  const showSessions = hideGroupHeader || !group.collapsed;
  const sessionTree = useMemo(() => buildArchivedSessionTree(group.sessions), [group.sessions]);

  return (
    <div {...stylex.props(styles.section, group.collapsed && showHeader && styles.sectionFolded)}>
      {showHeader ? (
        <ArchivedSessionGroupHeader
          group={group}
          chatLabel={chatLabel}
          removedProjectLabel={removedProjectLabel}
          isMultiSelectMode={isMultiSelectMode}
          selectedIds={selectedIds}
          onToggleCollapse={onToggleCollapse}
          onToggleGroupSelect={onToggleGroupSelect}
        />
      ) : null}

      {showSessions ? (
        <div {...stylex.props(styles.sessions, !isMobile && styles.sessionsCard)}>
          {sessionTree.map(({ item: session, depth }, index) => (
            <ArchivedSessionRow
              key={session.id}
              group={group}
              session={session}
              depth={depth}
              isFirstInGroup={index === 0}
              isLastInGroup={index === sessionTree.length - 1}
              now={now}
              isMobile={isMobile}
              onRestore={onRestore}
              onDelete={onDelete}
              onNavigate={onNavigate}
              restoreLabel={restoreLabel}
              restoreUnavailableLabel={restoreUnavailableLabel}
              removedProjectLabel={removedProjectLabel}
              restoreActionLabel={restoreActionLabel}
              deleteLabel={deleteLabel}
              deleteActionLabel={deleteActionLabel}
              isMultiSelectMode={isMultiSelectMode}
              isSelected={selectedIds.has(session.id)}
              onToggleSelect={onToggleSelect}
              onEnterMultiSelect={onEnterMultiSelect}
              owner={membersByUserId.get(session.userId)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ArchivedSessionRow({
  group,
  session,
  depth,
  isFirstInGroup,
  isLastInGroup,
  now,
  isMobile,
  onRestore,
  onDelete,
  onNavigate,
  restoreLabel,
  restoreUnavailableLabel,
  removedProjectLabel,
  restoreActionLabel,
  deleteLabel,
  deleteActionLabel,
  isMultiSelectMode,
  isSelected,
  onToggleSelect,
  onEnterMultiSelect,
  owner,
}: {
  group: ArchivedSessionGroup;
  session: SessionMeta;
  depth: 0 | 1;
  isFirstInGroup: boolean;
  isLastInGroup: boolean;
  now: Date;
  isMobile: boolean;
  onRestore: (sessionId: SessionId) => void;
  onDelete: (session: SessionMeta) => void;
  onNavigate: (sessionId: SessionId) => void;
  restoreLabel: string;
  restoreUnavailableLabel: string;
  removedProjectLabel: string;
  restoreActionLabel: string;
  deleteLabel: string;
  deleteActionLabel: string;
  isMultiSelectMode: boolean;
  isSelected: boolean;
  onToggleSelect: (sessionId: SessionId) => void;
  onEnterMultiSelect: (sessionId: SessionId) => void;
  owner?: { name?: string | null; image?: string | null } | null;
}) {
  const restoreAvailable = group.kind !== 'local' || group.local?.available === true;
  if (isMobile) {
    return (
      <MobileArchivedSessionItem
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
        isSelected={isSelected}
        onToggleSelect={onToggleSelect}
        onEnterMultiSelect={onEnterMultiSelect}
        owner={owner}
      />
    );
  }
  return (
    <DesktopArchivedSessionItem
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
      isSelected={isSelected}
      onToggleSelect={onToggleSelect}
      onEnterMultiSelect={onEnterMultiSelect}
      owner={owner}
      isFirstInGroup={isFirstInGroup}
      isLastInGroup={isLastInGroup}
    />
  );
}

export type ArchiveSessionListProps = Omit<
  ArchivedSessionGroupSectionProps,
  'group' | 'onToggleCollapse' | 'hideGroupHeader'
> & {
  groups: ArchivedSessionGroup[];
  hideGroupHeader: boolean;
  listScopeId: string;
  onToggleCollapse: (groupKey: string) => void;
  resetScrollKey?: string;
};

export function ArchiveSessionList({
  groups,
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
  hideGroupHeader,
  listScopeId,
  resetScrollKey,
}: ArchiveSessionListProps) {
  const rows = useMemo(
    () => flattenVisibleArchiveRows(groups, { hideGroupHeader }),
    [groups, hideGroupHeader]
  );
  const groupByKey = useMemo(() => {
    const map = new Map<string, ArchivedSessionGroup>();
    for (const group of groups) map.set(group.key, group);
    return map;
  }, [groups]);
  // A session row opens its group's card when the row above it is not one of the group's sessions.
  const firstSessionKeys = useMemo(() => {
    const keys = new Set<string>();
    rows.forEach((row, index) => {
      if (row.kind !== 'session') return;
      const previous = rows[index - 1];
      if (previous?.kind !== 'session' || previous.groupKey !== row.groupKey) keys.add(row.key);
    });
    return keys;
  }, [rows]);
  const sessionById = useMemo(() => {
    const map = new Map<SessionId, SessionMeta>();
    for (const group of groups) {
      for (const session of group.sessions) map.set(session.id, session);
    }
    return map;
  }, [groups]);

  const renderRow = useCallback(
    (row: ArchiveVirtualRow) => {
      const group = groupByKey.get(row.groupKey);
      if (!group) return null;
      if (row.kind === 'header') {
        return (
          <ArchivedSessionGroupHeader
            group={group}
            chatLabel={chatLabel}
            removedProjectLabel={removedProjectLabel}
            isMultiSelectMode={isMultiSelectMode}
            selectedIds={selectedIds}
            onToggleCollapse={() => onToggleCollapse(row.groupKey)}
            onToggleGroupSelect={onToggleGroupSelect}
          />
        );
      }
      const session = sessionById.get(row.sessionId);
      if (!session) return null;
      return (
        <ArchivedSessionRow
          group={group}
          session={session}
          depth={row.depth}
          isFirstInGroup={firstSessionKeys.has(row.key)}
          isLastInGroup={row.isLastInGroup}
          now={now}
          isMobile={isMobile}
          onRestore={onRestore}
          onDelete={onDelete}
          onNavigate={onNavigate}
          restoreLabel={restoreLabel}
          restoreUnavailableLabel={restoreUnavailableLabel}
          removedProjectLabel={removedProjectLabel}
          restoreActionLabel={restoreActionLabel}
          deleteLabel={deleteLabel}
          deleteActionLabel={deleteActionLabel}
          isMultiSelectMode={isMultiSelectMode}
          isSelected={selectedIds.has(session.id)}
          onToggleSelect={onToggleSelect}
          onEnterMultiSelect={onEnterMultiSelect}
          owner={membersByUserId.get(session.userId)}
        />
      );
    },
    [
      chatLabel,
      deleteActionLabel,
      deleteLabel,
      firstSessionKeys,
      groupByKey,
      isMobile,
      isMultiSelectMode,
      membersByUserId,
      now,
      onDelete,
      onEnterMultiSelect,
      onNavigate,
      onRestore,
      onToggleCollapse,
      onToggleGroupSelect,
      onToggleSelect,
      removedProjectLabel,
      restoreActionLabel,
      restoreLabel,
      restoreUnavailableLabel,
      selectedIds,
      sessionById,
    ]
  );

  return (
    <ArchiveListWindow
      rows={rows}
      isMobile={isMobile}
      listScopeId={listScopeId}
      renderRow={renderRow}
      resetScrollKey={resetScrollKey}
    />
  );
}

export function ArchiveView() {
  const { t } = useTranslation();
  const listScopeId = useId();
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
  const chevron = <ChevronDown {...stylex.props(styles.triggerGlyph)} aria-hidden="true" />;
  const GroupGlyph = groupMode === 'flat' ? List : Layers;
  const SortGlyph =
    sortMode === 'title' ? ArrowDownAZ : sortMode === 'oldest' ? Clock : ArrowUpDown;
  const archiveToolbar = (
    <div {...stylex.props(styles.toolbar)}>
      <div {...stylex.props(styles.toolbarSearchRow)}>
        <Input
          type="search"
          size="small"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder={t('archive.searchPlaceholder', 'Search archived sessions…')}
          aria-label={t('archive.search', 'Search archive')}
          leading={<Search {...stylex.props(styles.searchGlyph)} aria-hidden="true" />}
          className={stylex.props(styles.search).className}
        />
        {isMobile ? (
          <Menu.Root>
            <Menu.Trigger
              render={
                <Button type="button" variant="ghost" size="small">
                  <span {...stylex.props(styles.triggerLabel, styles.triggerLabelShort)}>
                    {scopeLabel}
                  </span>
                  {chevron}
                </Button>
              }
            />
            <Menu.Content align="end">
              <Menu.RadioGroup
                value={archiveScope}
                onValueChange={(value) => {
                  if (value === 'my' || value === 'team') setArchiveScope(value);
                }}
              >
                <Menu.RadioItem value="my">{t('sessions.sidebar.my', 'My Tasks')}</Menu.RadioItem>
                <Menu.RadioItem value="team">
                  {t('sessions.sidebar.team', 'All Tasks')}
                </Menu.RadioItem>
              </Menu.RadioGroup>
            </Menu.Content>
          </Menu.Root>
        ) : null}
      </div>
      <div {...stylex.props(styles.toolbarMenus)}>
        <Menu.Root>
          <Menu.Trigger
            render={
              <Button type="button" variant="ghost" size="small">
                <GroupGlyph {...stylex.props(styles.triggerGlyph)} aria-hidden="true" />
                <span {...stylex.props(styles.triggerLabel)}>{groupLabel}</span>
                {chevron}
              </Button>
            }
          />
          <Menu.Content align="end">
            <Menu.RadioGroup
              value={groupMode}
              onValueChange={(value) => {
                if (value === 'project' || value === 'flat') setGroupMode(value);
              }}
            >
              <Menu.RadioItem value="project">
                {t('archive.group.project', 'By project')}
              </Menu.RadioItem>
              <Menu.RadioItem value="flat">{t('archive.group.flat', 'One list')}</Menu.RadioItem>
            </Menu.RadioGroup>
          </Menu.Content>
        </Menu.Root>

        <Menu.Root>
          <Menu.Trigger
            render={
              <Button type="button" variant="ghost" size="small">
                <SortGlyph {...stylex.props(styles.triggerGlyph)} aria-hidden="true" />
                <span {...stylex.props(styles.triggerLabel)}>{sortLabel}</span>
                {chevron}
              </Button>
            }
          />
          <Menu.Content align="end">
            <Menu.RadioGroup
              value={sortMode}
              onValueChange={(value) => {
                if (value === 'newest' || value === 'oldest' || value === 'title') {
                  setSortMode(value);
                }
              }}
            >
              <Menu.RadioItem value="newest">
                {t('archive.sort.newest', 'Newest first')}
              </Menu.RadioItem>
              <Menu.RadioItem value="oldest">
                {t('archive.sort.oldest', 'Oldest first')}
              </Menu.RadioItem>
              <Menu.RadioItem value="title">{t('archive.sort.title', 'Title A–Z')}</Menu.RadioItem>
            </Menu.RadioGroup>
          </Menu.Content>
        </Menu.Root>
      </div>
    </div>
  );

  const archiveContent = (
    <div {...stylex.props(styles.content)}>
      <div {...stylex.props(styles.toolbarBand)}>{archiveToolbar}</div>
      {groupedSessions.length === 0 || filteredArchivedSessions.length === 0 ? (
        <div {...stylex.props(styles.empty)}>
          <Archive {...stylex.props(styles.emptyGlyph)} />
          <p {...stylex.props(styles.emptyTitle)}>{emptyLabel}</p>
          <p {...stylex.props(styles.emptyDescription)}>{emptyDescription}</p>
        </div>
      ) : (
        <ArchiveSessionList
          groups={groupedSessions}
          now={now}
          onRestore={handleRestore}
          onDelete={handleDelete}
          onNavigate={handleNavigateToSession}
          onToggleCollapse={handleToggleCollapse}
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
          listScopeId={listScopeId}
          resetScrollKey={`${archiveScope}:${groupMode}:${sortMode}:${normalizedSearchQuery}`}
        />
      )}
    </div>
  );

  const archiveDialogs = (
    <>
      {/* Single-item delete confirm dialog */}
      <Dialog.Root
        open={deleteConfirmSession != null}
        onOpenChange={(open) => setDeleteConfirmSession(open ? deleteConfirmSession : null)}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>{t('archive.deleteConfirm.title', 'Delete permanently?')}</Dialog.Title>
            <Dialog.Description>
              {deleteConfirmSession?.repoFullName
                ? t(
                    'archive.deleteConfirm.description.codeSession',
                    "This will delete the session and remove the session branch's worktree directory on your machine."
                  )
                : t(
                    'archive.deleteConfirm.description.chatSession',
                    'This will permanently delete the chat session.'
                  )}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button variant="secondary" onClick={() => setDeleteConfirmSession(null)}>
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
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>

      {/* Bulk delete confirm dialog */}
      <Dialog.Root
        open={bulkDeleteConfirmOpen}
        onOpenChange={(open) => {
          if (bulkActionInFlight === 'delete') return;
          setBulkDeleteConfirmOpen(open);
        }}
      >
        <Dialog.Content>
          <Dialog.Header>
            <Dialog.Title>
              {t('archive.bulkDeleteConfirm.title', 'Delete {{count}} sessions permanently?', {
                count: selectedCount,
              })}
            </Dialog.Title>
            <Dialog.Description>
              {hasCodeSessionInSelection
                ? t(
                    'archive.bulkDeleteConfirm.description.mixed',
                    'This will delete the selected sessions. Code sessions will also have their worktree directories removed from your machine.'
                  )
                : t(
                    'archive.bulkDeleteConfirm.description.chatOnly',
                    'This will permanently delete the selected sessions.'
                  )}
            </Dialog.Description>
          </Dialog.Header>
          <Dialog.Footer>
            <Button
              variant="secondary"
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
          </Dialog.Footer>
        </Dialog.Content>
      </Dialog.Root>
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
