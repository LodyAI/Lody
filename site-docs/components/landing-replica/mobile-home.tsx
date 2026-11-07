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
import * as stylex from '@stylexjs/stylex';
import { WorktreeIcon } from './icons';
import { MOBILE_LABELS, type ReplicaMobileChat } from './mobile';
import type { ReplicaLocale, ReplicaPrStatus } from './types';

const spin = stylex.keyframes({ to: { transform: 'rotate(360deg)' } });

const styles = stylex.create({
  waitingGlyph: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    color: 'hsl(var(--status-warning))',
  },
  workingStatus: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    animationName: spin,
    animationTimingFunction: 'linear',
    animationDuration: '1s',
    animationIterationCount: 'infinite',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'hsl(var(--primary))',
    willChange: 'transform',
  },
  workingGlyph: {
    width: '100%',
    height: '100%',
  },
  unreadStatus: {
    display: 'inline-block',
    height: 'calc(var(--spacing) * 2)',
    width: 'calc(var(--spacing) * 2)',
    flexShrink: 0,
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'hsl(var(--primary))',
  },
  conversationRow: {
    position: 'relative',
    display: 'flex',
    minHeight: 'calc(var(--spacing) * 11)',
    width: '100%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2.5)',
    borderWidth: 0,
    backgroundColor: 'hsl(var(--background))',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBlock: 'calc(var(--spacing) * 2.5)',
    textAlign: 'left',
    boxShadow: 'none',
    outlineStyle: 'none',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
  },
  statusSlot: {
    display: 'flex',
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  titleSlot: {
    display: 'flex',
    minWidth: 0,
    flex: '1',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
  conversationTitle: {
    minWidth: 0,
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '15px',
    fontWeight: 'var(--font-weight-medium)',
    lineHeight: '1.375',
    letterSpacing: '-0.01em',
    color: 'hsl(var(--foreground))',
  },
  diffStats: {
    flexShrink: 0,
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: '1',
    letterSpacing: '-0.025em',
  },
  additions: {
    color: 'hsl(var(--github-addition))',
  },
  deletions: {
    marginInlineStart: 'calc(var(--spacing) * 1)',
    color: 'hsl(var(--github-deletion))',
  },
  worktreeGlyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 55%, transparent)',
  },
  home: {
    position: 'relative',
    height: '100%',
    minHeight: 0,
    width: '100%',
    color: 'hsl(var(--foreground))',
  },
  homeShell: {
    position: 'relative',
    display: 'flex',
    height: '100%',
    width: '100%',
    flexDirection: 'column',
    backgroundColor: 'hsl(var(--background))',
  },
  homeHeader: {
    position: 'relative',
    zIndex: 30,
    paddingBottom: 'calc(var(--spacing) * 2)',
  },
  headerRow: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 9)',
    width: '100%',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  identitySlot: {
    position: 'relative',
    zIndex: 10,
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-start',
  },
  identity: {
    display: 'flex',
    height: 'calc(var(--spacing) * 9)',
    width: 'calc(var(--spacing) * 9)',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'color-mix(in oklab, hsl(var(--border)) 50%, transparent)',
      ':where(.dark, .dark *)': 'color-mix(in oklab, var(--color-white) 12%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--muted))',
      ':where(.dark, .dark *)': 'color-mix(in oklab, var(--color-white) 10%, transparent)',
    },
    color: 'hsl(var(--foreground))',
  },
  avatar: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    width: 'calc(var(--spacing) * 7)',
    flexShrink: 0,
    overflow: 'hidden',
    borderRadius: 'calc(infinity * 1px)',
    fontSize: '0.72rem',
  },
  avatarImage: {
    aspectRatio: '1',
    width: '100%',
    height: '100%',
  },
  searchSlot: {
    position: 'relative',
    zIndex: 10,
    height: 'calc(var(--spacing) * 9)',
    minWidth: 0,
    flex: '1',
    translate: '0 0',
    opacity: 1,
    transitionProperty: 'opacity,transform',
    transitionTimingFunction: 'var(--ease-out)',
    transitionDuration: '150ms',
  },
  search: {
    display: 'flex',
    height: 'calc(var(--spacing) * 9)',
    width: '100%',
    minWidth: 0,
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    borderRadius: 'calc(infinity * 1px)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'color-mix(in oklab, hsl(var(--border)) 50%, transparent)',
      ':where(.dark, .dark *)': 'color-mix(in oklab, var(--color-white) 12%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--muted))',
      ':where(.dark, .dark *)': 'color-mix(in oklab, var(--color-white) 10%, transparent)',
    },
    paddingInline: 'calc(var(--spacing) * 3)',
    color: 'hsl(var(--foreground))',
  },
  searchGlyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
    color: 'hsl(var(--muted-foreground))',
  },
  searchInput: {
    minWidth: 0,
    flex: '1',
    borderStyle: 'none',
    backgroundColor: 'transparent',
    fontSize: '0.82rem',
    outlineStyle: 'none',
    '::placeholder': {
      color: 'hsl(var(--muted-foreground))',
    },
  },
  headerActions: {
    position: 'relative',
    zIndex: 10,
    display: 'flex',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 'calc(var(--spacing) * 2)',
  },
  main: {
    position: 'relative',
    display: 'flex',
    minHeight: 0,
    flex: '1',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  mainColumn: {
    display: 'flex',
    minHeight: 0,
    flex: '1',
    flexDirection: 'column',
  },
  listScroll: {
    position: 'relative',
    zIndex: 0,
    minHeight: 0,
    flex: '1',
    overflowY: 'auto',
    paddingTop: 'calc(var(--spacing) * 1)',
    scrollbarGutter: 'auto',
    paddingBottom: 'calc(var(--mobile-tabbar-height) + var(--k-safe-area-bottom, 0px) + 1rem)',
  },
  conversationList: {
    display: 'flex',
    flexDirection: 'column',
  },
  filterRow: {
    display: 'flex',
    width: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
    paddingBottom: 'calc(var(--spacing) * 1.5)',
    paddingInlineEnd: 'calc(var(--spacing) * 4)',
    paddingInlineStart: '18px',
    paddingTop: 'calc(var(--spacing) * 2)',
  },
  filterButton: {
    position: 'relative',
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 8)',
    width: 'calc(var(--spacing) * 8)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: {
      default: 'color-mix(in oklab, hsl(var(--border)) 50%, transparent)',
      ':where(.dark, .dark *)': 'color-mix(in oklab, var(--color-white) 12%, transparent)',
    },
    backgroundColor: {
      default: 'hsl(var(--muted))',
      ':where(.dark, .dark *)': 'color-mix(in oklab, var(--color-white) 10%, transparent)',
    },
    color: 'hsl(var(--muted-foreground))',
  },
  filterGlyph: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    color: 'currentColor',
  },
  conversationWrapper: {
    overflow: 'hidden',
    backgroundColor: 'hsl(var(--background))',
  },
  dock: {
    position: 'fixed',
    bottom: 'calc(var(--spacing) * 0)',
    left: 'calc(var(--spacing) * 0)',
    right: 'calc(var(--spacing) * 0)',
    zIndex: 30,
    display: 'flex',
    alignItems: 'flex-end',
    justifyContent: 'space-between',
    gap: 'calc(var(--spacing) * 3)',
    paddingInline: 'calc(var(--spacing) * 4)',
    paddingBottom: 'calc(0.5rem + var(--k-safe-area-bottom, 0px))',
    paddingTop: 'calc(var(--spacing) * 2)',
  },
  dockPill: {
    position: 'relative',
    display: 'flex',
    height: 'calc(var(--spacing) * 14)',
    minWidth: 0,
    flex: '1',
    alignItems: 'center',
    justifyContent: 'space-around',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'calc(infinity * 1px)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1.5)',
    color: 'hsl(var(--foreground))',
  },
  chatTab: {
    position: 'relative',
    isolation: 'isolate',
    display: 'inline-flex',
    height: '100%',
    flex: '1',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 0.5)',
    borderRadius: 'calc(infinity * 1px)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: '0.72rem',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--primary))',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
  },
  activeTab: {
    position: 'absolute',
    inset: 'calc(var(--spacing) * 0)',
    zIndex: 0,
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: {
      default: 'color-mix(in oklab, hsl(var(--primary)) 20%, transparent)',
      ':where(.dark, .dark *)': 'color-mix(in oklab, hsl(var(--primary)) 25%, transparent)',
    },
  },
  chatTabGlyph: {
    position: 'relative',
    zIndex: 10,
    display: 'inline-flex',
    width: 'calc(var(--spacing) * 6)',
    height: 'calc(var(--spacing) * 6)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    ':is(*) > svg': {
      height: 'calc(var(--spacing) * 6)',
      width: 'calc(var(--spacing) * 6)',
    },
  },
  chatGlyph: {
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
  },
  chatLabel: {
    position: 'relative',
    zIndex: 10,
    lineHeight: '1',
  },
  projectTab: {
    position: 'relative',
    isolation: 'isolate',
    display: 'inline-flex',
    height: '100%',
    flex: '1',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'calc(var(--spacing) * 0.5)',
    borderRadius: 'calc(infinity * 1px)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: '0.72rem',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--muted-foreground))',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
    transitionDuration: 'var(--default-transition-duration)',
  },
  projectTabGlyph: {
    position: 'relative',
    zIndex: 10,
    display: 'inline-flex',
    width: 'calc(var(--spacing) * 6)',
    height: 'calc(var(--spacing) * 6)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    ':is(*) > svg': {
      height: 'calc(var(--spacing) * 6)',
      width: 'calc(var(--spacing) * 6)',
    },
  },
  projectGlyph: {
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
  },
  projectLabel: {
    position: 'relative',
    zIndex: 10,
    lineHeight: '1',
  },
  newChat: {
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 14)',
    width: 'calc(var(--spacing) * 14)',
    flexShrink: 0,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 'calc(infinity * 1px)',
    backgroundColor: 'hsl(var(--foreground))',
    color: 'hsl(var(--background))',
    boxShadow: {
      default: '0 6px 20px -6px rgba(0,0,0,0.28),0 2px 8px -2px rgba(0,0,0,0.16)',
      ':where(.dark, .dark *)': '0 8px 24px -6px rgba(0,0,0,0.55)',
    },
  },
  newChatGlyph: {
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
  },
  prOpen: {
    color: 'hsl(var(--github-open))',
  },
  prMerged: {
    color: 'hsl(var(--github-merged))',
  },
  prClosed: {
    color: 'hsl(var(--github-closed))',
  },
  prGlyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    flexShrink: 0,
  },
});

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
const PR_ICON: Record<
  ReplicaPrStatus,
  { icon: typeof GitPullRequest; xstyle?: stylex.StyleXStyles }
