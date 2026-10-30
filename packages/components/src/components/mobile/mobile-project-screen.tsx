import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive,
  ChevronDown,
  ChevronLeft,
  File as FileIcon,
  Github,
  Hand,
  MessageCircle,
  Pin,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { MdChat, MdSettings } from 'react-icons/md';
import { FaRegFileCode } from 'react-icons/fa';
import type { IconType } from 'react-icons';
import type { SessionPullRequestCiState, SessionPullRequestReadiness } from '@lody/shared';
import { isNativeAppShell } from '@/lib/native-platform';
import { consumeMobileBackNavigation } from '@/lib/mobile-back-navigation';
import { cn } from '@/lib/utils';
import { withClassName } from '@/lib/stylex';
import { useLongPress } from '@/hooks/use-long-press';
import { Checkbox } from '@lody/ui/checkbox';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { WorktreeIcon } from '@/components/icons/worktree-icon';
import {
  SessionMergeablePill,
  SessionPrIcon,
  SessionRowAuthorAvatar,
  type SessionRowOpenedByTreeSlot,
} from '@/components/sidebar-row-shared';
import { MobileEdgeBackSwipeZone } from './mobile-edge-back-swipe';
import { MobileFilterPillBar, type FilterPill } from './mobile-filter-pill-bar';
import {
  MobileChatList,
  type MobileChatGroupBy,
  type MobileChatListSelectionLabels,
} from './mobile-chat-list';
import { MobileInitialLetterAvatar } from './mobile-initial-letter-avatar';
import {
  MobileWorkspaceTabBar,
  type MobileBottomTabBarTabSpec,
  type MobileWorkspaceTabBarScrollSignal,
} from './mobile-workspace-tabbar';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';

const darkColors = {
  border: {
    default: '#ffffff1f',
    '@supports (color: color-mix(in lab, red, red))':
      'color-mix(in oklab, var(--color-white) 12%, transparent)',
  },
  idle: {
    default: '#ffffff1a',
    '@supports (color: color-mix(in lab, red, red))':
      'color-mix(in oklab, var(--color-white) 10%, transparent)',
  },
  feedback: {
    default: '#ffffff24',
    '@supports (color: color-mix(in lab, red, red))':
      'color-mix(in oklab, var(--color-white) 14%, transparent)',
  },
} as const;

