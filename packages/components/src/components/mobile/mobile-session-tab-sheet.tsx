import { useState, type ReactNode } from 'react';
import {
  ArchiveRestore,
  ChevronDown,
  File as FileIcon,
  FileDiff,
  FolderOpen,
  GitPullRequest,
  Hand,
  MonitorPlay,
  Plus,
  Smartphone,
  Undo2,
  X,
} from 'lucide-react';
import { Spinner } from '@lody/ui/spinner';
import { Badge } from '@lody/ui/badge';
import { useTranslation } from 'react-i18next';
import { getServerNow } from '@lody/shared';
import * as stylex from '@stylexjs/stylex';

import { ChatsIcon } from '@/components/icons/chats-icon';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
import { withClassName } from '@/lib/stylex';
import { themeColors } from '../../style/theme-colors.stylex';
import {
  themeFontSize,
  themeFontWeight,
  themeLineHeight,
  themeSpace,
} from '../../style/theme-scale.stylex';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';
import { sheetSurface } from './sheet-surface';

/**
 * Bottom sheet that replaces the mobile `SessionTabBar`. Opened by the header
 * 💬 button, it lists every tab of the current session grouped into
 * Conversations (parent + thread + draft tabs, plus "New Chat") and Viewers
 * (open file/diff tabs + Files / PR / Browser entries), and lets the user switch
 * to one.
 *
 * Each conversation row reads `[status] title elapsed`: the status slot is a
 * warning-tone hand while the conversation is blocked on a permission request,
 * else a spinner while working, else an unread accent dot, else empty; elapsed
 * is the relative "Xm ago" of the last activity (task-list style). The
 * component is pure — the caller resolves
 * waitingPermission/running/unread/active/lastActivityAt (see
 * `session-detail.tsx` wiring) so the sheet stays trivially story-able.
 */
export type ConversationTabEntry = {
  id: string;
  title: string;
  active: boolean;
  /** The session's main thread — pinned first, marked with a "Main" chip. */
  main?: boolean;
  /** Working → spinner. A permission request also counts as working. */
  running: boolean;
  /**
   * Blocked on a permission request → hand, outranking the spinner. A child
   * (subagent) tab is the case this exists for: it is the only place its
   * "needs you" state surfaces while another tab is on screen.
   */
  waitingPermission?: boolean;
  /** Unread messages → accent dot. */
  unread: boolean;
  /** Last activity timestamp (ms) for the trailing relative time; null hides it. */
  lastActivityAt: number | null;
};

/** Closed conversation, shown behind a collapsed disclosure row. */
export type ArchivedConversationEntry = {
  id: string;
  title: string;
  lastActivityAt: number | null;
  running?: boolean;
  waitingPermission?: boolean;
  unread?: boolean;
  /** An archived child of a live workspace: tapping restores it instead of reopening. */
  restoresArchive?: boolean;
};

export type ViewerTabEntry = {
  id: string;
  label: string;
  kind: 'file' | 'diff' | 'pr' | 'browser' | 'ios-simulator' | 'files';
  active: boolean;
};

export type MobileSessionTabSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: ConversationTabEntry[];
  /** Sorted by the caller (most recent first). Empty → no archived section. */
  archivedConversations?: ArchivedConversationEntry[];
  viewers: ViewerTabEntry[];
  onSelectConversation: (id: string) => void;
  /** Omitted for a review-only (archived) workspace: no New Chat row. */
  onNewConversation?: () => void;
  onSelectViewer: (id: string) => void;
  /** Tapping a closed row reopens (or, for `restoresArchive`, restores) it and switches to it. */
  onRestoreConversation?: (id: string) => void;
  onCloseConversation?: (id: string) => void;
};

