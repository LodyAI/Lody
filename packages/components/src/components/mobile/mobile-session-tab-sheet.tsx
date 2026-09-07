import { useState, type ReactNode } from 'react';
import {
  ChevronDown,
  File as FileIcon,
  FileDiff,
  FolderOpen,
  GitPullRequest,
  Hand,
  Loader2,
  MonitorPlay,
  Plus,
  Undo2,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getServerNow } from '@lody/shared';

import { ChatsIcon } from '@/components/icons/chats-icon';
import { GlassIconButton } from '@/components/mobile/glass-icon-button';
import { cn } from '@/lib/utils';
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from '@/ui/drawer';

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

/** Archived child conversation, shown behind a collapsed disclosure row. */
export type ArchivedConversationEntry = {
  id: string;
  title: string;
  lastActivityAt: number | null;
};

export type ViewerTabEntry = {
  id: string;
  label: string;
  kind: 'file' | 'diff' | 'pr' | 'browser' | 'files';
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
  onNewConversation: () => void;
  onSelectViewer: (id: string) => void;
  /** Tapping an archived row restores it (and switches to it). */
  onRestoreConversation?: (id: string) => void;
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
  files: FolderOpen,
};

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
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        <DrawerDescription className="sr-only">{title}</DrawerDescription>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-[calc(16px+var(--safe-area-bottom,0px))] pt-3">
          <GroupLabel>{t('sessions.tabs.conversationsGroup', 'Conversations')}</GroupLabel>
          <GroupCard>
            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                active={c.active}
                running={c.running}
                waitingPermission={c.waitingPermission === true}
                unread={c.unread}
                label={c.title || t('sessions.untitled', 'Untitled')}
                mainChip={c.main ? t('sessions.tabs.mainTab', 'Main') : null}
                elapsed={formatRelativeTime(c.lastActivityAt, t)}
                unreadLabel={t('sessions.unreadMessages', 'Unread messages')}
                waitingPermissionLabel={t('sessions.waitingPermission', 'Waiting for permission')}
                onSelect={() => select(() => onSelectConversation(c.id))}
              />
            ))}
            <button
              type="button"
              onClick={() => select(onNewConversation)}
              className={cn(
                rowClassName,
                'font-medium text-muted-foreground transition-colors hover:text-foreground'
              )}
            >
              <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                <Plus className="h-4 w-4" strokeWidth={1.8} aria-hidden="true" />
              </span>
              <span>{t('sessions.tabs.newChat', 'New Chat')}</span>
            </button>
            {showArchived ? (
              <>
                <button
                  type="button"
                  onClick={() => setArchivedOpen((v) => !v)}
                  aria-expanded={archivedOpen}
                  className={cn(rowClassName, 'text-muted-foreground transition-colors')}
                >
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center">
                    <ChevronDown
                      className={cn(
                        'h-4 w-4 transition-transform',
                        archivedOpen ? '' : '-rotate-90'
                      )}
                      strokeWidth={1.8}
                      aria-hidden="true"
                    />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {t('sessions.tabs.archivedCount', 'Archived ({{count}})', {
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
                        aria-label={t('sessions.tabs.restoreTab', 'Restore tab')}
                        className={cn(
                          rowClassName,
                          'transition-colors hover:bg-muted-foreground/5'
                        )}
                      >
                        <span className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {a.title || t('sessions.untitled', 'Untitled')}
                        </span>
                        <span className="shrink-0 text-xs tabular-nums text-muted-foreground/70">
                          {formatRelativeTime(a.lastActivityAt, t)}
                        </span>
                        <Undo2
                          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
                          strokeWidth={1.8}
                          aria-hidden="true"
                        />
                      </button>
                    ))
                  : null}
              </>
            ) : null}
          </GroupCard>

          {viewers.length > 0 ? (
            <>
              <GroupLabel className="mt-4">{t('sessions.tabs.viewersGroup', 'Viewers')}</GroupLabel>
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
                          className="h-4 w-4 shrink-0 text-muted-foreground"
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

/** Shared row shell: fixed leading slot keeps titles aligned across rows. */
const rowClassName =
  'flex w-full select-none items-center gap-3 px-3.5 py-2.5 text-left text-sm first:rounded-t-xl last:rounded-b-xl';

/** Card wrapper matching the menu sheet's info block (hairline row dividers). */
function GroupCard({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col divide-y divide-border/40 rounded-xl bg-card ring-1 ring-border/60">
      {children}
    </div>
  );
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
      className={cn(
        rowClassName,
        'transition-colors',
        // NB: bg-muted ≈ the sheet background in the dark theme, so the active
        // tint uses muted-foreground alpha to stay visible on the card.
        active ? 'bg-muted-foreground/10' : 'hover:bg-muted-foreground/5'
      )}
    >
      <span className="flex h-4 w-4 shrink-0 items-center justify-center">
        {/* Precedence matches the mobile project screen and the desktop sidebar:
            "this tab needs you" beats "this tab is busy" beats "unread". */}
        {waitingPermission ? (
          <Hand className="h-4 w-4 text-status-warning" aria-label={waitingPermissionLabel} />
        ) : running ? (
          <Loader2 className="h-4 w-4 animate-spin text-tab-active-accent" aria-hidden="true" />
        ) : unread ? (
          <span className="h-2 w-2 rounded-full bg-primary" aria-label={unreadLabel} />
        ) : null}
      </span>
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span
          className={cn(
            'min-w-0 truncate',
            active ? 'font-medium text-foreground' : 'text-foreground/90'
          )}
        >
          {label}
        </span>
        {mainChip ? (
          <span className="shrink-0 rounded border border-border/70 px-1 py-px text-[0.62rem] font-medium leading-none text-muted-foreground">
            {mainChip}
          </span>
        ) : null}
      </span>
      {elapsed ? (
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{elapsed}</span>
      ) : null}
    </button>
  );
}

function GroupLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'px-3.5 pb-1.5 text-[0.68rem] font-medium tracking-wide text-muted-foreground/70',
        className
      )}
    >
      {children}
    </div>
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
      className={cn(
        rowClassName,
        'transition-colors',
        active ? 'bg-muted-foreground/10' : 'hover:bg-muted-foreground/5'
      )}
    >
      {leading}
      <span
        className={cn(
          'min-w-0 flex-1 truncate',
          active ? 'font-medium text-foreground' : 'text-foreground/90'
        )}
      >
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
      <ChatsIcon className="h-5 w-5 text-current" aria-hidden="true" />
      {badge === 'unread' ? (
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-primary ring-2 ring-background" />
      ) : badge === 'working' ? (
        // Fixed dark frame (bg-background disc); only the inner gradient dot pulses.
        <span className="absolute -right-1 -top-1 flex h-3 w-3 items-center justify-center rounded-full bg-background">
          <span
            className="h-2 w-2 rounded-full animate-badge-pulse"
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