const styles = stylex.create({
  statusRunning: { color: 'hsl(var(--primary) / 1)' },
  /** A react-icon, sized to fill its box. */
  reactIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The status mark in a row's leading slot. */
  statusGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
  },
  statusWaiting: { color: themeColors.statusWarning },
  statusWorking: { color: themeColors.primary },
  /** The dot that says a conversation is unread. */
  unreadDot: {
    display: 'inline-block',
    width: themeSpace[2],
    height: themeSpace[2],
    flexShrink: 0,
    borderRadius: '9999px',
    backgroundColor: themeColors.primary,
  },

  /** The widened leading slot of an opened conversation. */
  treeChildSlot: { width: themeSpace[8], justifyContent: 'flex-start' },
  /** The plain leading slot of a top-level row. */
  treeSlot: { width: themeSpace[4], justifyContent: 'center' },
  /** The node's centre: the trunk, the elbow and the glyph all start here. */
  treeNodeStart: { insetInlineStart: '23px' },
  /** The elbow that reaches the child's content. */
  treeElbowWidth: { width: '21px' },
  /** The trunk and the elbow's own line. */
  treeLine: { backgroundColor: 'hsl(var(--muted-foreground) / 0.3)' },
  /** The connector that runs the row's full height. */
  treeConnector: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    pointerEvents: 'none',
  },
  /** The trunk. */
  treeTrunk: {
    position: 'absolute',
    top: 0,
    width: '1px',
  },
  treeTrunkLast: { height: '50%' },
  treeTrunkFull: { bottom: 0 },
  /** The elbow. */
  treeElbow: {
    position: 'absolute',
    top: '50%',
    height: '1px',
  },
  /** The opener's fold control. */
  treeToggle: {
    position: 'absolute',
    top: '50%',
    zIndex: 30,
    display: 'flex',
    height: themeSpace[9],
    width: themeSpace[7],
    alignItems: 'center',
    justifyContent: 'center',
    translate: '0 -50%',
    insetInlineStart: '9px',
    borderRadius: themeRadius.md,
    color: themeColors.mutedForeground,
    backgroundColor: { default: null, ':active': 'hsl(var(--muted) / 0.6)' },
  },
  /** The fold control's chevron. */
  treeChevron: {
    width: themeSpace[4],
    height: themeSpace[4],
    rotate: '0deg',
    transitionProperty: 'transform',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0, 0, 0.2, 1)',
  },
  treeChevronClosed: { rotate: '-90deg' },

  /** The conversation row itself. */
  row: {
    position: 'relative',
    display: 'flex',
    minHeight: themeSpace[11],
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[2.5],
    borderWidth: 0,
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[2.5],
    paddingBottom: themeSpace[2.5],
    textAlign: 'left',
    boxShadow: 'none',
    ...TRANSITION_COLORS,
  },
  /** The row at rest. */
  rowIdle: {
    backgroundColor: { default: themeColors.background, ':active': 'hsl(var(--muted) / 0.4)' },
  },
  /** The selected row. */
  rowSelected: { backgroundColor: 'hsl(var(--muted) / 0.5)' },
  /** The row in a multi-select, picked. */
  rowPicked: { backgroundColor: 'hsl(var(--primary) / 0.1)' },
  /** A row's leading slot. */
  rowSlot: {
    display: 'flex',
    height: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
  },
  /** A row's title cluster. */
  rowTitleLine: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  /** A row's title. */
  rowTitle: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '15px',
    fontWeight: themeFontWeight.medium,
    lineHeight: 1.375,
    letterSpacing: '-0.01em',
    color: themeColors.foreground,
  },
  /** An archived row's title. */
  rowTitleArchived: { color: themeColors.mutedForeground },
  /** The pin mark. */
  rowPin: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  /** The line-diff numbers. */
  rowDiff: {
    flexShrink: 0,
    fontSize: '11px',
    lineHeight: 1,
    letterSpacing: '-0.025em',
    fontVariantNumeric: 'tabular-nums',
  },
  rowDiffAdded: { color: themeColors.githubAddition },
  rowDiffRemoved: {
    marginInlineStart: themeSpace[1],
    color: themeColors.githubDeletion,
  },
  /** The worktree mark. */
  rowWorktree: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground) / 0.55)',
  },

  /** The screen's own column. */
  screen: {
    position: 'relative',
    height: '100%',
    minHeight: 0,
    width: '100%',
    overflow: 'hidden',
    color: themeColors.foreground,
  },
  /** The shell the header + list stack in. */
  shell: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    backgroundColor: themeColors.background,
  },
  /** The filter pill bar's accordion. */
  accordion: { overflow: 'hidden' },
  /** The scrolling region. */
  scroll: {
    position: 'relative',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
    paddingTop: themeSpace[1],
    paddingBottom: 'calc(var(--mobile-tabbar-height) + var(--k-safe-area-bottom, 0px) + 1rem)',
    scrollbarGutter: 'auto',
  },
  /** The row that holds the filter toggle above an empty list. */
  filterRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[2],
    paddingBottom: themeSpace[1.5],
  },

  /** A placeholder page: the same shell the empty conversation state uses. */
  placeholder: {
    display: 'flex',
    marginInline: themeSpace[3],
    marginTop: themeSpace[3],
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[12],
    paddingBottom: themeSpace[12],
    textAlign: 'center',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
  },
  placeholderTitle: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  placeholderBody: {
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    color: themeColors.mutedForeground,
  },

  /** The header row of the chat tab. */
  chatHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 30,
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingTop: 'calc(var(--k-safe-area-top) + var(--spacing) * 2)',
    paddingBottom: themeSpace[2],
    paddingInlineStart: 'calc(var(--k-safe-area-left) + var(--spacing) * 3)',
    paddingInlineEnd: 'calc(var(--k-safe-area-right) + var(--spacing) * 3)',
  },
  /** The header row of the files / settings tabs. */
  plainHeader: {
    position: 'sticky',
    top: 0,
    zIndex: 30,
    display: 'grid',
    gridTemplateColumns: '2.25rem minmax(0, 1fr) 2.25rem',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingTop: 'calc(var(--k-safe-area-top) + var(--spacing) * 2)',
    paddingBottom: themeSpace[2],
    paddingInlineStart: 'calc(var(--k-safe-area-left) + var(--spacing) * 3)',
    paddingInlineEnd: 'calc(var(--k-safe-area-right) + var(--spacing) * 3)',
  },
  /** The centred project identity. */
  identity: {
    display: 'flex',
    minWidth: 0,
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
  },
  identityName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.98rem',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '-0.025em',
  },

  /** A chip in the header's corner. */
  headerChip: {
    display: 'inline-flex',
    width: themeSpace[9],
    height: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    scale: { default: null, ':active': '0.97' },
    ...TRANSITION_COLORS,
  },
  headerChipActive: {
    borderColor: 'hsl(var(--primary) / 0.4)',
    backgroundColor: 'hsl(var(--primary) / 0.15)',
    color: themeColors.primary,
  },
  headerChipIdle: {
    borderColor: { default: 'hsl(var(--border) / 0.5)', [DARK_SCOPE]: darkColors.border },
    backgroundColor: {
      default: themeColors.muted,
      ':active': 'hsl(var(--muted) / 0.8)',
      [DARK_SCOPE]: { ...darkColors.idle, ':active': darkColors.feedback },
    },
    color: themeColors.foreground,
  },

  /** The filter chip on the first group heading. */
  filterChip: {
    position: 'relative',
    display: 'inline-flex',
    width: themeSpace[8],
    height: themeSpace[8],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: 'hsl(var(--border) / 0.5)', [DARK_SCOPE]: darkColors.border },
    backgroundColor: {
      default: themeColors.muted,
      ':hover': 'hsl(var(--muted) / 0.8)',
      [DARK_SCOPE]: {
        ...darkColors.idle,
        ':hover': { ...darkColors.idle, '@media (hover: hover)': darkColors.feedback },
      },
    },
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
    scale: { default: null, ':active': '0.97' },
    // The global "Pro focus style" paints an inset ring on every focused
    // input and button; the picker's own focus-scoped ring never painted
    // (the app zeroes Tailwind's ring on focus), so it must not appear
    // here either.
    boxShadow: { default: null, ':focus-visible': 'none' },
    ...TRANSITION_COLORS,
  },
  /** The filter chip while the bar is open. */
  filterChipOpen: {
    borderColor: { default: 'hsl(var(--primary) / 0.4)', [DARK_SCOPE]: darkColors.border },
    // The original dark utilities override the open fill too; composing an
    // ordinary open color here would erase the base style's dark conditions.
    backgroundColor: {
      default: 'hsl(var(--primary) / 0.15)',
      [DARK_SCOPE]: {
        ...darkColors.idle,
        ':hover': { ...darkColors.idle, '@media (hover: hover)': darkColors.feedback },
      },
    },
    color: themeColors.primary,
  },
  /** The filter chip's glyph. */
  filterChipGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    color: 'currentColor',
  },
  /** The dot that says filters are applied. */
  filterDot: {
    position: 'absolute',
    top: themeSpace[1],
    right: themeSpace[1],
    width: themeSpace[1.5],
    height: themeSpace[1.5],
    borderRadius: '9999px',
    backgroundColor: themeColors.primary,
  },

  /** The project avatar. */
  avatar: {
    width: themeSpace[6],
    height: themeSpace[6],
    flexShrink: 0,
    borderRadius: themeRadius.full,
    objectFit: 'cover',
  },
  avatarGlyph: {
    width: themeSpace[6],
    height: themeSpace[6],
    flexShrink: 0,
  },

  /** The search pill in the header. */
  searchPill: {
    display: 'flex',
    height: themeSpace[9],
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    paddingInline: themeSpace[3],
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: 'hsl(var(--border) / 0.5)', [DARK_SCOPE]: darkColors.border },
    backgroundColor: {
      default: themeColors.muted,
      ':focus-within': 'hsl(var(--muted) / 0.8)',
      [DARK_SCOPE]: { ...darkColors.idle, ':focus-within': darkColors.feedback },
    },
    color: themeColors.foreground,
    ...TRANSITION_COLORS,
  },
  searchGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  searchInput: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    borderStyle: 'none',
    backgroundColor: 'transparent',
    fontSize: '0.82rem',
    // The global "Pro focus style" paints an inset ring on every focused
    // input and button; the picker's own focus-scoped ring never painted
    // (the app zeroes Tailwind's ring on focus), so it must not appear
    // here either.
    boxShadow: { default: null, ':focus-visible': 'none' },
    '::placeholder': { color: themeColors.mutedForeground },
  },
  /** The button that clears the search. */
  searchClear: {
    display: 'inline-flex',
    marginRight: 'calc(var(--spacing) * -1)',
    width: themeSpace[6],
    height: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    color: { default: themeColors.mutedForeground, ':hover': themeColors.foreground },
    backgroundColor: { default: null, ':hover': 'hsl(var(--muted) / 0.6)' },
    ...TRANSITION_COLORS,
  },
  searchClearGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
  },

  /** The wrapper that lets the fold chevron sit beside the row button. */
  treeOpenerWrap: { position: 'relative' },
  /** The glyph of a placeholder page. */
  placeholderIcon: {
    width: themeSpace[8],
    height: themeSpace[8],
    color: 'hsl(var(--muted-foreground) / 0.7)',
  },
  /** The tab bar's glyphs. */
  tabIcon: {
    width: themeSpace[6],
    height: themeSpace[6],
  },
  /** The header's back chevron. */
  headerChevron: {
    width: themeSpace[5],
    height: themeSpace[5],
  },
  /** The header's archive mark. */
  headerArchive: {
    width: themeSpace[4],
    height: themeSpace[4],
  },
  /** The search column in the header. */
  searchColumn: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  /** Said to a screen reader and to nobody else. */
  srOnly: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    margin: '-1px',
    padding: 0,
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },

  /** The empty conversation state. */
  emptyState: {
    marginInline: themeSpace[3],
    marginTop: themeSpace[3],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[6],
    paddingBottom: themeSpace[6],
    textAlign: 'center',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
});