/** Relative "Xm ago" of the last activity, task-list style; '' when unknown. */
function formatRelativeTime(
  ms: number | null,
  t: (key: string, fallback: string, opts?: Record<string, unknown>) => string
): string {
  if (ms == null || !Number.isFinite(ms)) return '';
  const diffMs = Math.max(0, getServerNow() - ms);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return t('sessions.tabs.justNow', 'just now');
  if (minutes < 60) return t('sessions.tabs.minutesAgo', '{{count}}m ago', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('sessions.tabs.hoursAgo', '{{count}}h ago', { count: hours });
  const days = Math.floor(hours / 24);
  return t('sessions.tabs.daysAgo', '{{count}}d ago', { count: days });
}

/** Does any non-active conversation have unread messages? Drives the header dot. */
export function hasBackgroundUnread(conversations: ConversationTabEntry[]): boolean {
  return conversations.some((c) => !c.active && c.unread);
}

/** Is any non-active conversation running an agent? Drives the breathing badge. */
export function hasBackgroundWorking(conversations: ConversationTabEntry[]): boolean {
  return conversations.some((c) => !c.active && c.running);
}

const VIEWER_ICON: Record<ViewerTabEntry['kind'], typeof FileIcon> = {
  file: FileIcon,
  diff: FileDiff,
  pr: GitPullRequest,
  browser: MonitorPlay,
  'ios-simulator': Smartphone,
  files: FolderOpen,
};

/** Tailwind's `transition-colors`: colour properties only, 150ms, standard ease. */
const TRANSITION_COLORS = {
  transitionProperty: 'color, background-color, border-color, text-decoration-color, fill, stroke',
  transitionDuration: '150ms',
  transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
} as const;

const styles = stylex.create({
  /** A row's leading slot: one node, always the same width. */
  leadingSlot: {
    display: 'flex',
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  /** The wrapper a conversation row and its close chip share. */
  conversationLine: { display: 'flex', alignItems: 'center' },
  /** The column that holds the row button. */
  conversationBody: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
  },
  /** The chip that closes a conversation tab. */
  closeChip: {
    flexShrink: 0,
    padding: themeSpace[3],
    color: themeColors.mutedForeground,
  },

  /** A row that opens something else. */
  actionable: {
    backgroundColor: {
      default: null,
      '@media (hover: hover)': {
        ':hover': 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 5%, transparent)',
      },
    },
    ...TRANSITION_COLORS,
  },
  /** The row that starts a new conversation. */
  newChat: {
    fontWeight: themeFontWeight.medium,
    color: {
      default: themeColors.mutedForeground,
      '@media (hover: hover)': { ':hover': themeColors.foreground },
    },
    ...TRANSITION_COLORS,
  },
  /** The row that opens the closed-conversations list. */
  disclosure: {
    color: themeColors.mutedForeground,
    ...TRANSITION_COLORS,
  },
  /** A row that is the current one. */
  active: {
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 10%, transparent)',
  },
  /** A row's title and its badge. */
  titleLine: {
    display: 'flex',
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    alignItems: 'center',
    gap: themeSpace[1.5],
  },
  /** The title itself. */
  title: {
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  /** The title of the current row. */
  titleActive: {
    fontWeight: themeFontWeight.medium,
    color: themeColors.foreground,
  },
  /** The title of a row that is not current. */
  titleIdle: { color: 'color-mix(in oklab, hsl(var(--foreground) / 1) 90%, transparent)' },
  /** A title in the sheet's quiet ink. */
  titleQuiet: { color: themeColors.mutedForeground },

  /** The trailing "Xm ago". */
  elapsed: {
    flexShrink: 0,
    fontSize: themeFontSize.xs,
    lineHeight: themeLineHeight.xs,
    fontVariantNumeric: 'tabular-nums',
    color: themeColors.mutedForeground,
  },
  /** The trailing "Xm ago" of a closed conversation. */
  elapsedClosed: {
    color: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 70%, transparent)',
  },

  /** The glyph beside a closed conversation's title. */
  restoreGlyph: {
    width: themeSpace[3.5],
    height: themeSpace[3.5],
    flexShrink: 0,
    color: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 70%, transparent)',
  },
  /** The chevron of the closed-conversations disclosure. */
  disclosureChevron: {
    width: themeSpace[4],
    height: themeSpace[4],
    rotate: '0deg',
    transitionProperty: 'transform',
    transitionDuration: '150ms',
    transitionTimingFunction: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  disclosureChevronClosed: { rotate: '-90deg' },
  /** The disclosure's label. */
  disclosureLabel: {
    minWidth: 0,
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },

  /** The dot that says a conversation has unread messages. */
  unreadDot: {
    width: themeSpace[2],
    height: themeSpace[2],
    borderRadius: '9999px',
    backgroundColor: themeColors.primary,
  },
  /** The hand that says a conversation needs permission. */
  waitingGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    color: themeColors.statusWarning,
  },
  /** The spinner that says a conversation is working. */
  workingGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    color: themeColors.tabActiveAccent,
  },
  /** The glyph of a viewer row. */
  viewerGlyph: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    color: themeColors.mutedForeground,
  },

  /** The group heading above a card. */
  groupLabel: {
    paddingInline: themeSpace[3.5],
    paddingBottom: themeSpace[1.5],
    fontSize: '0.68rem',
    fontWeight: themeFontWeight.medium,
    letterSpacing: '0.025em',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground) / 1) 70%, transparent)',
  },

  groupLabelSpaced: { marginTop: themeSpace[4] },

  /** The header trigger's glyph. */
  triggerGlyph: {
    width: themeSpace[5],
    height: themeSpace[5],
    color: 'currentColor',
  },
  /** The badge that says background tabs are waiting. */
  triggerDot: {
    position: 'absolute',
    top: 'calc(var(--spacing) * -0.5)',
    right: 'calc(var(--spacing) * -0.5)',
    width: themeSpace[2],
    height: themeSpace[2],
    borderRadius: '9999px',
    backgroundColor: themeColors.primary,
    boxShadow: '0 0 0 2px hsl(var(--background))',
  },
  /** The frame that holds the breathing dot. */
  triggerFrame: {
    position: 'absolute',
    top: '-0.25rem',
    right: '-0.25rem',
    display: 'flex',
    width: themeSpace[3],
    height: themeSpace[3],
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '9999px',
    backgroundColor: themeColors.background,
  },
  /** The breathing dot itself. */
  triggerPulse: {
    width: themeSpace[2],
    height: themeSpace[2],
    borderRadius: '9999px',
  },
});

