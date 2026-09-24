import { useId, type ReactNode } from 'react';
import {
  Archive,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Folder,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Hand,
  Loader2,
  Search,
  Settings,
  SquarePen,
  X,
  type LucideIcon,
} from 'lucide-react';
import { Button } from './button';
import type { ReplicaLocale, ReplicaPrStatus, ReplicaSessionRow } from './types';
import { cn } from './utils';

/* Display-only replica of the desktop `LoroSidebar` in Workspace organize mode,
   as the landing composes it: nav rows, a Local Projects section, the Chats
   group and the GitHub Worktrees repo groups (`session-list.tsx`), footer. */

const SIDEBAR_COPY: Record<
  ReplicaLocale,
  {
    home: string;
    search: string;
    back: string;
    forward: string;
    localProjects: string;
    chats: string;
    githubRepos: string;
    mergeable: string;
  }
> = {
  en: {
    home: 'New chat',
    search: 'Search',
    back: 'Back',
    forward: 'Forward',
    localProjects: 'Local Projects',
    chats: 'Chats',
    githubRepos: 'GitHub Worktrees',
    mergeable: 'Mergeable',
  },
  zh: {
    home: '新对话',
    search: '搜索',
    back: '后退',
    forward: '前进',
    localProjects: '本地项目',
    chats: '对话',
    githubRepos: 'GitHub Worktrees',
    mergeable: '可合并',
  },
};

// ---- PR status icon (sidebar-row-shared `SessionPrIcon`) ---------------------

const PR_STATUS_ICON: Record<ReplicaPrStatus, { icon: LucideIcon; className: string }> = {
  open: { icon: GitPullRequest, className: 'text-github-open' },
  // The app's `text-pr-merged` utility resolves to `--github-merged`.
  merged: { icon: GitMerge, className: 'text-github-merged' },
  closed: { icon: GitPullRequestClosed, className: 'text-github-closed' },
  draft: { icon: GitPullRequestDraft, className: 'text-github-draft' },
};

export const REPLICA_PR_STATUS_TEXT: Record<ReplicaPrStatus, string> = {
  open: 'text-github-open',
  merged: 'text-github-merged',
  closed: 'text-github-closed',
  draft: 'text-github-draft',
};

type ReplicaCiState = NonNullable<ReplicaSessionRow['prCiState']>;

/** PR glyph with the CI verdict badge cut into its bottom-right corner. */
export function ReplicaPrIcon({
  status,
  ciState,
  className,
}: {
  status: ReplicaPrStatus;
  ciState?: ReplicaCiState | null;
  className?: string;
}) {
  const maskId = `pr-ci-${ciState ?? 'none'}-${useId().replaceAll(':', '')}`;
  const meta = PR_STATUS_ICON[status];
  const BaseIcon = meta.icon;
  if (!ciState) {
    return (
      <BaseIcon
        className={cn('h-3.5 w-3.5 shrink-0', meta.className, className)}
        strokeWidth={2.25}
        aria-hidden="true"
      />
    );
  }
  const isRunning = ciState === 'pending';
  const VerdictIcon = ciState === 'success' ? Check : ciState === 'failure' ? X : null;
  const verdictClassName =
    ciState === 'success'
      ? 'text-status-success'
      : ciState === 'failure'
        ? 'text-destructive'
        : 'text-status-warning';
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn('h-4 w-4 shrink-0', status === 'merged' && 'translate-x-px', className)}
      data-pr-ci-verdict={ciState}
      aria-hidden="true"
    >
      <mask
        id={maskId}
        x="0"
        y="0"
        width="16"
        height="16"
        maskUnits="userSpaceOnUse"
        maskContentUnits="userSpaceOnUse"
      >
        <rect width="16" height="16" fill="white" />
        <circle cx="12" cy="12" r={isRunning ? 3.75 : 5} fill="black" />
      </mask>
      <g mask={`url(#${maskId})`}>
        <BaseIcon width={14} height={14} strokeWidth={2.25} className={meta.className} />
      </g>
      <g transform="translate(7 7)">
        {isRunning ? (
          <circle cx="5" cy="5" r="2.5" fill="currentColor" className={verdictClassName} />
        ) : VerdictIcon ? (
          <VerdictIcon width={10} height={10} strokeWidth={3} className={verdictClassName} />
        ) : null}
      </g>
    </svg>
  );
}

// ---- Row building blocks -----------------------------------------------------

/* The app's `Spinner`: the rotation runs on an HTML wrapper, because an
   `<svg class="animate-spin">` falls off the compositor on DPR≠1 displays. */
export function ReplicaSpinner({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 animate-spin items-center justify-center will-change-transform',
        className
      )}
    >
      <Loader2 className="size-full" aria-hidden="true" />
    </span>
  );
}