function MobileReactIcon({ icon: Icon, className }: { icon: IconType; className?: string }) {
  /* Fill the sized wrapper — not size="1em" (inherits the tab label's 0.72rem). */
  return (
    <span
      {...withClassName(
        stylex.props(styles.reactIcon),
        cn('[&_svg]:h-full [&_svg]:w-full', className)
      )}
      aria-hidden="true"
    >
      <Icon />
    </span>
  );
}

/* --------------------------------------------------------------------------
 * Data types — kept aligned with desktop SessionList's SessionListRow where they
 * overlap so chat-landing can feed the same metas in. The mobile row is a
 * cut-down view, not a re-skin, so it owns its own type rather than
 * importing SessionListRow wholesale.
 * ----------------------------------------------------------------------- */

export type MobileProjectKind = 'local' | 'github';

export type MobileProjectContext =
  | {
      kind: 'local';
      machineId: string;
      projectId: string;
      /** Display name (e.g. "lody"). */
      name: string;
      /** Optional path shown alongside the project name. */
      path?: string;
    }
  | {
      kind: 'github';
      /** "owner/repo" (used as the row key + URL slug). */
      fullName: string;
      /** GitHub-side display name (typically the repo name without owner). */
      name: string;
      /** GitHub org / user the repo belongs to. */
      ownerHandle: string;
      /** Optional avatar (org / user). Falls back to the GitHub octocat. */
      avatarUrl?: string | null;
    };

export type MobilePrStatus = 'open' | 'merged' | 'closed' | 'draft';

export type MobileConversationKind = 'chat' | 'local' | 'github';

export type MobileConversationItem = {
  id: string;
  title: string;
  /** Which "container" the conversation belongs to — drives the home
     Chat tab's by-type grouping and the conversation-type filter pill.
     Optional for back-compat with callers that don't need it. */
  kind?: MobileConversationKind | null;
  branchName?: string | null;
  prNumber?: number | null;
  prStatus?: MobilePrStatus | null;
  /** Associated PR url. Presence is what decides the row's PR icon (a PR can
     sync before its status does), mirroring the desktop sidebar's `showPr`. */
  prUrl?: string | null;
  /** Rollup CI verdict of the PR head commit, synced by the CLI PR poller.
     Rendered as the badge cut into the PR glyph (see `SessionPrIcon`). */
  prCiState?: SessionPullRequestCiState | null;
  /** Merge readiness derived from the poller's CI + merge-state codes. `y`
     swaps the row's line diff for the `Mergeable` pill (see `SessionMergeablePill`). */
  prReadiness?: SessionPullRequestReadiness | null;
  addedLines?: number;
  deletedLines?: number;
  /** Numeric timestamp used for sorting; the caller MAY pre-format `ageLabel`. */
  latestMessageAt?: number | null;
  ageLabel?: string;
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  isOffline?: boolean;
  hasUnreadMessages?: boolean;
  isPinned?: boolean;
  /** Machine id the conversation lives on. Powers the machine filter. */
  machineId?: string | null;
  /** PRECISE Session that created this one — `lody session create` with a
     session in scope, which is how the `lody_session_create` MCP tool spawns
     independent work. Presentation-only provenance; deliberately NOT
     `parentSessionId`. See `lib/session-opened-by-tree.ts`. */
  openedBySessionId?: string | null;
  /** The list ROW to nest under. Differs from `openedBySessionId` when the
     opener is a child Tab, which has no row of its own — the caller walks
     `parentSessionId` up to the root via `buildSidebarOpenerRowResolver`. */
  openedByRowSessionId?: string | null;
  /** Stable id for the project the conversation belongs to:
     `machineId:localProjectId` for local sessions, `owner/repo` for
     GitHub sessions. `null` for chat-only sessions with no project.
     Powers the project filter pill AND the "Group: Project" bucket
     mode — same field for both so the filter selection and the
     bucket key never drift apart. */
  projectKey?: string | null;
  /** Human-readable label for the project bucket (e.g. project name
     or `owner/repo`). Only set when `projectKey` is also set;
     consumed by the chat list's group heading. */
  projectLabel?: string | null;
  /** Effective privacy of a local project bucket in a team workspace. */
  isPrivateProject?: boolean;
  /** Owner avatar URL for GitHub-bound sessions (see
     `getGitHubOwnerAvatarUrl`). Used as the row's leading identity
     icon and by project-bucket headings in "Group: Project". Local
     sessions leave this undefined. */
  projectAvatarUrl?: string | null;
  /** True when the session runs in an isolated git worktree. Drives the
     leading Worktree leaf icon for local sessions (GitHub rows keep the
     owner avatar instead — they are effectively always worktrees). */
  isWorktree?: boolean;
  /** Creator of the conversation. Populated only when the caller is
     showing team-scope sessions; in `my` scope the row hides the
     avatar slot entirely. Shape matches `<UserAvatar>`'s user prop
     so the row can pass it through directly. */
  owner?: {
    id?: string | null;
    name?: string | null;
    image?: string | null;
  } | null;
};

export type MobileProjectMachine = {
  id: string;
  name: string;
  isOnline: boolean;
};

export type MobileProjectTab = 'chat' | 'files' | 'settings';

export type MobileProjectScreenLabels = {
  backAriaLabel?: string;
  /** Aria for the always-visible search field at the top of the header. */
  searchAriaLabel?: string;
  /** Aria + tooltip for the archive-toggle chip in the header. */
  archiveToggleLabel?: string;
  /** Aria for the filter chip on the first group heading. */
  filterBarToggleLabel?: string;
  /** Copy for the multi-select toolbar + delete confirmation shown
     when the user long-presses a row in the archive view. */
  archiveSelection?: MobileChatListSelectionLabels;
  /** Placeholder shown inside the header search input. */
  searchPlaceholder?: string;
  /** Aria label for the X chip that clears the search query. */
  clearSearchAriaLabel?: string;
  /** @deprecated Chat list no longer shows a section heading in the
     active (non-archived) mode. Kept for call-site compatibility. */
  allConversationsHeading?: string;
  /** Heading rendered above the project list when the archive toggle
     is on. Falls back to "归档对话" when omitted. */
  archivedConversationsHeading?: string;
  /** Empty-state copy when nothing matches the active filters. */
  emptyConversations?: string;
  /** Bottom-tabbar tab labels. */
  chatTab?: string;
  filesTab?: string;
  settingsTab?: string;
  newChatAriaLabel?: string;
  /** Copy for the Settings tab placeholder empty state. */
  settingsTabPlaceholderTitle?: string;
  settingsTabPlaceholderBody?: string;
};

export type MobileProjectFilesTabContentProps = {
  readonly onScrollActivity: (scrollTop: number) => void;
  readonly bottomTabBarVisible: boolean;
};