export function MobileSessionTabSheet({
  open,
  onOpenChange,
  conversations,
  archivedConversations = [],
  viewers,
  onSelectConversation,
  onNewConversation,
  onSelectViewer,
  onRestoreConversation,
  onCloseConversation,
}: MobileSessionTabSheetProps) {
  const { t } = useTranslation();
  const title = t('sessions.tabs.sheetTitle', 'Tabs');
  // Collapsed by default on every open (content unmounts with the drawer).
  const [archivedOpen, setArchivedOpen] = useState(false);
  const showArchived = archivedConversations.length > 0 && onRestoreConversation != null;

  const select = (fn: () => void) => {
    fn();
    onOpenChange(false);
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} repositionInputs={false}>
      <DrawerContent className="h-auto! max-h-[85dvh]! rounded-t-2xl border-border/60">
        <DrawerTitle {...stylex.props(sheetSurface.srOnly)}>{title}</DrawerTitle>
        <DrawerDescription {...stylex.props(sheetSurface.srOnly)}>{title}</DrawerDescription>
        <div {...stylex.props(sheetSurface.body)}>
          <GroupLabel>{t('sessions.tabs.conversationsGroup', 'Conversations')}</GroupLabel>
          <GroupCard>
            {conversations.map((c) => (
              <div key={c.id} {...stylex.props(styles.conversationLine, sheetSurface.cardChild)}>
                <div {...stylex.props(styles.conversationBody)}>
                  <ConversationRow
                    active={c.active}
                    running={c.running}
                    waitingPermission={c.waitingPermission === true}
                    unread={c.unread}
                    label={c.title || t('sessions.untitled', 'Untitled')}
                    mainChip={c.main ? t('sessions.tabs.mainTab', 'Main') : null}
                    elapsed={formatRelativeTime(c.lastActivityAt, t)}
                    unreadLabel={t('sessions.unreadMessages', 'Unread messages')}
                    waitingPermissionLabel={t(
                      'sessions.waitingPermission',
                      'Waiting for permission'
                    )}
                    onSelect={() => select(() => onSelectConversation(c.id))}
                  />
                </div>
                {onCloseConversation && (
                  <button
                    type="button"
                    {...stylex.props(styles.closeChip)}
                    aria-label={t('sessions.tabs.closeTab', 'Close tab')}
                    onClick={() => onCloseConversation(c.id)}
                  >
                    <X {...stylex.props(sheetSurface.glyph16)} />
                  </button>
                )}
              </div>
            ))}
            {onNewConversation ? (
              <button
                type="button"
                onClick={() => select(onNewConversation)}
                {...stylex.props(sheetSurface.cardRow, sheetSurface.cardRowText, styles.newChat)}
              >
                <span {...stylex.props(styles.leadingSlot)}>
                  <Plus
                    {...stylex.props(sheetSurface.glyph16)}
                    strokeWidth={1.8}
                    aria-hidden="true"
                  />
                </span>
                <span>{t('sessions.tabs.newChat', 'New Chat')}</span>
              </button>
            ) : null}
            {showArchived ? (
              <>
                <button
                  type="button"
                  onClick={() => setArchivedOpen((v) => !v)}
                  aria-expanded={archivedOpen}
                  {...stylex.props(
                    sheetSurface.cardRow,
                    sheetSurface.cardRowText,
                    styles.disclosure
                  )}
                >
                  <span {...stylex.props(styles.leadingSlot)}>
                    <ChevronDown
                      {...stylex.props(
                        styles.disclosureChevron,
                        !archivedOpen && styles.disclosureChevronClosed
                      )}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </span>
                  <span {...stylex.props(styles.disclosureLabel)}>
                    {t('sessions.tabs.closedCount', 'Closed ({{count}})', {
                      count: archivedConversations.length,
                    })}
                  </span>
                </button>
                {archivedOpen
                  ? archivedConversations.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() => select(() => onRestoreConversation(a.id))}
                        aria-label={
                          a.restoresArchive
                            ? t('archive.restore', 'Restore session')
                            : t('sessions.tabs.reopenTab', 'Reopen conversation')
                        }
                        {...stylex.props(
                          sheetSurface.cardRow,
                          sheetSurface.cardRowText,
                          styles.actionable
                        )}
                      >
                        <span {...stylex.props(styles.leadingSlot)}>
                          {a.waitingPermission ? (
                            <Hand
                              {...stylex.props(styles.waitingGlyph)}
                              aria-label={t('sessions.waitingPermission', 'Waiting for permission')}
                            />
                          ) : a.running ? (
                            <Spinner {...stylex.props(sheetSurface.glyph16)} />
                          ) : a.unread ? (
                            <span
                              {...stylex.props(styles.unreadDot)}
                              aria-label={t('sessions.unreadMessages', 'Unread messages')}
                            />
                          ) : null}
                        </span>
                        <span {...stylex.props(styles.title, styles.titleQuiet)}>
                          {a.title || t('sessions.untitled', 'Untitled')}
                        </span>
                        <span {...stylex.props(styles.elapsed, styles.elapsedClosed)}>
                          {formatRelativeTime(a.lastActivityAt, t)}
                        </span>
                        {a.restoresArchive ? (
                          <ArchiveRestore
                            {...stylex.props(styles.restoreGlyph)}
                            strokeWidth={1.8}
                            aria-hidden="true"
                          />
                        ) : (
                          <Undo2
                            {...stylex.props(styles.restoreGlyph)}
                            strokeWidth={1.8}
                            aria-hidden="true"
                          />
                        )}
                      </button>
                    ))
                  : null}
              </>
            ) : null}
          </GroupCard>

          {viewers.length > 0 ? (
            <>
              <GroupLabel spaced>{t('sessions.tabs.viewersGroup', 'Viewers')}</GroupLabel>
              <GroupCard>
                {viewers.map((v) => {
                  const Icon = VIEWER_ICON[v.kind];
                  return (
                    <ViewerRow
                      key={v.id}
                      active={v.active}
                      onSelect={() => select(() => onSelectViewer(v.id))}
                      leading={
                        <Icon
                          {...stylex.props(styles.viewerGlyph)}
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      }
                      label={v.label}
                    />
                  );
                })}
              </GroupCard>
            </>
          ) : null}
        </div>
      </DrawerContent>
    </Drawer>
  );
}

