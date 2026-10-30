import { SchedulesWorkspace } from '../schedules/schedules-workspace';
import {
  forwardRef,
  Fragment,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
  Archive,
  BellRing,
  CircleHelp,
  CircleCheckBig,
  Check,
  Clock3,
  Copy,
  FolderPlus,
  Folders,
  Github,
  LockKeyhole,
  MessageCircle,
  Monitor,
  MonitorDown,
  MonitorSmartphone,
  Plus,
  Search,
  Settings,
  Share2,
  SlidersHorizontal,
  Terminal,
  X,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import * as stylex from '@stylexjs/stylex';
import { control, corner, radius } from '@lody/ui/tokens/scales.stylex';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { MdChat, MdComputer, MdFolderCopy } from 'react-icons/md';
import { FaGithub } from 'react-icons/fa';
import type { IconType } from 'react-icons';
import { isIOSRuntimeEnvironment } from '@/lib/native-platform';
import { writeTextToClipboard } from '@/lib/clipboard';
import { getDownloadPageUrl } from '@/lib/lody-urls';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';
import { withClassName } from '@/lib/stylex';
import { usePullToRefresh } from '@/hooks/use-pull-to-refresh';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
import { type MobileConversationItem } from './mobile-project-screen';
import {
  MobileChatList,
  type MobileChatGroupBy,
  type MobileChatListSelectionLabels,
} from './mobile-chat-list';
import {
  MobileConnectionStatus,
  type MobileConnectionStatusLabels,
} from './mobile-connection-status';
import type { LodyConnectionUiState } from '@/atoms/control-connection';
import { MobileFilterPillBar, type FilterPill } from './mobile-filter-pill-bar';
import { MobileInitialLetterAvatar } from './mobile-initial-letter-avatar';
import { CachedAvatarImg } from '@/components/cached-avatar-img';
import { WorkspaceAvatar } from '@/components/workspace-avatar';
import { MobileWorkspaceTabBar, type MobileBottomTabBarTabSpec } from './mobile-workspace-tabbar';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeEasing,
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeRadius,
  themeSpace,
} from '../../style/theme-scale.stylex';

/* Tailwind's `transition-colors` / `transition` / `transition-transform`. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: themeEasing['in-out'],
} as const;
const TRANSITION_ALL = {
  transitionProperty: 'all',
  transitionDuration: '150ms',
  transitionTimingFunction: themeEasing['in-out'],
} as const;
const TRANSITION_TRANSFORM = {
  transitionProperty: 'transform, translate, scale, rotate',
  transitionDuration: '150ms',
  transitionTimingFunction: themeEasing['in-out'],
} as const;
/* `motion-safe:` — the scale only happens when motion is welcome. */
const MOTION_SAFE = '@media (prefers-reduced-motion: no-preference)';

const DARK_SCOPE =
  ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))';
const DARK_WHITE_12 = {
  default: '#ffffff1f',
  '@supports (color: color-mix(in lab, red, red))':
    'color-mix(in oklab, var(--color-white) 12%, transparent)',
} as const;
const DARK_WHITE_10 = {
  default: '#ffffff1a',
  '@supports (color: color-mix(in lab, red, red))':
    'color-mix(in oklab, var(--color-white) 10%, transparent)',
} as const;
const DARK_WHITE_14 = {
  default: '#ffffff24',
  '@supports (color: color-mix(in lab, red, red))':
    'color-mix(in oklab, var(--color-white) 14%, transparent)',
} as const;

