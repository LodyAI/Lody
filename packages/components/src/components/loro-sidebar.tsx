import { useWorkspaceFeature } from '@/hooks/use-workspace-feature';
import { useTranslation } from 'react-i18next';
import { isElectronRenderer, isMacOSElectronRenderer } from '@/lib/electron';
import { ContextMenu } from '@lody/ui/context-menu';
import { isNewWindowClick, openDesktopWindow } from '@/lib/desktop-window';
import {
  type ComponentPropsWithoutRef,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { useStore } from 'jotai';
import { cn } from '@/lib/utils';
import { clsx } from 'clsx';
import { sidebarScrollTopByWorkspaceAtom } from '@/atoms/sidebar-state';
import {
  WINDOW_DRAG_EXEMPT_CLASS,
  WINDOW_DRAG_HEADER_CLASS,
  useMacTrafficLightRowPadClass,
  useWindowsCaptionRowPadClass,
} from '@/ui/window-drag-region';
import { useElectronFullscreen } from '@/lib/electron';
import { Badge } from '@lody/ui/badge';
import { Button } from '@lody/ui/button';
import * as stylex from '@stylexjs/stylex';
import { sidebarSurface } from './sidebar-surface';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeFontWeight,
  themeRadius,
  themeSpace,
  themeDuration,
  themeEasing,
  themeShadow,
} from '../style/theme-scale.stylex';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { radius, space } from '@lody/ui/tokens/scales.stylex';
import { Kbd } from '@lody/ui/kbd';
import { Tooltip } from '@lody/ui/tooltip';
import { WorkingGrid } from '@/ui/working-grid';
import { commands, formatKeyBinding, type ShortcutCommandId } from '@/lib/commands';
import { setCommandPaletteOpen } from '@/lib/commands/palette-state';
import { Menu } from '@/ui/menu';
import { ScrollArea } from '@lody/ui/scroll-area';
import {
  AppWindow,
  Archive,
  CircleHelp,
  BookOpen,
  Bug,
  ClipboardList,
  ListTodo,
  Github,
  Link2,
  ListFilter,
  MessageSquareMore,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  Plus,
  Search,
  Settings,
  Users,
} from 'lucide-react';
import { MynauiEditOne } from '@lody/ui';
import { CuidaSidebarExpandOutline } from './icons/cuida-sidebar-expand-outline';
import {
  SessionList,
  type SessionListProps,
  type SessionListPullRequestOpen,
  type SessionListRow,
} from './session-list';
import {
  SidebarUpdatedSessionList,
  type SidebarUpdatedBucketKey,
  type SidebarUpdatedItem,
  type SidebarUpdatedSessionListLabels,
} from './sidebar-updated-session-list';
import { SidebarFilterPopover, type SidebarFilterLabels } from './sidebar-filter-popover';
import { WorkspaceAvatar } from './workspace-avatar';
import { AuthRecoveryEntrySlot } from './auth-recovery-entry';
import type { SidebarOrganizeMode } from '@/atoms/sidebar-state';
import { useIsMobile } from '@/hooks/use-mobile';
import { useStableNow } from '@/hooks/use-stable-now';
import {
  SIDEBAR_ROW_TEXT_CLASS,
  SIDEBAR_CAPTION_TEXT_CLASS,
  SIDEBAR_HELPER_TEXT_CLASS,
  SIDEBAR_CONTROL_TEXT_CLASS,
} from './sidebar-row-shared';

/**
 * The parts of the sidebar shell that were Tailwind. The rows' own box, ink
 * and fills come from `sidebarSurface`; these are the pieces around it.
 */
const shellStyles = stylex.create({
  relative: { position: 'relative' },
  navLabel: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  flexFill: { minWidth: 0, flex: '1 1 0%' },
  currentInk: { color: 'currentColor' },
  nativeControl: {
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': '2px' },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': '2px' },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  unselectable: { userSelect: 'none' },
  disabledControl: {
    pointerEvents: 'none',
    cursor: 'default',
    color: 'hsl(var(--sidebar-foreground-muted) / 0.6)',
  },
  accessibleLabel: {
    position: 'absolute',
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clipPath: 'inset(50%)',
    whiteSpace: 'nowrap',
    borderWidth: 0,
  },
  navControl: {
    display: 'flex',
    width: '100%',
    userSelect: 'none',
    alignItems: 'center',
    textAlign: 'left',
    outlineStyle: { default: 'none', '@media (forced-colors: active)': 'solid' },
    outlineWidth: { default: null, '@media (forced-colors: active)': '2px' },
    outlineColor: { default: null, '@media (forced-colors: active)': 'transparent' },
    outlineOffset: { default: null, '@media (forced-colors: active)': '2px' },
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke, --tw-gradient-from, --tw-gradient-via, --tw-gradient-to, opacity, box-shadow, transform, translate, scale, rotate, filter, -webkit-backdrop-filter, backdrop-filter, display, content-visibility, overlay, pointer-events',
    transitionDuration: themeDuration[150],
    transitionTimingFunction: themeEasing['in-out'],
  },
  navGapDesktop: { gap: themeSpace[1.5] },
  navGapMobile: { gap: themeSpace[2] },
  glass: {
    position: 'relative',
    overflow: 'hidden',
    borderRadius: themeRadius.xl,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--sidebar-border) / 0.8)',
    backgroundColor: 'hsl(var(--sidebar) / 0.8)',
    color: themeColors.sidebarForeground,
    boxShadow: themeShadow.xs,
  },
  trayPadding: { padding: themeSpace[1] },
  trayItem: { marginBottom: { default: themeSpace[1], ':last-child': 0 } },
  chatsPadding: { paddingTop: themeSpace[2] },
  viewportDesktop: { paddingInline: themeSpace[1.5], paddingBottom: themeSpace[3] },
  viewportMobile: {
    paddingLeft: 'calc(12px + env(safe-area-inset-left, 0px))',
    paddingRight: 'calc(12px + env(safe-area-inset-right, 0px))',
  },
  /**
   * The focus state these rows had before the migration. The header's icon
   * button carried `focus-visible:ring-1 focus-visible:ring-sidebar-ring/40`,
   * the footer's icon button carried
   * `focus-visible:ring-1 focus-visible:ring-sidebar-ring/40`, the navigation
   * row carried `focus-visible:ring-1 focus-visible:ring-sidebar-ring/30`, and
   * the footer's workspace row carried
   * `focus-visible:ring-1 focus-visible:ring-sidebar-ring/30`. Each of them
   * declared a full box-shadow in the utilities layer, which erased the app's
   * global inset focus ring, and the app forces Tailwind's own ring
   * transparent — so the focused row painted NO focus indicator of its own.
   * Keep that: no resting shadow, and no focus shadow.
   */
  noFocusRing: { boxShadow: { default: null, ':focus-visible': 'none' } },
  /** A navigation row's own box. */
  navRow: { position: 'relative', display: 'flex', width: '100%', alignItems: 'center' },
  /** The navigation row's icon slot. */
  navIcon: {
    display: 'flex',
    height: themeSpace[5],
    width: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The icon rests one step quieter than the label. */
  navIconIdle: { color: themeColors.sidebarForegroundMuted },
  /** A navigation row's trailing control. */
  navAction: { position: 'absolute', right: themeSpace[1], display: 'flex', alignItems: 'center' },
  /** A clipped label. */
  clipped: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The workspace switcher's trailing count. */
  switcherMeta: {
    marginLeft: 'auto',
    flexShrink: 0,
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.mutedForeground,
  },
  /** The sidebar's own plane. */
  shell: {
    position: 'relative',
    height: '100%',
    userSelect: 'none',
    backgroundColor: themeColors.sidebar,
    color: themeColors.sidebarForeground,
  },
  /** The column the sidebar's rows live in. */
  column: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  /** The header row. */
  header: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[2],
  },
  headerDesktop: { height: themeSpace[11], paddingInline: themeSpace[1.5] },
  headerMobile: {
    paddingTop: 'calc(12px + var(--safe-area-top))',
    paddingInlineStart: 'calc(12px + var(--safe-area-left))',
    paddingInlineEnd: 'calc(12px + var(--safe-area-right))',
  },
  /** The wordmark. */
  wordmark: {
    userSelect: 'none',
    paddingInlineStart: '9px',
    fontSize: '18px',
    fontWeight: themeFontWeight.semibold,
    lineHeight: 1,
    letterSpacing: '-0.03em',
    color: themeColors.reading,
  },
  /** The header's trailing buttons. */
  headerActions: {
    marginLeft: 'auto',
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[0.5],
  },
  /** The navigation rows' column. */
  navColumn: { display: 'flex', flexDirection: 'column', gap: '1px' },
  navColumnDesktop: { paddingInline: themeSpace[1.5] },
  navColumnMobile: {
    marginTop: themeSpace[2],
    paddingInlineStart: 'calc(12px + var(--safe-area-left))',
    paddingInlineEnd: 'calc(12px + var(--safe-area-right))',
  },
  /** The scroll area's own column. */
  scrollColumn: { minHeight: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  scrollColumnDesktop: { marginTop: themeSpace[3] },
  scrollColumnMobile: {
    marginTop: themeSpace[4],
    paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))',
  },
  /** The empty state's own column. */
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingInline: themeSpace[6],
    paddingBottom: themeSpace[5],
    paddingTop: themeSpace[7],
    textAlign: 'center',
  },
  /** The empty state's mark. */
  emptyMark: {
    display: 'flex',
    height: themeSpace[9],
    width: themeSpace[9],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.xl,
    backgroundColor: 'hsl(var(--sidebar-accent))',
    color: themeColors.sidebarForegroundMuted,
    boxShadow: 'inset 0 0 0 1px hsl(var(--sidebar-border) / 0.6)',
  },
  emptyMarkGlyph: { width: themeSpace[4], height: themeSpace[4] },
  emptyTitle: {
    marginTop: themeSpace[3],
    maxWidth: '220px',
    fontWeight: themeFontWeight.medium,
    color: themeColors.sidebarForeground,
  },
  emptyDescription: {
    marginTop: themeSpace[0.5],
    maxWidth: '220px',
    color: themeColors.sidebarForegroundMuted,
  },
  /** A floating panel above the bottom dock. */
  floating: {
    pointerEvents: 'none',
    position: 'absolute',
    zIndex: 10,
  },
  floatingMobile: {
    bottom: themeSpace[12],
    left: 'calc(16px + var(--safe-area-left))',
  },
  floatingDesktop: { bottom: '44px', left: themeSpace[3], right: themeSpace[3] },
  floatingContent: { pointerEvents: 'auto' },
  /** The workspace identity row on mobile. */
  identityMobile: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.lg,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[1.5],
    textAlign: 'left',
    height: themeSpace[9],
    color: themeColors.sidebarForeground,
  },
  /** The repository section's header. */
  repoHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    paddingInline: themeSpace[1],
    fontWeight: themeFontWeight.medium,
    color: themeColors.sidebarForegroundMuted,
  },
  repoHeaderGlyph: { width: themeSpace[3.5], height: themeSpace[3.5] },
  repoHeaderAction: { marginLeft: 'auto', flexShrink: 0 },
  /** A repository's own row. */
  repoRow: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.lg,
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[2],
  },
  repoRowIdle: {
    color: themeColors.sidebarForegroundMuted,
    backgroundColor: { default: 'transparent', ':hover': themeColors.sidebarHover },
  },
  repoRowSelected: {
    color: themeColors.sidebarSelectionForeground,
    backgroundColor: themeColors.sidebarSelection,
  },
  repoDot: {
    height: themeSpace[2],
    width: themeSpace[2],
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.sidebarBorder,
  },
  repoTitle: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  repoAge: { flexShrink: 0, color: themeColors.sidebarForegroundMuted },
  /** The pinned section's own column. */
  pinnedStack: { paddingTop: themeSpace[1] },
  pinnedStackCollapsed: { paddingTop: themeSpace[1], paddingBottom: themeSpace[1] },
  pinnedStackOpen: { paddingTop: themeSpace[1], paddingBottom: themeSpace[3] },
  /** The floating content's own box. */
  floatGlyph: { width: '100%', height: '100%' },
  /** The shell's own glyphs. */
  glyph16: { width: themeSpace[4], height: themeSpace[4] },
  glyph12: { width: themeSpace[3], height: themeSpace[3] },
  glyph14Spaced: { width: themeSpace[3.5], height: themeSpace[3.5], marginRight: themeSpace[1.5] },
  glyphBox16: {
    display: 'flex',
    width: themeSpace[4],
    height: themeSpace[4],
    alignItems: 'center',
    justifyContent: 'center',
  },
  glyphBox20: {
    display: 'flex',
    width: themeSpace[5],
    height: themeSpace[5],
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The archive glyph, and the arrow that replaces it while hovered. */
  glyphFull: { width: '100%', height: '100%' },
  glyphHidden: { width: '100%', height: '100%', display: 'none' },
  /** The desktop workspace row. */
  desktopIdentity: {
    display: 'flex',
    width: '100%',
    minWidth: 0,
    userSelect: 'none',
    alignItems: 'center',
    gap: themeSpace[1.5],
    textAlign: 'left',
    outlineStyle: 'none',
    transitionProperty:
      'color, background-color, border-color, text-decoration-color, fill, stroke',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  /** The mobile workspace row's hover. */
  identityMobileHover: {
    backgroundColor: { default: 'transparent', ':hover': themeColors.sidebarHover },
    color: { default: themeColors.sidebarForeground, ':hover': themeColors.sidebarHoverForeground },
  },
  /** The workspace identity's own box and name. */
  identityBox: { minWidth: 0, flexGrow: 1, flexShrink: 1, flexBasis: '0%' },
  identityRow: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    alignItems: 'center',
    gap: themeSpace[2],
  },
  identityIconSlot: {
    display: 'flex',
    height: themeSpace[5],
    width: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  identityName: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontWeight: themeFontWeight.medium,
  },
  /** A group label's type: a sentence, not a shout. */
  groupLabelType: {
    textTransform: 'none',
    fontWeight: 400,
    letterSpacing: '0rem',
  },
  /** The repository section's own column. */
  repoStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[3],
    paddingTop: themeSpace[1],
  },
  repoGroup: { display: 'flex', flexDirection: 'column', gap: themeSpace[2] },
  pinnedBottom: { paddingBottom: themeSpace[1] },
});