/** Card wrapper matching the menu sheet's info block (hairline row dividers). */
function GroupCard({ children }: { children: ReactNode }) {
  return <div {...stylex.props(sheetSurface.card)}>{children}</div>;
}

/** `[status] title elapsed` row for a conversation tab (no close affordance). */
function ConversationRow({
  active,
  running,
  waitingPermission,
  unread,
  label,
  mainChip,
  elapsed,
  unreadLabel,
  waitingPermissionLabel,
  onSelect,
}: {
  active: boolean;
  running: boolean;
  waitingPermission: boolean;
  unread: boolean;
  label: string;
  /** Localized "Main" badge text; null hides the chip. */
  mainChip?: string | null;
  elapsed: string;
  unreadLabel: string;
  waitingPermissionLabel: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active}
      {...stylex.props(
        sheetSurface.cardRow,
        sheetSurface.cardRowText,
        active ? styles.active : styles.actionable
      )}
    >
      <span {...stylex.props(styles.leadingSlot)}>
        {/* Precedence matches the mobile project screen and the desktop sidebar:
            "this tab needs you" beats "this tab is busy" beats "unread". */}
        {waitingPermission ? (
          <Hand {...stylex.props(styles.waitingGlyph)} aria-label={waitingPermissionLabel} />
        ) : running ? (
          <Spinner {...stylex.props(styles.workingGlyph)} aria-hidden="true" />
        ) : unread ? (
          <span {...stylex.props(styles.unreadDot)} aria-label={unreadLabel} />
        ) : null}
      </span>
      <span {...stylex.props(styles.titleLine)}>
        <span {...stylex.props(styles.title, active ? styles.titleActive : styles.titleIdle)}>
          {label}
        </span>
        {mainChip ? <Badge>{mainChip}</Badge> : null}
      </span>
      {elapsed ? <span {...stylex.props(styles.elapsed)}>{elapsed}</span> : null}
    </button>
  );
}