export type MobileProjectScreenProps = {
  project: MobileProjectContext;
  /** Already filtered + sorted by the caller (newest first), in the
     same shape the home Chat tab uses. */
  conversations: MobileConversationItem[];
  /** Optional pill bar rendered above the list. Each consumer
     (local-project vs github-repo) trims this to the filters that
     make sense for the surface. */
  filterPills?: ReadonlyArray<FilterPill>;
  /** View grouping. Defaults to `none` (flat list); other values
     bucket the same items into named sections. Headings come from
     `labels.chatGroupLabels` via `MobileChatList`. */
  chatGroupBy?: MobileChatGroupBy;
  /** Per-bucket headings keyed by `MobileChatList`'s bucket ids. */
  chatGroupLabels?: Partial<Record<string, string>>;
  selectedConversationId?: string | null;
  labels?: MobileProjectScreenLabels;
  /** Optional content rendered inside the project's Settings tab. When
     omitted, the tab shows the existing "coming soon" placeholder.
     Production caller (chat-landing) passes
     `<MobileLocalProjectSettings ... />` for local projects so the
     per-project share + history-import controls live alongside the
     conversation list, not in a separate workspace-wide
     `/settings/projects` page. */
  settingsTabContent?: ReactNode;
  /** Content rendered inside the project's Files tab. */
  filesTabContent: ReactNode | ((props: MobileProjectFilesTabContentProps) => ReactNode);
  onBack: () => void;
  onConversationSelect?: (conversationId: string) => void;
  /** Pin / archive callbacks for the swipe-to-reveal drawer on each
     conversation row (active list). */
  onConversationTogglePin?: (conversationId: string, nextPinned: boolean) => void;
  onConversationArchive?: (conversationId: string) => void;
  /** Restore (un-archive) callback for the swipe drawer shown on each
     row of the *archived* list. */
  onConversationRestore?: (conversationId: string) => void;
  /** Hands a batch of conversation ids to the parent for *permanent*
     deletion. Only invoked from the multi-select toolbar shown in the
     archive view's selection mode. */
  onConversationPermanentDelete?: (chatIds: string[]) => void | Promise<void>;
  /** When provided, the bottom tabbar's new-chat chip is rendered;
     tap fires this callback (typically opens the new-chat sheet in
     the same project context). Omit to hide the chip. */
  onNewChat?: () => void;
  /** When true, the chat list renders the *archived* conversations and
     the shell tints to `bg-muted` so the whole surface reads as "you
     are looking at archived items". The caller still owns the data —
     it hands over the archived list via `conversations` when this is
     true and the active list when it's false. */
  showArchived?: boolean;
  /** Fires when the user taps the archive chip in the header. Renders
     the chip when both this and `onConversationSelect` are wired. */
  onShowArchivedToggle?: () => void;
  /** File-browser breadcrumb segments (relative to the project root) for
     the Files tab's shared header. Empty at the root. */
  fileNavSegments?: string[];
  /** Pop one file-browser level. Wired to the shared header's back chip
     when the Files tab is drilled into a folder/file. */
  onFileNavBack?: () => void;
};

/* --------------------------------------------------------------------------
 * Status indicator — priority matches desktop `TaskIndicator`:
 *
 *   waiting-permission  →  <Hand>  text-status-warning
 *   working             →  <Spinner>  text-primary
 *   unread              →  small primary dot (not a large filled disc)
 *   idle                →  null (slot stays reserved for title alignment)
 * ----------------------------------------------------------------------- */
function StatusIndicator({
  isWorking,
  isWaitingPermission,
  hasUnreadMessages,
}: {
  isWorking?: boolean;
  isWaitingPermission?: boolean;
  hasUnreadMessages?: boolean;
}): ReactNode {
  if (isWaitingPermission) {
    return (
      <Hand
        {...stylex.props(styles.statusGlyph, styles.statusWaiting)}
        aria-label="waiting permission"
      />
    );
  }
  if (isWorking) {
    return (
      <Spinner
        diameter="calc(var(--spacing) * 4)"
        {...stylex.props(styles.statusRunning)}
        aria-label="running"
      />
    );
  }
  if (hasUnreadMessages) {
    return <span data-unread-dot="" {...stylex.props(styles.unreadDot)} aria-label="unread" />;
  }
  return null;
}

/* --------------------------------------------------------------------------
 * Opened-by tree (`lib/session-opened-by-tree.ts`) — mobile geometry.
 *
 * The leading slot owns ONE node, exactly like the desktop sidebar row: it
 * shows the fold chevron on an opener, ├/└ on an opened Session, or the status
 * indicator — never two of them. Status wins, on both sides of the
 * relationship: "this session needs you" beats "this session has children".
 *
 * That single node is why a top-level row keeps its exact flat geometry — the
 * slot is the same 16px status slot it always was. Only an opened Session
 * widens it (16px → 32px, left-aligned so the node stays at the same x),
 * producing a 16px content indent without moving the node or the background.
 * ----------------------------------------------------------------------- */
/** The node centre — `ps-4` + half of the 16px slot. Shared by chevron, lines and
    status. The elbow reaches 44px, i.e. 4px shy of the child's 48px content
    start. Both live in `styles`. */

function ConversationRowTreeConnector({ isLastChild }: { isLastChild: boolean }) {
  return (
    /* Anchored to the ROW, not the slot, so the trunk can run the row's full
       height and meet its neighbours with no seam. */
    <span
      aria-hidden="true"
      data-conversation-tree-connector=""
      {...stylex.props(styles.treeConnector)}
    >
      <span
        data-tree-trunk={isLastChild ? 'last' : 'full'}
        {...stylex.props(
          styles.treeTrunk,
          styles.treeNodeStart,
          styles.treeLine,
          /* Last child stops at the elbow so the trunk does not dangle past
             the group; every other child carries it into the next row. */
          isLastChild ? styles.treeTrunkLast : styles.treeTrunkFull
        )}
      />
      <span
        {...stylex.props(
          styles.treeElbow,
          styles.treeNodeStart,
          styles.treeElbowWidth,
          styles.treeLine
        )}
      />
    </span>
  );
}

/**
 * The opener's fold control. A SIBLING of the row button, never a child of it —
 * a phone row is one big `<button>`, and nesting an interactive control inside
 * a button is invalid and unreachable to assistive tech.
 *
 * It sits ON the leading node, so it renders only while that node is free
 * (see `conversationRowHasActivity`). `z-30` clears the project screen's
 * `EDGE_ZONE_PX` back-swipe strip at `zIndex={20}`, which would otherwise
 * swallow every tap in the leading 48px — the same reason the composer carries
 * `protectFromEdgeBackZone`.
 */