/** ③ The row's single trailing status channel: waiting > working > unread > rest. */
function RowEndSlot({ row, rest }: { row: ReplicaSessionRow; rest?: ReactNode }) {
  const status = row.isWaitingPermission ? (
    <Hand className="h-3 w-3 text-status-warning" />
  ) : row.isWorking ? (
    <ReplicaSpinner className="h-3 w-3 text-primary" />
  ) : row.hasUnreadMessages ? (
    <span className="h-2 w-2 rounded-full bg-primary" />
  ) : null;
  const content = status ? (
    <div
      data-session-row-indicator=""
      className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
    >
      {status}
    </div>
  ) : (
    rest
  );
  // Desktop rows always reserve the (hover-only) archive target, hence min-w-5.
  return (
    <div
      data-session-row-end-slot=""
      className="pointer-events-none relative flex h-5 min-w-5 shrink-0 items-center justify-center"
    >
      {content ? <span className="flex">{content}</span> : null}
    </div>
  );
}

function MergeablePill({ label }: { label: string }) {
  return (
    <span
      data-session-mergeable-pill=""
      className="inline-flex h-5 shrink-0 items-center rounded-full border border-status-success/45 bg-status-success/[0.06] px-1.5 text-[10px] font-medium leading-none tracking-[0.01em] text-status-success"
    >
      {label}
    </span>
  );
}

/** One `SessionList` row (chat or GitHub repo group). */
function SessionListRowView({
  row,
  kind,
  selected,
  mergeableLabel,
}: {
  row: ReplicaSessionRow;
  kind: 'chat' | 'repo';
  selected: boolean;
  mergeableLabel: string;
}) {
  const hasPr = Boolean(row.prUrl || row.prNumber);
  const prStatus = row.prStatus ?? 'open';
  const showMergeablePill =
    hasPr &&
    Boolean(row.prMergeable) &&
    prStatus !== 'merged' &&
    prStatus !== 'closed' &&
    !selected;
  const rest =
    kind === 'chat' ? (
      <span className="flex items-center gap-1.5">
        <span className="inline-flex items-center justify-end gap-1 text-[0.8em] text-muted-foreground">
          <span className="select-none tabular-nums">{row.ageLabel}</span>
        </span>
      </span>
    ) : hasPr || showMergeablePill ? (
      <span className="flex select-none items-center gap-1.5 text-[0.75em] tabular-nums text-sidebar-foreground-muted/80">
        {showMergeablePill ? <MergeablePill label={mergeableLabel} /> : null}
        {hasPr ? <ReplicaPrIcon status={prStatus} ciState={row.prCiState} /> : null}
      </span>
    ) : undefined;

  return (
    <div
      aria-current={selected ? 'page' : undefined}
      data-sidebar-session-id={row.id}
      className={cn(
        'group relative w-full cursor-pointer rounded-md border border-transparent bg-transparent px-2 py-1 text-left',
        selected && 'bg-sidebar-selection text-sidebar-selection-foreground'
      )}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <div
          data-session-row-leading-slot=""
          className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center"
        />
        <div
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1 truncate text-[0.9em]',
            selected ? 'text-sidebar-selection-foreground' : 'text-sidebar-foreground'
          )}
        >
          <span className="truncate font-normal">{row.title}</span>
        </div>
        <RowEndSlot row={row} rest={rest} />
      </div>
    </div>
  );
}

/** A `SessionList` group: the Chats section or one GitHub repo. */
function SessionGroup({
  kind,
  label,
  ownerAvatarUrl,
  rows,
  selectedSessionId,
  mergeableLabel,
}: {
  kind: 'chat' | 'repo';
  label: string;
  ownerAvatarUrl?: string;
  rows: ReplicaSessionRow[];
  selectedSessionId: string | null;
  mergeableLabel: string;
}) {
  return (
    <div className="mb-3 flex flex-col gap-0.5 last:mb-0">
      <div className="group flex h-7 items-center">
        <div
          className={cn(
            'relative flex h-7 w-full min-w-0 flex-1 cursor-pointer select-none items-center gap-1 rounded-md border border-transparent bg-transparent px-2 text-left transition-colors',
            kind === 'repo'
              ? 'text-[0.9em] font-normal text-sidebar-foreground dark:text-sidebar-foreground/75'
              : 'text-[0.9em] font-medium text-sidebar-foreground-muted'
          )}
        >
          {kind === 'repo' ? (
            <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
              {ownerAvatarUrl ? (
                <img
                  src={ownerAvatarUrl}
                  alt=""
                  aria-hidden="true"
                  className="absolute left-0 top-1/2 h-3.5 w-3.5 -translate-y-1/2 rounded-sm object-cover opacity-80"
                />
              ) : null}
            </span>
          ) : null}
          <span className="min-w-0 truncate text-left">{label}</span>
          <span className="flex-1" aria-hidden="true" />
        </div>
      </div>
      <div className="flex flex-col gap-px">
        {rows.map((row) => (
          <SessionListRowView
            key={row.id}
            row={row}
            kind={kind}
            selected={row.id === selectedSessionId}
            mergeableLabel={mergeableLabel}
          />
        ))}
      </div>
    </div>
  );
}