function GroupLabel({ children, spaced = false }: { children: ReactNode; spaced?: boolean }) {
  return (
    <div {...stylex.props(styles.groupLabel, spaced && styles.groupLabelSpaced)}>{children}</div>
  );
}

/** Viewer row (file/diff/PR/browser): icon + label, active highlight, no close. */
function ViewerRow({
  active,
  leading,
  label,
  onSelect,
}: {
  active: boolean;
  leading: ReactNode;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active}
      {...stylex.props(
        sheetSurface.cardRow,
        sheetSurface.cardRowText,
        active ? styles.active : styles.actionable
      )}
    >
      {leading}
      <span {...stylex.props(styles.title, active ? styles.titleActive : styles.titleIdle)}>
        {label}
      </span>
    </button>
  );
}

/**
 * Header trigger button — glass 💬 with a corner badge for background tabs.
 *
 * The badge is a single aggregate signal with precedence, since one dot can't
 * express two things across many tabs:
 *   - unread wins → solid `bg-primary` dot (finished output waiting to be seen,
 *     the more actionable state);
 *   - else working → hollow ring with a slow opacity "breathe" (a background
 *     agent is still running — ambient, nothing to do yet).
 * Shape (solid vs ring) carries the distinction so it survives reduced-motion.
 *
 * There is deliberately no third "waiting for approval" state here: a dot can
 * only differ by color, and `--status-warning` resolves to `--primary` in
 * VS Code-derived themes, so it would be the unread dot. The waiting hand lives
 * in the sheet rows, where a glyph has room to be a glyph.
 */
export function MobileSessionTabButton({
  hasUnread,
  hasWorking = false,
  onOpen,
  className,
  ariaLabel,
}: {
  hasUnread: boolean;
  hasWorking?: boolean;
  onOpen: () => void;
  className?: string;
  ariaLabel?: string;
}) {
  const { t } = useTranslation();
  const badge = hasUnread ? 'unread' : hasWorking ? 'working' : 'none';
  return (
    <GlassIconButton
      label={ariaLabel ?? t('sessions.tabs.label', 'Session tabs')}
      onClick={onOpen}
      className={className}
    >
      <ChatsIcon {...stylex.props(styles.triggerGlyph)} aria-hidden="true" />
      {badge === 'unread' ? (
        <span {...stylex.props(styles.triggerDot)} />
      ) : badge === 'working' ? (
        // Fixed dark frame (bg-background disc); only the inner gradient dot pulses.
        <span {...stylex.props(styles.triggerFrame)}>
          <span
            {...withClassName(stylex.props(styles.triggerPulse), 'animate-badge-pulse')}
            style={{
              backgroundImage:
                'linear-gradient(135deg, color-mix(in oklch, hsl(var(--primary)) 55%, white), hsl(var(--primary)))',
            }}
          />
        </span>
      ) : null}
    </GlassIconButton>
  );
}