function ConversationRowTreeToggle({
  expanded,
  label,
  onToggle,
}: {
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-conversation-tree-toggle=""
      aria-label={label}
      aria-expanded={expanded}
      onClick={(event) => {
        /* The row button is a sibling, so this never bubbles into it — but the
           swipe wrapper listens on an ancestor, and a drag that began here
           should not also read as a tap on the row. */
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      {...stylex.props(styles.treeToggle)}
    >
      <ChevronDown
        {...stylex.props(styles.treeChevron, !expanded && styles.treeChevronClosed)}
        aria-hidden="true"
      />
    </button>
  );
}

/**
 * Whether the row's leading node is already claimed by a status mark. Exported
 * because the list needs the same answer to decide whether the row carries a
 * tap target in the back-swipe strip (`liftAboveEdgeSwipeZone`), and the two
 * must not drift apart.
 */
export function conversationRowHasActivity(conversation: MobileConversationItem): boolean {
  return Boolean(
    conversation.isWaitingPermission || conversation.isWorking || conversation.hasUnreadMessages
  );
}

/* --------------------------------------------------------------------------
 * Conversation row — Linear-inspired single line:
 *   [status circle] [team owner?] [pin?] title .............. [+/-] [worktree] [PR]
 * Always-on leading status, comfortable row height, medium title weight.
 * Age / branch / project meta omitted. `secondaryField` kept for callers.
 *
 * The trailing metric cluster keeps the desktop sidebar's order and glyphs
 * (`sidebar-row-shared.tsx`): line diff, then the worktree marker, then the PR
 * status icon owning the right edge. It is the same `SessionPrIcon` component,
 * so PR status tone + the CI verdict badge cut into it stay identical across
 * platforms. A ready PR replaces the diff numbers with `SessionMergeablePill`
 * in that same slot, on the same gates the sidebar uses.
 * ----------------------------------------------------------------------- */
export function ConversationRow({
  conversation,
  selected,
  onClick,
  archived = false,
  selectionMode = false,
  isSelected = false,
  onToggleSelect,
  onLongPress,
  treeSlot,
  secondaryField: _secondaryField = 'branch',
}: {
  conversation: MobileConversationItem;
  selected: boolean;
  onClick?: () => void;
  /** When true, the row is being rendered inside the archive view —
     the title text dims to `text-muted-foreground` so the list as a
     whole reads as "you're looking at archived items". Status
     indicators and change counts stay at full opacity. */
  archived?: boolean;
  /** When true, the parent list is in multi-select mode: the row
     renders a leading checkbox, tap toggles `isSelected` instead of
     firing `onClick`, and long-press is a no-op (we're already in
     the mode it would have entered). */
  selectionMode?: boolean;
  /** Drawn state of the leading checkbox while in selection mode. */
  isSelected?: boolean;
  /** Tap handler while in selection mode — caller flips this row's
     entry in the selected-ids set. */
  onToggleSelect?: () => void;
  /** Press-and-hold handler — enters multi-select mode and selects
     this row. Caller is expected to start the mode + pre-select this
     id in one go (matches iOS Mail edit-mode entry). */
  onLongPress?: () => void;
  /** This row's place in the opened-by tree (`lib/session-opened-by-tree.ts`):
     an opener with a fold control, an opened Session with a ├/└ connector, or
     undefined for a plain top-level row. Built by the caller with the shared
     `buildSessionRowOpenedByTreeSlot` so the labels match the desktop sidebar. */
  treeSlot?: SessionRowOpenedByTreeSlot;
  /** @deprecated Second-line branch/project meta is no longer shown.
     Kept so existing callers (home Chat tab, project page, list
     grouping) do not need a simultaneous API change. */
  secondaryField?: 'branch' | 'project';
}) {
  void _secondaryField;
  const treeChild = treeSlot?.kind === 'child' ? treeSlot : null;
  /* One node, one meaning. An active row shows its status and drops both the
     fold chevron and the ├/└ — same rule the desktop sidebar row applies. */
  const hasActivity = conversationRowHasActivity(conversation);
  const treeOpener = treeSlot?.kind === 'opener' && !hasActivity ? treeSlot : null;
  const showChildConnectors = treeChild !== null && !hasActivity;
  const hasChanges =
    typeof conversation.addedLines === 'number' &&
    typeof conversation.deletedLines === 'number' &&
    (conversation.addedLines > 0 || conversation.deletedLines > 0);
  /* Same gate as the desktop sidebar row: a row carrying a PR shows its
     status. `prUrl` is the primary signal (status can still be syncing);
     a bare number covers callers that only carry the compact fields. */
  const showPr =
    Boolean(conversation.prUrl?.trim()) ||
    (typeof conversation.prNumber === 'number' && conversation.prNumber > 0);
  const prStatus = conversation.prStatus ?? 'open';
  /* Readiness can linger on a terminal PR (the webhook fan-out flips status to
     merged but cannot clear the poller's record), so gate the pill on the PR
     still being live — same reasoning as the desktop sidebar row. */
  const isMergeable =
    showPr && conversation.prReadiness === 'y' && prStatus !== 'merged' && prStatus !== 'closed';
  /* The pill takes the line diff's slot: once a PR is ready, "it can merge" is
     the more useful fact than how many lines changed. Hidden on the open
     conversation, whose own info bar owns the merge control. */
  const showMergeablePill = isMergeable && !selected;

  /* Long-press only arms outside selection mode — once we're in it,
     a press should toggle the row's checkbox, not re-enter the mode.
     The hook is a no-op when `enabled` is false so the row stays a
     plain button. */
  const { handlers: longPressHandlers, shouldSwallowClick } = useLongPress({
    onLongPress,
    enabled: Boolean(onLongPress) && !selectionMode,
  });

  const rowButton = (
    <button
      type="button"
      /* The row itself is never indented: an opened Session widens its
         LEADING SLOT, so the row's background never shifts. */
      data-conversation-row-indent="flat"
      onClick={(event) => {
        if (shouldSwallowClick()) {
          /* Long-press already fired during this gesture — the
             implicit tap that follows pointer-up would otherwise
             trigger the regular click handler. */
          event.preventDefault();
          return;
        }
        if (selectionMode) {
          onToggleSelect?.();
          return;
        }
        onClick?.();
      }}
      aria-pressed={selectionMode ? isSelected : selected}
      {...longPressHandlers}
      {...withClassName(
        stylex.props(
          styles.row,
          /* Solid canvas (not transparent) so nothing under the row can
           read as a divider hairline between list items. */
          selected && !selectionMode ? styles.rowSelected : styles.rowIdle,
          selectionMode && isSelected && styles.rowPicked
        ),
        'mobile-project-conversation-row'
      )}
    >
      {showChildConnectors ? (
        <ConversationRowTreeConnector isLastChild={treeChild.isLastChild} />
      ) : null}
      {/* The one leading node. An opened Session widens it (left-aligned, so
          the node itself does not move) to indent everything after it. */}
      <div
        data-conversation-row-leading-slot=""
        data-conversation-row-slot={treeChild ? 'nested' : 'flat'}
        {...stylex.props(styles.rowSlot, treeChild ? styles.treeChildSlot : styles.treeSlot)}
      >
        {selectionMode ? (
          <Checkbox
            checked={isSelected}
            tabIndex={-1}
            className="pointer-events-none"
            aria-hidden="true"
          />
        ) : (
          <StatusIndicator
            isWorking={conversation.isWorking}
            isWaitingPermission={conversation.isWaitingPermission}
            hasUnreadMessages={conversation.hasUnreadMessages}
          />
        )}
      </div>
      <SessionRowAuthorAvatar author={conversation.owner} />
      <div {...stylex.props(styles.rowTitleLine)}>
        {conversation.isPinned ? (
          /* h-4 matches ~15px title optically (glyph fills less than
             the box, so h-3 read as much smaller than the type). */
          <Pin {...stylex.props(styles.rowPin)} aria-label="pinned" strokeWidth={2} />
        ) : null}
        <span {...stylex.props(styles.rowTitle, archived && styles.rowTitleArchived)}>
          {conversation.title}
        </span>
      </div>
      {showMergeablePill ? (
        <SessionMergeablePill />
      ) : hasChanges && !isMergeable ? (
        <span {...stylex.props(styles.rowDiff)}>
          <span {...stylex.props(styles.rowDiffAdded)}>+{conversation.addedLines}</span>
          <span {...stylex.props(styles.rowDiffRemoved)}>-{conversation.deletedLines}</span>
        </span>
      ) : null}
      {conversation.isWorktree ? (
        <WorktreeIcon {...stylex.props(styles.rowWorktree)} aria-label="Worktree" />
      ) : null}
      {showPr ? <SessionPrIcon prStatus={prStatus} prCiState={conversation.prCiState} /> : null}
    </button>
  );

  /* Only a visible chevron needs the positioning wrapper that lets it sit
     BESIDE the row button instead of inside it. Every other row — including an
     active opener, whose node is showing status — returns the bare button, so
     the flat DOM is unchanged for them. */
  if (!treeOpener) return rowButton;
  return (
    <div {...stylex.props(styles.treeOpenerWrap)}>
      {rowButton}
      <ConversationRowTreeToggle
        expanded={treeOpener.expanded}
        label={treeOpener.label}
        onToggle={treeOpener.onToggle}
      />
    </div>
  );
}

/* --------------------------------------------------------------------------
 * Project / repo detail screen — a focused single-purpose surface:
 *
 *   [back chevron]   [avatar] owner/repo or projectName
 *   [filter pills, scrolled-horizontal, drop the irrelevant ones]
 *   [grouped or flat conversation list, identical chrome to the home Chat tab]
 *
 * Everything else that used to live here (filter popover, scope popover,
 * three-tab dock with placeholder tabs) is gone — the home
 * Chat tab's filter pills + view-mode pill cover that ground, and the
 * placeholder tabs were not implemented. Edge-swipe-back is preserved.
 * ----------------------------------------------------------------------- */

const PROJECT_TRANSITION = { duration: 0.28, ease: [0.32, 0.72, 0, 1] as const };

export function MobileProjectScreen({
  project,
  conversations,
  filterPills,
  chatGroupBy = 'none',
  chatGroupLabels,
  selectedConversationId = null,
  labels = {},
  onBack,
  onConversationSelect,
  onConversationTogglePin,
  onConversationArchive,
  onConversationRestore,
  onConversationPermanentDelete,
  onNewChat,
  showArchived = false,
  onShowArchivedToggle,
  fileNavSegments,
  onFileNavBack,
  filesTabContent,
  settingsTabContent,
}: MobileProjectScreenProps) {
  /* Tab state is screen-local: switching tabs is purely a view
     concern (no URL change, no chat-landing state mutation). */
  const [selectedProjectTab, setSelectedProjectTab] = useState<MobileProjectTab>('chat');
  /* Scroll container handed to `MobileWorkspaceTabBar` so the dock
     collapses while the user scrolls. */
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [filesScrollSignal, setFilesScrollSignal] =
    useState<MobileWorkspaceTabBarScrollSignal | null>(null);
  const handleFilesScrollActivity = useCallback((scrollTop: number) => {
    setFilesScrollSignal((previous) => ({
      scrollTop,
      seq: (previous?.seq ?? 0) + 1,
    }));
  }, []);
  useEffect(() => {
    if (selectedProjectTab !== 'files') {
      setFilesScrollSignal(null);
    }
  }, [selectedProjectTab]);
  /* `owner/repo` for github reads more anchored than just the repo
     short name (matches the home GitHub-tab row title). For local we
     use the project's display name as-is. */
  const displayName = project.kind === 'github' ? project.fullName : project.name;
  const filesTabAtRoot = (fileNavSegments?.length ?? 0) === 0;
  const filesTabNested = selectedProjectTab === 'files' && !filesTabAtRoot;
  const showProjectTabBar = selectedProjectTab !== 'files' || filesTabAtRoot;
  const renderedFilesTabContent =
    typeof filesTabContent === 'function'
      ? filesTabContent({
          onScrollActivity: handleFilesScrollActivity,
          bottomTabBarVisible: showProjectTabBar,
        })
      : filesTabContent;

  /* In-page search — always-visible pill at the top of the chat header.
     Local-only state: search is purely a view concern for this screen. */
  const [searchQuery, setSearchQuery] = useState('');
  /* Filter pill bar starts collapsed; the chip on the first group
     heading toggles it open (mirrors home Chat tab). */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const trimmedQuery = searchQuery.trim().toLowerCase();
  const visibleConversations = useMemo(() => {
    if (!trimmedQuery) return conversations;
    return conversations.filter((conversation) =>
      conversation.title.toLowerCase().includes(trimmedQuery)
    );
  }, [conversations, trimmedQuery]);
  const hasFilterPills = Boolean(filterPills && filterPills.length > 0);
  /* Best-effort "filters applied" signal: any multi-select pill whose
     selection differs from its default, or any non-first single-select
     option. Enough for the trailing chip's active dot. */
  const hasActiveProjectFilters = useMemo(() => {
    if (!filterPills) return false;
    for (const pill of filterPills) {
      if (pill.kind === 'multi') {
        if (pill.selectedIds.size !== pill.defaultIds.size) return true;
        for (const id of pill.selectedIds) {
          if (!pill.defaultIds.has(id)) return true;
        }
      } else if (pill.kind === 'single') {
        const defaultId = pill.options[0]?.id;
        if (defaultId != null && pill.selectedId !== defaultId) return true;
      } else if (pill.kind === 'aggregate') {
        for (const dim of pill.pills) {
          if (dim.selectedIds.size !== dim.defaultIds.size) return true;
          for (const id of dim.selectedIds) {
            if (!dim.defaultIds.has(id)) return true;
          }
        }
      }
    }
    return false;
  }, [filterPills]);

  /* If we're being mounted because the user just *backed out of* a
     session-detail page, the chat already played its slide-off to the
     right — replaying our forward push-enter on top of that would look
     like an iOS push on a pop. `useState` initializer + flag consume
     keeps the value stable across re-renders and self-clears so a real
     forward navigation to this page still gets its enter slide. */
  const [skipEnterAnimation] = useState(() => consumeMobileBackNavigation());

  return (
    <div {...withClassName(stylex.props(styles.screen), 'mobile-home-app safe-areas')}>
      {/* iOS-style push enter: slide in from the right on mount, unless
         we're a back-navigation destination (see `skipEnterAnimation`
         above). The back navigation has no exit animation — see
         `mobile-settings-layout.tsx` for the rationale (the brief
         frame between exit-animation end and route unmount flashes the
         html bg). */}
      <motion.div
        initial={skipEnterAnimation ? false : { x: '100%' }}
        animate={{ x: 0 }}
        transition={PROJECT_TRANSITION}
        /* Column flex: header + (search) + (pills) all sit ABOVE the
           scroll container. Only the inner list region scrolls — so
           the vertical scrollbar appears to the right of the
           conversation list, not running through the header + pills.
           See the user-reported bug "scrollbar should be above the
           pills". */
        {...withClassName(stylex.props(styles.shell), 'mobile-home-shell')}
      >
        {filesTabNested ? null : (
          <MobileEdgeBackSwipeZone isNativeApp={isNativeAppShell()} onBack={onBack} zIndex={20} />
        )}
        {selectedProjectTab === 'chat' ? (
          <ProjectChatTopBar
            project={project}
            displayName={displayName}
            labels={labels}
            onBack={onBack}
            searchQuery={searchQuery}
            onSearchChange={setSearchQuery}
            showArchived={showArchived}
            onShowArchivedToggle={onShowArchivedToggle}
          />
        ) : (
          <ProjectPlainTopBar
            project={project}
            displayName={displayName}
            labels={labels}
            /* At the file root the back chip exits the project (same as
               Settings); once drilled into a folder/file it pops one
               file-browser level instead. */
            onBack={
              selectedProjectTab === 'files' && (fileNavSegments?.length ?? 0) > 0 && onFileNavBack
                ? onFileNavBack
                : onBack
            }
          />
        )}

        {/* Filter pill bar — toggled from the first group heading's
           trailing chip (mirrors home Chat). Unmounted on Files /
           Settings so those tabs stay free of conversation chrome. */}
        <AnimatePresence initial={false}>
          {selectedProjectTab === 'chat' && filtersOpen && hasFilterPills && filterPills ? (
            <motion.div
              key="project-filter-pills"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: 'easeInOut' }}
              {...stylex.props(styles.accordion)}
            >
              <MobileFilterPillBar pills={filterPills} />
            </motion.div>
          ) : null}
        </AnimatePresence>

        <div ref={listScrollRef} {...withClassName(stylex.props(styles.scroll), 'scrollbar-pro')}>
          {selectedProjectTab === 'chat' ? (
            visibleConversations.length === 0 ? (
              <>
                {hasFilterPills ? (
                  <div {...stylex.props(styles.filterRow)}>
                    <ProjectListFilterToggle
                      open={filtersOpen}
                      hasActiveFilters={hasActiveProjectFilters}
                      ariaLabel={labels.filterBarToggleLabel ?? '过滤器'}
                      onToggle={() => setFiltersOpen((open) => !open)}
                    />
                  </div>
                ) : null}
                <ProjectEmptyState label={labels.emptyConversations ?? '没有匹配的对话'} />
              </>
            ) : (
              <MobileChatList
                chats={visibleConversations}
                groupBy={chatGroupBy}
                groupLabels={chatGroupLabels}
                /* Project sub-page always shows the branch name in the
                   row's meta line. We're already inside a single
                   project's surface, so the project label would be
                   redundant chrome — branch is the disambiguating piece
                   of info between rows. */
                rowSecondaryField="branch"
                /* Active list is flat — no "全部对话" section label. Only
                   the archived surface keeps a heading so the mode is
                   obvious. */
                flatHeading={
                  showArchived ? (labels.archivedConversationsHeading ?? '归档对话') : undefined
                }
                firstGroupTrailing={
                  hasFilterPills ? (
                    <ProjectListFilterToggle
                      open={filtersOpen}
                      hasActiveFilters={hasActiveProjectFilters}
                      ariaLabel={labels.filterBarToggleLabel ?? '过滤器'}
                      onToggle={() => setFiltersOpen((open) => !open)}
                    />
                  ) : undefined
                }
                selectedConversationId={selectedConversationId}
                onSelect={onConversationSelect}
                rowActions={{
                  onTogglePin: onConversationTogglePin,
                  onArchive: onConversationArchive,
                  onRestore: onConversationRestore,
                }}
                archived={showArchived}
                onPermanentDelete={showArchived ? onConversationPermanentDelete : undefined}
                selectionLabels={labels.archiveSelection}
              />
            )
          ) : null}
          {selectedProjectTab === 'files' ? renderedFilesTabContent : null}
          {selectedProjectTab === 'settings'
            ? (settingsTabContent ?? (
                <ProjectTabPlaceholder
                  icon={
                    <SettingsIcon
                      {...stylex.props(styles.placeholderIcon)}
                      strokeWidth={1.6}
                      aria-hidden="true"
                    />
                  }
                  title={labels.settingsTabPlaceholderTitle ?? labels.settingsTab ?? '设置'}
                  body={labels.settingsTabPlaceholderBody ?? '即将上线'}
                />
              ))
            : null}
        </div>

        {showProjectTabBar ? (
          /* Bottom dock — same component the home page uses, with
             project-specific tabs (Chat / Files / Settings) and a
             project-context new-chat chip. The chip is hidden when
             `onNewChat` isn't wired. */
          <MobileWorkspaceTabBar<MobileProjectTab>
            tabs={projectTabSpecs(labels)}
            selectedTab={selectedProjectTab}
            onTabSelect={setSelectedProjectTab}
            onNewChat={onNewChat}
            newChatAriaLabel={labels.newChatAriaLabel}
            ariaLabel={labels.chatTab ?? '导航'}
            /* Distinct layoutId so the highlight FLIP animation doesn't
               share state with the home page's tabbar. */
            layoutId="mobile-project-tabbar"
            scrollContainerRef={listScrollRef}
            scrollSignal={selectedProjectTab === 'files' ? filesScrollSignal : null}
          />
        ) : null}
      </motion.div>
    </div>
  );
}