export type LoroSidebarNavKey = 'home' | 'archive' | 'schedules';

export type LoroSidebarChatScope = 'my' | 'team';
export type LoroSidebarOrganizeMode = SidebarOrganizeMode;

export type LoroSidebarWorkspace = {
  id: string;
  slug?: string;
  name: string;
  logo?: string | null;
  /** Paid plan tier for the Plus/Enterprise badge; null/undefined = free. */
  planTier?: 'plus' | 'enterprise' | null;
  /** Member count, when known (the active workspace). Shown in the switcher header. */
  memberCount?: number | null;
};

export type LoroSidebarRepoItemDelta = {
  add: number;
  del: number;
};

export type LoroSidebarRepoItem = {
  id: string;
  title: string;
  ageLabel?: string;
  lineChange?: LoroSidebarRepoItemDelta;
  isSelected?: boolean;
};

export type LoroSidebarRepoSection = {
  id: string;
  repoFullName: string;
  items: LoroSidebarRepoItem[];
};

export type LoroSidebarChatItem = {
  id: string;
  title: string;
  ageLabel?: string;
  isUnread?: boolean;
};

export type LoroSidebarLabels = {
  home: string;
  schedules: string;
  docs: string;
  joinCommunity: string;
  feedback: string;
  bugReport: string;
  myChats: string;
  teamChats: string;
  onlyChats: string;
  switchWorkspace: string;
  createWorkspace: string;
  inviteMembers: string;
  connectGithubRepo: string;
  planPlus: string;
  planEnterprise: string;
  planFree: string;
  pinned: string;
  connectionLoading: string;
  connectionReconnecting: string;
  connectionOffline: string;
  workspaceSyncing: string;
  filter: SidebarFilterLabels;
  updated: SidebarUpdatedSessionListLabels;
};

export interface LoroSidebarProps {
  className?: string;

  workspaceName: string;
  userEmail: string;
  workspaces: LoroSidebarWorkspace[];
  currentWorkspaceId: string;
  /** Stable workspace key for restoring the scroll viewport after a desktop remount. */
  scrollStateKey?: string | null;
  /**
   * Whether the workspace identity opens the switch/create menu. Platforms
   * without the `multiWorkspace` capability render the identity as a static
   * nameplate so the unavailable product concept has no mouse or keyboard
   * affordance.
   */
  workspaceSwitcherEnabled?: boolean;
  connectionUiState?: 'online' | 'loading' | 'offline' | 'reconnecting';
  /**
   * The network may already be online while the target workspace runtime and
   * metadata are still converging. Keep that scoped readiness visible in the
   * workspace identity instead of incorrectly presenting it as ready.
   */
  workspaceSyncing?: boolean;
  isElectron?: boolean;
  isElectronMacOS?: boolean;
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;

  activeNav?: LoroSidebarNavKey | null;

  topContent?: ReactNode;
  /** The filter trigger element rendered in-flow on the first visible section
      header. Caller-owned so its open state survives remounting between slots. */
  desktopFilterAction?: ReactNode;
  /**
   * In-flow content rendered after {@link sessionListProps} inside the scroll
   * viewport (workspace mode only). LoroAppSidebar uses this to place the Chats
   * section below the GitHub Worktrees list so Chats reads as the last section.
   * When present without top or pinned content, that section owns the desktop
   * filter action; the preceding list must not mount a second fallback action.
   */
  afterSessionListContent?: ReactNode;
  bottomFloatingContent?: ReactNode;

  repoSections?: LoroSidebarRepoSection[];
  chats?: LoroSidebarChatItem[];
  sessionListProps?: SessionListProps;