/** A local project folder group with its sessions (landing's local-project shape). */
function LocalProjectGroup({
  name,
  sessions,
  selectedSessionId,
}: {
  name: string;
  sessions: ReplicaSessionRow[];
  selectedSessionId: string | null;
}) {
  return (
    <div className="space-y-0.5">
      <div className="group flex items-center">
        <div className="group relative flex w-full min-w-0 flex-1 cursor-pointer select-none items-center gap-2 rounded-md border border-transparent bg-transparent py-1 pl-2 pr-3 text-left text-xs font-semibold text-sidebar-foreground-muted/65">
          <span className="relative flex h-5 w-5 shrink-0 items-center justify-center">
            <Folder className="absolute h-3.5 w-3.5 text-current opacity-80" />
          </span>
          <span className="min-w-0 flex-1 truncate text-left">{name}</span>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        {sessions.map((row) => {
          const selected = row.id === selectedSessionId;
          return (
            <div
              key={row.id}
              aria-current={selected ? 'page' : undefined}
              data-sidebar-session-id={row.id}
              className={cn(
                'group w-full rounded-md border border-transparent bg-transparent py-1.5 pl-2 pr-3 text-left',
                selected
                  ? 'bg-sidebar-selection text-sidebar-selection-foreground'
                  : 'text-sidebar-foreground'
              )}
            >
              <div className="flex items-start gap-2">
                <div className="mt-0.5 flex h-4 w-4 items-center justify-center">
                  {row.isWorking ? <ReplicaSpinner className="h-3.5 w-3.5 text-primary" /> : null}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-start gap-3">
                    <div className="min-w-0 flex-1 truncate text-sm text-current">
                      <span className="truncate">{row.title}</span>
                    </div>
                    <span className="ml-auto shrink-0 select-none text-xs tabular-nums text-muted-foreground">
                      {row.ageLabel}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Chrome ------------------------------------------------------------------

function NavRow({ active, label, icon }: { active: boolean; label: string; icon: ReactNode }) {
  return (
    <div className="relative flex w-full items-center">
      <button
        type="button"
        tabIndex={-1}
        className={cn(
          'group flex w-full select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.9em] outline-hidden transition',
          active
            ? 'bg-sidebar-selection text-sidebar-selection-foreground'
            : 'text-sidebar-foreground dark:text-sidebar-foreground/75'
        )}
      >
        <span className="flex h-5 w-5 shrink-0 items-center justify-center text-current">
          {icon}
        </span>
        <span className="truncate">{label}</span>
      </button>
    </div>
  );
}

function HeaderNavButton({ label, children }: { label: string; children: ReactNode }) {
  // The landing has no navigation history, so back/forward render disabled.
  return (
    <button
      type="button"
      aria-label={label}
      disabled
      className="flex h-5 w-5 shrink-0 cursor-default items-center justify-center rounded-md text-sidebar-foreground-muted/40 outline-hidden"
    >
      {children}
    </button>
  );
}

function FooterIconButton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Button
      variant="ghost"
      size="icon"
      tabIndex={-1}
      className="h-6 w-6 rounded-md text-sidebar-foreground transition-colors dark:text-sidebar-foreground-muted [&_svg]:h-3.5 [&_svg]:w-3.5"
    >
      {children}
      <span className="sr-only">{label}</span>
    </Button>
  );
}

export type ReplicaSidebarProject = { name: string; sessions: ReplicaSessionRow[] };

export type ReplicaSidebarRepo = {
  repoFullName: string;
  ownerAvatarUrl: string;
  sessions: ReplicaSessionRow[];
};

export type ReplicaSidebarProps = {
  locale: ReplicaLocale;
  workspace: { name: string; logoUrl: string };
  /** The worktree demo's freshly created project; rendered above `localProjects`. */
  demoProject: ReplicaSidebarProject | null;
  localProjects: ReplicaSidebarProject[];
  chats: ReplicaSessionRow[];
  github: ReplicaSidebarRepo[];
  selectedSessionId: string | null;
  /** "New chat" nav row highlighted (chat landing visible). */
  homeActive: boolean;
  width?: number;
};

export function ReplicaSidebar({
  locale,
  workspace,
  demoProject,
  localProjects,
  chats,
  github,
  selectedSessionId,
  homeActive,
  width = 296,
}: ReplicaSidebarProps) {
  const copy = SIDEBAR_COPY[locale];
  const projects = demoProject ? [demoProject, ...localProjects] : localProjects;
  const hasGithubRows = github.some((repo) => repo.sessions.length > 0);

  return (
    <div className="min-h-0 shrink-0 border-r border-sidebar-border bg-sidebar-background">
      <div
        className="relative h-full select-none text-sidebar-foreground"
        style={{ width, minWidth: width, maxWidth: width }}
      >
        <div className="relative flex h-full flex-col overflow-hidden">
          <div className="group/sidebar-header relative flex h-11 items-center justify-between gap-2 px-1.5">
            <span
              aria-label="Lody"
              className="select-none px-2 text-[18px] font-semibold leading-none tracking-[-0.03em] text-sidebar-foreground"
              style={{ fontFamily: 'var(--font-wordmark)' }}
            >
              Lody
            </span>
            <div className="ml-auto flex shrink-0 items-center">
              <HeaderNavButton label={copy.back}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </HeaderNavButton>
              <HeaderNavButton label={copy.forward}>
                <ChevronRight className="h-3.5 w-3.5" />
              </HeaderNavButton>
            </div>
          </div>

          <div className="flex flex-col gap-px px-1.5">
            <NavRow
              active={homeActive}
              label={copy.home}
              icon={<SquarePen className="h-4 w-4" />}
            />
            <NavRow active={false} label={copy.search} icon={<Search className="h-4 w-4" />} />
          </div>

          <div className="mt-2 min-h-0 flex-1 overflow-hidden">
            <div className="px-1.5 pb-3">
              <div className="relative">
                <div className="pb-1 pt-1">
                  <div className="space-y-3">
                    <div className="space-y-2">
                      <div className="space-y-0.5">
                        <div className="group flex h-7 items-center gap-1 rounded-md pr-2">
                          <div className="relative flex h-7 min-w-0 flex-1 select-none items-center gap-1 rounded-md border border-transparent bg-transparent px-2 text-left text-xs font-semibold text-sidebar-foreground-muted/65">
                            <span className="min-w-0 truncate">{copy.localProjects}</span>
                            <span className="flex-1" aria-hidden="true" />
                          </div>
                        </div>
                        <div className="space-y-1">
                          {projects.map((project) => (
                            <LocalProjectGroup
                              key={project.name}
                              name={project.name}
                              sessions={project.sessions}
                              selectedSessionId={selectedSessionId}
                            />
                          ))}
                        </div>
                      </div>
                    </div>
                    {chats.length ? (
                      <div className="flex flex-col">
                        <SessionGroup
                          kind="chat"
                          label={copy.chats}
                          rows={chats}
                          selectedSessionId={selectedSessionId}
                          mergeableLabel={copy.mergeable}
                        />
                      </div>
                    ) : null}
                    {hasGithubRows ? (
                      <div className="px-2 text-xs font-semibold text-sidebar-foreground-muted/65">
                        {copy.githubRepos}
                      </div>
                    ) : null}
                  </div>
                </div>
                <div className="flex flex-col">
                  {github
                    .filter((repo) => repo.sessions.length > 0)
                    .map((repo) => (
                      <div
                        key={repo.repoFullName}
                        className="mb-3 w-full last:mb-0"
                        data-repo-full-name={repo.repoFullName}
                      >
                        <SessionGroup
                          kind="repo"
                          label={repo.repoFullName}
                          ownerAvatarUrl={repo.ownerAvatarUrl}
                          rows={repo.sessions}
                          selectedSessionId={selectedSessionId}
                          mergeableLabel={copy.mergeable}
                        />
                      </div>
                    ))}
                </div>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center justify-between border-t-[0.5px] border-sidebar-border px-1.5 py-1">
            <div className="min-w-0 flex-1">
              <div className="flex h-8 w-full min-w-0 select-none items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[0.9em] text-sidebar-foreground dark:text-sidebar-foreground/75">
                <span className="relative flex h-5 w-5 shrink-0 overflow-hidden rounded-full text-[10px]">
                  <img
                    src={workspace.logoUrl}
                    alt={workspace.name}
                    className="aspect-square size-full"
                  />
                </span>
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate font-medium">{workspace.name}</span>
                </span>
              </div>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <FooterIconButton label="Settings">
                <Settings strokeWidth={1.5} />
              </FooterIconButton>
              <FooterIconButton label="Help">
                <CircleHelp strokeWidth={1.5} />
              </FooterIconButton>
              <FooterIconButton label="Archive">
                <Archive strokeWidth={1.5} />
              </FooterIconButton>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