const styles = stylex.create({
  /* The Material-icon wrapper: a sized box the icon fills. */
  reactIconGlyph: { width: '100%', height: '100%' },
  workspacePill: { width: themeSpace[9], height: themeSpace[9], justifyContent: 'center', gap: 0 },
  statusBounds: { minWidth: 0, maxWidth: 'min(100%, 12rem)' },
  reactIcon: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },

  /* ── Icons ─────────────────────────────────────────────────────────── */
  icon3: { width: themeSpace[3], height: themeSpace[3] },
  icon3Shrink: { width: themeSpace[3], height: themeSpace[3], flexShrink: 0 },
  icon35: { width: themeSpace[3.5], height: themeSpace[3.5] },
  icon35ShrinkMuted: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  icon4: { width: themeSpace[4], height: themeSpace[4] },
  icon4Current: { width: themeSpace[4], height: themeSpace[4], color: 'currentColor' },
  icon4Shrink: { width: themeSpace[4], height: themeSpace[4], flexShrink: 0 },
  icon4ShrinkMuted: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  icon5: { width: themeSpace[5], height: themeSpace[5] },
  icon5Shrink: { width: themeSpace[5], height: themeSpace[5], flexShrink: 0 },
  icon5ShrinkMuted: {
    width: themeSpace[5],
    height: themeSpace[5],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },
  icon6: { width: themeSpace[6], height: themeSpace[6] },
  icon8Shrink: { width: themeSpace[8], height: themeSpace[8], flexShrink: 0 },
  icon18: { width: '18px', height: '18px' },

  /* ── Floating pill (workspace / settings chip) ────────────────────── */
  pill: {
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: 'hsl(var(--border) / 0.5)', [DARK_SCOPE]: DARK_WHITE_12 },
    backgroundColor: themeColors.muted,
    color: themeColors.foreground,
    ...TRANSITION_COLORS,
  },
  pillActive: {
    backgroundColor: {
      default: themeColors.muted,
      ':active': 'hsl(var(--muted) / 0.8)',
      [DARK_SCOPE]: { ...DARK_WHITE_10, ':active': DARK_WHITE_14 },
    },
    transform: { default: 'none', ':active': 'scale(0.97)' },
  },

  /* ── Add-project sheet ────────────────────────────────────────────── */
  sheetStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2.5],
    paddingInline: themeSpace[4],
    paddingTop: themeSpace[3],
  },
  sheetOption: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[3.5],
    borderRadius: themeRadius['2xl'],
    backgroundColor: {
      default: 'hsl(var(--muted) / 0.4)',
      ':active': 'hsl(var(--muted) / 0.7)',
    },
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3.5],
    textAlign: 'left',
    ...TRANSITION_COLORS,
  },
  sheetOptionIcon: {
    display: 'flex',
    height: themeSpace[11],
    width: themeSpace[11],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--primary) / 0.1)',
    color: themeColors.primary,
  },
  sheetOptionBody: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  sheetOptionTitle: {
    display: 'block',
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.semibold,
    lineHeight: 1.25,
  },
  sheetOptionHint: {
    marginTop: themeSpace[0.5],
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.8rem',
    color: themeColors.mutedForeground,
  },

  /* ── Private-resource help sheet ───────────────────────────────────── */
  helpStack: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    paddingInline: themeSpace[5],
    paddingBottom: themeSpace[2],
    paddingTop: themeSpace[4],
    textAlign: 'center',
  },
  helpIcon: {
    marginBottom: themeSpace[3],
    display: 'inline-flex',
    height: themeSpace[10],
    width: themeSpace[10],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.muted,
    color: themeColors.mutedForeground,
  },
  helpClose: {
    marginTop: themeSpace[5],
    minHeight: themeSpace[11],
    width: '100%',
    maxWidth: '24rem',
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.primary,
    paddingInline: themeSpace[4],
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    fontWeight: themeFontWeight.semibold,
    color: themeColors.primaryForeground,
    opacity: { default: 1, ':active': 0.8 },
  },

  /* ── Row trailing meta ─────────────────────────────────────────────── */
  trailingMeta: {
    marginLeft: themeSpace[2],
    display: 'inline-flex',
    flexDirection: 'column',
    alignItems: 'flex-end',
    gap: themeSpace[1],
    alignSelf: 'center',
  },
  trailingAge: {
    fontSize: '0.7rem',
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.mutedForeground,
  },
  trailingBadge: {
    display: 'inline-flex',
    height: '1.125rem',
    minWidth: '1.125rem',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.primary,
    paddingInline: themeSpace[1.5],
    fontSize: '0.68rem',
    fontWeight: themeFontWeight.semibold,
    lineHeight: 1,
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.primaryForeground,
  },

  /* ── Header search ─────────────────────────────────────────────────── */
  searchField: {
    display: 'flex',
    height: themeSpace[9],
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1.5],
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: 'hsl(var(--border) / 0.5)', [DARK_SCOPE]: DARK_WHITE_12 },
    backgroundColor: {
      default: themeColors.muted,
      ':focus-within': 'hsl(var(--muted) / 0.8)',
      [DARK_SCOPE]: { ...DARK_WHITE_10, ':focus-within': DARK_WHITE_14 },
    },
    paddingInline: themeSpace[3],
    color: themeColors.foreground,
    ...TRANSITION_COLORS,
  },
  searchInput: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    borderWidth: 0,
    borderStyle: 'none',
    backgroundColor: 'transparent',
    fontSize: '0.82rem',
    // The field's focus ring was a Tailwind `focus:ring-0`, which painted
    // nothing and erased the app's global focus ring. The field keeps no
    // focus indicator, exactly as before.
    boxShadow: { default: null, ':focus-visible': 'none' },
    '::placeholder': { color: themeColors.mutedForeground },
  },
  searchClear: {
    marginRight: 'calc(var(--spacing) * -1)',
    display: 'inline-flex',
    height: themeSpace[6],
    width: themeSpace[6],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    color: {
      default: themeColors.mutedForeground,
      ':hover': themeColors.foreground,
    },
    backgroundColor: {
      default: 'transparent',
      ':hover': 'hsl(var(--background) / 0.6)',
    },
  },

  /* ── Chat-list filter toggle ───────────────────────────────────────── */
  filterToggle: {
    position: 'relative',
    display: 'inline-flex',
    height: themeSpace[8],
    width: themeSpace[8],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: 'hsl(var(--border) / 0.5)', [DARK_SCOPE]: DARK_WHITE_12 },
    backgroundColor: {
      default: themeColors.muted,
      ':hover': 'hsl(var(--muted) / 0.8)',
      [DARK_SCOPE]: {
        ...DARK_WHITE_10,
        ':hover': {
          ...DARK_WHITE_10,
          '@media (hover: hover)': DARK_WHITE_14,
        },
      },
    },
    color: {
      default: themeColors.mutedForeground,
      ':hover': themeColors.foreground,
    },
    // The toggle's focus ring was a Tailwind `focus-visible:ring-1`, which
    // painted nothing and erased the app's global focus ring. It keeps no
    // focus indicator, exactly as before.
    boxShadow: { default: null, ':focus-visible': 'none' },
    transform: { default: 'none', ':active': 'scale(0.97)' },
    ...TRANSITION_COLORS,
  },
  filterToggleOpen: {
    borderColor: { default: 'hsl(var(--primary) / 0.4)', [DARK_SCOPE]: DARK_WHITE_12 },
    /* The open state replaces the resting fill, but the hover fill still
       applies on top of it — the same order the Tailwind classes had. */
    backgroundColor: {
      default: 'hsl(var(--primary) / 0.15)',
      ':hover': 'hsl(var(--muted) / 0.8)',
      [DARK_SCOPE]: {
        ...DARK_WHITE_10,
        ':hover': {
          ...DARK_WHITE_10,
          '@media (hover: hover)': DARK_WHITE_14,
        },
      },
    },
    color: {
      default: themeColors.primary,
      ':hover': themeColors.foreground,
    },
  },
  filterToggleDot: {
    position: 'absolute',
    right: themeSpace[1],
    top: themeSpace[1],
    height: themeSpace[1.5],
    width: themeSpace[1.5],
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.primary,
  },

  /* ── Section headings ──────────────────────────────────────────────── */
  allItemsHeading: {
    paddingInline: themeSpace[5],
    paddingBottom: themeSpace[1],
    paddingTop: themeSpace[3],
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: '0.025em',
    color: themeColors.mutedForeground,
  },
  machineGroupHeading: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    paddingInline: themeSpace[5],
    paddingBottom: themeSpace[1],
    paddingTop: themeSpace[3],
  },
  machineGroupName: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.78rem',
    fontWeight: themeFontWeight.semibold,
    letterSpacing: '-0.025em',
    color: themeColors.foreground,
  },
  machinePrivateButton: {
    display: 'inline-flex',
    minHeight: themeSpace[7],
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    borderRadius: themeRadius.full,
    paddingInline: themeSpace[1.5],
    fontSize: '0.68rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
    backgroundColor: { default: 'transparent', ':active': themeColors.muted },
  },
  statusDot: {
    display: 'inline-block',
    height: themeSpace[2],
    width: themeSpace[2],
    flexShrink: 0,
    borderRadius: themeRadius.full,
  },
  statusDotOnline: { backgroundColor: themeColors.statusSuccess },
  statusDotOffline: { backgroundColor: 'hsl(var(--muted-foreground) / 0.4)' },

  /* ── Owner avatar / list shell ─────────────────────────────────────── */
  ownerAvatarImage: {
    height: themeSpace[10],
    width: themeSpace[10],
    flexShrink: 0,
    borderRadius: themeRadius.xl,
    objectFit: 'cover',
  },
  ownerAvatarTile: {
    display: 'inline-flex',
    height: themeSpace[10],
    width: themeSpace[10],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.muted,
    color: 'hsl(var(--foreground) / 0.8)',
  },
  listShell: {
    marginInline: themeSpace[3],
    overflow: 'hidden',
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
  },

  /* ── Flat list row ─────────────────────────────────────────────────── */
  listRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[3],
    borderBottomWidth: { default: '1px', ':last-child': 0 },
    borderBottomStyle: 'solid',
    borderBottomColor: 'hsl(var(--border) / 0.4)',
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2.5],
    textAlign: 'left',
    color: { default: themeColors.foreground, ':disabled': themeColors.mutedForeground },
    backgroundColor: {
      default: 'transparent',
      ':hover': 'hsl(var(--muted) / 0.3)',
      ':active': 'hsl(var(--muted) / 0.4)',
      ':focus-visible': 'hsl(var(--muted) / 0.4)',
      ':disabled:hover': 'transparent',
      ':disabled:active': 'transparent',
    },
    ...TRANSITION_COLORS,
  },
  listRowBody: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
  },
  listRowTitleLine: {
    display: 'flex',
    minWidth: 0,
    gap: themeSpace[1.5],
    alignItems: 'baseline',
  },
  listRowTitleLineCentered: { alignItems: 'center' },
  listRowTitle: {
    fontSize: '1.02rem',
    fontWeight: themeFontWeight.semibold,
    lineHeight: 1.25,
  },
  listRowTitleWrap: {
    minWidth: 0,
    overflowWrap: 'break-word',
  },
  listRowTitleTruncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  listRowSuffix: {
    fontSize: '0.78rem',
    fontWeight: themeFontWeight.normal,
    lineHeight: 1.25,
    color: themeColors.mutedForeground,
  },
  listRowSuffixWrap: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  listRowSuffixTruncate: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  /* ── Recents strip ─────────────────────────────────────────────────── */
  recentsWrap: {
    paddingBottom: themeSpace[2],
    paddingTop: themeSpace[3],
  },
  recentsHeading: {
    paddingInline: themeSpace[5],
    paddingBottom: themeSpace[1],
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.semibold,
    textTransform: 'uppercase',
    letterSpacing: '0.025em',
    color: themeColors.mutedForeground,
  },
  recentsScroller: {
    display: 'flex',
    alignItems: 'stretch',
    gap: themeSpace[2],
    overflowX: 'auto',
    paddingInline: themeSpace[5],
  },
  recentCard: {
    display: 'inline-flex',
    width: '10rem',
    flexShrink: 0,
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius['2xl'],
    backgroundColor: themeColors.card,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2],
    textAlign: 'left',
    color: themeColors.foreground,
    boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 8px 24px -16px rgba(0,0,0,0.12)',
    transform: { default: 'none', ':active': 'scale(0.97)' },
    ...TRANSITION_TRANSFORM,
  },
  recentCardBody: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  recentCardMeta: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.7rem',
    lineHeight: 1.25,
    color: themeColors.mutedForeground,
  },
  recentCardName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.85rem',
    fontWeight: themeFontWeight.semibold,
    lineHeight: 1.25,
  },
  recentAvatar: {
    height: themeSpace[8],
    width: themeSpace[8],
    flexShrink: 0,
    borderRadius: themeRadius.full,
    objectFit: 'cover',
  },

  /* ── Projects sub-tab selector ─────────────────────────────────────── */
  subTabBar: {
    marginInline: themeSpace[3],
    marginBottom: themeSpace[2],
    marginTop: themeSpace[1],
    display: 'flex',
  },
  subTabTrack: {
    position: 'relative',
    display: 'inline-flex',
    borderRadius: themeRadius.full,
    backgroundColor: 'hsl(var(--muted) / 0.5)',
    padding: themeSpace[0.5],
  },
  subTabThumb: {
    position: 'absolute',
    bottom: themeSpace[0.5],
    left: 0,
    top: themeSpace[0.5],
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.card,
  },
  subTabButton: {
    position: 'relative',
    zIndex: 10,
    borderRadius: themeRadius.full,
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[1],
    fontSize: '0.78rem',
    fontWeight: themeFontWeight.medium,
    color: {
      default: themeColors.mutedForeground,
      ':active': themeColors.foreground,
    },
    ...TRANSITION_COLORS,
  },
  subTabButtonActive: { color: themeColors.foreground },
  subTabLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },

  /* ── Home screen chrome ────────────────────────────────────────────── */
  appRoot: {
    position: 'relative',
    height: '100%',
    minHeight: 0,
    width: '100%',
    color: themeColors.foreground,
  },
  shell: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    backgroundColor: themeColors.background,
  },
  header: {
    position: 'relative',
    zIndex: 30,
    paddingTop: 'calc(var(--k-safe-area-top, 0px) + var(--spacing) * 2)',
    paddingBottom: themeSpace[2],
    paddingInlineStart: 'calc(var(--k-safe-area-left, 0px) + var(--spacing) * 3)',
    paddingInlineEnd: 'calc(var(--k-safe-area-right, 0px) + var(--spacing) * 3)',
  },
  headerRow: {
    position: 'relative',
    display: 'flex',
    height: themeSpace[9],
    width: '100%',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  headerLeading: {
    position: 'relative',
    zIndex: 10,
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  workspaceIdentity: {
    display: 'flex',
    height: themeSpace[9],
    width: themeSpace[9],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: { default: 'hsl(var(--border) / 0.5)', [DARK_SCOPE]: DARK_WHITE_12 },
    backgroundColor: { default: themeColors.muted, [DARK_SCOPE]: DARK_WHITE_10 },
    color: themeColors.foreground,
  },
  searchSlot: {
    position: 'relative',
    zIndex: 10,
    height: themeSpace[9],
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    transitionProperty: 'opacity, transform',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0, 0, 0.2, 1)',
  },
  searchSlotOpaque: {
    opacity: 1,
    transform: 'translateY(0)',
    pointerEvents: 'auto',
  },
  searchSlotHidden: {
    opacity: 0,
    transform: 'translateY(0.375rem)',
    pointerEvents: 'none',
  },
  headerTrailing: {
    position: 'relative',
    zIndex: 10,
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: themeSpace[2],
  },
  statusOverlay: {
    pointerEvents: 'none',
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  contentColumn: {
    position: 'relative',
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  contentBody: {
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
  },
  contentBodyHidden: { display: 'none' },
  overflowHidden: { overflow: 'hidden' },
  listRegion: {
    position: 'relative',
    zIndex: 0,
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflowY: 'auto',
    paddingTop: themeSpace[1],
    paddingBottom: 'calc(var(--mobile-tabbar-height) + var(--k-safe-area-bottom, 0px) + 1rem)',
    scrollbarGutter: 'auto',
  },
  schedulesColumn: {
    display: 'flex',
    minHeight: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    flexDirection: 'column',
    overflow: 'hidden',
  },

  /* ── Inbox tab ─────────────────────────────────────────────────────── */
  inboxSection: {
    display: 'flex',
    flexDirection: 'column',
  },
  inboxList: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[2],
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[3],
  },
  inboxLoading: {
    paddingInline: themeSpace[2],
    paddingBlock: themeSpace[8],
    textAlign: 'center',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  inboxCard: {
    position: 'relative',
    display: 'flex',
    gap: themeSpace[3],
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: themeColors.background,
    paddingInline: themeSpace[3.5],
    paddingBlock: themeSpace[3],
    boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.05)',
  },
  inboxCardButton: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'flex-start',
    gap: themeSpace[3],
    textAlign: 'left',
    opacity: { default: 1, ':active': 0.7 },
  },
  inboxCardIcon: {
    position: 'relative',
    marginTop: themeSpace[0.5],
    display: 'flex',
    height: themeSpace[9],
    width: themeSpace[9],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.muted,
    color: themeColors.foreground,
  },
  inboxUnreadDot: {
    position: 'absolute',
    right: 'calc(var(--spacing) * -0.5)',
    top: 'calc(var(--spacing) * -0.5)',
    height: themeSpace[2.5],
    width: themeSpace[2.5],
    borderRadius: themeRadius.full,
    borderWidth: '2px',
    borderStyle: 'solid',
    borderColor: themeColors.background,
    backgroundColor: themeColors.primary,
  },
  inboxCardBody: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  inboxCardTitle: {
    display: 'block',
    fontSize: '0.9rem',
    fontWeight: themeFontWeight.semibold,
    lineHeight: 1.375,
    color: themeColors.foreground,
  },
  inboxCardDescription: {
    marginTop: themeSpace[0.5],
    display: 'block',
    fontSize: '0.78rem',
    lineHeight: 1.625,
    color: themeColors.mutedForeground,
  },
  inboxCardAction: {
    marginTop: themeSpace[2],
    display: 'block',
    fontSize: '0.78rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.primary,
  },
  inboxDismiss: {
    display: 'flex',
    height: themeSpace[7],
    width: themeSpace[7],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    color: themeColors.mutedForeground,
    backgroundColor: { default: 'transparent', ':active': themeColors.muted },
  },

  /* ── Local project rows ────────────────────────────────────────────── */
  removalState: {
    display: 'inline-flex',
    minWidth: 0,
    alignItems: 'center',
    gap: themeSpace[1],
    fontSize: '0.7rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
  },
  removalStateText: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  projectPath: {
    marginTop: themeSpace[0.5],
    display: 'block',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '0.72rem',
    color: themeColors.mutedForeground,
  },

  /* ── Chat tab ──────────────────────────────────────────────────────── */
  chatSection: {
    display: 'flex',
    flexDirection: 'column',
  },
  chatTrailingRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[1.5],
    paddingTop: themeSpace[2],
  },

  /* ── Onboarding guide ──────────────────────────────────────────────── */
  onboardingRoot: {
    paddingInline: themeSpace[4],
    paddingBottom: themeSpace[6],
    paddingTop: themeSpace[8],
  },
  onboardingColumn: {
    marginInline: 'auto',
    display: 'flex',
    maxWidth: '24rem',
    flexDirection: 'column',
    gap: themeSpace[4],
  },
  onboardingHead: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: themeSpace[3],
    textAlign: 'center',
  },
  onboardingGlyph: {
    display: 'flex',
    height: themeSpace[12],
    width: themeSpace[12],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius['2xl'],
    backgroundColor: themeColors.muted,
    color: themeColors.mutedForeground,
  },
  onboardingHeadStack: {
    display: 'flex',
    flexDirection: 'column',
    gap: themeSpace[1],
  },
  onboardingTitle: {
    /* `space-y-1` on the stack: every child but the last carries the gap. */
    marginBlockStart: { default: themeSpace[1], ':last-child': 0 },
    marginBlockEnd: { default: themeSpace[1], ':last-child': 0 },
    fontSize: '0.95rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  onboardingBody: {
    marginBlockStart: { default: themeSpace[1], ':last-child': 0 },
    marginBlockEnd: { default: themeSpace[1], ':last-child': 0 },
    fontSize: '0.8rem',
    lineHeight: 1.625,
    color: themeColors.mutedForeground,
  },
  onboardingCard: {
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
    padding: themeSpace[4],
  },
  onboardingCardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: themeSpace[2],
  },
  onboardingCardTitle: {
    fontSize: '0.85rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  onboardingCardActions: {
    marginTop: themeSpace[3],
    display: 'flex',
    alignItems: 'stretch',
    gap: themeSpace[2],
  },
  onboardingCardHint: {
    marginTop: themeSpace[2.5],
    fontSize: '0.75rem',
    lineHeight: 1.625,
    color: themeColors.mutedForeground,
  },
  onboardingShareButton: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    justifyContent: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.xl,
    backgroundColor: themeColors.primary,
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[2.5],
    fontSize: '0.85rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.primaryForeground,
    ...TRANSITION_TRANSFORM,
  },
  onboardingShareButtonMotion: {
    [MOTION_SAFE]: { ':active': { transform: 'scale(0.98)' } },
  },
  onboardingCopyButton: {
    position: 'relative',
    display: 'inline-flex',
    width: themeSpace[10],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.xl,
    backgroundColor: {
      default: 'hsl(var(--muted) / 0.7)',
      ':active': themeColors.muted,
    },
    color: themeColors.mutedForeground,
    ...TRANSITION_ALL,
  },
  onboardingCopyButtonMotion: {
    [MOTION_SAFE]: { ':active': { transform: 'scale(0.9)' } },
  },
  onboardingSteps: {
    paddingInline: themeSpace[1],
    paddingTop: themeSpace[1],
  },
  onboardingStepsHeading: {
    fontSize: '0.72rem',
    fontWeight: themeFontWeight.medium,
    textTransform: 'uppercase',
    letterSpacing: '0.025em',
    color: themeColors.mutedForeground,
  },
  onboardingStepList: {
    marginTop: themeSpace[2.5],
  },
  onboardingStep: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: themeSpace[2.5],
    /* `space-y-2` on the list: every child but the last carries the gap. */
    marginBlockStart: { default: themeSpace[2], ':last-child': 0 },
    marginBlockEnd: { default: themeSpace[2], ':last-child': 0 },
  },
  onboardingStepNumber: {
    marginTop: '1px',
    display: 'flex',
    height: '18px',
    width: '18px',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.full,
    backgroundColor: themeColors.muted,
    fontSize: '0.68rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.mutedForeground,
  },
  onboardingStepText: {
    fontSize: '0.78rem',
    lineHeight: 1.625,
    color: themeColors.mutedForeground,
  },
  onboardingInlineIcon: {
    display: 'inline-flex',
  },
  onboardingArtifactPill: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[2],
    borderRadius: themeRadius.xl,
    backgroundColor: {
      default: 'hsl(var(--muted) / 0.7)',
      ':active': themeColors.muted,
    },
    paddingInline: themeSpace[3],
    paddingBlock: themeSpace[2.5],
    textAlign: 'left',
    ...TRANSITION_ALL,
  },
  onboardingArtifactPillMotion: {
    [MOTION_SAFE]: { ':active': { transform: 'scale(0.98)' } },
  },
  onboardingArtifactCode: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    fontFamily: 'var(--font-mono)',
    fontSize: '0.78rem',
    color: themeColors.foreground,
  },
  onboardingArtifactTrailing: {
    position: 'relative',
    display: 'inline-flex',
    flexShrink: 0,
    alignItems: 'center',
    color: themeColors.mutedForeground,
  },
  onboardingShareIconButton: {
    display: 'inline-flex',
    width: themeSpace[10],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: themeRadius.xl,
    backgroundColor: {
      default: 'hsl(var(--muted) / 0.7)',
      ':active': themeColors.muted,
    },
    color: themeColors.mutedForeground,
    ...TRANSITION_ALL,
  },
  onboardingShareIconButtonMotion: {
    [MOTION_SAFE]: { ':active': { transform: 'scale(0.9)' } },
  },

  /* ── Empty states ──────────────────────────────────────────────────── */
  tabEmptyState: {
    marginInline: themeSpace[3],
    marginTop: themeSpace[3],
    borderRadius: themeRadius['2xl'],
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.4)',
    backgroundColor: themeColors.card,
    paddingInline: themeSpace[4],
    paddingBlock: themeSpace[6],
    textAlign: 'center',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
    color: themeColors.mutedForeground,
  },
  tabEmptyAction: {
    marginTop: themeSpace[3],
    display: 'flex',
    justifyContent: 'center',
  },
  tabEmptyButton: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: themeSpace[1.5],
    borderRadius: themeRadius.full,
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'hsl(var(--border) / 0.6)',
    backgroundColor: {
      default: themeColors.background,
      ':hover': 'hsl(var(--muted) / 0.4)',
      ':active': 'hsl(var(--muted) / 0.6)',
    },
    paddingInline: themeSpace[3.5],
    paddingBlock: themeSpace[1.5],
    fontSize: '0.8rem',
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
    ...TRANSITION_COLORS,
  },
});

function MobileReactIcon({
  icon: Icon,
  className,
  ariaHidden = true,
}: {
  icon: IconType;
  className?: string;
  ariaHidden?: boolean;
}) {
  /* Fill the sized wrapper — do NOT use size="1em". Tab buttons set
     `text-[0.72rem]` for the label, so 1em collapsed Material icons to ~12px. */
  return (
    <span
      className={cn(stylex.props(styles.reactIcon).className, className)}
      aria-hidden={ariaHidden}
    >
      <Icon {...stylex.props(styles.reactIconGlyph)} />
    </span>
  );
}

/* Re-export so callers that already import `MobileChatGroupBy` from
   the home screen don't have to chase the type to its new module. */
export type { MobileChatGroupBy };