  /**
   * How sidebar contents are grouped. 'workspace' (default) keeps the existing Chats /
   * Local Projects / GitHub Worktrees layout. 'updated' renders {@link updatedItems} as
   * a single flat recency-sorted "Chats" list — when 'updated' is selected,
   * {@link topContent} and {@link sessionListProps} are not rendered.
   */
  organizeMode?: LoroSidebarOrganizeMode;
  /** Current chat scope (My Tasks / All Tasks). Surfaced in the footer filter popover. */
  chatScope?: LoroSidebarChatScope;
  /** Items rendered when {@link organizeMode} is 'updated'. */
  updatedItems?: SidebarUpdatedItem[];
  /** Pinned sessions rendered as a dedicated section above every organize mode. */
  pinnedItems?: SidebarUpdatedItem[];
  /** Whether the dedicated pinned section is collapsed. */
  pinnedSectionCollapsed?: boolean;
  /** Selected item id used to highlight a row in 'updated' mode. */
  updatedSelectedItemId?: string | null;
  /** Per-bucket collapse state for the 'updated' organize mode. */
  updatedBucketsCollapsed?: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
  /**
   * Per-bucket "show all" state for the 'updated' organize mode. Buckets above
   * the threshold default to a compact preview; this map records which buckets
   * the user has expanded.
   */
  updatedShowFullBuckets?: Partial<Record<SidebarUpdatedBucketKey, boolean>>;
  /**
   * Loading state for the 'updated' organize mode. When true and there are no
   * items yet, the list renders a skeleton instead of the empty state — keeps
   * the visual contract aligned with `SessionList.isLoading` in Workspace mode.
   */
  updatedIsLoading?: boolean;
  /** Whether Updated-mode rows show their project mark and name below the title. */
  showUpdatedProjectNames?: boolean;
  onShowUpdatedProjectNamesChange?: (next: boolean) => void;
  /** Whether rows with a branch show the branch segment on their meta line. */
  showBranchNames?: boolean;
  onShowBranchNamesChange?: (next: boolean) => void;
  onOrganizeModeChange?: (mode: LoroSidebarOrganizeMode) => void;
  onChatScopeChange?: (scope: LoroSidebarChatScope) => void;
  onSelectUpdatedItem?: (id: string, tabSessionId?: string) => void;
  onTogglePinnedSection?: () => void;
  onToggleUpdatedBucket?: (key: SidebarUpdatedBucketKey) => void;
  onToggleUpdatedShowFullBucket?: (key: SidebarUpdatedBucketKey) => void;
  /**
   * Archive a session from the 'updated' organize mode. Mirrors `sessionListProps.onArchiveSession`
   * so both organize modes share the same destination handler.
   */
  onArchiveUpdatedItem?: (id: string) => void;
  /** Mark a read session unread in the desktop Updated/Pinned lists. */
  onMarkUpdatedItemUnread?: (id: string) => void;
  /** Rename an Updated row through the shared Rename Chat dialog. */
  onRenameUpdatedItem?: (id: string, nextTitle: string) => void | Promise<void>;
  /** Toggle pin for an Updated row. Mirrors `sessionListProps.onTogglePinSession`. */
  onToggleUpdatedItemPinned?: (id: string, nextPinned: boolean) => void;
  /** Copy session URL for an Updated row. Mirrors `sessionListProps.onCopySessionUrl`. */
  onCopyUpdatedItemUrl?: (id: string) => void;
  /** Share an Updated row with the team. Mirrors `sessionListProps.onShareSessionWithTeam`. */
  onShareUpdatedItemWithTeam?: (id: string) => void;
  /** Open PR for a github Updated row. Mirrors `sessionListProps.onOpenPullRequest`. */
  onOpenUpdatedItemPullRequest?: (request: SessionListPullRequestOpen) => void;
  getUpdatedItemHref?: (id: string) => string | undefined;

  labels?: Partial<LoroSidebarLabels>;

  onWorkspaceSelected?: (workspaceId: string) => void;
  onCreateWorkspaceClicked?: () => void;
  onInviteClicked?: () => void;
  onLinkRepoClicked?: () => void;
  onHomeClicked?: () => void;
  onArchiveClicked?: () => void;
  /** Shows the Schedules entry; absent where there is nowhere to go. */
  onSchedulesClicked?: () => void;
  onSettingsClicked?: () => void;
  onDocsClicked?: () => void;
  onGithubClicked?: () => void;
  onJoinCommunityClicked?: () => void;
  onFeedbackClicked?: () => void;
  onBugReportClicked?: () => void;
  onChatScopeChanged?: (scope: LoroSidebarChatScope) => void;
  onWidthChange?: (width: number) => void;
  /**
   * When true, the sidebar renders nothing (fully hidden). Mobile ignores this —
   * mobile uses the drawer instead. Drag-to-collapse and the workspace-row
   * hover button both fire `onRequestCollapse` to set this externally.
   */
  collapsed?: boolean;
  /**
   * Fired when the user requests collapsing the sidebar (drag past threshold,
   * hover-reveal button on the workspace row, or keyboard shortcut at parent).
   */
  onRequestCollapse?: () => void;
  /**
   * Overlay presentation for the compact desktop layout: fluid width owned by
   * the caller's wrapper, no resize sash. Desktop chrome stays desktop —
   * unlike `isMobile`, which swaps in touch chrome and safe-area insets.
   */
  overlay?: boolean;
}

/**
 * Drag the resize edge to the LEFT so the unclamped width drops below this
 * value -> the sidebar collapses. Matches VSCode's drag-to-collapse behavior.
 */
const COLLAPSE_DRAG_THRESHOLD = 160;

const resizeStyles = stylex.create({
  handle: {
    position: 'absolute',
    right: '-3.5px',
    top: radius.large,
    bottom: `calc(${space[8]} + ${space[2]})`,
    zIndex: 20,
    width: '7px',
    cursor: 'col-resize',
    touchAction: 'none',
    color: colors.label,
    '--sidebar-resize-opacity': {
      default: 0,
      ':hover': 0.42,
    },
  },
  dragging: {
    '--sidebar-resize-opacity': 0.56,
  },
  feedback: {
    position: 'absolute',
    insetBlock: 0,
    left: '50%',
    width: '1px',
    transform: 'translateX(-50%)',
    borderRadius: radius.full,
    backgroundImage: 'linear-gradient(to bottom, transparent, currentColor, transparent)',
    pointerEvents: 'none',
    opacity: 'var(--sidebar-resize-opacity)',
  },
});

const footerStyles = stylex.create({
  layout: { display: 'flex', flexShrink: 0, alignItems: 'center', justifyContent: 'space-between' },
  mobile: {
    borderTopWidth: '0.5px',
    borderTopStyle: 'solid',
    borderTopColor: themeColors.sidebarBorder,
    paddingLeft: 'calc(6px + var(--safe-area-left))',
    paddingRight: 'calc(12px + var(--safe-area-right))',
    paddingTop: themeSpace[1],
    paddingBottom: themeSpace[2],
  },
  paddingDesktop: { paddingInline: themeSpace[2.5], paddingBlock: themeSpace[1.5] },
  desktop: { columnGap: space[1] },
  workspace: { display: 'flex', minWidth: 0, flex: 1, alignItems: 'center' },
  actions: {
    display: 'flex',
    alignItems: 'center',
    flexShrink: 0,
    gap: space[1],
  },
  /** The current page's button on mobile; desktop uses `sidebarSurface.selected`. */
  selectedMobileAction: {
    display: 'inline-flex',
    backgroundColor: colors.selectedFill,
    borderRadius: radius.large,
  },
});

const defaultLabels: LoroSidebarLabels = {
  home: 'Home',
  schedules: 'Schedules',
  docs: 'Docs',
  joinCommunity: 'Join community',
  feedback: 'Feedback',
  bugReport: 'Report bug',
  myChats: 'My Tasks',
  teamChats: 'All Tasks',
  onlyChats: 'Chats',
  switchWorkspace: 'Switch workspace',
  createWorkspace: 'Create workspace',
  inviteMembers: 'Invite members',
  connectGithubRepo: 'Connect GitHub repo',
  planPlus: 'Plus',
  planEnterprise: 'Enterprise',
  planFree: 'Free',
  pinned: 'Pinned',
  connectionLoading: 'Loading',
  connectionReconnecting: 'Reconnecting',
  connectionOffline: 'Offline',
  workspaceSyncing: 'Syncing workspace…',
  filter: {
    triggerAriaLabel: 'Filter sidebar',
    organizeHeading: 'View',
    showHeading: 'Tasks',
    detailsHeading: 'Details',
    organizeProject: 'Project',
    organizeUpdated: 'Updated',
    updatedProjectNames: 'Show Project',
    showBranchNames: 'Show Branch',
    showMyTasks: 'My Tasks',
    showAllTasks: 'All Tasks',
    emptyMyTasks: 'No tasks match this view',
    emptyMyTasksHint: 'Try showing every task in this workspace.',
    emptyAllTasks: 'No tasks yet',
    emptyAllTasksHint: 'Tasks in this workspace will appear here.',
    showAllTasksAction: 'Show all tasks',
  },
  updated: {
    heading: 'Chats',
    emptyTitle: 'Nothing yet',
    emptyDescription: 'Start a chat or open a worktree to see it here.',
  },
};

const PINNED_BUCKETS_COLLAPSED: Partial<Record<SidebarUpdatedBucketKey, boolean>> = {
  all: true,
};

const defaultRepoSections: LoroSidebarRepoSection[] = [
  {
    id: 'repo-1',
    repoFullName: 'loro-dev/loro',
    items: [
      {
        id: 'task-1',
        title: 'Browser notifications',
        ageLabel: '1d',
        lineChange: { add: 123, del: 912 },
        isSelected: true,
      },
      {
        id: 'task-2',
        title: 'Flock meta persistence',
        ageLabel: '2d',
        lineChange: { add: 456, del: 12 },
      },
      {
        id: 'task-3',
        title: 'Why frontend crash',
        ageLabel: '1w',
      },
    ],
  },
  {
    id: 'repo-2',
    repoFullName: 'loro-dev/lody',
    items: [
      {
        id: 'task-4',
        title: 'Fix Data Persistence Issue',
        ageLabel: '10m',
        lineChange: { add: 456, del: 12 },
      },
      {
        id: 'task-5',
        title: 'Delete outdated comments',
        ageLabel: '12m',
        lineChange: { add: 0, del: 172 },
      },
    ],
  },
];