/* Tab specs for the project bottom tabbar — mirrors `workspaceTabSpecs`
   in mobile-home-screen.tsx but for the project context. Both local and
   GitHub projects get a Settings tab: local exposes team-share + ACP
   history sync + worktree scripts, GitHub exposes the repo-level worktree
   setup + cleanup scripts. The tab's content is supplied by chat-landing
   via `settingsTabContent` per project kind. */
function projectTabSpecs(
  labels: MobileProjectScreenLabels
): ReadonlyArray<MobileBottomTabBarTabSpec<MobileProjectTab>> {
  return [
    {
      key: 'chat',
      ios: <MessageCircle {...stylex.props(styles.tabIcon)} strokeWidth={1.75} />,
      material: (
        <MobileReactIcon icon={MdChat} className={stylex.props(styles.tabIcon).className} />
      ),
      label: labels.chatTab ?? '对话',
    },
    {
      key: 'files',
      ios: <FileIcon {...stylex.props(styles.tabIcon)} strokeWidth={1.75} />,
      material: (
        <MobileReactIcon icon={FaRegFileCode} className={stylex.props(styles.tabIcon).className} />
      ),
      label: labels.filesTab ?? '文件',
    },
    {
      key: 'settings',
      ios: <SettingsIcon {...stylex.props(styles.tabIcon)} strokeWidth={1.75} />,
      material: (
        <MobileReactIcon icon={MdSettings} className={stylex.props(styles.tabIcon).className} />
      ),
      label: labels.settingsTab ?? '设置',
    },
  ];
}