/* The mobile home dock surfaces up to three content tabs, ordered
   left → right: Inbox · Chat · 项目. Inbox is available in
   multi-member workspaces and occupies the natural "home" position.
   The 项目 tab merges Local + GitHub via an inner sub-tab; the 设置
   surface lives in the header's gear button. */
export type MobileHomeTab = 'inbox' | 'chat' | 'projects' | 'schedules';

/* Sub-tab inside the "项目" tab. Drives both the heading + full list
   below the segmented selector. Persisted via `mobileHomeProjectsSubTabAtom`
   in atoms/mobile-home-state.ts so a Chat ↔ Projects round-trip lands the
   user back on the side they were last on. */
export type MobileProjectsSubTab = 'local' | 'github';

export type MobileHomeWorkspace = {
  id: string;
  name: string;
  avatarUrl?: string | null;
};

export type MobileHomeWorkspaceOption = MobileHomeWorkspace & {
  isActive?: boolean;
};

export type MobileHomeMachine = {
  id: string;
  name: string;
  isOnline: boolean;
  isPrivate?: boolean;
};

export type MobileInboxItem = {
  id: string;
  kind: 'session_completed' | 'permission_requested' | 'sharing_review';
  title: string;
  description: string;
  updatedAt: number;
  unread?: boolean;
  actionLabel?: string;
};

/* Copy for the first-run guide shown on the Chat tab when the workspace
   has no machines AND no conversations yet — i.e. the user installed the
   mobile app before ever connecting a computer. The mobile app is a thin
   client (agents run on the user's own machines), so the guide walks the
   two real ways to connect one: a single CLI command on any machine, or
   the desktop app on their computer. Every field is optional — defaults
   keep the guide complete for hosts that only pass the original three
   strings. */
export type MobileHomeOnboardingLabels = {
  title?: string;
  description?: string;
  /** Heading for the one-command path (CLI / SSH / server). */
  commandHeading?: string;
  /** The shell command rendered inside the copyable pill. */
  command?: string;
  /** Prerequisite + sign-in explanation shown under the command pill. */
  commandHint?: string;
  /** aria-label / tooltip for the command pill's copy action. */
  copyCommandLabel?: string;
  /** Feedback shown inside the pill after a successful copy — reused for
     the download-link copy fallback. */

  /** Native share-sheet action on the command card (sends the command +
     download link); only rendered when the platform exposes
     `navigator.share`. */
  shareCommandLabel?: string;
  /** Heading for the desktop-app path. */
  desktopHeading?: string;
  /** What the desktop app does once installed + signed in. */
  desktopHint?: string;
  /** Share-sheet chip on the desktop card, rendered only when the
     platform exposes `navigator.share`. */
  shareDownloadLabel?: string;
  /** aria-label for the desktop card's URL pill — tapping it copies the
     download link. The phone itself never opens the download page. */
  copyDownloadLabel?: string;
  /** Heading for the "what happens next" numbered steps. */
  nextStepsHeading?: string;
  /** Step 1 — the machine appears in this workspace. */
  nextStepMachine?: string;
  /** Step 2 — add a project folder on that machine. */
  nextStepProject?: string;
  /** Step 3 — configure an agent and dispatch the first task. */
  nextStepAgent?: string;
};

export type MobileHomeLocalProject = {
  id: string;
  /** Machine that owns this project — used by the home screen to group
     projects under their machine section. */
  machineId: string;
  name: string;
  path: string;
  conversationCount: number;
  /** Latest message timestamp across all conversations under this
     project. Drives the trailing "5m / 2h / 3d" age label on the row.
     `null` / undefined renders no label. */
  latestMessageAt?: number | null;
  /** Number of conversations under this project that have new messages
     since the user last opened them. `0` / undefined hides the badge. */
  unreadCount?: number;
  /** Effective privacy: true when either the machine or project grant is private. */
  isPrivate?: boolean;
  /** Durable project-removal state. Pending rows stay visible but cannot open. */
  removalState?: 'removing' | 'waiting_for_device' | null;
};

export type MobileHomeGitHubRepository = {
  id: string;
  /** Short repo name (no owner prefix). Kept around for search / sort
     callers even though the row title is now rendered as
     `owner/name`. */
  name: string;
  /** `owner/name` — also used as the row's click target and title. */
  fullName: string;
  /** Owner handle (user or org). Drives the leading avatar lookup. */
  ownerHandle: string;
  /** Owner avatar URL. When null the row falls back to a generic github
     glyph in the leading slot. */
  ownerAvatarUrl?: string | null;
  /** Optional one-line repo description. Currently unused by the flat
     list (the row reserves a single line for `owner/name`), but kept on
     the type so search can match against it. */
  description?: string | null;
  /** Currently unused in the row UI (count badge was removed). Kept on
     the type so consumers can still surface it elsewhere (search,
     sort). */
  conversationCount?: number;
  /** Latest message timestamp for any conversation under this repo —
     drives the trailing semantic age label AND the list sort order
     (newest first). */
  latestMessageAt?: number | null;
  /** Number of conversations under this repo that have new messages
     since the user last opened them. `0` / undefined hides the badge. */
  unreadCount?: number;
};

/* Chat-tab rows reuse the `MobileConversationItem` shape used by the
   in-project conversation page (title + status + optional line counts
   + age on a single line). Re-export it here so consumers don't have
   to know that the type lives next door in `mobile-project-screen`. */
export type { MobileConversationItem };

/* Item in the "最近常用" horizontal strip. The strip used to live inside
   each tab (local / github) separately; after the Projects merge it
   lives at the top of the merged tab and shows a single sorted list of
   recent items across BOTH kinds. The strip render branches on `kind`
   so each item still shows the right avatar / caption format. Capped
   to ~6 by the caller. */
export type MobileHomeRecentLocalProject = {
  id: string;
  /** Project short name (no path prefix). */
  name: string;
  /** Path under the project's machine — shown as the small caption
     beneath the project name. */
  path: string;
  /** Machine name (shown as a secondary label, since the home tab no
     longer has a machine pill to disambiguate). */
  machineName?: string;
  /** Timestamp the caller uses to merge-sort with GitHub recents in
     the unified strip. Higher = more recent. */
  latestActivityAt?: number | null;
};

export type MobileHomeRecentRepo = {
  id: string;
  /** Repo short name (no owner prefix). */
  name: string;
  /** "owner/repo". Used as the click target. */
  fullName: string;
  /** GitHub org / user handle to show beneath the avatar. */
  ownerHandle: string;
  /** Owner avatar URL (org or user); falls back to the octocat glyph. */
  avatarUrl?: string | null;
  /** Timestamp the caller uses to merge-sort with Local recents in
     the unified strip. Higher = more recent. */
  latestActivityAt?: number | null;
};

/* Discriminated union for the merged-recents strip. The home screen
   keeps the original two arrays as separate props (for type clarity
   and minimal caller churn) and merges them on demand via
   `mergeRecentProjects`. */
export type MobileHomeRecentProject =
  | ({ kind: 'local' } & MobileHomeRecentLocalProject)
  | ({ kind: 'github' } & MobileHomeRecentRepo);

export type MobileHomeScreenLabels = {
  switchWorkspace?: string;
  /** Copy shown by the inline connection-status indicator in the home
     header's middle slot when the workspace's control connection is
     anything other than `'online'`. */
  connectionBanner?: MobileConnectionStatusLabels;
  /** Label for the leftmost "Inbox" tab in the bottom dock. */
  inboxTab?: string;
  /** Placeholder body shown inside the Inbox tab while the feature
     has no active notifications. */
  inboxPlaceholder?: string;
  inboxLoading?: string;
  inboxDismissAriaLabel?: string;
  privateLabel?: string;
  privateHelpAriaLabel?: string;
  privateHelpTitle?: string;
  privateHelpDescription?: string;
  privateHelpClose?: string;
  /** Label for the merged "项目" tab in the bottom dock. */
  projectsTab?: string;
  /** Sub-tab segmented selector labels inside the Projects tab. The
     same `localTab` / `githubTab` strings are reused. */
  localTab?: string;
  githubTab?: string;
  /** Header add-project action sheet: trigger/title + the two options
     (each with a short hint subtitle). */
  addProjectMenu?: string;
  addLocalProject?: string;
  addLocalProjectHint?: string;
  addGitHubRepository?: string;
  addGitHubRepositoryHint?: string;
  chatTab?: string;
  schedulesTab?: string;
  /** aria-label for the header plus button on the Schedules tab. */
  newSchedule?: string;
  settingsTab?: string;
  /** aria-label for the archive-toggle chip in the header. Toggles the
     Chat tab between active and archived conversations. */
  archiveToggleLabel?: string;
  /** aria-label for the chip after search that shows/hides the Chat
     filter pill bar (Team Tasks / Group / Filters). */
  filterBarToggleLabel?: string;
  /** Heading shown above the unified recents strip on the Projects
     tab. Defaults to "最近常用" when omitted. */
  recentProjectsHeading?: string;
  online?: string;
  offline?: string;
  projectRemoving?: string;
  projectRemovalWaiting?: string;
  /** Copy shown inside the pull-to-refresh indicator while the user is
     pulling down. Two states: below threshold = "pull more", at or
     past threshold = "release to refresh". Both fade in as the pull
     grows so the user gets a smooth on-ramp instead of a sudden text
     pop. */
  pullToRefresh?: string;
  releaseToRefresh?: string;
  /** Placeholder shown inside the header search input. Defaults to a
     contextual placeholder per tab ("搜索项目" / "搜索仓库" / "搜索对话")
     when omitted. */
  searchPlaceholder?: string;
  searchAriaLabel?: string;
  clearSearchAriaLabel?: string;
  /** Heading above the recently-used strip on Local + GitHub tabs. */
  recentReposHeading?: string;
  recentLocalProjectsHeading?: string;
  /** Heading above the flat "all items" list on Local / GitHub tabs.
     Defaults to "全部项目" / "全部仓库" when omitted. Chat tab no longer
     renders an "全部对话" label above the flat list. */
  allLocalProjectsHeading?: string;
  allGitHubReposHeading?: string;
  /** @deprecated Chat list no longer shows a section heading in the
     active (non-archived) mode. Kept for call-site compatibility. */
  allChatsHeading?: string;
  /** Heading rendered above the Chat tab's list when the archive
     toggle is on. Falls back to "归档对话" when not provided. */
  archivedChatsHeading?: string;
  /** Copy for the multi-select toolbar + delete confirmation shown
     when the user long-presses a row in the archive view. See
     `MobileChatListSelectionLabels`. */
  archiveSelection?: MobileChatListSelectionLabels;
  /** Per-bucket headings used by the Chat tab's grouped view modes.
     Keys are the bucket ids each grouping mode produces. Missing
     entries fall back to the id itself. */
  chatGroupLabels?: Partial<Record<string, string>>;
  /** Empty-state message for the entire tab when nothing exists yet
     (no machines, no authorized repos, no chats). */
  emptyLocalProjects?: string;
  emptyGitHubProjects?: string;
  emptyChats?: string;
  /** First-run onboarding copy for the Chat tab, shown when the
     workspace has no machines AND no conversations (distinct from
     `emptyChats`, which assumes a machine already exists). Guides the
     user to download + launch the desktop client. */
  onboarding?: MobileHomeOnboardingLabels;
  /** Empty-state shown when active chat filters removed every
     conversation (distinct from `emptyChats`, which means none exist).
     Paired with the "Clear filters" button. */
  emptyFilteredChats?: string;
  /** Label for the "Clear filters" button rendered in the filtered
     empty state. */
  clearChatFilters?: string;
  /** Empty-state when search query matches nothing. */
  emptySearch?: string;
  /** ARIA label for the standalone new-conversation chip in the dock. */
  newChatAriaLabel?: string;
  conversationCount?: (count: number) => string;
};