const defaultChats: LoroSidebarChatItem[] = [
  { id: 'chat-1', title: 'Temperature of the sun', ageLabel: '1h', isUnread: true },
  { id: 'chat-2', title: 'How to design workflow', ageLabel: '2h', isUnread: true },
];

function ageLabelToDate(label: string | undefined, now: Date): Date {
  if (!label) return now;

  const match = label.trim().match(/^(\d+)(mo|[mhdwy])$/);
  if (!match) return now;

  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return now;

  const unit = match[2];
  const minuteMs = 60_000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  const deltaMs =
    unit === 'm'
      ? amount * minuteMs
      : unit === 'h'
        ? amount * hourMs
        : unit === 'd'
          ? amount * dayMs
          : unit === 'w'
            ? amount * 7 * dayMs
            : unit === 'mo'
              ? amount * 30 * dayMs
              : amount * 365 * dayMs;

  return new Date(now.getTime() - deltaMs);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function GlassSurface({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn(stylex.props(shellStyles.glass).className, className)}>
      <div {...stylex.props(shellStyles.relative)}>{children}</div>
    </div>
  );
}

type WorkspaceIdentityStatus = 'loading' | 'reconnecting' | 'offline' | 'syncing';

function ConnectionPill({
  state,
  labels,
}: {
  state: WorkspaceIdentityStatus;
  labels: Pick<
    LoroSidebarLabels,
    'connectionLoading' | 'connectionReconnecting' | 'connectionOffline' | 'workspaceSyncing'
  >;
}) {
  const isLoading = state !== 'offline';
  const label =
    state === 'syncing'
      ? labels.workspaceSyncing
      : state === 'reconnecting'
        ? labels.connectionReconnecting
        : state === 'loading'
          ? labels.connectionLoading
          : labels.connectionOffline;
  return (
    <Badge
      tone={isLoading ? 'running' : 'danger'}
      icon={isLoading ? <WorkingGrid {...stylex.props(shellStyles.glyph12)} /> : undefined}
      aria-label={label}
      data-workspace-status={state}
    >
      {label}
    </Badge>
  );
}

type IconButtonProps = {
  active?: boolean;
  className?: string;
  label: string;
  children: ReactNode;
} & Omit<ComponentPropsWithoutRef<'button'>, 'children' | 'className' | 'type'>;

const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { active = false, className, label, children, ...buttonProps }: IconButtonProps,
  ref
) {
  const isMobile = useIsMobile();
  if (!isMobile) {
    // Desktop: the navigation rows' ink and fills, not the generic ghost
    // button's, so the footer reads as the header's sibling.
    return (
      <button
        ref={ref}
        type="button"
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn(
          stylex.props(
            sidebarSurface.iconButton,
            active && sidebarSurface.selected,
            shellStyles.unselectable,
            shellStyles.nativeControl,
            shellStyles.noFocusRing
          ).className,
          className
        )}
        {...buttonProps}
      >
        <span {...stylex.props(shellStyles.glyphBox16)}>{children}</span>
        <span {...stylex.props(shellStyles.accessibleLabel)}>{label}</span>
      </button>
    );
  }
  const button = (
    <Button
      ref={ref}
      type="button"
      variant="ghost"
      size="small"
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      className={cn('h-12 w-12', className)}
      {...buttonProps}
    >
      <span {...stylex.props(shellStyles.glyphBox20)}>{children}</span>
      <span {...stylex.props(shellStyles.accessibleLabel)}>{label}</span>
    </Button>
  );
  return active ? (
    <span {...stylex.props(footerStyles.selectedMobileAction)}>{button}</span>
  ) : (
    button
  );
});

/**
 * The live binding for a command, formatted for this platform, or null when the
 * command is unbound (or not registered). Read from the registry rather than
 * `COMMAND_SHORTCUTS` so a rebound key is what the tooltip teaches.
 */
function useCommandShortcutLabel(id: ShortcutCommandId): string | null {
  const binding = useSyncExternalStore(
    (onChange) => commands.subscribe(onChange),
    // A string, not the array: `getKeybindingsFor` allocates, and an unstable
    // snapshot would re-render forever.
    () => commands.getKeybindingsFor(id)[0] ?? '',
    () => ''
  );
  return binding ? formatKeyBinding(binding) : null;
}

type NavigationAvailability = {
  canGoBack: boolean;
  canGoForward: boolean;
};

type WindowNavigation = {
  canGoBack: boolean;
  canGoForward: boolean;
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
};

const readNavigationAvailability = (): NavigationAvailability => {
  const navigation = (window as Window & { navigation?: WindowNavigation }).navigation;
  if (navigation && typeof navigation.canGoBack === 'boolean') {
    return { canGoBack: navigation.canGoBack, canGoForward: navigation.canGoForward };
  }
  return {
    canGoBack: window.history.length > 1,
    canGoForward: false,
  };
};

let navigationAvailabilitySnapshot: NavigationAvailability = {
  canGoBack: false,
  canGoForward: false,
};

const getNavigationAvailabilitySnapshot = (): NavigationAvailability => {
  const next = readNavigationAvailability();
  if (
    next.canGoBack === navigationAvailabilitySnapshot.canGoBack &&
    next.canGoForward === navigationAvailabilitySnapshot.canGoForward
  ) {
    return navigationAvailabilitySnapshot;
  }
  navigationAvailabilitySnapshot = next;
  return next;
};

const subscribeNavigationAvailability = (onStoreChange: () => void) => {
  window.addEventListener('popstate', onStoreChange);
  const navigation = (window as Window & { navigation?: WindowNavigation }).navigation;
  navigation?.addEventListener('currententrychange', onStoreChange);
  navigation?.addEventListener('navigate', onStoreChange);
  return () => {
    window.removeEventListener('popstate', onStoreChange);
    navigation?.removeEventListener('currententrychange', onStoreChange);
    navigation?.removeEventListener('navigate', onStoreChange);
  };
};

function useNavigationAvailability(): NavigationAvailability {
  return useSyncExternalStore(
    subscribeNavigationAvailability,
    getNavigationAvailabilitySnapshot,
    () => navigationAvailabilitySnapshot
  );
}

function SidebarHeaderIconButton({
  label,
  shortcut,
  onClick,
  className,
  disabled = false,
  children,
}: {
  label: string;
  shortcut?: string | null;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
  children: ReactNode;
}) {
  const button = (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        // The same box, ink and fills as the footer's icon buttons.
        stylex.props(
          sidebarSurface.iconButton,
          shellStyles.nativeControl,
          // Disabled controls retain their muted ink without a hover fill.
          disabled ? shellStyles.disabledControl : shellStyles.noFocusRing
        ).className,
        className
      )}
    >
      {children}
    </button>
  );
  if (disabled) return button;
  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={button} />
      <Tooltip.Content side="bottom" className="flex items-center gap-1.5">
        <span>{label}</span>
        {shortcut ? <Kbd>{shortcut}</Kbd> : null}
      </Tooltip.Content>
    </Tooltip.Root>
  );
}

function NavButton({
  active,
  isMobile,
  label,
  icon,
  onClick,
  badge,
  action,
}: {
  active: boolean;
  isMobile: boolean;
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  /** Optional trailing count. Omitted (not zero-rendered) when there is nothing to report. */
  badge?: number;
  /**
   * Trailing control (e.g. Tasks' quick-add `+`). A sibling of the row button,
   * never a child: a button inside a button is invalid markup, and the browser
   * would route the click to the row underneath it.
   */
  action?: ReactNode;
}) {
  return (
    <div {...stylex.props(shellStyles.navRow)}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          // Same size as the session titles below: a smaller label reads as
          // undersized next to its 16px icon.
          SIDEBAR_ROW_TEXT_CLASS,
          'group',
          // Desktop rows share a +15px icon and +37px text column with the
          // project, repository, and session rows below them. Same brightness as
          // unselected session titles; hover changes the fill only.
          stylex.props(
            shellStyles.navControl,
            isMobile ? shellStyles.navGapMobile : shellStyles.navGapDesktop,
            sidebarSurface.row,
            // Desktop: the 20px icon slot plus 4px padding is the same 28px as a
            // Workspace conversation row (its 20px end slot sets that height), so
            // navigation and list share one rhythm. Touch keeps the taller target.
            isMobile ? sidebarSurface.tall : sidebarSurface.navSnug,
            !isMobile && sidebarSurface.navInset,
            active ? sidebarSurface.selected : sidebarSurface.hover,
            // Keep the label clear of the trailing control instead of letting it
            // truncate under it.
            Boolean(action) && sidebarSurface.navAction
          ).className,
          stylex.props(shellStyles.noFocusRing).className
        )}
      >
        {/* The slot is the 16px icon box itself, not a padded frame. On desktop,
            its +15px start and the label's +37px start match the list rows.
            Height stays 20px to keep the row's optical line. */}
        {/* Icons rest one step quieter than the label so the words lead; they
            come up to full ink with the hover or the selected fill. */}
        <span
          className={clsx(
            stylex.props(shellStyles.navIcon).className,
            stylex.props(active ? shellStyles.currentInk : shellStyles.navIconIdle).className,
            // The icon comes up to the row's ink when the pointer is over it.
            'group-hover:text-current'
          )}
        >
          {icon}
        </span>
        <span {...stylex.props(shellStyles.navLabel)}>{label}</span>
        {badge !== undefined && badge > 0 ? (
          <span
            className={clsx(
              SIDEBAR_CAPTION_TEXT_CLASS,
              stylex.props(shellStyles.switcherMeta).className
            )}
          >
            {badge > 99 ? '99+' : badge}
          </span>
        ) : null}
      </button>
      {action ? <span {...stylex.props(shellStyles.navAction)}>{action}</span> : null}
    </div>
  );
}