> = {
  open: { icon: GitPullRequest, xstyle: styles.prOpen },
  merged: { icon: GitMerge, xstyle: styles.prMerged },
  closed: { icon: GitPullRequestClosed, xstyle: styles.prClosed },
  draft: { icon: GitPullRequestDraft, xstyle: undefined },
};

function StatusIndicator({ chat }: { chat: ReplicaMobileChat }) {
  if (chat.isWaitingPermission) {
    return <Hand {...stylex.props(styles.waitingGlyph)} aria-label="waiting permission" />;
  }
  if (chat.isWorking) {
    return (
      <span {...stylex.props(styles.workingStatus)} aria-label="running">
        <Loader2 {...stylex.props(styles.workingGlyph)} aria-hidden="true" />
      </span>
    );
  }
  if (chat.hasUnreadMessages) {
    return <span {...stylex.props(styles.unreadStatus)} aria-label="unread" />;
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
      {...stylex.props(styles.conversationRow)}
      className={cn(
        stylex.props(styles.conversationRow).className,
        'mobile-project-conversation-row'
      )}
    >
      <div data-conversation-row-leading-slot="" {...stylex.props(styles.statusSlot)}>
        <StatusIndicator chat={chat} />
      </div>
      <div {...stylex.props(styles.titleSlot)}>
        <span {...stylex.props(styles.conversationTitle)}>{chat.title}</span>
      </div>
      {hasChanges ? (
        <span {...stylex.props(styles.diffStats)}>
          <span {...stylex.props(styles.additions)}>+{chat.addedLines}</span>
          <span {...stylex.props(styles.deletions)}>-{chat.deletedLines}</span>
        </span>
      ) : null}
      {chat.isWorktree ? (
        <WorktreeIcon {...stylex.props(styles.worktreeGlyph)} aria-label="Worktree" />
      ) : null}
      {showPr ? (
        <PrIcon
          {...stylex.props(styles.prGlyph, pr.xstyle)}
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
    <div
      {...stylex.props(styles.home)}
      className={cn(stylex.props(styles.home).className, 'mobile-home-app safe-areas')}
    >
      <div
        {...stylex.props(styles.homeShell)}
        className={cn(stylex.props(styles.homeShell).className, 'mobile-home-shell')}
      >
        <header
          {...stylex.props(styles.homeHeader)}
          className={cn(
            stylex.props(styles.homeHeader).className,
            'mobile-home-glass pt-safe-2 ps-safe-3 pe-safe-3'
          )}
        >
          <div {...stylex.props(styles.headerRow)}>
            <div {...stylex.props(styles.identitySlot)}>
              <div {...stylex.props(styles.identity)} data-workspace-identity>
                <span {...stylex.props(styles.avatar)}>
                  <img
                    src={workspaceAvatarUrl}
                    alt={workspaceName}
                    {...stylex.props(styles.avatarImage)}
                  />
                </span>
              </div>
            </div>

            <div {...stylex.props(styles.searchSlot)}>
              <label
                {...stylex.props(styles.search)}
                className={cn(stylex.props(styles.search).className, 'mobile-home-header-search')}
              >
                <Search
                  {...stylex.props(styles.searchGlyph)}
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
                  {...stylex.props(styles.searchInput)}
                />
              </label>
            </div>

            <div {...stylex.props(styles.headerActions)} />
          </div>
        </header>

        <div {...stylex.props(styles.main)}>
          <div {...stylex.props(styles.mainColumn)}>
            <div
              data-mobile-session-list-scroll-region=""
              {...stylex.props(styles.listScroll)}
              className={cn(stylex.props(styles.listScroll).className, 'mobile-home-list-region')}
              data-landing-scroll-region=""
            >
              <section aria-label={labels.chatTab} {...stylex.props(styles.conversationList)}>
                <div {...stylex.props(styles.filterRow)}>
                  <button
                    type="button"
                    aria-label={labels.filters}
                    aria-pressed={false}
                    {...stylex.props(styles.filterButton)}
                  >
                    <CarbonSettingsAdjust
                      {...stylex.props(styles.filterGlyph)}
                      aria-hidden="true"
                    />
                  </button>
                </div>
                {chats.slice(0, MOBILE_CHAT_PREVIEW_MAX_ROOTS).map((chat) => (
                  <div key={chat.id} {...stylex.props(styles.conversationWrapper)}>
                    <ConversationRow chat={chat} />
                  </div>
                ))}
              </section>
            </div>
          </div>
        </div>

        <div
          {...stylex.props(styles.dock)}
          className={cn(stylex.props(styles.dock).className, 'mobile-workspace-dock')}
        >
          <div
            role="tablist"
            aria-label={labels.chatTab}
            {...stylex.props(styles.dockPill)}
            className={cn(
              stylex.props(styles.dockPill).className,
              'mobile-workspace-tab-pill mobile-tabbar-glass'
            )}
          >
            <button
              type="button"
              role="tab"
              aria-selected
              {...stylex.props(styles.chatTab)}
              className={cn(stylex.props(styles.chatTab).className, 'mobile-workspace-tab')}
            >
              <span aria-hidden="true" {...stylex.props(styles.activeTab)} />
              <span {...stylex.props(styles.chatTabGlyph)}>
                <MessageCircle {...stylex.props(styles.chatGlyph)} strokeWidth={1.75} />
              </span>
              <span {...stylex.props(styles.chatLabel)}>{labels.chatTab}</span>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={false}
              {...stylex.props(styles.projectTab)}
              className={cn(stylex.props(styles.projectTab).className, 'mobile-workspace-tab')}
            >
              <span {...stylex.props(styles.projectTabGlyph)}>
                <Folders {...stylex.props(styles.projectGlyph)} strokeWidth={1.75} />
              </span>
              <span {...stylex.props(styles.projectLabel)}>{labels.projectsTab}</span>
            </button>
          </div>
          <button
            type="button"
            aria-label={labels.newChat}
            {...stylex.props(styles.newChat)}
            className={cn(stylex.props(styles.newChat).className, 'mobile-workspace-new-chat')}
          >
            <PencilLine
              {...stylex.props(styles.newChatGlyph)}
              strokeWidth={1.85}
              aria-hidden="true"
            />
          </button>
        </div>
      </div>
    </div>
  );
}