export type MobileHomeScreenProps = {
  workspace: MobileHomeWorkspace;
  workspaceOptions?: MobileHomeWorkspaceOption[];
  machines: MobileHomeMachine[];
  inboxItems?: MobileInboxItem[];
  inboxLoading?: boolean;
  onInboxItemSelect?: (itemId: string) => void;
  onInboxItemDismiss?: (itemId: string) => void;
  /** Workspace control-connection state (mirrors the desktop sidebar's
     `lodyConnectionUiStateAtom`). Defaults to `'online'` (banner stays
     hidden) when the caller doesn't pass anything — keeps Storybook /
     legacy callers from having to thread it through. */
  connectionUiState?: LodyConnectionUiState;
  /** True while the workspace's first machine/session sync is still in
     flight on app launch. Mirrors the desktop chat-landing's
     `isInitialDataLoading`. Used to suppress the first-run onboarding
     takeover until we actually know the workspace is empty — otherwise a
     returning user would see a flash of "download the client" before their
     cached machines + chats hydrate. Defaults to `false`. */
  isInitialDataLoading?: boolean;
  /** Fired when the user pulls down past threshold at the top of the
     list. Caller drives the actual sync (typically
     `runtime.repo.sync()`); the home screen owns the gesture
     detection but lets the parent decide what "refresh" means. */
  onPullToRefresh?: () => Promise<void> | void;
  selectedTab: MobileHomeTab;
  /** Inbox only appears in workspaces with more than one member. */
  showInboxTab?: boolean;
  /** Active sub-tab inside the Projects tab. Required when `selectedTab`
     is 'projects'; ignored on the Chat tab. */
  selectedProjectsSubTab?: MobileProjectsSubTab;
  /** Fired when the user taps a segment in the Projects sub-tab
     selector. Caller is expected to persist the choice + update
     whatever downstream state needs the sub-tab (e.g. the composer's
     contextType). */
  onProjectsSubTabSelect?: (sub: MobileProjectsSubTab) => void;
  /** Header add-project dropdown actions (shown on the Projects tab, left of
     the settings gear): pick a folder, or open GitHub integration settings. */
  onAddLocalProject?: () => void;
  onAddGitHubRepository?: () => void;
  localProjects: MobileHomeLocalProject[];
  /** Recently active local projects — rendered as a horizontal strip
     at the top of the Local tab. Empty array hides the strip. */
  recentLocalProjects?: MobileHomeRecentLocalProject[];
  /** Flat list of all authorized GitHub repositories, sorted by the
     caller (newest activity first). The component does not regroup
     them by owner anymore; each row stands on its own. */
  githubRepositories: MobileHomeGitHubRepository[];
  /** Recently active repositories — rendered as a horizontal strip at
     the top of the GitHub tab. Empty array hides the strip. */
  recentGitHubRepos?: MobileHomeRecentRepo[];
  /** Every non-archived conversation in the workspace, sorted by the
     caller (newest first). Rendered as single-line rows (title +
     optional +/- / age) shared with the in-project page. */
  chats: MobileConversationItem[];
  /** Pills rendered above the Chat tab's list for filtering / view
     mode switching. When omitted no bar is mounted (the tab renders
     the same as before). */
  chatFilterPills?: ReadonlyArray<FilterPill>;
  /** Active grouping mode for the Chat tab. `none` (default) renders
     the chats as one flat newest-first list. Anything else inserts
     section headings between buckets. The caller passes the bucket
     labels via `labels.chatGroupLabels`. */
  chatGroupBy?: MobileChatGroupBy;
  /** True when active chat filters are narrowing the list. Drives the
     "Clear filters" affordance in the empty state (so an all-filtered-out
     list reads as "your filters hid everything", not "no conversations"). */
  hasActiveChatFilters?: boolean;
  /** Resets all chat filters to their default (show-everything) state.
     Wired to the empty-state "Clear filters" button. */
  onClearChatFilters?: () => void;
  labels?: MobileHomeScreenLabels;
  theme?: 'ios' | 'material';
  /** Tap on the workspace pill in the header — typically opens a
     bottom-sheet workspace switcher rendered by the parent. The pill
     itself no longer hosts an inline dropdown (the sheet handles
     create / invite actions too, which don't fit a dropdown well). */
  onWorkspaceMenuOpen?: () => void;
  /** Retained for callers that still drive selection externally (e.g.
     stories without the sheet). Most consumers should wire the sheet
     instead and select via that. */
  onWorkspaceSelect?: (workspaceId: string) => void;
  onTabSelect?: (tab: MobileHomeTab) => void;
  onLocalProjectSelect?: (projectId: string) => void;
  onGitHubRepositorySelect?: (repoFullName: string) => void;
  onChatSelect?: (chatId: string) => void;
  /** Pin / unpin a chat from the swipe-to-reveal drawer on its row.
     Receives the next pinned state so the handler doesn't have to
     re-derive the current state. */
  onChatTogglePin?: (chatId: string, nextPinned: boolean) => void;
  /** Archive a chat from the swipe-to-reveal drawer (or from the
     super-swipe). */
  onChatArchive?: (chatId: string) => void;
  /** Restore (un-archive) a chat from the swipe-to-reveal drawer shown
     on rows of the *archived* Chat list. */
  onChatRestore?: (chatId: string) => void;
  /** Hands a batch of chat ids to the parent for *permanent* deletion.
     Only invoked from the multi-select toolbar shown in the archive
     view's selection mode. The list itself owns the selection +
     confirmation UX; this prop only carries out the destructive
     action. */
  onChatPermanentDelete?: (chatIds: string[]) => void | Promise<void>;
  /** Fires when the gear chip in the top header is tapped. Navigates to
     the settings surface. */
  onSettingsOpen?: () => void;
  /** Fires when the standalone new-conversation chip in the bottom dock
     is tapped. Optional — when omitted the chip is not rendered. */
  onNewChat?: () => void;
  /** Localized download-page URL carried by the onboarding's share/copy
     actions — the payload a phone hands to a computer (the phone itself
     never navigates to it). Defaults to the production download page. */
  onboardingDownloadUrl?: string;
  /** When true, the Chat tab renders the *archived* conversations
     (instead of the active ones) and the content area is tinted with
     `bg-muted` to give the "everything here is archived" feel. The
     caller still owns the data — it just hands over the archived
     list via `chats` when this is true and the active list when it's
     false. */
  showArchived?: boolean;
  /** Fires when the user taps the Archive chip in the header. Only
     rendered when both this callback and the Chat tab are active. */
  onShowArchivedToggle?: () => void;
};

const workspaceAvatarStyles = stylex.create({
  crop: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    width: control.large,
    height: control.large,
    borderRadius: radius.full,
    cornerShape: corner.round,
    overflow: 'hidden',
  },
  content: {
    display: 'flex',
    // Fill the 36px header control with the primitive's 32px large tile.
    transform: 'scale(1.125)',
  },
});

/* The header owns its circular crop; shared workspace tiles keep their shape. */
function HomeWorkspaceAvatar({ workspace }: { workspace: MobileHomeWorkspace }) {
  return (
    <span {...stylex.props(workspaceAvatarStyles.crop)}>
      <span {...stylex.props(workspaceAvatarStyles.content)}>
        <WorkspaceAvatar
          workspace={{ name: workspace.name, logo: workspace.avatarUrl }}
          size="large"
        />
      </span>
    </span>
  );
}

/* Floating pill (workspace chip / settings chip).
   Light: soft muted inset (card == white background, so no white
   shadow blobs). Dark: muted alone is too close to the canvas —
   add a hairline + slightly lifted white/10 fill so archive /
   settings / chips actually read as controls. */
const FloatingPill = forwardRef<HTMLButtonElement, React.ButtonHTMLAttributes<HTMLButtonElement>>(
  function FloatingPill({ className, type = 'button', ...rest }, ref) {
    return (
      <button
        {...rest}
        ref={ref}
        type={type}
        className={[
          stylex.props(styles.pill, styles.pillActive, styles.workspacePill).className,
          className,
        ]
          .filter(Boolean)
          .join(' ')}
      />
    );
  }
);

/* Add-project action sheet launched from the Projects header. A bottom sheet
   with large, well-separated tap targets (rejected: a desktop-style dropdown —
   its items sat too close together on touch and read as out of place on
   mobile). Dismisses via swipe-down / backdrop tap (vaul). */
function AddProjectActionSheet({
  open,
  onOpenChange,
  onAddLocalProject,
  onAddGitHubRepository,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAddLocalProject?: () => void;
  onAddGitHubRepository?: () => void;
  labels: MobileHomeScreenLabels;
}) {
  const options: Array<{
    key: string;
    icon: ReactNode;
    title: string;
    hint: string;
    onSelect: () => void;
  }> = [];
  if (onAddLocalProject) {
    options.push({
      key: 'local',
      icon: (
        <FolderPlus
          className={stylex.props(styles.icon5).className}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ),
      title: labels.addLocalProject ?? '添加文件夹',
      hint: labels.addLocalProjectHint ?? '浏览机器目录，选择一个文件夹',
      onSelect: onAddLocalProject,
    });
  }
  if (onAddGitHubRepository) {
    options.push({
      key: 'github',
      icon: (
        <Github
          className={stylex.props(styles.icon5).className}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ),
      title: labels.addGitHubRepository ?? '添加 GitHub 仓库',
      hint: labels.addGitHubRepositoryHint ?? '连接 GitHub 集成',
      onSelect: onAddGitHubRepository,
    });
  }

  const title = labels.addProjectMenu ?? '添加项目';

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent bottomPadding="safeArea">
        <DrawerTitle visuallyHidden>{title}</DrawerTitle>
        <DrawerDescription visuallyHidden>{title}</DrawerDescription>
        <div {...stylex.props(styles.sheetStack)}>
          {options.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => {
                onOpenChange(false);
                opt.onSelect();
              }}
              {...stylex.props(styles.sheetOption)}
            >
              <span {...stylex.props(styles.sheetOptionIcon)}>{opt.icon}</span>
              <span {...stylex.props(styles.sheetOptionBody)}>
                <span {...stylex.props(styles.sheetOptionTitle)}>{opt.title}</span>
                <span {...stylex.props(styles.sheetOptionHint)}>{opt.hint}</span>
              </span>
            </button>
          ))}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