export function getLoroSidebarFooterClassName(isMobile: boolean): string {
  return (
    stylex.props(footerStyles.layout, isMobile ? footerStyles.mobile : footerStyles.paddingDesktop)
      .className ?? ''
  );
}

export const DEFAULT_DESKTOP_SIDEBAR_WIDTH = 300;
export const MIN_DESKTOP_SIDEBAR_WIDTH = 240;
export const MAX_DESKTOP_SIDEBAR_WIDTH = 420;

export const LoroSidebar = memo(function LoroSidebar({
  className,
  workspaceName,
  userEmail,
  workspaces,
  currentWorkspaceId,
  scrollStateKey,
  workspaceSwitcherEnabled = true,
  connectionUiState,
  workspaceSyncing = false,
  isElectron = false,
  isElectronMacOS: _isElectronMacOS = false,
  defaultWidth = DEFAULT_DESKTOP_SIDEBAR_WIDTH,
  minWidth = MIN_DESKTOP_SIDEBAR_WIDTH,
  maxWidth = MAX_DESKTOP_SIDEBAR_WIDTH,
  activeNav = null,
  topContent,
  desktopFilterAction,
  afterSessionListContent,
  bottomFloatingContent,
  repoSections = defaultRepoSections,
  chats = defaultChats,
  sessionListProps,
  organizeMode = 'workspace',
  chatScope = 'my',
  updatedItems,
  pinnedItems,
  pinnedSectionCollapsed = false,
  updatedSelectedItemId,
  updatedBucketsCollapsed,
  updatedShowFullBuckets,
  updatedIsLoading = false,
  showUpdatedProjectNames = true,
  onShowUpdatedProjectNamesChange,
  showBranchNames = false,
  onShowBranchNamesChange,
  onOrganizeModeChange,
  onChatScopeChange,
  onSelectUpdatedItem,
  onTogglePinnedSection,
  onToggleUpdatedBucket,
  onToggleUpdatedShowFullBucket,
  onArchiveUpdatedItem,
  onMarkUpdatedItemUnread,
  onRenameUpdatedItem,
  onToggleUpdatedItemPinned,
  onCopyUpdatedItemUrl,
  onShareUpdatedItemWithTeam,
  onOpenUpdatedItemPullRequest,
  getUpdatedItemHref,
  labels,
  onWorkspaceSelected,
  onCreateWorkspaceClicked,
  onInviteClicked,
  onLinkRepoClicked,
  onHomeClicked,
  onArchiveClicked,
  onSchedulesClicked,
  onSettingsClicked,
  onDocsClicked,
  onGithubClicked,
  onJoinCommunityClicked,
  onFeedbackClicked,
  onBugReportClicked,
  onWidthChange,
  collapsed = false,
  onRequestCollapse,
  overlay = false,
}: LoroSidebarProps) {
  const schedulesAllowed = useWorkspaceFeature('schedules');
  const isMobile = useIsMobile();
  const isElectronFullscreen = useElectronFullscreen();
  const macTrafficLightRowPadClass = useMacTrafficLightRowPadClass();
  const windowsCaptionRowPadClass = useWindowsCaptionRowPadClass();
  const { t } = useTranslation();
  const store = useStore();
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !scrollStateKey) return undefined;
    viewport.scrollTop = store.get(sidebarScrollTopByWorkspaceAtom)[scrollStateKey] ?? 0;
    return () => {
      const previous = store.get(sidebarScrollTopByWorkspaceAtom);
      store.set(sidebarScrollTopByWorkspaceAtom, {
        ...previous,
        [scrollStateKey]: viewport.scrollTop,
      });
    };
  }, [collapsed, scrollStateKey, store]);
  const collapseShortcut = useCommandShortcutLabel('sidebar.toggle');
  const backShortcut = useCommandShortcutLabel('nav.back');
  const forwardShortcut = useCommandShortcutLabel('nav.forward');
  const { canGoBack, canGoForward } = useNavigationAvailability();
  const mergedLabels: LoroSidebarLabels = {
    ...defaultLabels,
    ...labels,
    filter: { ...defaultLabels.filter, ...(labels?.filter ?? {}) },
    updated: { ...defaultLabels.updated, ...(labels?.updated ?? {}) },
  };
  const now = useStableNow();
  const resolvedMinWidth = useMemo(() => Math.max(160, minWidth), [minWidth]);
  const resolvedMaxWidth = useMemo(
    () => Math.max(resolvedMinWidth + 40, maxWidth),
    [resolvedMinWidth, maxWidth]
  );
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    clamp(defaultWidth, resolvedMinWidth, resolvedMaxWidth)
  );
  const [isResizing, setIsResizing] = useState(false);
  const resizeStateRef = useRef({ pointerId: -1, startX: 0, startWidth: 0 });

  useEffect(() => {
    setSidebarWidth(clamp(defaultWidth, resolvedMinWidth, resolvedMaxWidth));
  }, [defaultWidth, resolvedMinWidth, resolvedMaxWidth]);

  const handleResizeStart = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      resizeStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: sidebarWidth,
      };
      setIsResizing(true);
    },
    [isMobile, sidebarWidth]
  );

  const handleResizeMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      const { pointerId, startX, startWidth } = resizeStateRef.current;
      if (pointerId !== event.pointerId) return;
      const rawWidth = startWidth + (event.clientX - startX);
      if (onRequestCollapse && rawWidth < COLLAPSE_DRAG_THRESHOLD) {
        // VSCode-style: dragging past the threshold collapses immediately and ends drag.
        resizeStateRef.current.pointerId = -1;
        setIsResizing(false);
        try {
          event.currentTarget.releasePointerCapture(event.pointerId);
        } catch {
          // Ignore release errors when pointer capture is already gone.
        }
        onRequestCollapse();
        return;
      }
      const nextWidth = clamp(rawWidth, resolvedMinWidth, resolvedMaxWidth);
      setSidebarWidth(nextWidth);
      onWidthChange?.(nextWidth);
    },
    [isMobile, resolvedMinWidth, resolvedMaxWidth, onWidthChange, onRequestCollapse]
  );

  const handleResizeEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isMobile) return;
      const { pointerId } = resizeStateRef.current;
      if (pointerId !== event.pointerId) return;
      resizeStateRef.current.pointerId = -1;
      setIsResizing(false);
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // Ignore release errors when pointer capture is already gone.
      }
    },
    [isMobile]
  );
  const fallbackChatSessions: SessionListRow[] = chats.map((chat) => ({
    sessionId: chat.id,
    title: chat.title,
    repoFullName: null,
    branchName: '',
    prUrl: null,
    latestMessageAt: ageLabelToDate(chat.ageLabel, now),
    addedLines: 0,
    deletedLines: 0,
    isWorking: false,
    hasUnreadMessages: Boolean(chat.isUnread),
    isOffline: false,
    isWaitingPermission: false,
  }));
  const resolvedChatsSessionListProps: SessionListProps | null = fallbackChatSessions.length
    ? { sessions: fallbackChatSessions, repos: [] }
    : null;
  const sessionListClassName = sessionListProps?.className;
  const chatsSessionListClassName = resolvedChatsSessionListProps?.className;
  if (!isMobile && collapsed) {
    return null;
  }

  // The filter trigger is a normal in-flow action on whichever section header
  // is first — the row's items-center keeps it aligned, so no overlay or
  // placeholder. The caller supplies the element with lifted open state so
  // remounting the one instance at a new slot keeps an open popover open; the
  // local fallback covers direct uses (e.g. stories) that do not pass one.
  const sectionHeaderFilterAction = !isMobile
    ? (desktopFilterAction ?? (
        <SidebarFilterPopover
          organize={organizeMode}
          scope={chatScope}
          onOrganizeChange={onOrganizeModeChange}
          onScopeChange={onChatScopeChange}
          showUpdatedProjectNames={showUpdatedProjectNames}
          onShowUpdatedProjectNamesChange={onShowUpdatedProjectNamesChange}
          showBranchNames={showBranchNames}
          onShowBranchNamesChange={onShowBranchNamesChange}
          labels={mergedLabels.filter}
          side="right"
          align="start"
          triggerSize="mini"
        />
      ))
    : null;
  const hasPinnedItems = Boolean(pinnedItems?.length);
  const isWorkspaceEmpty =
    organizeMode === 'workspace' &&
    !topContent &&
    !hasPinnedItems &&
    !afterSessionListContent &&
    !sessionListProps?.isLoading;
  const workspaceEmptyState = isWorkspaceEmpty ? (
    <div {...stylex.props(shellStyles.emptyState)} data-sidebar-empty-state={chatScope}>
      <div {...stylex.props(shellStyles.emptyMark)}>
        {chatScope === 'my' ? (
          <ListFilter
            {...stylex.props(shellStyles.emptyMarkGlyph)}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        ) : (
          <ClipboardList
            {...stylex.props(shellStyles.emptyMarkGlyph)}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        )}
      </div>
      <p
        className={clsx(SIDEBAR_CONTROL_TEXT_CLASS, stylex.props(shellStyles.emptyTitle).className)}
      >
        {chatScope === 'my' ? mergedLabels.filter.emptyMyTasks : mergedLabels.filter.emptyAllTasks}
      </p>
      <p
        className={clsx(
          SIDEBAR_HELPER_TEXT_CLASS,
          stylex.props(shellStyles.emptyDescription).className
        )}
      >
        {chatScope === 'my'
          ? mergedLabels.filter.emptyMyTasksHint
          : mergedLabels.filter.emptyAllTasksHint}
      </p>
      {chatScope === 'my' && onChatScopeChange ? (
        <Button
          type="button"
          variant="secondary"
          size="small"
          className={cn(
            SIDEBAR_HELPER_TEXT_CLASS,
            'mt-3 h-7 rounded-full border-sidebar-border bg-sidebar px-3 font-medium text-sidebar-foreground shadow-none hover:bg-sidebar-hover hover:text-sidebar-hover-foreground'
          )}
          onClick={() => onChatScopeChange('team')}
        >
          <Users
            {...stylex.props(shellStyles.glyph14Spaced)}
            strokeWidth={1.8}
            aria-hidden="true"
          />
          {mergedLabels.filter.showAllTasksAction}
        </Button>
      ) : null}
    </div>
  ) : undefined;
  const workspaceIdentityStatus: WorkspaceIdentityStatus | null =
    connectionUiState && connectionUiState !== 'online'
      ? connectionUiState
      : workspaceSyncing
        ? 'syncing'
        : null;
  const workspaceIdentity = (
    <>
      <WorkspaceAvatar
        workspace={{
          name: workspaceName,
          logo: workspaces.find((ws) => ws.id === currentWorkspaceId)?.logo,
        }}
        size="small"
      />
      <span {...stylex.props(shellStyles.identityRow)}>
        <span {...stylex.props(shellStyles.identityName)}>{workspaceName}</span>
        {workspaceIdentityStatus ? (
          <ConnectionPill state={workspaceIdentityStatus} labels={mergedLabels} />
        ) : null}
      </span>
    </>
  );
  // Desktop: laid out like a navigation row: the avatar in a 16px icon column (h-5
  // slot, as `NavButton`), then the name in the row's regular weight.
  const desktopWorkspaceIdentity = (
    <>
      <span {...stylex.props(shellStyles.identityIconSlot)}>
        <WorkspaceAvatar
          workspace={{
            name: workspaceName,
            logo: workspaces.find((ws) => ws.id === currentWorkspaceId)?.logo,
          }}
          className="h-4 w-4 text-[9px]"
        />
      </span>
      <span {...stylex.props(shellStyles.identityRow)}>
        <span {...stylex.props(shellStyles.identityName)}>{workspaceName}</span>
        {workspaceIdentityStatus ? (
          <ConnectionPill state={workspaceIdentityStatus} labels={mergedLabels} />
        ) : null}
      </span>
    </>
  );
  const desktopWorkspaceRowClassName = (interactive: boolean) =>
    clsx(
      SIDEBAR_ROW_TEXT_CLASS,
      stylex.props(
        sidebarSurface.row,
        sidebarSurface.footerRow,
        interactive && sidebarSurface.hover
      ).className,
      stylex.props(shellStyles.desktopIdentity).className,
      interactive && stylex.props(shellStyles.noFocusRing).className
    );
  const windowDrag = isElectron && !isElectronFullscreen;
  const mobileWorkspaceIdentityClassName = clsx(
    SIDEBAR_CONTROL_TEXT_CLASS,
    stylex.props(shellStyles.identityMobile).className,
    // Preserve this explicit dark-ancestor ink step until the marker/theme
    // contract covers the mobile workspace identity.
    'dark:text-sidebar-foreground/75',
    workspaceSwitcherEnabled && stylex.props(shellStyles.identityMobileHover).className
  );
  const getPlanLabel = (planTier: LoroSidebarWorkspace['planTier']) =>
    planTier === 'enterprise'
      ? mergedLabels.planEnterprise
      : planTier === 'plus'
        ? mergedLabels.planPlus
        : mergedLabels.planFree;
  const newWindowHint = t('workspace.openInNewWindowHint', {
    key: isMacOSElectronRenderer() ? '⌘' : 'Ctrl',
  });
  const renderWorkspaceControl = (menuSide: 'top' | 'bottom') =>
    workspaceSwitcherEnabled ? (
      <Menu.Root modal={!isMobile}>
        <div {...stylex.props(shellStyles.identityBox)}>
          <Menu.Trigger
            render={
              isMobile ? (
                <button
                  type="button"
                  className={cn(
                    mobileWorkspaceIdentityClassName,
                    windowDrag && WINDOW_DRAG_EXEMPT_CLASS
                  )}
                  data-workspace-switcher-trigger
                  data-workspace-syncing={workspaceSyncing ? 'true' : 'false'}
                  aria-busy={workspaceSyncing || undefined}
                >
                  {workspaceIdentity}
                </button>
              ) : (
                <button
                  type="button"
                  className={cn(
                    desktopWorkspaceRowClassName(true),
                    windowDrag && WINDOW_DRAG_EXEMPT_CLASS
                  )}
                  data-workspace-switcher-trigger
                  data-workspace-syncing={workspaceSyncing ? 'true' : 'false'}
                  aria-busy={workspaceSyncing || undefined}
                >
                  {desktopWorkspaceIdentity}
                </button>
              )
            }
          />
        </div>
        <Menu.Content align="start" side={menuSide} className="w-64">
          <Menu.GroupLabel
            className={clsx(
              SIDEBAR_HELPER_TEXT_CLASS,
              stylex.props(shellStyles.groupLabelType).className
            )}
          >
            {userEmail}
          </Menu.GroupLabel>
          <Menu.Separator />

          {workspaces.length > 0 ? (
            <>
              <Menu.GroupLabel className={clsx(SIDEBAR_HELPER_TEXT_CLASS, 'font-medium')}>
                {mergedLabels.switchWorkspace}
              </Menu.GroupLabel>
              <Menu.RadioGroup
                value={currentWorkspaceId}
                onValueChange={(value) => onWorkspaceSelected?.(value)}
              >
                {/* Local provider: hosts may render the sidebar without a root one. */}
                <Tooltip.Provider delay={400}>
                  {workspaces.map((ws) => {
                    const workspaceSlug = ws.slug;
                    const supportsNewWindow = isElectronRenderer() && !!workspaceSlug;
                    // The avatar carries identity, so the check moves to the
                    // row's trailing edge. ps-2/pe-8 replace the ps-8 selection
                    // indent: the 20px avatar and the action rows' 20px icon
                    // boxes share one leading column, and gap-1.5 lands every
                    // label on the same text column.
                    const row = (
                      <Menu.RadioItem
                        key={ws.id}
                        value={ws.id}
                        indicator="check"
                        indicatorSide="end"
                        // Resolve the radio item in the dropdown's context before
                        // introducing the separate right-click menu in its render.
                        render={
                          supportsNewWindow
                            ? (props) => (
                                <ContextMenu.Root>
                                  <ContextMenu.Trigger render={<div {...props} />} />
                                  <ContextMenu.Content>
                                    <ContextMenu.Item
                                      icon={AppWindow}
                                      onClick={() => {
                                        openDesktopWindow(undefined, workspaceSlug, 'context_menu');
                                      }}
                                    >
                                      {t('workspace.openInNewWindow')}
                                    </ContextMenu.Item>
                                  </ContextMenu.Content>
                                </ContextMenu.Root>
                              )
                            : undefined
                        }
                        icon={
                          <WorkspaceAvatar
                            workspace={{ name: ws.name, logo: ws.logo }}
                            className="h-5 w-5 text-[10px]"
                          />
                        }
                        className="gap-1.5 ps-2"
                        onClickCapture={(event) => {
                          if (!workspaceSlug || !isNewWindowClick(event)) return;
                          if (openDesktopWindow(undefined, workspaceSlug, 'modifier_click')) {
                            event.preventDefault();
                            event.stopPropagation();
                          }
                        }}
                        endContent={
                          ws.id === currentWorkspaceId ? (
                            // The checked row is the current workspace — it
                            // carries the richer plan/members line that used to
                            // need a separate header card.
                            <span
                              className={clsx(
                                SIDEBAR_CAPTION_TEXT_CLASS,
                                stylex.props(shellStyles.switcherMeta).className,
                                stylex.props(shellStyles.clipped).className
                              )}
                            >
                              {typeof ws.memberCount === 'number'
                                ? t('workspace.switcher.planAndMembers', {
                                    plan: getPlanLabel(ws.planTier),
                                    count: ws.memberCount,
                                  })
                                : t('workspace.switcher.plan', {
                                    plan: getPlanLabel(ws.planTier),
                                  })}
                            </span>
                          ) : ws.planTier ? (
                            <Badge>
                              {ws.planTier === 'enterprise'
                                ? mergedLabels.planEnterprise
                                : mergedLabels.planPlus}
                            </Badge>
                          ) : null
                        }
                      >
                        {ws.name}
                      </Menu.RadioItem>
                    );

                    if (!supportsNewWindow || ws.id === currentWorkspaceId) return row;

                    return (
                      <Tooltip.Root key={ws.id}>
                        <Tooltip.Trigger render={row} />
                        <Tooltip.Content side="right" sideOffset={8}>
                          {newWindowHint}
                        </Tooltip.Content>
                      </Tooltip.Root>
                    );
                  })}
                </Tooltip.Provider>
              </Menu.RadioGroup>
              <Menu.Separator />
            </>
          ) : null}

          {/* Icon boxes match the radio rows' avatars, so both row kinds
              share one leading column and one text column. */}
          <Menu.Item className="gap-1.5" icon={Plus} onClick={() => onCreateWorkspaceClicked?.()}>
            {mergedLabels.createWorkspace}
          </Menu.Item>
          <Menu.Item className="gap-1.5" icon={Users} onClick={() => onInviteClicked?.()}>
            {mergedLabels.inviteMembers}
          </Menu.Item>
          <Menu.Item className="gap-1.5" icon={Link2} onClick={() => onLinkRepoClicked?.()}>
            {mergedLabels.connectGithubRepo}
          </Menu.Item>
        </Menu.Content>
      </Menu.Root>
    ) : (
      <div {...stylex.props(shellStyles.identityBox)}>
        <div
          className={
            isMobile ? mobileWorkspaceIdentityClassName : desktopWorkspaceRowClassName(false)
          }
          data-workspace-identity
        >
          {isMobile ? workspaceIdentity : desktopWorkspaceIdentity}
        </div>
      </div>
    );

  return (
    <div
      // No overflow-hidden here: the resize sash extends past the right border
      // so its hit area straddles the edge; the inner content div clips instead.
      className={clsx(stylex.props(shellStyles.shell).className, className)}
      style={
        isMobile || overlay
          ? undefined
          : { width: sidebarWidth, minWidth: resolvedMinWidth, maxWidth: resolvedMaxWidth }
      }
    >
      {!isMobile && !overlay && (
        <div
          data-sidebar-resize-handle
          {...stylex.props(resizeStyles.handle, isResizing && resizeStyles.dragging)}
          onPointerDown={handleResizeStart}
          onPointerMove={handleResizeMove}
          onPointerUp={handleResizeEnd}
          onPointerCancel={handleResizeEnd}
        >
          <div aria-hidden="true" {...stylex.props(resizeStyles.feedback)} />
        </div>
      )}

      <div {...stylex.props(shellStyles.column)}>
        <div
          className={clsx(
            stylex.props(
              shellStyles.header,
              isMobile ? shellStyles.headerMobile : shellStyles.headerDesktop
            ).className,
            cn(macTrafficLightRowPadClass, windowsCaptionRowPadClass),
            windowDrag && WINDOW_DRAG_HEADER_CLASS
          )}
        >
          {isMobile ? (
            <div {...stylex.props(footerStyles.workspace)}>
              {renderWorkspaceControl('bottom')}
              <AuthRecoveryEntrySlot />
            </div>
          ) : isElectron ? (
            <span {...stylex.props(shellStyles.flexFill)} />
          ) : (
            <span
              aria-label="Lody"
              {...stylex.props(shellStyles.wordmark)}
              style={{ fontFamily: 'var(--font-wordmark)' }}
            >
              Lody
            </span>
          )}
          {!isMobile ? (
            <Tooltip.Provider delay={400}>
              <div
                className={clsx(
                  // `gap-0.5` between full-size buttons keeps Back and Forward
                  // apart as two targets instead of one fused control.
                  stylex.props(shellStyles.headerActions).className,
                  windowDrag && WINDOW_DRAG_EXEMPT_CLASS
                )}
              >
                {onRequestCollapse ? (
                  <SidebarHeaderIconButton
                    label={t('commands.sidebar.toggle', 'Toggle Sidebar')}
                    shortcut={collapseShortcut}
                    onClick={() => onRequestCollapse()}
                    // Always visible: the collapse control is found where it
                    // was last seen, not revealed by hovering the header.
                    className="focus-visible:outline-hidden"
                  >
                    <CuidaSidebarExpandOutline {...stylex.props(shellStyles.glyph16)} />
                  </SidebarHeaderIconButton>
                ) : null}
                <SidebarHeaderIconButton
                  disabled={!canGoBack}
                  label={t('commands.nav.back', 'Back')}
                  shortcut={backShortcut}
                  onClick={() => {
                    if (!canGoBack) return;
                    if (!commands.execute('nav.back')) window.history.back();
                  }}
                >
                  <ChevronLeft {...stylex.props(shellStyles.glyph16)} strokeWidth={1.5} />
                </SidebarHeaderIconButton>
                <SidebarHeaderIconButton
                  disabled={!canGoForward}
                  label={t('commands.nav.forward', 'Forward')}
                  shortcut={forwardShortcut}
                  onClick={() => {
                    if (!canGoForward) return;
                    if (!commands.execute('nav.forward')) window.history.forward();
                  }}
                >
                  <ChevronRight {...stylex.props(shellStyles.glyph16)} strokeWidth={1.5} />
                </SidebarHeaderIconButton>
              </div>
            </Tooltip.Provider>
          ) : null}
        </div>

        <div
          className={clsx(
            // `gap-px` keeps navigation rows from painting as one fused block
            // when both are selected-adjacent or hover-highlighted.
            stylex.props(
              shellStyles.navColumn,
              isMobile ? shellStyles.navColumnMobile : shellStyles.navColumnDesktop
            ).className
          )}
        >
          <NavButton
            active={activeNav === 'home'}
            isMobile={isMobile}
            label={mergedLabels.home}
            icon={<MynauiEditOne {...stylex.props(shellStyles.glyph16)} />}
            onClick={onHomeClicked}
          />
          {onSchedulesClicked && schedulesAllowed ? (
            <NavButton
              active={activeNav === 'schedules'}
              isMobile={isMobile}
              label={mergedLabels.schedules}
              icon={<ListTodo {...stylex.props(shellStyles.glyph16)} strokeWidth={1.5} />}
              onClick={onSchedulesClicked}
            />
          ) : null}
          <NavButton
            active={false}
            isMobile={isMobile}
            label={t('common.search', 'Search')}
            icon={<Search {...stylex.props(shellStyles.glyph16)} strokeWidth={1.5} />}
            onClick={() => setCommandPaletteOpen(true)}
          />
        </div>

        <ScrollArea
          viewportRef={scrollViewportRef}
          className={clsx(
            stylex.props(
              shellStyles.scrollColumn,
              isMobile ? shellStyles.scrollColumnMobile : shellStyles.scrollColumnDesktop
            ).className
          )}
          // Overlay only while the list is scrolling. ScrollArea defaults to `hover`,
          // which paints the thumb as soon as the pointer enters the sidebar.
          visibility="scroll"
          // The horizontal gutter must live on the *viewport*, not the ScrollArea
          // root. The viewport is the scroll/clip container; with rows at
          // `w-full` and the gutter on the root, the selected row's 1px `outline`
          // (painted outside the box) sits flush against the viewport's clip edge
          // and gets shaved on the left/right — only the sides, since the viewport
          // scrolls vertically. Padding the viewport insets the rows from that clip
          // edge so the highlight outline renders fully. Geometry/scrollbar position
          // are unchanged (the absolutely-positioned scrollbar tracks the root edge).
          viewportClassName={
            stylex.props(isMobile ? shellStyles.viewportMobile : shellStyles.viewportDesktop)
              .className
          }
        >
          <div {...stylex.props(shellStyles.relative)}>
            {hasPinnedItems ? (
              <div
                className={
                  stylex.props(
                    pinnedSectionCollapsed
                      ? shellStyles.pinnedStackCollapsed
                      : shellStyles.pinnedStackOpen
                  ).className
                }
              >
                <SidebarUpdatedSessionList
                  items={pinnedItems ?? []}
                  now={now}
                  isMobile={isMobile}
                  showPinnedIcon={false}
                  showProjectContext={organizeMode === 'updated' && showUpdatedProjectNames}
                  selectedItemId={updatedSelectedItemId ?? null}
                  collapsedBuckets={pinnedSectionCollapsed ? PINNED_BUCKETS_COLLAPSED : undefined}
                  labels={{
                    heading: mergedLabels.pinned,
                    emptyTitle: mergedLabels.updated.emptyTitle,
                    emptyDescription: mergedLabels.updated.emptyDescription,
                  }}
                  onSelectItem={onSelectUpdatedItem}
                  onToggleBucket={onTogglePinnedSection}
                  toggleBucketLabel={mergedLabels.pinned}
                  onArchiveItem={onArchiveUpdatedItem}
                  onMarkItemUnread={onMarkUpdatedItemUnread}
                  onRenameItem={onRenameUpdatedItem}
                  onTogglePinItem={onToggleUpdatedItemPinned}
                  onCopyItemUrl={onCopyUpdatedItemUrl}
                  onShareItemWithTeam={onShareUpdatedItemWithTeam}
                  onOpenPullRequest={onOpenUpdatedItemPullRequest}
                  getItemHref={getUpdatedItemHref}
                  headerAction={sectionHeaderFilterAction ?? undefined}
                />
              </div>
            ) : null}
            {organizeMode === 'updated' ? (
              // Design intent: 'updated' mode is a flat firehose of recent
              // sessions. It deliberately drops Workspace-mode structure
              // (per-repo groups with collapse/reorder, per-project headers
              // with rename/remove, per-group "+" new-session affordance,
              // GitHub Worktrees / Local Projects section headers). Users who
              // need that structure switch back via the footer popover; the
              // sidebar-state.sidebarOrganizeModeAtom persists the choice.
              // Per-row actions (rename, pin, archive, copy URL, copy branch,
              // open PR) are wired through the props below so the two modes
              // are at parity for individual sessions even though section-
              // level affordances diverge.
              !hasPinnedItems || updatedIsLoading || Boolean(updatedItems?.length) ? (
                <div
                  className={
                    hasPinnedItems ? undefined : stylex.props(shellStyles.pinnedStack).className
                  }
                >
                  <SidebarUpdatedSessionList
                    items={updatedItems ?? []}
                    now={now}
                    isMobile={isMobile}
                    isLoading={updatedIsLoading}
                    showProjectContext={showUpdatedProjectNames}
                    selectedItemId={updatedSelectedItemId ?? null}
                    labels={mergedLabels.updated}
                    collapsedBuckets={updatedBucketsCollapsed}
                    showFullBuckets={updatedShowFullBuckets}
                    onSelectItem={onSelectUpdatedItem}
                    onToggleBucket={onToggleUpdatedBucket}
                    onToggleFullBucket={onToggleUpdatedShowFullBucket}
                    onArchiveItem={onArchiveUpdatedItem}
                    onMarkItemUnread={onMarkUpdatedItemUnread}
                    onRenameItem={onRenameUpdatedItem}
                    onTogglePinItem={onToggleUpdatedItemPinned}
                    onCopyItemUrl={onCopyUpdatedItemUrl}
                    onShareItemWithTeam={onShareUpdatedItemWithTeam}
                    onOpenPullRequest={onOpenUpdatedItemPullRequest}
                    getItemHref={getUpdatedItemHref}
                    headerAction={
                      hasPinnedItems ? undefined : (sectionHeaderFilterAction ?? undefined)
                    }
                  />
                </div>
              ) : null
            ) : (
              <>
                {/* pb-1 (not pb-3): the last topContent item is the GitHub
                  Worktrees section header, whose repo list renders just below
                  as the sibling SessionList — the header must hug its content. */}
                {topContent ? (
                  <div
                    className={
                      stylex.props(
                        hasPinnedItems ? shellStyles.pinnedBottom : shellStyles.pinnedStack
                      ).className
                    }
                  >
                    {topContent}
                  </div>
                ) : null}
                {sessionListProps ? (
                  <SessionList
                    {...sessionListProps}
                    className={sessionListClassName}
                    emptyState={workspaceEmptyState}
                    headerAction={
                      topContent || hasPinnedItems || afterSessionListContent
                        ? sessionListProps.headerAction
                        : (sessionListProps.headerAction ?? sectionHeaderFilterAction ?? undefined)
                    }
                  />
                ) : null}
                {afterSessionListContent}
              </>
            )}
            {organizeMode === 'workspace' && !topContent && !sessionListProps ? (
              <div {...stylex.props(shellStyles.repoStack)}>
                {repoSections.map((section, sectionIndex) => (
                  <div key={section.id} {...stylex.props(shellStyles.repoGroup)}>
                    <div
                      className={clsx(
                        SIDEBAR_CONTROL_TEXT_CLASS,
                        stylex.props(shellStyles.repoHeader).className
                      )}
                    >
                      <Github {...stylex.props(shellStyles.repoHeaderGlyph)} />
                      <span {...stylex.props(shellStyles.clipped)}>{section.repoFullName}</span>
                      {sectionIndex === 0 && sectionHeaderFilterAction ? (
                        <span {...stylex.props(shellStyles.repoHeaderAction)}>
                          {sectionHeaderFilterAction}
                        </span>
                      ) : null}
                    </div>

                    {/* A project with no sessions yet is its header alone, not an empty tray. */}
                    {section.items.length > 0 ? (
                      <GlassSurface className={stylex.props(shellStyles.trayPadding).className}>
                        <ul>
                          {section.items.map((item) => (
                            <li key={item.id} {...stylex.props(shellStyles.trayItem)}>
                              <div
                                className={clsx(
                                  SIDEBAR_ROW_TEXT_CLASS,
                                  stylex.props(
                                    shellStyles.repoRow,
                                    item.isSelected
                                      ? shellStyles.repoRowSelected
                                      : shellStyles.repoRowIdle
                                  ).className
                                )}
                              >
                                <span {...stylex.props(shellStyles.repoDot)} />
                                <span {...stylex.props(shellStyles.repoTitle)}>{item.title}</span>
                                {item.ageLabel ? (
                                  <span
                                    className={clsx(
                                      SIDEBAR_CAPTION_TEXT_CLASS,
                                      stylex.props(shellStyles.repoAge).className
                                    )}
                                  >
                                    {item.ageLabel}
                                  </span>
                                ) : null}
                              </div>
                            </li>
                          ))}
                        </ul>
                      </GlassSurface>
                    ) : null}
                  </div>
                ))}

                <div {...stylex.props(shellStyles.chatsPadding)}>
                  {resolvedChatsSessionListProps ? (
                    <SessionList
                      {...resolvedChatsSessionListProps}
                      className={chatsSessionListClassName}
                    />
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </ScrollArea>

        {bottomFloatingContent ? (
          <div
            className={clsx(
              stylex.props(
                shellStyles.floating,
                isMobile ? shellStyles.floatingMobile : shellStyles.floatingDesktop
              ).className
            )}
          >
            <div {...stylex.props(shellStyles.floatingContent)}>{bottomFloatingContent}</div>
          </div>
        ) : null}

        <div
          className={cn(
            getLoroSidebarFooterClassName(isMobile),
            !isMobile && stylex.props(footerStyles.desktop).className
          )}
          data-sidebar-footer
        >
          {!isMobile ? (
            <div {...stylex.props(footerStyles.workspace)}>
              {renderWorkspaceControl('top')}
              <AuthRecoveryEntrySlot />
            </div>
          ) : null}
          <div {...stylex.props(footerStyles.actions)}>
            <Menu.Root>
              <Menu.Trigger
                render={
                  <IconButton label={t('menu.help', 'Help')}>
                    <CircleHelp {...stylex.props(shellStyles.glyphFull)} strokeWidth={1.5} />
                  </IconButton>
                }
              />
              <Menu.Content side={isMobile ? 'top' : 'right'} align="end" className="min-w-[160px]">
                <Menu.Item icon={BookOpen} onClick={() => onDocsClicked?.()}>
                  {mergedLabels.docs}
                </Menu.Item>
                <Menu.Item icon={Github} onClick={() => onGithubClicked?.()}>
                  {t('sidebar.github', 'GitHub')}
                </Menu.Item>
                <Menu.Item icon={Users} onClick={() => onJoinCommunityClicked?.()}>
                  {mergedLabels.joinCommunity}
                </Menu.Item>
                <Menu.Item icon={MessageSquareMore} onClick={() => onFeedbackClicked?.()}>
                  {mergedLabels.feedback}
                </Menu.Item>
                <Menu.Item icon={Bug} onClick={() => onBugReportClicked?.()}>
                  {mergedLabels.bugReport}
                </Menu.Item>
              </Menu.Content>
            </Menu.Root>

            {/* While Archive is open, its button returns to the previous page
                (Home when there is no history). */}
            {activeNav === 'archive' ? (
              <IconButton
                label={t('archive.leave', 'Leave Archive')}
                title={t('archive.leave', 'Leave Archive')}
                active
                className="group"
                onClick={() => {
                  if (canGoBack && commands.execute('nav.back')) return;
                  if (canGoBack) {
                    window.history.back();
                    return;
                  }
                  onHomeClicked?.();
                }}
              >
                <Archive
                  strokeWidth={1.5}
                  className={clsx(
                    stylex.props(shellStyles.glyphFull).className,
                    'group-hover:hidden group-focus-visible:hidden'
                  )}
                />
                <ArrowLeft
                  strokeWidth={1.5}
                  className={clsx(
                    stylex.props(shellStyles.glyphHidden).className,
                    'group-hover:block group-focus-visible:block'
                  )}
                />
              </IconButton>
            ) : (
              <IconButton label={t('archive.title', 'Archive')} onClick={onArchiveClicked}>
                <Archive {...stylex.props(shellStyles.glyphFull)} strokeWidth={1.5} />
              </IconButton>
            )}

            <IconButton label={t('settings.title', 'Settings')} onClick={onSettingsClicked}>
              <Settings {...stylex.props(shellStyles.glyphFull)} strokeWidth={1.5} />
            </IconButton>
          </div>

          {isMobile ? (
            <SidebarFilterPopover
              organize={organizeMode}
              scope={chatScope}
              onOrganizeChange={onOrganizeModeChange}
              onScopeChange={onChatScopeChange}
              showUpdatedProjectNames={showUpdatedProjectNames}
              onShowUpdatedProjectNamesChange={onShowUpdatedProjectNamesChange}
              showBranchNames={showBranchNames}
              onShowBranchNamesChange={onShowBranchNamesChange}
              labels={mergedLabels.filter}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
});

LoroSidebar.displayName = 'LoroSidebar';