/* Empty-state shell rendered on the Files / Settings tabs until the
   real surfaces are designed. Centered glyph + heading + body, same
   neutral card shell the conversation empty state uses so the page
   doesn't look mid-load. */
function ProjectTabPlaceholder({
  icon,
  title,
  body,
}: {
  icon: ReactNode;
  title: string;
  body: string;
}) {
  return (
    <div {...stylex.props(styles.placeholder)}>
      {icon}
      <p {...stylex.props(styles.placeholderTitle)}>{title}</p>
      <p {...stylex.props(styles.placeholderBody)}>{body}</p>
    </div>
  );
}

/* Chat-tab project header — one chrome row matching home:
   back | compact project mark | search (fills the blank) | archive.
   The full display name is no longer a centered title; the mark +
   search placeholder keep context. Filter lives on the first group
   heading (not here). */
function ProjectChatTopBar({
  project,
  displayName,
  labels,
  onBack,
  searchQuery,
  onSearchChange,
  showArchived,
  onShowArchivedToggle,
}: {
  project: MobileProjectContext;
  displayName: string;
  labels: MobileProjectScreenLabels;
  onBack: () => void;
  searchQuery: string;
  onSearchChange: (next: string) => void;
  showArchived: boolean;
  onShowArchivedToggle?: () => void;
}) {
  return (
    <header {...withClassName(stylex.props(styles.chatHeader), 'mobile-home-glass')}>
      <HeaderChip onClick={onBack} ariaLabel={labels.backAriaLabel ?? 'Back'}>
        <ChevronLeft {...stylex.props(styles.headerChevron)} aria-hidden="true" />
      </HeaderChip>
      <span {...stylex.props(styles.srOnly)}>{displayName}</span>
      <ProjectAvatar project={project} />
      <div {...stylex.props(styles.searchColumn)}>
        <ProjectSearchInput value={searchQuery} onChange={onSearchChange} labels={labels} />
      </div>
      {onShowArchivedToggle ? (
        <HeaderChip
          onClick={onShowArchivedToggle}
          ariaLabel={labels.archiveToggleLabel ?? '归档'}
          ariaPressed={showArchived}
          active={showArchived}
        >
          <Archive {...stylex.props(styles.headerArchive)} aria-hidden="true" strokeWidth={2} />
        </HeaderChip>
      ) : null}
    </header>
  );
}

