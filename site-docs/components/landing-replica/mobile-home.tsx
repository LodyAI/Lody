/**
 * Display-only replica of `mobile/mobile-home-screen.tsx` on the path the
 * landing shows: theme `ios`, Chat tab, `chatGroupBy="none"`, online, no
 * search query, filter bar collapsed, nothing pinned, no archive/settings
 * header actions, dock expanded. Rows follow `ConversationRow` in
 * `mobile/mobile-project-screen.tsx`; the dock follows
 * `mobile/mobile-workspace-tabbar.tsx`.
 */

import type { SVGProps } from 'react';
import {
  Folders,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hand,
  Loader2,
  MessageCircle,
  PencilLine,
  Search,
} from 'lucide-react';
import { cn } from './utils';
import { WorktreeIcon } from './icons';
import { MOBILE_LABELS, type ReplicaMobileChat } from './mobile';
import type { ReplicaLocale, ReplicaPrStatus } from './types';

/** Carbon "settings adjust" glyph on the chat-list filter chip. */
function CarbonSettingsAdjust(props: SVGProps<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="1em" height="1em" viewBox="0 0 32 32" {...props}>
      <path
        fill="currentColor"
        d="M30 8h-4.1c-.5-2.3-2.5-4-4.9-4s-4.4 1.7-4.9 4H2v2h14.1c.5 2.3 2.5 4 4.9 4s4.4-1.7 4.9-4H30zm-9 4c-1.7 0-3-1.3-3-3s1.3-3 3-3s3 1.3 3 3s-1.3 3-3 3M2 24h4.1c.5 2.3 2.5 4 4.9 4s4.4-1.7 4.9-4H30v-2H15.9c-.5-2.3-2.5-4-4.9-4s-4.4 1.7-4.9 4H2zm9-4c1.7 0 3 1.3 3 3s-1.3 3-3 3s-3-1.3-3-3s1.3-3 3-3"
      />
    </svg>
  );
}

// `text-pr-merged` in the app resolves to --github-merged.
const PR_ICON: Record<ReplicaPrStatus, { icon: typeof GitPullRequest; className: string }> = {
  open: { icon: GitPullRequest, className: 'text-github-open' },
  merged: { icon: GitMerge, className: 'text-github-merged' },
  closed: { icon: GitPullRequestClosed, className: 'text-github-closed' },
  draft: { icon: GitPullRequestDraft, className: 'text-github-draft' },
};

function StatusIndicator({ chat }: { chat: ReplicaMobileChat }) {
  if (chat.isWaitingPermission) {
    return (
      <Hand className="h-4 w-4 shrink-0 text-status-warning" aria-label="waiting permission" />
    );
  }
  if (chat.isWorking) {
    return (
      <span
        className="inline-flex h-4 w-4 shrink-0 animate-spin items-center justify-center text-primary will-change-transform"
        aria-label="running"
      >
        <Loader2 className="size-full" aria-hidden="true" />
      </span>
    );
  }
  if (chat.hasUnreadMessages) {
    return (
      <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" />
    );
  }
  return null;
}

function ConversationRow({ chat }: { chat: ReplicaMobileChat }) {
  const hasChanges =
    typeof chat.addedLines === 'number' &&
    typeof chat.deletedLines === 'number' &&
    (chat.addedLines > 0 || chat.deletedLines > 0);
  const showPr = typeof chat.prNumber === 'number' && chat.prNumber > 0;
  const pr = PR_ICON[chat.prStatus ?? 'open'];
  const PrIcon = pr.icon;
  return (
    <button
      type="button"
      aria-pressed={false}
      className="mobile-project-conversation-row relative flex min-h-11 w-full items-center gap-2.5 border-0 bg-background px-4 py-2.5 text-left shadow-none outline-none transition-colors"
    >
      <div
        data-conversation-row-leading-slot=""
        className="flex h-4 w-4 shrink-0 items-center justify-center"
      >
        <StatusIndicator chat={chat} />
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[15px] font-medium leading-snug tracking-[-0.01em] text-foreground">
          {chat.title}
        </span>
      </div>
      {hasChanges ? (
        <span className="shrink-0 text-[11px] tabular-nums leading-none tracking-tight">
          <span className="text-github-addition">+{chat.addedLines}</span>
          <span className="ms-1 text-github-deletion">-{chat.deletedLines}</span>
        </span>
      ) : null}
      {chat.isWorktree ? (
        <WorktreeIcon
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/55"
          aria-label="Worktree"
        />
      ) : null}
      {showPr ? (
        <PrIcon
          className={cn('h-3.5 w-3.5 shrink-0', pr.className)}
          strokeWidth={2.25}
          aria-hidden="true"
        />
      ) : null}
    </button>
  );
}

/* Home caps each bucket at 5 rows behind a "Show all" toggle; the landing
   never overflows it, so the toggle is not replicated. */
const MOBILE_CHAT_PREVIEW_MAX_ROOTS = 5;