function PrivateResourceHelpSheet({
  open,
  onOpenChange,
  labels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: MobileHomeScreenLabels;
}) {
  const title = labels.privateHelpTitle ?? 'Private resources are only visible to you';
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent bottomPadding="safeArea">
        <div {...stylex.props(styles.helpStack)}>
          <span {...stylex.props(styles.helpIcon)}>
            <LockKeyhole className={stylex.props(styles.icon5).className} aria-hidden="true" />
          </span>
          <DrawerTitle className="text-base font-semibold text-foreground">{title}</DrawerTitle>
          <DrawerDescription className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {labels.privateHelpDescription ??
              'Private machines, local projects, and their conversations are hidden from teammates. Share a machine in device settings or a project in project settings.'}
          </DrawerDescription>
          <button
            type="button"
            {...stylex.props(styles.helpClose)}
            onClick={() => onOpenChange(false)}
          >
            {labels.privateHelpClose ?? 'Got it'}
          </button>
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/* Compact semantic age label ("now", "5m", "2h", "3d", "2mo", "1y") used
   in the row's trailing slot. Mirrors `formatMobileAgeLabel` in
   chat-landing.tsx; duplicated here so the home component stays
   self-contained. */
function formatHomeRowAgeLabel(dateValue: number | string | undefined | null): string {
  if (dateValue == null) return '';
  const ts = typeof dateValue === 'number' ? dateValue : Date.parse(String(dateValue));
  if (!Number.isFinite(ts)) return '';
  const diffMs = Date.now() - ts;
  if (diffMs < 60_000) return 'now';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.floor(months / 12)}y`;
}

/* Trailing-slot content for list rows on the Local + GitHub tabs.
   Stacks the semantic age label on top with an unread-count pill
   underneath — when there's nothing to show, the whole slot collapses
   to `null` so Konsta's row layout doesn't reserve extra width. */
function RowTrailingMeta({
  latestMessageAt,
  unreadCount,
}: {
  latestMessageAt?: number | null;
  unreadCount?: number;
}) {
  const ageLabel = formatHomeRowAgeLabel(latestMessageAt ?? null);
  const unread = unreadCount ?? 0;
  if (!ageLabel && unread === 0) return null;
  return (
    <span {...stylex.props(styles.trailingMeta)}>
      {ageLabel ? <span {...stylex.props(styles.trailingAge)}>{ageLabel}</span> : null}
      {unread > 0 ? (
        <span {...stylex.props(styles.trailingBadge)}>{unread > 99 ? '99+' : unread}</span>
      ) : null}
    </span>
  );
}

/* Fast top→bottom exit for header search before the status/pull pill
   mounts. Keep short so the handoff still tracks the finger; longer
   values leave a blank band that feels laggy. Must match the CSS
   `duration-150` on the search slot (150ms). */
const HEADER_SEARCH_EXIT_MS = 150;

/* Header search input. Fills the chrome-row middle between the workspace
   avatar and trailing actions. Same surface as FloatingPill. */
function HeaderSearchInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
  clearAriaLabel,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  ariaLabel: string;
  clearAriaLabel: string;
  className?: string;
}) {
  return (
    <label
      className={[
        'mobile-home-header-search',
        stylex.props(styles.searchField).className,
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <Search
        className={stylex.props(styles.icon35ShrinkMuted).className}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        enterKeyHint="search"
        /* Drop the browser's default focus border on type=search; the
           muted pill is the visual container. */
        {...stylex.props(styles.searchInput)}
      />
      {value ? (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={clearAriaLabel}
          {...stylex.props(styles.searchClear)}
        >
          <X
            className={stylex.props(styles.icon35).className}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
      ) : null}
    </label>
  );
}

/* Chat-list filter toggle — lives on the first group heading's trailing
   edge (not next to search). Active tint when the pill bar is open; a
   small primary dot marks applied filters while the bar is collapsed. */
function ChatListFilterToggle({
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
      {...stylex.props(styles.filterToggle, open && styles.filterToggleOpen)}
    >
      <SlidersHorizontal
        className={stylex.props(styles.icon4Current).className}
        strokeWidth={1.8}
        aria-hidden="true"
      />
      {hasActiveFilters && !open ? (
        <span aria-hidden="true" {...stylex.props(styles.filterToggleDot)} />
      ) : null}
    </button>
  );
}

/* Small uppercase label used as a section heading. Visually matches
   the "最近常用" heading on the recents strip, but standalone (no
   horizontal scroll, no trailing chips). */
function AllItemsHeading({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.allItemsHeading)}>{children}</div>;
}

function MachineStatusDot({ online }: { online: boolean }) {
  return (
    <span
      {...stylex.props(styles.statusDot, online ? styles.statusDotOnline : styles.statusDotOffline)}
      aria-hidden="true"
    />
  );
}

/* Initial-letter avatar lives in its own module so the in-project
   header can share the same look. */

/* Owner avatar for GitHub rows: real image when we have a URL,
   otherwise the github glyph on a neutral tile. */
function GhOwnerAvatar({ url, handle }: { url?: string | null; handle: string }) {
  if (url) {
    return (
      <CachedAvatarImg
        src={url}
        alt=""
        loading="lazy"
        className={stylex.props(styles.ownerAvatarImage).className}
      />
    );
  }
  return (
    <span {...stylex.props(styles.ownerAvatarTile)} aria-label={handle}>
      <Github
        className={stylex.props(styles.icon5).className}
        strokeWidth={1.6}
        aria-hidden="true"
      />
    </span>
  );
}

/* Rounded card surface that wraps the flat row list on each tab. */
function MobileHomeListShell({ children }: { children: ReactNode }) {
  return <ul {...stylex.props(styles.listShell)}>{children}</ul>;
}

/* Single row in the flat home list. Slots:
   - `leading`: 40×40 avatar tile (initial letter / owner image / glyph)
   - `title` + optional `titleSuffix` on the same line (project name +
     light path; or `owner/repo` with no suffix)
   - optional `secondaryLine` underneath (machine meta for Local + Chat;
     empty for GitHub which is a single-line row)
   - `trailing`: time + unread badge (renders `RowTrailingMeta`)

   `last:border-b-0` lets the shell crop the final divider without a
   per-call special case. */
function MobileHomeListRow({
  leading,
  title,
  titleSuffix,
  secondaryLine,
  trailing,
  onClick,
  ariaLabel,
  wrapTitle = false,
  disabled = false,
}: {
  leading: ReactNode;
  title: ReactNode;
  titleSuffix?: ReactNode;
  secondaryLine?: ReactNode;
  trailing?: ReactNode;
  onClick?: () => void;
  ariaLabel?: string;
  /** Let the title wrap to show in full instead of truncating on one
     line. The `titleSuffix` then stays pinned (shrink-0) to the first
     line. Used by the local-projects list so long project names aren't
     clipped. */
  wrapTitle?: boolean;
  disabled?: boolean;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        aria-label={ariaLabel}
        {...stylex.props(styles.listRow)}
      >
        {leading}
        <span {...stylex.props(styles.listRowBody)}>
          <span
            {...stylex.props(styles.listRowTitleLine, wrapTitle && styles.listRowTitleLineCentered)}
          >
            <span
              {...stylex.props(
                styles.listRowTitle,
                wrapTitle ? styles.listRowTitleWrap : styles.listRowTitleTruncate
              )}
            >
              {title}
            </span>
            {titleSuffix ? (
              <span
                {...stylex.props(
                  styles.listRowSuffix,
                  wrapTitle ? styles.listRowSuffixWrap : styles.listRowSuffixTruncate
                )}
              >
                {titleSuffix}
              </span>
            ) : null}
          </span>
          {secondaryLine}
        </span>
        {trailing}
      </button>
    </li>
  );
}

/* Horizontal "最近常用" strip rendered at the top of the Local + GitHub
   tabs. Each card is a tap-to-enter rounded rectangle showing a
   leading visual (machine icon / owner avatar), the project or repo
   name, and a secondary caption (machine name / owner handle). The
   parent caps the list and sorts by recency. */
function RecentItemsRow<TItem extends { id: string }>({
  items,
  heading,
  onSelect,
  renderItem,
}: {
  items: TItem[];
  heading: ReactNode;
  onSelect: (item: TItem) => void;
  renderItem: (item: TItem) => ReactNode;
}) {
  if (items.length === 0) return null;
  return (
    <div {...withClassName(stylex.props(styles.recentsWrap), 'mobile-home-recents')}>
      <div {...stylex.props(styles.recentsHeading)}>{heading}</div>
      <div {...withClassName(stylex.props(styles.recentsScroller), 'hide-scrollbar')}>
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onSelect(item)}
            {...stylex.props(styles.recentCard)}
          >
            {renderItem(item)}
          </button>
        ))}
      </div>
    </div>
  );
}

/* Build the bottom tabbar's tab list from the screen's labels. Lives
   at module scope (rather than inside `MobileHomeScreen`) so the spec
   doesn't get rebuilt unnecessarily — `labels` is identity-stable per
   render of the parent, and the tab callbacks are passed to
   `<MobileWorkspaceTabBar>` via plain props, not closures. */
function workspaceTabSpecs(
  labels: MobileHomeScreenLabels,
  showInboxTab = false
): ReadonlyArray<MobileBottomTabBarTabSpec<MobileHomeTab>> {
  /* Icons at 24px (h-6) — the dock pill is h-14, so h-5/20px read as
     under-drawn next to the label. Material icons go through MobileReactIcon
     which fills this box (not 1em of the label's 0.72rem). */
  return [
    ...(showInboxTab
      ? [
          {
            key: 'inbox' as const,
            ios: <BellRing className={stylex.props(styles.icon6).className} strokeWidth={1.75} />,
            material: (
              <BellRing className={stylex.props(styles.icon6).className} strokeWidth={1.75} />
            ),
            label: labels.inboxTab ?? 'Inbox',
          },
        ]
      : []),
    {
      key: 'chat',
      ios: <MessageCircle className={stylex.props(styles.icon6).className} strokeWidth={1.75} />,
      material: <MobileReactIcon icon={MdChat} className={stylex.props(styles.icon6).className} />,
      label: labels.chatTab ?? 'Chat',
    },
    {
      key: 'schedules',
      ios: <Clock3 className={stylex.props(styles.icon6).className} />,
      material: <Clock3 className={stylex.props(styles.icon6).className} />,
      label: labels.schedulesTab ?? 'Schedules',
    },
    {
      key: 'projects',
      ios: <Folders className={stylex.props(styles.icon6).className} strokeWidth={1.75} />,
      material: (
        <MobileReactIcon icon={MdFolderCopy} className={stylex.props(styles.icon6).className} />
      ),
      label: labels.projectsTab ?? '项目',
    },
  ];
}

/* Storybook / unconfigured callers see hard-coded Chinese fallbacks
   here — in production every caller threads through chat-landing,
   which supplies its own localized `labels.searchPlaceholder` (see
   the `useMemo` in chat-landing that picks the per-tab i18n key).
   Keep the fallbacks Chinese to match this repo's dev language; the
   i18n scanner can't reach inline literals like these because they
   aren't wrapped in `t()`. */
function defaultSearchPlaceholder(
  tab: MobileHomeTab,
  sub: MobileProjectsSubTab | undefined
): string {
  if (tab === 'inbox') return '搜索';
  if (tab === 'chat') return '搜索对话';
  if (tab === 'schedules') return '搜索定时任务';
  if (sub === 'github') return '搜索仓库';
  return '搜索项目';
}

/* Merge the two recent arrays into a single newest-first sorted list,
   capped at `cap` items. Stable for items without `latestActivityAt`
   — they sink to the bottom in their input order. The discriminator
   `kind` is added here so the strip renderer can branch on it.

   We merge in the component (not the caller) so callers stay close to
   their data sources: each kind has different timestamp fields and
   different filtering rules, and forcing the caller to flatten would
   leak that logic to every consumer. The merge is cheap (O(n log n))
   and the inputs are already capped at ≤5 each. */
function mergeRecentProjects(
  local: MobileHomeRecentLocalProject[],
  github: MobileHomeRecentRepo[],
  cap = 6
): MobileHomeRecentProject[] {
  const tagged: MobileHomeRecentProject[] = [
    ...local.map((item) => ({ kind: 'local' as const, ...item })),
    ...github.map((item) => ({ kind: 'github' as const, ...item })),
  ];
  tagged.sort((left, right) => {
    const leftTs = left.latestActivityAt ?? -Infinity;
    const rightTs = right.latestActivityAt ?? -Infinity;
    return rightTs - leftTs;
  });
  return tagged.slice(0, cap);
}

/* Compact pill-segmented control for the Projects sub-tab.

   Design intent: read as a section-local filter that sits *with* the
   content, not as a heavy page-level mode switch. We get that by
   keeping it small, content-sized (not full-width), and left-aligned.
   The `layoutId`-driven thumb still gives the iOS-segmented feel —
   framer-motion animates both x AND width when the active segment
   changes, since the two labels render at different widths.

   Rejected alternatives:
   - Full-width half-and-half segments: visually equal to "primary
     navigation", crowds the page; the user explicitly asked for
     "小一点，更有设计感".
   - Underlined tabs: too quiet for this layer; the segments need to
     read as interactive switches, not section headings.
   - Reuse `MobileFilterPillBar`: that bar shows N independent chips
     where each is on/off — a 2-segment exclusive selector reads more
     clearly with a shared thumb than two separately-toggleable pills.

   Tokens: `bg-muted/50` for the track is intentionally lighter than
   the original `bg-muted/60` — a thinner pill needs less contrast to
   register as a single grouped control. The active thumb is plain
   `bg-card` (no shadow) since the pill itself is so compact a shadow
   would feel chunky at this scale. */
function ProjectsSubTabSelector({
  active,
  localLabel,
  githubLabel,
  onSelect,
  iosTheme,
}: {
  active: MobileProjectsSubTab;
  localLabel: string;
  githubLabel: string;
  onSelect: (sub: MobileProjectsSubTab) => void;
  iosTheme: boolean;
}) {
  const listRef = useRef<HTMLDivElement>(null);
  const localRef = useRef<HTMLButtonElement>(null);
  const githubRef = useRef<HTMLButtonElement>(null);
  const segments: Array<{
    key: MobileProjectsSubTab;
    label: string;
    icon: ReactNode;
    ref: { current: HTMLButtonElement | null };
  }> = [
    {
      key: 'local',
      label: localLabel,
      icon: iosTheme ? (
        <Monitor
          className={stylex.props(styles.icon35).className}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        <MobileReactIcon icon={MdComputer} className={stylex.props(styles.icon35).className} />
      ),
      ref: localRef,
    },
    {
      key: 'github',
      label: githubLabel,
      icon: iosTheme ? (
        <Github
          className={stylex.props(styles.icon35).className}
          strokeWidth={1.8}
          aria-hidden="true"
        />
      ) : (
        <MobileReactIcon icon={FaGithub} className={stylex.props(styles.icon35).className} />
      ),
      ref: githubRef,
    },
  ];

  // Drive the active thumb with a *value* animation (x + width) rather than
  // framer-motion's `layoutId` layout animation. A layout animation re-measures
  // the thumb's on-screen box on every re-render and springs to correct any
  // delta — so while pull-to-refresh translates this whole subtree, each
  // `pullDistance` frame re-renders the selector, the thumb measures a new
  // screen position, and it visibly lags behind the content while "catching up".
  // Measuring the active button once per `active` change and animating x/width
  // keeps the same spring feel on tab-switch while staying immune to the
  // ancestor transform (rejected: keeping `layoutId` + memoizing the subtree —
  // `pullDistance` lives high in the tree and threading memo through is fragile).
  const [thumb, setThumb] = useState<{ x: number; width: number } | null>(null);
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return undefined;
    const measure = () => {
      const btn = (active === 'local' ? localRef : githubRef).current;
      if (!btn) return;
      // getBoundingClientRect (border-box) instead of offsetLeft so the thumb's
      // `left: 0` (padding-box of the borderless list, which coincides with its
      // border-box) lines up with the measured offset.
      const listRect = list.getBoundingClientRect();
      const btnRect = btn.getBoundingClientRect();
      setThumb({ x: btnRect.left - listRect.left, width: btnRect.width });
    };
    measure();
    // Re-measure when the pill itself reflows (font swap, container resize). A
    // ResizeObserver fires on the list's own box change but NOT on an ancestor's
    // pull-to-refresh transform, so it keeps the thumb aligned without
    // reintroducing the lag the layout animation caused.
    return observeResizeOnAnimationFrame(list, () => measure());
  }, [active, localLabel, githubLabel, iosTheme]);

  return (
    <div {...stylex.props(styles.subTabBar)}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={localLabel + ' / ' + githubLabel}
        {...stylex.props(styles.subTabTrack)}
      >
        {thumb ? (
          <motion.span
            aria-hidden="true"
            {...stylex.props(styles.subTabThumb)}
            initial={false}
            animate={{ x: thumb.x, width: thumb.width }}
            transition={{ type: 'spring', stiffness: 380, damping: 34, mass: 0.65 }}
          />
        ) : null}
        {segments.map((seg) => {
          const isActive = seg.key === active;
          return (
            <button
              key={seg.key}
              ref={(button) => {
                seg.ref.current = button;
              }}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => onSelect(seg.key)}
              {...stylex.props(styles.subTabButton, isActive && styles.subTabButtonActive)}
            >
              <span {...stylex.props(styles.subTabLabel)}>
                {seg.icon}
                {seg.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function normalizeForSearch(value: string | null | undefined): string {
  return (value ?? '').toLowerCase();
}

export function filterMobileInboxItems(
  items: readonly MobileInboxItem[],
  normalizedQuery: string
): MobileInboxItem[] {
  if (!normalizedQuery) return [...items];
  return items.filter(
    (item) =>
      normalizeForSearch(item.title).includes(normalizedQuery) ||
      normalizeForSearch(item.description).includes(normalizedQuery) ||
      normalizeForSearch(item.actionLabel).includes(normalizedQuery)
  );
}

export function MobileHomeScreen({
  workspace,
  workspaceOptions = [],
  machines,
  inboxItems = [],
  inboxLoading = false,
  onInboxItemSelect,
  onInboxItemDismiss,
  connectionUiState = 'online',
  isInitialDataLoading = false,
  onPullToRefresh,
  selectedTab,
  showInboxTab = false,
  selectedProjectsSubTab = 'local',
  onProjectsSubTabSelect,
  onAddLocalProject,
  onAddGitHubRepository,
  localProjects,
  recentLocalProjects = [],
  githubRepositories,
  recentGitHubRepos = [],
  chats,
  chatFilterPills,
  chatGroupBy = 'project',
  hasActiveChatFilters = false,
  onClearChatFilters,
  labels = {},
  theme,
  onWorkspaceMenuOpen,
  onWorkspaceSelect: _onWorkspaceSelect,
  onTabSelect,
  onLocalProjectSelect,
  onGitHubRepositorySelect,
  onChatSelect,
  onChatTogglePin,
  onChatArchive,
  onChatRestore,
  onChatPermanentDelete,
  onSettingsOpen,
  onNewChat,
  onboardingDownloadUrl,
  showArchived = false,
  onShowArchivedToggle,
}: MobileHomeScreenProps) {
  /* `workspaceOptions` was the source for the inline workspace dropdown
     menu — that's now handled by `MobileWorkspaceSwitcherSheet` rendered
     by the parent. The prop stays on the type for backward compatibility
     but isn't consumed here anymore. */
  void workspaceOptions;

  /* Chat filter pill bar starts collapsed so the list chrome stays
     clean; the filter chip after search toggles it open. Session-local
     only (not persisted) — reopening the app lands on a quiet surface. */
  const [chatFiltersOpen, setChatFiltersOpen] = useState(false);

  /* Single search query across all tabs — the input lives in the header
     and stays visible regardless of tab. Resetting on tab change would
     surprise users who flick between tabs while searching for the same
     thing in both ("react" could match a project name AND a chat
     title). Persisting keeps the filter useful. */
  const [searchQuery, setSearchQuery] = useState('');
  const createScheduleRef = useRef<(() => void) | null>(null);
  // Controls the add-project action sheet launched from the Projects header.
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [privateHelpOpen, setPrivateHelpOpen] = useState(false);
  /* Ref to the list-region scroll container — handed to
     `MobileWorkspaceTabBar` so the dock can collapse while the user
     scrolls. */
  const listScrollRef = useRef<HTMLDivElement>(null);
  /* Pull-to-refresh: when the list is at the top and the user
     pulls down past threshold, fire `onPullToRefresh`. The hook
     reports `isRefreshing` while the promise is in flight (fed into
     the header status pill so it shows "刷新中…" until the sync
     settles) and `pullDistance` during the gesture itself, which both
     translates the filter-pill bar + list down. The header runs a fast
     top→bottom search exit, then mounts the centered pull/status pill. */
  const {
    pullDistance,
    isRefreshing: isPullingRefresh,
    threshold: pullThreshold,
  } = usePullToRefresh({
    scrollRef: listScrollRef,
    onRefresh: () => onPullToRefresh?.() ?? Promise.resolve(),
    enabled: Boolean(onPullToRefresh),
  });
  const pullPastThreshold = pullDistance >= pullThreshold;
  const normalizedQuery = normalizeForSearch(searchQuery.trim());

  /* First-run onboarding: the user opened the mobile app before ever
     launching the desktop client, so the workspace has no machines and
     no conversations. The Chat tab is the default landing surface, so we
     surface a "download + start Lody on your computer" guide there instead
     of a bare "no conversations" line. Gated to the live Chat list (not
     the archive view, an active filter, or an in-progress search) so it
     only ever stands in for the genuine empty workspace. */
  const showChatOnboarding =
    selectedTab === 'chat' &&
    !isInitialDataLoading &&
    !showArchived &&
    !hasActiveChatFilters &&
    normalizedQuery.length === 0 &&
    machines.length === 0 &&
    chats.length === 0;

  /* Machine lookup table for the secondary line on Local + Chat rows.
     Each row carries a `machineId`; we resolve it to `{name, isOnline}`
     here rather than walking the array per row. */
  const machineLookup = useMemo(() => {
    const map = new Map<string, { name: string; isOnline: boolean; isPrivate?: boolean }>();
    for (const machine of machines) {
      map.set(machine.id, {
        name: machine.name,
        isOnline: machine.isOnline,
        isPrivate: machine.isPrivate,
      });
    }
    return map;
  }, [machines]);

  const scheduleTabActive = selectedTab === 'schedules';

  const resolvedTheme: 'ios' | 'material' =
    theme ?? (isIOSRuntimeEnvironment() ? 'ios' : 'material');

  const searchPlaceholder =
    labels.searchPlaceholder ?? defaultSearchPlaceholder(selectedTab, selectedProjectsSubTab);

  /* Unified recents list for the Projects tab. Merged inside the
     component so callers stay close to their own per-kind data. The
     full list below stays per-sub-tab — only the recents are unified. */
  const recentProjectsMerged = useMemo(
    () => mergeRecentProjects(recentLocalProjects, recentGitHubRepos),
    [recentLocalProjects, recentGitHubRepos]
  );
  const searchAriaLabel = labels.searchAriaLabel ?? searchPlaceholder;
  const clearSearchAriaLabel = labels.clearSearchAriaLabel ?? 'Clear search';

  /* Status/pull owns the middle chrome while pulling, refreshing, or
     ambient connection needs attention. Search and status must never
     overlap: search exits first (fast top→bottom fade), then the pill
     mounts; on restore the pill unmounts immediately and search fades
     back in. */
  const wantStatusSlot =
    pullDistance > 0 ||
    isPullingRefresh ||
    connectionUiState === 'loading' ||
    connectionUiState === 'reconnecting' ||
    connectionUiState === 'offline';
  /* Keep search mounted for the exit transition; opacity/transform are
     driven by `searchOpaque`. Pill only mounts once `statusRevealed`. */
  const [searchOpaque, setSearchOpaque] = useState(() => !wantStatusSlot);
  const [statusRevealed, setStatusRevealed] = useState(() => wantStatusSlot);
  useEffect(() => {
    let reveal: number | undefined;
    if (wantStatusSlot) {
      /* Exit search first; reveal pill only after the fade finishes so
         the two never share the chrome band. */
      setSearchOpaque(false);
      setStatusRevealed(false);
      reveal = window.setTimeout(() => {
        setStatusRevealed(true);
      }, HEADER_SEARCH_EXIT_MS);
    } else {
      /* Restore: drop pill immediately (no crossfade overlap), then
         fade search back in on the next frame so the exit transition
         can reverse cleanly. */
      setStatusRevealed(false);
      setSearchOpaque(true);
    }
    return () => {
      if (reveal !== undefined) window.clearTimeout(reveal);
    };
  }, [wantStatusSlot]);

  /* Tab swipe was removed — conflicted with the row-level
     left-swipe-to-reveal-actions gesture on conversation rows. The
     dock tabbar at the bottom remains the only way to switch tabs. */

  return (
    /* No Konsta App wrapper anymore — the flat lists use plain
       Tailwind-styled rows. The `safe-areas` class still has to be
       here because Konsta's `pt-safe-*` / `ps-safe-*` / `pe-safe-*`
       utilities (used by the header below and by other mobile screens
       in this tree) only resolve the `--k-safe-area-*` vars when an
       ancestor opts in via this class — `<App safeAreas>` used to do
       it for us; now we do it directly. The class is just a CSS hook
       (from konsta/styles/safe-areas.css), no Konsta runtime needed. */
    <div {...withClassName(stylex.props(styles.appRoot), 'mobile-home-app safe-areas')}>
      {/* Column flex so the header + Chat-tab pill bar sit ABOVE the
         scroll region — keeps the vertical scrollbar contained to
         the list area instead of running through the chrome at the
         top. Mirrors the structure on MobileProjectScreen. */}
      <div {...withClassName(stylex.props(styles.shell), 'mobile-home-shell')}>
        {/* Sticky header: safe-area padding outside the chrome row so the
           status/pull pill can center on the same h-9 band as the
           workspace / search / trailing controls — not the full header
           including `pt-safe` (that was pulling the pill into the notch). */}
        <header {...withClassName(stylex.props(styles.header), 'mobile-home-glass')}>
          {/* Single chrome row: workspace | search (middle blank) |
             archive/settings. Search fills the gap at rest; on pull it
             does a fast top→bottom fade, then the status/pull pill
             mounts (never overlapping). Leading/trailing keep
             `relative z-10` so taps stay hittable under the pill overlay. */}
          <div {...stylex.props(styles.headerRow)}>
            {/* Icon-only workspace identity. With a menu callback it is the
               switcher trigger; without one it remains a static nameplate. */}
            <div {...stylex.props(styles.headerLeading)}>
              {onWorkspaceMenuOpen ? (
                <FloatingPill
                  aria-label={`${labels.switchWorkspace ?? 'Switch workspace'}: ${workspace.name}`}
                  aria-haspopup="dialog"
                  onClick={onWorkspaceMenuOpen}
                >
                  <HomeWorkspaceAvatar workspace={workspace} />
                </FloatingPill>
              ) : (
                <div {...stylex.props(styles.workspaceIdentity)} data-workspace-identity>
                  <HomeWorkspaceAvatar workspace={workspace} />
                </div>
              )}
            </div>

            {/* Search stays mounted so CSS can run the exit transition.
               Slot always occupies flex-1 so trailing discs don't jump. */}
            <div
              {...stylex.props(
                styles.searchSlot,
                searchOpaque ? styles.searchSlotOpaque : styles.searchSlotHidden
              )}
              aria-hidden={!searchOpaque}
            >
              <HeaderSearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder={searchPlaceholder}
                ariaLabel={searchAriaLabel}
                clearAriaLabel={clearSearchAriaLabel}
              />
            </div>

            {/* Trailing header actions — same canvas liquid-glass discs as
               the in-session mobile header (`GlassIconButton`). */}
            <div {...stylex.props(styles.headerTrailing)}>
              {selectedTab === 'chat' && onShowArchivedToggle ? (
                <GlassIconButton
                  label={labels.archiveToggleLabel ?? '归档'}
                  onClick={onShowArchivedToggle}
                  className={cn(showArchived && 'text-primary')}
                >
                  <Archive
                    className={stylex.props(styles.icon5).className}
                    aria-hidden="true"
                    strokeWidth={1.75}
                  />
                </GlassIconButton>
              ) : null}

              {selectedTab === 'projects' && (onAddLocalProject || onAddGitHubRepository) ? (
                <GlassIconButton
                  label={labels.addProjectMenu ?? '添加项目'}
                  onClick={() => setAddMenuOpen(true)}
                >
                  <Plus
                    className={stylex.props(styles.icon5).className}
                    aria-hidden="true"
                    strokeWidth={1.75}
                  />
                </GlassIconButton>
              ) : null}

              {selectedTab === 'schedules' ? (
                <GlassIconButton
                  label={labels.newSchedule ?? '新建定时任务'}
                  onClick={() => createScheduleRef.current?.()}
                >
                  <Plus
                    className={stylex.props(styles.icon5).className}
                    aria-hidden="true"
                    strokeWidth={1.75}
                  />
                </GlassIconButton>
              ) : null}

              {onSettingsOpen ? (
                <GlassIconButton label={labels.settingsTab ?? '设置'} onClick={onSettingsOpen}>
                  <Settings
                    className={stylex.props(styles.icon5).className}
                    aria-hidden="true"
                    strokeWidth={1.75}
                  />
                </GlassIconButton>
              ) : null}
            </div>

            {/* Connection / pull status — horizontal center of the chrome
               row. Mounted only after search has finished exiting so the
               two never share the band. pointer-events-none so it never
               steals taps from workspace / trailing discs. */}
            {statusRevealed ? (
              <div {...stylex.props(styles.statusOverlay)}>
                <MobileConnectionStatus
                  className={stylex.props(styles.statusBounds).className}
                  state={connectionUiState}
                  refreshing={isPullingRefresh}
                  pull={
                    onPullToRefresh && pullDistance > 0
                      ? {
                          active: true,
                          pastThreshold: pullPastThreshold,
                          label: pullPastThreshold
                            ? (labels.releaseToRefresh ?? '释放刷新')
                            : (labels.pullToRefresh ?? '下拉刷新'),
                        }
                      : undefined
                  }
                  labels={labels.connectionBanner}
                />
              </div>
            ) : null}
          </div>
        </header>

        <AddProjectActionSheet
          open={addMenuOpen}
          onOpenChange={setAddMenuOpen}
          onAddLocalProject={onAddLocalProject}
          onAddGitHubRepository={onAddGitHubRepository}
          labels={labels}
        />
        <PrivateResourceHelpSheet
          open={privateHelpOpen}
          onOpenChange={setPrivateHelpOpen}
          labels={labels}
        />

        {/* Pull-driven content region. Filter pills + list share one
           `translate3d` so they move as a single compositor layer.
           The header stays put: search does a fast top→bottom exit,
           then the centered status pill mounts. */}
        <div {...stylex.props(styles.contentColumn)}>
          <div
            {...stylex.props(styles.contentBody, scheduleTabActive && styles.contentBodyHidden)}
            style={
              pullDistance > 0
                ? {
                    transform: `translate3d(0, ${pullDistance}px, 0)`,
                    willChange: 'transform',
                  }
                : undefined
            }
          >
            {/* Chat-tab filter pill bar — toggled from the first group
               heading's trailing chip. Stays ABOVE the list scroll region
               (pinned) and rides pull-to-refresh with the list. */}
            <AnimatePresence initial={false}>
              {selectedTab === 'chat' &&
              chatFiltersOpen &&
              chatFilterPills &&
              chatFilterPills.length > 0 ? (
                <motion.div
                  key="chat-filter-pills"
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: 'easeInOut' }}
                  {...stylex.props(styles.overflowHidden)}
                >
                  <MobileFilterPillBar pills={chatFilterPills} />
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div
              ref={listScrollRef}
              data-mobile-session-list-scroll-region=""
              {...withClassName(
                stylex.props(styles.listRegion),
                'mobile-home-list-region scrollbar-pro'
              )}
            >
              {selectedTab === 'inbox' ? (
                <InboxTabView
                  label={labels.inboxTab ?? 'Inbox'}
                  placeholder={labels.inboxPlaceholder}
                  loadingLabel={labels.inboxLoading ?? 'Loading…'}
                  dismissAriaLabel={labels.inboxDismissAriaLabel ?? 'Dismiss'}
                  emptySearchLabel={labels.emptySearch ?? 'No matching results'}
                  items={inboxItems ?? []}
                  loading={inboxLoading}
                  query={normalizedQuery}
                  onSelect={onInboxItemSelect}
                  onDismiss={onInboxItemDismiss}
                />
              ) : null}

              {selectedTab === 'projects' ? (
                <ProjectsTabView
                  localProjects={localProjects}
                  githubRepositories={githubRepositories}
                  recentProjectsMerged={recentProjectsMerged}
                  selectedSubTab={selectedProjectsSubTab}
                  onSubTabSelect={(sub) => onProjectsSubTabSelect?.(sub)}
                  machineLookup={machineLookup}
                  hasMachines={machines.length > 0}
                  labels={labels}
                  query={normalizedQuery}
                  onLocalProjectSelect={onLocalProjectSelect}
                  onGitHubRepositorySelect={onGitHubRepositorySelect}
                  onPrivateHelp={() => setPrivateHelpOpen(true)}
                  iosTheme={resolvedTheme === 'ios'}
                />
              ) : null}

              {selectedTab === 'chat' ? (
                showChatOnboarding ? (
                  <MobileHomeOnboarding
                    labels={labels.onboarding ?? {}}
                    downloadUrl={onboardingDownloadUrl}
                  />
                ) : (
                  <ChatsFlatView
                    chats={chats}
                    groupBy={chatGroupBy}
                    labels={labels}
                    query={normalizedQuery}
                    onSelect={onChatSelect}
                    onTogglePin={onChatTogglePin}
                    onArchive={onChatArchive}
                    onRestore={onChatRestore}
                    archived={showArchived}
                    onPermanentDelete={showArchived ? onChatPermanentDelete : undefined}
                    hasActiveFilters={hasActiveChatFilters}
                    onClearFilters={onClearChatFilters}
                    firstGroupTrailing={
                      chatFilterPills && chatFilterPills.length > 0 ? (
                        <ChatListFilterToggle
                          open={chatFiltersOpen}
                          hasActiveFilters={hasActiveChatFilters}
                          ariaLabel={labels.filterBarToggleLabel ?? '过滤器'}
                          onToggle={() => setChatFiltersOpen((open) => !open)}
                        />
                      ) : undefined
                    }
                    onPrivateHelp={() => setPrivateHelpOpen(true)}
                  />
                )
              ) : null}
            </div>
          </div>

          {/* Schedules tab keeps the home header and the bottom dock.
             Its own title/search row stays hidden so this search field
             is the one that filters the list. */}
          {scheduleTabActive ? (
            <div {...stylex.props(styles.schedulesColumn)}>
              <SchedulesWorkspace
                hideHeader
                query={searchQuery}
                createScheduleRef={createScheduleRef}
              />
            </div>
          ) : null}
        </div>

        {/* Shared workspace tabbar (chat / projects) + the optional
            separate new-chat chip. The 设置 surface is reached via the
            gear button in the top header, so it's no longer one of the
            bottom tabs. Tabs are built locally so the translations stay
            co-located with the other screen copy. */}
        <MobileWorkspaceTabBar<MobileHomeTab>
          tabs={workspaceTabSpecs(labels, showInboxTab)}
          selectedTab={selectedTab}
          onTabSelect={(tab) => onTabSelect?.(tab)}
          onNewChat={onNewChat}
          newChatAriaLabel={labels.newChatAriaLabel}
          ariaLabel={labels.chatTab ?? '导航'}
          theme={resolvedTheme}
          scrollContainerRef={listScrollRef}
        />
      </div>
    </div>
  );
}

/* ── Inbox tab ───────────────────────────────────────────────────────── */

function InboxTabView({
  label,
  placeholder,
  loadingLabel,
  dismissAriaLabel,
  emptySearchLabel,
  items,
  loading = false,
  query,
  onSelect,
  onDismiss,
}: {
  label: string;
  placeholder?: string;
  loadingLabel: string;
  dismissAriaLabel: string;
  emptySearchLabel: string;
  items: MobileInboxItem[];
  loading?: boolean;
  query: string;
  onSelect?: (itemId: string) => void;
  onDismiss?: (itemId: string) => void;
}) {
  const visibleItems = useMemo(() => {
    return filterMobileInboxItems(items, query);
  }, [items, query]);

  if (!loading && items.length === 0) {
    return (
      <section aria-label={label} {...stylex.props(styles.inboxSection)}>
        <TabEmptyState label={placeholder ?? 'No new notifications'} />
      </section>
    );
  }
  if (!loading && query && visibleItems.length === 0) {
    return (
      <section aria-label={label} {...stylex.props(styles.inboxSection)}>
        <TabEmptyState label={emptySearchLabel} />
      </section>
    );
  }
  return (
    <section aria-label={label} {...stylex.props(styles.inboxList)}>
      {loading ? <div {...stylex.props(styles.inboxLoading)}>{loadingLabel}</div> : null}
      {visibleItems.map((item) => {
        const Icon =
          item.kind === 'sharing_review'
            ? LockKeyhole
            : item.kind === 'permission_requested'
              ? BellRing
              : CircleCheckBig;
        return (
          <article key={item.id} {...stylex.props(styles.inboxCard)}>
            <button
              type="button"
              {...stylex.props(styles.inboxCardButton)}
              onClick={() => onSelect?.(item.id)}
            >
              <span {...stylex.props(styles.inboxCardIcon)}>
                <Icon
                  className={stylex.props(styles.icon18).className}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                {item.unread ? <span {...stylex.props(styles.inboxUnreadDot)} /> : null}
              </span>
              <span {...stylex.props(styles.inboxCardBody)}>
                <span {...stylex.props(styles.inboxCardTitle)}>{item.title}</span>
                <span {...stylex.props(styles.inboxCardDescription)}>{item.description}</span>
                {item.actionLabel ? (
                  <span {...stylex.props(styles.inboxCardAction)}>{item.actionLabel}</span>
                ) : null}
              </span>
            </button>
            <button
              type="button"
              {...stylex.props(styles.inboxDismiss)}
              onClick={() => onDismiss?.(item.id)}
              aria-label={dismissAriaLabel}
            >
              <X className={stylex.props(styles.icon4).className} aria-hidden="true" />
            </button>
          </article>
        );
      })}
    </section>
  );
}

/* ── Projects tab (Local + GitHub merged) ────────────────────────────── */

/* The Projects tab's top-level body. Owns the layout order:
   (1) unified recents strip, (2) sub-tab selector, (3) sub-tab body
   (Local or GitHub). The recents strip is rendered only when there are
   any recents AND the user isn't searching — search should focus the
   user on the filtered full list. */
function ProjectsTabView({
  localProjects,
  githubRepositories,
  recentProjectsMerged,
  selectedSubTab,
  onSubTabSelect,
  machineLookup,
  hasMachines,
  labels,
  query,
  onLocalProjectSelect,
  onGitHubRepositorySelect,
  onPrivateHelp,
  iosTheme,
}: {
  localProjects: MobileHomeLocalProject[];
  githubRepositories: MobileHomeGitHubRepository[];
  recentProjectsMerged: MobileHomeRecentProject[];
  selectedSubTab: MobileProjectsSubTab;
  onSubTabSelect: (sub: MobileProjectsSubTab) => void;
  machineLookup: Map<string, { name: string; isOnline: boolean }>;
  hasMachines: boolean;
  labels: MobileHomeScreenLabels;
  query: string;
  onLocalProjectSelect?: (projectId: string) => void;
  onGitHubRepositorySelect?: (fullName: string) => void;
  onPrivateHelp: () => void;
  iosTheme: boolean;
}) {
  const localLabel = labels.localTab ?? '本地';
  const githubLabel = labels.githubTab ?? 'GitHub';

  /* Unified recents — only rendered when there's anything to show
     AND the user isn't actively searching. Each item's `kind` drives
     the inline render branch (avatar source + caption format). */
  const recentStrip =
    !query && recentProjectsMerged.length > 0 ? (
      <RecentItemsRow
        items={recentProjectsMerged}
        heading={labels.recentProjectsHeading ?? '最近常用'}
        onSelect={(item) => {
          if (item.kind === 'local') onLocalProjectSelect?.(item.id);
          else onGitHubRepositorySelect?.(item.fullName);
        }}
        renderItem={(item) =>
          item.kind === 'local' ? (
            <>
              <MobileInitialLetterAvatar name={item.name} hashSeed={item.id} size="lg" />
              <div {...stylex.props(styles.recentCardBody)}>
                <div {...stylex.props(styles.recentCardMeta)}>{item.machineName ?? item.path}</div>
                <div {...stylex.props(styles.recentCardName)}>{item.name}</div>
              </div>
            </>
          ) : (
            <>
              {item.avatarUrl ? (
                <CachedAvatarImg
                  src={item.avatarUrl}
                  alt=""
                  className={stylex.props(styles.recentAvatar).className}
                  loading="lazy"
                />
              ) : (
                <Github
                  className={stylex.props(styles.icon8Shrink).className}
                  strokeWidth={1.6}
                  aria-hidden="true"
                />
              )}
              <div {...stylex.props(styles.recentCardBody)}>
                <div {...stylex.props(styles.recentCardMeta)}>{item.ownerHandle}</div>
                <div {...stylex.props(styles.recentCardName)}>{item.name}</div>
              </div>
            </>
          )
        }
      />
    ) : null;

  return (
    <section aria-label={labels.projectsTab ?? '项目'} {...stylex.props(styles.chatSection)}>
      {recentStrip}
      <ProjectsSubTabSelector
        active={selectedSubTab}
        localLabel={localLabel}
        githubLabel={githubLabel}
        onSelect={onSubTabSelect}
        iosTheme={iosTheme}
      />
      {selectedSubTab === 'local' ? (
        <LocalProjectsList
          projects={localProjects}
          machineLookup={machineLookup}
          hasMachines={hasMachines}
          labels={labels}
          query={query}
          onSelect={onLocalProjectSelect}
          onPrivateHelp={onPrivateHelp}
        />
      ) : (
        <GitHubReposList
          repositories={githubRepositories}
          labels={labels}
          query={query}
          onSelect={onGitHubRepositorySelect}
        />
      )}
    </section>
  );
}

/* ── Local projects (grouped by machine) ─────────────────────────────── */

/* Section heading for a machine group: status dot + machine name in
   normal case (machine names are proper nouns, so unlike `AllItemsHeading`
   it isn't uppercased). */
function MachineGroupHeading({
  machine,
  fallbackName,
  privateLabel,
  privateHelpAriaLabel,
  hasPrivateProject,
  onPrivateHelp,
}: {
  machine: { name: string; isOnline: boolean; isPrivate?: boolean } | null;
  fallbackName: string;
  privateLabel: string;
  privateHelpAriaLabel: string;
  hasPrivateProject: boolean;
  onPrivateHelp: () => void;
}) {
  return (
    <div {...stylex.props(styles.machineGroupHeading)}>
      <MachineStatusDot online={machine?.isOnline ?? false} />
      <span {...stylex.props(styles.machineGroupName)}>{machine?.name ?? fallbackName}</span>
      {machine?.isPrivate || hasPrivateProject ? (
        <button
          type="button"
          onClick={onPrivateHelp}
          aria-label={privateHelpAriaLabel}
          {...stylex.props(styles.machinePrivateButton)}
        >
          <LockKeyhole className={stylex.props(styles.icon3).className} aria-hidden="true" />
          {machine?.isPrivate ? privateLabel : null}
          <CircleHelp className={stylex.props(styles.icon3).className} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

function LocalProjectsList({
  projects,
  machineLookup,
  hasMachines,
  labels,
  query,
  onSelect,
  onPrivateHelp,
}: {
  projects: MobileHomeLocalProject[];
  machineLookup: Map<string, { name: string; isOnline: boolean; isPrivate?: boolean }>;
  hasMachines: boolean;
  labels: MobileHomeScreenLabels;
  query: string;
  onSelect?: (projectId: string) => void;
  onPrivateHelp: () => void;
}) {
  const visible = useMemo(() => {
    if (!query) return projects;
    return projects.filter(
      (project) =>
        normalizeForSearch(project.name).includes(query) ||
        normalizeForSearch(project.path).includes(query)
    );
  }, [projects, query]);

  /* Bucket the visible projects by machine. Group order follows the
     caller's already-sorted project list, so cross-machine project
     recency is not lost when section headings are inserted. */
  const groups = useMemo<Array<[string, MobileHomeLocalProject[]]>>(() => {
    const byMachine = new Map<string, MobileHomeLocalProject[]>();
    for (const project of visible) {
      const bucket = byMachine.get(project.machineId);
      if (bucket) bucket.push(project);
      else byMachine.set(project.machineId, [project]);
    }
    return Array.from(byMachine.entries());
  }, [visible]);

  if (projects.length === 0) {
    return (
      <TabEmptyState
        label={
          labels.emptyLocalProjects ??
          (hasMachines ? '当前 workspace 还没有本地项目' : '当前 workspace 没有可用机器')
        }
      />
    );
  }
  if (query && visible.length === 0) {
    return <TabEmptyState label={labels.emptySearch ?? '没有匹配的结果'} />;
  }

  return (
    <>
      {groups.map(([machineId, machineProjects]) => {
        const machine = machineLookup.get(machineId) ?? null;
        return (
          <Fragment key={machineId}>
            <MachineGroupHeading
              machine={machine}
              fallbackName={machineId}
              privateLabel={labels.privateLabel ?? 'Private'}
              privateHelpAriaLabel={labels.privateHelpAriaLabel ?? 'Learn about private resources'}
              hasPrivateProject={machineProjects.some((project) => project.isPrivate)}
              onPrivateHelp={onPrivateHelp}
            />
            <MobileHomeListShell>
              {machineProjects.map((project) => (
                <MobileHomeListRow
                  key={project.id}
                  ariaLabel={project.name}
                  onClick={project.removalState ? undefined : () => onSelect?.(project.id)}
                  disabled={Boolean(project.removalState)}
                  leading={
                    <MobileInitialLetterAvatar
                      name={project.name}
                      hashSeed={project.id}
                      size="lg"
                    />
                  }
                  title={project.name}
                  /* Full project name (wraps instead of truncating). The
                     machine now lives in the group heading, so the row
                     only carries the name + path. */
                  wrapTitle
                  titleSuffix={
                    project.removalState ? (
                      <span {...stylex.props(styles.removalState)}>
                        {project.removalState === 'waiting_for_device' ? (
                          <Clock3
                            className={stylex.props(styles.icon3Shrink).className}
                            aria-hidden="true"
                          />
                        ) : (
                          <Spinner
                            className={stylex.props(styles.icon3Shrink).className}
                            aria-hidden="true"
                          />
                        )}
                        <span {...stylex.props(styles.removalStateText)}>
                          {project.removalState === 'waiting_for_device'
                            ? (labels.projectRemovalWaiting ?? 'Waiting for device…')
                            : (labels.projectRemoving ?? 'Removing…')}
                        </span>
                      </span>
                    ) : project.isPrivate ? (
                      <LockKeyhole
                        className={stylex.props(styles.icon35ShrinkMuted).className}
                        aria-hidden="true"
                      />
                    ) : undefined
                  }
                  secondaryLine={
                    project.path ? (
                      <span {...stylex.props(styles.projectPath)}>{project.path}</span>
                    ) : undefined
                  }
                  trailing={
                    project.removalState ? undefined : (
                      <RowTrailingMeta
                        latestMessageAt={project.latestMessageAt}
                        unreadCount={project.unreadCount}
                      />
                    )
                  }
                />
              ))}
            </MobileHomeListShell>
          </Fragment>
        );
      })}
    </>
  );
}

/* ── GitHub repos (flat list, newest first) ──────────────────────────── */

function GitHubReposList({
  repositories,
  labels,
  query,
  onSelect,
}: {
  repositories: MobileHomeGitHubRepository[];
  labels: MobileHomeScreenLabels;
  query: string;
  onSelect?: (repoFullName: string) => void;
}) {
  const visible = useMemo(() => {
    if (!query) return repositories;
    return repositories.filter(
      (repo) =>
        normalizeForSearch(repo.fullName).includes(query) ||
        normalizeForSearch(repo.name).includes(query) ||
        normalizeForSearch(repo.ownerHandle).includes(query) ||
        (repo.description ? normalizeForSearch(repo.description).includes(query) : false)
    );
  }, [repositories, query]);

  if (repositories.length === 0) {
    return (
      <TabEmptyState
        label={labels.emptyGitHubProjects ?? '当前 workspace 没有已授权的 GitHub 仓库'}
      />
    );
  }
  if (query && visible.length === 0) {
    return <TabEmptyState label={labels.emptySearch ?? '没有匹配的结果'} />;
  }

  return (
    <>
      <AllItemsHeading>{labels.allGitHubReposHeading ?? '全部仓库'}</AllItemsHeading>
      <MobileHomeListShell>
        {visible.map((repository) => (
          <MobileHomeListRow
            key={repository.id}
            ariaLabel={repository.fullName}
            onClick={() => onSelect?.(repository.fullName)}
            leading={
              <GhOwnerAvatar url={repository.ownerAvatarUrl} handle={repository.ownerHandle} />
            }
            title={repository.fullName}
            trailing={
              <RowTrailingMeta
                latestMessageAt={repository.latestMessageAt}
                unreadCount={repository.unreadCount}
              />
            }
          />
        ))}
      </MobileHomeListShell>
    </>
  );
}

/* ── Chats (flat list, newest first) ─────────────────────────────────── */

/* The filter pill bar is rendered ABOVE the scroll region by
   `MobileHomeScreen` itself, so this view doesn't carry it anymore
   — keeping the pill bar outside the scroll container is what
   contains the vertical scrollbar to the list area only. */
function ChatsFlatView({
  chats,
  groupBy,
  labels,
  query,
  onSelect,
  onTogglePin,
  onArchive,
  onRestore,
  archived,
  onPermanentDelete,
  hasActiveFilters = false,
  onClearFilters,
  firstGroupTrailing,
  onPrivateHelp,
}: {
  chats: MobileConversationItem[];
  groupBy: MobileChatGroupBy;
  labels: MobileHomeScreenLabels;
  query: string;
  onSelect?: (chatId: string) => void;
  onTogglePin?: (chatId: string, nextPinned: boolean) => void;
  onArchive?: (chatId: string) => void;
  onRestore?: (chatId: string) => void;
  archived?: boolean;
  onPermanentDelete?: (chatIds: string[]) => void | Promise<void>;
  /** True when active filters narrowed the list — switches the empty
     state to the "filters hid everything" copy + Clear filters button. */
  hasActiveFilters?: boolean;
  onClearFilters?: () => void;
  /** Filter chip mounted on the first group heading (or a trailing-only
     row when the list is empty / flat with no heading). */
  firstGroupTrailing?: ReactNode;
  onPrivateHelp: () => void;
}) {
  const visible = useMemo(() => {
    if (!query) return chats;
    return chats.filter(
      (chat) =>
        normalizeForSearch(chat.title).includes(query) ||
        normalizeForSearch(chat.branchName).includes(query)
    );
  }, [chats, query]);

  /* Shared "Clear filters" action for the empty states below. Only
     offered when filters are active and a handler is wired. */
  const clearFiltersAction =
    hasActiveFilters && onClearFilters ? (
      <TabEmptyStateButton onClick={onClearFilters}>
        {labels.clearChatFilters ?? '清除所有过滤'}
      </TabEmptyStateButton>
    ) : undefined;

  /* Empty states still need the filter chip so the user can open the
     bar / clear filters without a group heading to host it. */
  const emptyTrailing =
    firstGroupTrailing != null ? (
      <div {...stylex.props(styles.chatTrailingRow)}>{firstGroupTrailing}</div>
    ) : null;

  if (chats.length === 0) {
    /* `chats` is already filtered by the caller, so an empty list with
       active filters means the filters hid everything (vs. a workspace
       with no conversations at all). */
    return (
      <section aria-label={labels.chatTab ?? 'Chat'} {...stylex.props(styles.chatSection)}>
        {emptyTrailing}
        <TabEmptyState
          label={
            hasActiveFilters
              ? (labels.emptyFilteredChats ?? '当前过滤条件下没有对话')
              : (labels.emptyChats ?? '当前 workspace 还没有对话')
          }
          action={clearFiltersAction}
        />
      </section>
    );
  }
  if (query && visible.length === 0) {
    return (
      <section aria-label={labels.chatTab ?? 'Chat'} {...stylex.props(styles.chatSection)}>
        {emptyTrailing}
        <TabEmptyState label={labels.emptySearch ?? '没有匹配的结果'} action={clearFiltersAction} />
      </section>
    );
  }

  return (
    /* The chat tab aggregates EVERY conversation (chat-only,
       local-project, github-repo) into one newest-first list. The
       list body is rendered by `MobileChatList` (shared with the
       in-project detail page) so design tweaks land in one place. */
    <section aria-label={labels.chatTab ?? 'Chat'} {...stylex.props(styles.chatSection)}>
      <MobileChatList
        chats={visible}
        groupBy={groupBy}
        groupLabels={labels.chatGroupLabels}
        /* Home aggregates every project and worktree into one scroll, so each
           bucket previews its latest rows and offers the rest. Without it a
           single busy project owns the screen — the whole reason the cap
           exists. The in-project list deliberately does not pass this. */
        capGroupPreviews
        /* Home unmounts under Settings; keep folded groups folded on return. */
        bucketStateKey={archived ? 'home:archived' : 'home'}
        /* Active list is flat — no "全部对话" section label. Only the
           archived surface keeps a heading so the mode is obvious. */
        flatHeading={archived ? (labels.archivedChatsHeading ?? '归档对话') : undefined}
        firstGroupTrailing={firstGroupTrailing}
        onSelect={onSelect}
        rowActions={{ onTogglePin, onArchive, onRestore }}
        archived={archived}
        onPermanentDelete={onPermanentDelete}
        selectionLabels={labels.archiveSelection}
        privateLabel={labels.privateLabel}
        privateHelpAriaLabel={labels.privateHelpAriaLabel}
        onPrivateHelp={onPrivateHelp}
      />
    </section>
  );
}

/* First-run guide shown on the Chat tab of an empty workspace (no machines
   + no conversations). The mobile app is a thin client over the user's own
   machines, so the only thing standing between a new user and their first
   task is getting ONE machine connected. The guide offers the two real
   paths — the `lody daemon start` one-liner on any machine (including a
   headless server reached over SSH, whose printed sign-in link can be
   opened right on this phone) and the desktop app on their computer —
   then previews what happens once a machine comes online.

   Rendered inline (not a blocking modal) so the user can still switch
   workspaces / open settings underneath it. Pure presentational — copy via
   `labels`, actions via `navigator.share` + the shared clipboard helper —
   so i18n + Storybook live in the caller. The phone itself never opens
   the download page: opening it here only re-pitches the mobile app the
   user already installed, so the desktop card shares or copies the link
   for the computer instead. */
export function MobileHomeOnboarding({
  labels,
  downloadUrl,
}: {
  labels: MobileHomeOnboardingLabels;
  /** Localized download-page URL carried by the share/copy actions. */
  downloadUrl?: string;
}) {
  const command = labels.command ?? 'npx lody daemon start';
  const copyLabel = labels.copyCommandLabel ?? '复制命令';
  const linkUrl = downloadUrl ?? getDownloadPageUrl(undefined);
  /* The pill displays the URL without its scheme — `lody.ai/download` is
     short enough to read and type on the computer; the copy value keeps
     `https://` so a pasted link stays clickable. */
  const linkDisplay = linkUrl.replace(/^https?:\/\//u, '');
  const [copied, setCopied] = useState<'command' | 'link' | null>(null);
  const copiedTimerRef = useRef<number | undefined>(undefined);
  useEffect(() => {
    return () => window.clearTimeout(copiedTimerRef.current);
  }, []);

  /* The native share sheet is the phone → computer bridge: AirDrop hands
     the link straight to a Mac's browser, Messages/Mail carry it to the
     user's own machine. Capacitor WebViews may not expose it — copy to
     clipboard remains the universal path. */
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

  async function copyText(text: string, kind: 'command' | 'link') {
    if (!(await writeTextToClipboard(text))) return;
    setCopied(kind);
    window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => setCopied(null), 2000);
  }

  function shareSetup() {
    if (!canShare) return;
    /* Single `text` field is the most portable payload: the receiver gets
       both the command and the link regardless of which field the target
       app reads. AbortError (dismissed sheet) is expected — swallow it. */
    void navigator.share({ text: `${command}\n${linkUrl}` }).catch(() => {});
  }

  function shareDownload() {
    if (!canShare) return;
    /* A bare `url` renders as a rich link — AirDrop opens it straight in
       the receiving Mac's browser. Same AbortError contract as above. */
    void navigator.share({ url: linkUrl }).catch(() => {});
  }

  const nextSteps = [
    labels.nextStepMachine ?? '它会自动出现在当前 workspace。',
    labels.nextStepProject ?? '在「项目」里选择这台机器，添加一个文件夹。',
    labels.nextStepAgent ?? '在「设置 → Agents」中配置 Agent，即可下发第一个任务。',
  ];

  return (
    <div {...stylex.props(styles.onboardingRoot)}>
      <div {...stylex.props(styles.onboardingColumn)}>
        <div {...stylex.props(styles.onboardingHead)}>
          <div {...stylex.props(styles.onboardingGlyph)}>
            <MonitorSmartphone
              className={stylex.props(styles.icon6).className}
              strokeWidth={1.6}
              aria-hidden="true"
            />
          </div>
          <div {...stylex.props(styles.onboardingHeadStack)}>
            <p {...stylex.props(styles.onboardingTitle)}>{labels.title ?? '先连接一台机器'}</p>
            {labels.description ? (
              <p {...stylex.props(styles.onboardingBody)}>{labels.description}</p>
            ) : null}
          </div>
        </div>

        {/* Path 1 — one command on any machine. The command is the most
            transferable artifact a phone can hand to a terminal: type it,
            paste it into an SSH client, or share it to the computer. */}
        <section {...stylex.props(styles.onboardingCard)}>
          <div {...stylex.props(styles.onboardingCardHead)}>
            <Terminal
              className={stylex.props(styles.icon4ShrinkMuted).className}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <p {...stylex.props(styles.onboardingCardTitle)}>
              {labels.commandHeading ?? '一行命令，接入任意机器'}
            </p>
          </div>
          <div {...stylex.props(styles.onboardingCardActions)}>
            <OnboardingArtifactPill
              display={command}
              ariaLabel={`${copyLabel}: ${command}`}
              isCopied={copied === 'command'}
              onCopy={() => void copyText(command, 'command')}
            />
            {canShare ? (
              <OnboardingShareButton
                label={labels.shareCommandLabel ?? '分享到电脑'}
                onShare={shareSetup}
              />
            ) : null}
          </div>
          <p {...stylex.props(styles.onboardingCardHint)}>
            {labels.commandHint ??
              '在服务器、虚拟机或你的电脑上运行（需 Node.js 22.23.4+（22.x）、24.22.1+（24.x）或 26.12.1+（26.x））。命令会发起登录；没有浏览器的机器会打印链接，用这台手机打开即可完成授权。'}
          </p>
        </section>

        {/* Path 2 — the desktop app: friendlier on a personal computer and
            needs no Node.js; signing in starts the bundled runtime. The share
            sheet is the whole interaction — a URL wants a browser, and
            AirDrop lands it there; no need to display the link itself. Only
            when `navigator.share` is missing does the type/copy pill appear
            as the fallback path. The phone never opens the page itself. */}
        <section {...stylex.props(styles.onboardingCard)}>
          <div {...stylex.props(styles.onboardingCardHead)}>
            <MonitorDown
              className={stylex.props(styles.icon4ShrinkMuted).className}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <p {...stylex.props(styles.onboardingCardTitle)}>
              {labels.desktopHeading ?? '或者在电脑上装桌面端'}
            </p>
          </div>
          {canShare ? (
            <div {...stylex.props(styles.onboardingCardActions)}>
              <button
                type="button"
                onClick={shareDownload}
                aria-label={labels.shareDownloadLabel ?? '发送到电脑'}
                {...stylex.props(styles.onboardingShareButton, styles.onboardingShareButtonMotion)}
              >
                <Share2
                  className={stylex.props(styles.icon4Shrink).className}
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                {labels.shareDownloadLabel ?? '发送到电脑'}
              </button>
              {/* Trailing copy accelerator — same coupled layout as the
                  command pill's share button: primary action leads, the
                  quiet icon button is the fallback. */}
              <button
                type="button"
                onClick={() => void copyText(linkUrl, 'link')}
                aria-label={`${labels.copyDownloadLabel ?? '复制下载链接'}: ${linkUrl}`}
                title={labels.copyDownloadLabel ?? '复制下载链接'}
                data-copied={copied === 'link' ? 'true' : 'false'}
                {...stylex.props(styles.onboardingCopyButton, styles.onboardingCopyButtonMotion)}
              >
                <OnboardingCopiedIcon
                  isCopied={copied === 'link'}
                  className={stylex.props(styles.icon4).className ?? ''}
                  strokeWidth={1.8}
                />
              </button>
            </div>
          ) : (
            <div {...stylex.props(styles.onboardingCardActions)}>
              <OnboardingArtifactPill
                display={linkDisplay}
                ariaLabel={`${labels.copyDownloadLabel ?? '复制下载链接'}: ${linkUrl}`}
                isCopied={copied === 'link'}
                onCopy={() => void copyText(linkUrl, 'link')}
              />
            </div>
          )}
          <p {...stylex.props(styles.onboardingCardHint)}>
            {labels.desktopHint ?? '安装桌面端并登录，它会自动启动 Agent 运行环境。'}
          </p>
        </section>

        {/* What happens after the machine connects — so the user knows the
            flow continues on this phone. */}
        <section {...stylex.props(styles.onboardingSteps)}>
          <p {...stylex.props(styles.onboardingStepsHeading)}>
            {labels.nextStepsHeading ?? '机器上线之后'}
          </p>
          <ol {...stylex.props(styles.onboardingStepList)}>
            {nextSteps.map((step, index) => (
              <li key={index} {...stylex.props(styles.onboardingStep)}>
                <span {...stylex.props(styles.onboardingStepNumber)}>{index + 1}</span>
                <span {...stylex.props(styles.onboardingStepText)}>{step}</span>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </div>
  );
}

/* The mono artifact pill is the guide's central element: it displays text
   the user can simply TYPE on the other device (the command, the download
   URL), so walking to the computer and typing it is the baseline path.
   Tapping copies as a convenience — copy is the accelerator, not the
   interaction model. */
/* Copy feedback icon: Copy ↔ Check crossfades — the outgoing icon blurs and
   shrinks out while the incoming one blurs in, so the eye reads one smooth
   morph instead of two objects swapping. `popLayout` pops the exiting icon
   out of flow so the swap never shifts layout. First mount renders idle
   instantly; prefers-reduced-motion skips the animation entirely. */
function OnboardingCopiedIcon({
  isCopied,
  className,
  strokeWidth,
}: {
  isCopied: boolean;
  className: string;
  strokeWidth: number;
}) {
  const reduceMotion = useReducedMotion();
  const icon = isCopied ? (
    <Check className={className} strokeWidth={strokeWidth} aria-hidden="true" />
  ) : (
    <Copy className={className} strokeWidth={strokeWidth} aria-hidden="true" />
  );
  if (reduceMotion) {
    return <span {...stylex.props(styles.onboardingInlineIcon)}>{icon}</span>;
  }
  return (
    <AnimatePresence mode="popLayout" initial={false}>
      <motion.span
        key={isCopied ? 'copied' : 'idle'}
        {...stylex.props(styles.onboardingInlineIcon)}
        initial={{ opacity: 0, scale: 0.7, filter: 'blur(2px)' }}
        animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
        exit={{ opacity: 0, scale: 0.7, filter: 'blur(2px)' }}
        transition={{ duration: 0.18, ease: 'easeOut' }}
      >
        {icon}
      </motion.span>
    </AnimatePresence>
  );
}

function OnboardingArtifactPill({
  display,
  ariaLabel,
  isCopied,
  onCopy,
}: {
  display: string;
  ariaLabel: string;
  isCopied: boolean;
  onCopy: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={ariaLabel}
      data-copied={isCopied ? 'true' : 'false'}
      {...stylex.props(styles.onboardingArtifactPill, styles.onboardingArtifactPillMotion)}
    >
      <code {...stylex.props(styles.onboardingArtifactCode)}>{display}</code>
      <span {...stylex.props(styles.onboardingArtifactTrailing)}>
        <OnboardingCopiedIcon
          isCopied={isCopied}
          className={stylex.props(styles.icon35).className ?? ''}
          strokeWidth={2}
        />
      </span>
    </button>
  );
}

/* Icon-only share affordance pinned to the artifact pill's trailing edge —
   "this thing → send it". Quiet secondary styling: the typeable pill stays
   the primary instruction, share is just the accelerator. Label is carried
   by aria-label/title only, so it adds no visual weight. */
function OnboardingShareButton({ label, onShare }: { label: string; onShare: () => void }) {
  return (
    <button
      type="button"
      onClick={onShare}
      aria-label={label}
      title={label}
      {...stylex.props(styles.onboardingShareIconButton, styles.onboardingShareIconButtonMotion)}
    >
      <Share2
        className={stylex.props(styles.icon4).className}
        strokeWidth={1.8}
        aria-hidden="true"
      />
    </button>
  );
}

function TabEmptyState({ label, action }: { label: ReactNode; action?: ReactNode }) {
  return (
    <div {...stylex.props(styles.tabEmptyState)}>
      <div>{label}</div>
      {action ? <div {...stylex.props(styles.tabEmptyAction)}>{action}</div> : null}
    </div>
  );
}

/* Pill button shown inside an empty state (e.g. "Clear filters"). Quiet
   secondary styling so it reads as a recovery action, not a primary CTA. */
function TabEmptyStateButton({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button type="button" onClick={onClick} {...stylex.props(styles.tabEmptyButton)}>
      <X className={stylex.props(styles.icon35).className} strokeWidth={2} aria-hidden="true" />
      {children}
    </button>
  );
}