/* Plain project header for Files and Settings. The right spacer keeps the
   project identity centered while omitting chat-only actions. */
function ProjectPlainTopBar({
  project,
  displayName,
  labels,
  onBack,
}: {
  project: MobileProjectContext;
  displayName: string;
  labels: MobileProjectScreenLabels;
  onBack: () => void;
}) {
  return (
    <header {...withClassName(stylex.props(styles.plainHeader), 'mobile-home-glass')}>
      <HeaderChip onClick={onBack} ariaLabel={labels.backAriaLabel ?? 'Back'}>
        <ChevronLeft {...stylex.props(styles.headerChevron)} aria-hidden="true" />
      </HeaderChip>
      <ProjectHeaderIdentity project={project} displayName={displayName} />
      <span aria-hidden />
    </header>
  );
}

function ProjectHeaderIdentity({
  project,
  displayName,
}: {
  project: MobileProjectContext;
  displayName: string;
}) {
  return (
    <div {...stylex.props(styles.identity)}>
      <ProjectAvatar project={project} />
      <h1 {...stylex.props(styles.identityName)}>{displayName}</h1>
    </div>
  );
}

/* Floating-pill side chip used by the project header's back + archive
   buttons. Matches home `FloatingPill`: recessed muted fill (no
   card-on-white soft shadow — muddy in light theme). `active` uses a
   primary tint so archive-on reads as engaged. */
function HeaderChip({
  children,
  onClick,
  ariaLabel,
  ariaPressed,
  active = false,
}: {
  children: ReactNode;
  onClick: () => void;
  ariaLabel: string;
  ariaPressed?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      {...stylex.props(styles.headerChip, active ? styles.headerChipActive : styles.headerChipIdle)}
    >
      {children}
    </button>
  );
}

/* Filter chip on the first group heading — same look as the home Chat
   list filter toggle. */
function ProjectListFilterToggle({
  open,
  hasActiveFilters,
  ariaLabel,
  onToggle,
}: {
  open: boolean;
  hasActiveFilters: boolean;
  ariaLabel: string;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={ariaLabel}
      aria-pressed={open}
      {...stylex.props(styles.filterChip, open && styles.filterChipOpen)}
    >
      <SlidersHorizontal
        {...stylex.props(styles.filterChipGlyph)}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      {hasActiveFilters && !open ? (
        <span aria-hidden="true" {...stylex.props(styles.filterDot)} />
      ) : null}
    </button>
  );
}

/* Leading avatar for the project header:
   - github: owner image when present, github glyph fallback;
   - local:  initial-letter tile (same component the home rows use,
             at the smaller `sm` size). Seeded on the unique project
             id so two projects named "lody" on different machines
             get distinct hues. */
function ProjectAvatar({ project }: { project: MobileProjectContext }) {
  if (project.kind === 'github') {
    if (project.avatarUrl) {
      return (
        <CachedAvatarImg
          src={project.avatarUrl}
          alt=""
          loading="lazy"
          className={stylex.props(styles.avatar).className}
        />
      );
    }
    return <Github {...stylex.props(styles.avatarGlyph)} strokeWidth={1.6} aria-hidden="true" />;
  }
  return (
    <MobileInitialLetterAvatar
      name={project.name}
      hashSeed={`${project.machineId}:${project.projectId}`}
      size="sm"
    />
  );
}

/* Always-visible search pill at the top of the chat header. Filters
   conversations by title — keep the predicate inside the screen
   since search is purely a view concern (no need to persist it or
   round-trip through chat-landing). */
function ProjectSearchInput({
  value,
  onChange,
  labels,
}: {
  value: string;
  onChange: (next: string) => void;
  labels: MobileProjectScreenLabels;
}) {
  return (
    <label {...stylex.props(styles.searchPill)}>
      <Search {...stylex.props(styles.searchGlyph)} strokeWidth={1.8} aria-hidden="true" />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={labels.searchPlaceholder ?? '搜索对话'}
        aria-label={labels.searchAriaLabel ?? '搜索'}
        enterKeyHint="search"
        {...stylex.props(styles.searchInput)}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={labels.clearSearchAriaLabel ?? 'Clear search'}
          {...stylex.props(styles.searchClear)}
        >
          <X {...stylex.props(styles.searchClearGlyph)} strokeWidth={1.8} aria-hidden="true" />
        </button>
      ) : null}
    </label>
  );
}

function ProjectEmptyState({ label }: { label: string }) {
  return <div {...stylex.props(styles.emptyState)}>{label}</div>;
}