export function ReplicaMobileHomeScreen({
  locale,
  chats,
  workspaceName,
  workspaceAvatarUrl,
}: {
  locale: ReplicaLocale;
  /** Newest first; one flat list, capped at 5 rows like the app's preview. */
  chats: ReplicaMobileChat[];
  workspaceName: string;
  workspaceAvatarUrl: string;
}) {
  const labels = MOBILE_LABELS[locale];
  return (
    <div className="mobile-home-app safe-areas relative h-full min-h-0 w-full text-foreground">
      <div className="mobile-home-shell relative flex h-full w-full flex-col bg-background">
        <header className="mobile-home-glass relative z-30 pt-safe-2 pb-2 ps-safe-3 pe-safe-3">
          <div className="relative flex h-9 w-full items-center gap-2">
            <div className="relative z-10 flex shrink-0 items-center justify-start">
              <div
                className="flex h-9 w-9 items-center justify-center rounded-full border border-border/50 bg-muted text-foreground dark:border-white/12 dark:bg-white/10"
                data-workspace-identity
              >
                <span className="relative flex h-7 w-7 shrink-0 overflow-hidden rounded-full text-[0.72rem]">
                  <img
                    src={workspaceAvatarUrl}
                    alt={workspaceName}
                    className="aspect-square size-full"
                  />
                </span>
              </div>
            </div>

            <div className="relative z-10 h-9 min-w-0 flex-1 translate-y-0 opacity-100 transition-[opacity,transform] duration-150 ease-out">
              <label
                className={cn(
                  'mobile-home-header-search flex h-9 w-full min-w-0 items-center gap-1.5 rounded-full border border-border/50 bg-muted px-3 text-foreground',
                  'dark:border-white/12 dark:bg-white/10'
                )}
              >
                <Search
                  className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
                  strokeWidth={1.8}
                  aria-hidden="true"
                />
                <input
                  type="search"
                  readOnly
                  tabIndex={-1}
                  value=""
                  placeholder={labels.searchConversations}
                  aria-label={labels.search}
                  className="min-w-0 flex-1 border-none bg-transparent text-[0.82rem] outline-none placeholder:text-muted-foreground"
                />
              </label>
            </div>

            <div className="relative z-10 flex shrink-0 items-center justify-end gap-2" />
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col">
            <div
              data-mobile-session-list-scroll-region=""
              className={cn(
                'mobile-home-list-region relative z-0 min-h-0 flex-1 overflow-y-auto pt-1 [scrollbar-gutter:auto]',
                'pb-[calc(var(--mobile-tabbar-height)+var(--k-safe-area-bottom,0px)+1rem)]'
              )}
            >
              <section aria-label={labels.chatTab} className="flex flex-col">
                <div className="flex w-full items-center justify-end pb-1.5 pe-4 ps-[18px] pt-2">
                  <button
                    type="button"
                    aria-label={labels.filters}
                    aria-pressed={false}
                    className={cn(
                      'relative inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border',
                      'border-border/50 bg-muted text-muted-foreground',
                      'dark:border-white/12 dark:bg-white/10'
                    )}
                  >
                    <CarbonSettingsAdjust className="h-4 w-4 text-current" aria-hidden="true" />
                  </button>
                </div>
                {chats.slice(0, MOBILE_CHAT_PREVIEW_MAX_ROOTS).map((chat) => (
                  <div key={chat.id} className="overflow-hidden bg-background">
                    <ConversationRow chat={chat} />
                  </div>
                ))}
              </section>
            </div>
          </div>
        </div>

        <div className="mobile-workspace-dock fixed bottom-0 left-0 right-0 z-30 flex items-end justify-between gap-3 px-4 pb-[calc(0.5rem+var(--k-safe-area-bottom,0px))] pt-2">
          <div
            role="tablist"
            aria-label={labels.chatTab}
            className="mobile-workspace-tab-pill mobile-tabbar-glass relative flex h-14 min-w-0 flex-1 items-center justify-around gap-1 rounded-full px-2 py-1.5 text-foreground"
          >
            <button
              type="button"
              role="tab"
              aria-selected
              className="mobile-workspace-tab relative isolate inline-flex h-full flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-2 py-1 text-[0.72rem] font-medium text-primary transition-colors"
            >
              <span
                aria-hidden="true"
                className="absolute inset-0 z-0 rounded-full bg-primary/20 dark:bg-primary/25"
              />
              <span className="relative z-10 inline-flex size-6 shrink-0 items-center justify-center [&>svg]:h-6 [&>svg]:w-6">
                <MessageCircle className="h-6 w-6" strokeWidth={1.75} />
              </span>
              <span className="relative z-10 leading-none">{labels.chatTab}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              className="mobile-workspace-tab relative isolate inline-flex h-full flex-1 flex-col items-center justify-center gap-0.5 rounded-full px-2 py-1 text-[0.72rem] font-medium text-muted-foreground transition-colors"
            >
              <span className="relative z-10 inline-flex size-6 shrink-0 items-center justify-center [&>svg]:h-6 [&>svg]:w-6">
                <Folders className="h-6 w-6" strokeWidth={1.75} />
              </span>
              <span className="relative z-10 leading-none">{labels.projectsTab}</span>
            </button>
          </div>
          <button
            type="button"
            aria-label={labels.newChat}
            className={cn(
              'mobile-workspace-new-chat inline-flex h-14 w-14 shrink-0 items-center justify-center rounded-full',
              'bg-foreground text-background',
              'shadow-[0_6px_20px_-6px_rgba(0,0,0,0.28),0_2px_8px_-2px_rgba(0,0,0,0.16)]',
              'dark:shadow-[0_8px_24px_-6px_rgba(0,0,0,0.55)]'
            )}
          >
            <PencilLine className="h-6 w-6" strokeWidth={1.85} aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  );
}
