/**
 * Display-only replica of the app's embedded `PrTabView` (landing "power"
 * section): slim header with the PR badge + green Squash split button, the PR
 * description, the collapsed "All checks passed" row, the conversation cards and
 * the decorative comment composer. The frame is inert; nothing here is wired.
 */

import { CheckCircle2, ChevronDown, GitMerge, GitPullRequest } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from './button';
import { cn } from './utils';

export type PowerPrLabels = {
  mergeShortSquash: string;
  moreActions: string;
  opened: (when: string) => string;
  commits: (count: number) => string;
  files: (count: number) => string;
  checksPassed: string;
  checksCount: (count: number) => string;
  commented: string;
  reviewApproved: string;
  composerPlaceholder: string;
  composerSubmit: string;
};

/** Inline run of a pre-structured Markdown line: plain text or inline code. */
export type PowerPrInline = string | { code: string };

export type PowerPrBodyBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'paragraph'; runs: readonly PowerPrInline[] }
  | { kind: 'list'; items: readonly (readonly PowerPrInline[])[] };

export type PowerPrConversationItem =
  | { kind: 'comment'; id: string; author: string; createdAt: string; body: string }
  | { kind: 'review'; id: string; author: string; submittedAt: string; body: string };

export type PowerPrData = {
  repoFullName: string;
  number: number;
  title: string;
  author: string;
  /** ISO timestamps; rendered as a fixed UTC date so SSR and client agree. */
  createdAt: string;
  commits: number;
  additions: number;
  deletions: number;
  changedFiles: number;
  body: readonly PowerPrBodyBlock[];
  checksTotal: number;
  conversation: readonly PowerPrConversationItem[];
};

export type PowerPrViewProps = {
  data: PowerPrData;
  labels: PowerPrLabels;
  /** BCP 47 locale for the comment dates. */
  intlLocale: string;
};

const PR_ACTION_BTN = 'h-7 gap-1.5 px-2.5 text-[0.9em]';
const PR_MERGE_BTN_GREEN =
  'bg-status-success text-white hover:bg-status-success/90 dark:text-background';
const PR_SPLIT_DIVIDER = 'border-l border-white/25 dark:border-black/25';

/** Same classes MarkdownRenderer applies (size "sm" = 14px body, 16px h2). */
const MD_ROOT = 'markdown-renderer max-w-none text-foreground leading-[1.75]';
const MD_H2 = 'mt-5 mb-2 text-[16px] font-semibold tracking-tight first:mt-0';
const MD_P = 'mt-0 mb-3 last:mb-0';
const MD_UL = 'my-2 list-none pl-0';
const MD_LI =
  "relative my-0 py-0 pl-6 [&:not(:first-child)]:mt-1 before:absolute before:left-[10px] before:top-[0.75em] before:size-1 before:-translate-y-1/2 before:rounded-full before:bg-current before:content-['']";
const MD_CODE =
  'rounded-sm bg-foreground/[0.08] px-1 py-px font-mono text-[0.85em] text-foreground ring-0 dark:bg-foreground/[0.14]';

function formatDate(iso: string, intlLocale: string): string {
  return new Intl.DateTimeFormat(intlLocale, {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));
}

function Inline({ runs }: { runs: readonly PowerPrInline[] }) {
  return (
    <>
      {runs.map((run, index) =>
        typeof run === 'string' ? (
          <span key={index}>{run}</span>
        ) : (
          <code key={index} className={MD_CODE}>
            {run.code}
          </code>
        )
      )}
    </>
  );
}

function Markdown({ blocks }: { blocks: readonly PowerPrBodyBlock[] }) {
  return (
    <div className={MD_ROOT} style={{ fontSize: '14px' }}>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          return (
            <h2 key={index} className={MD_H2}>
              {block.text}
            </h2>
          );
        }
        if (block.kind === 'paragraph') {
          return (
            <p key={index} className={MD_P}>
              <Inline runs={block.runs} />
            </p>
          );
        }
        return (
          <ul key={index} className={MD_UL}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex} className={MD_LI}>
                <Inline runs={item} />
              </li>
            ))}
          </ul>
        );
      })}
    </div>
  );
}

function PlainMarkdown({ body }: { body: string }) {
  return (
    <div className={MD_ROOT} style={{ fontSize: '14px' }}>
      <p className={MD_P}>{body}</p>
    </div>
  );
}

function UserAvatar({ login, size = 'md' }: { login: string; size?: 'xs' | 'md' }) {
  return (
    <span
      data-slot="avatar"
      className={cn(
        'relative flex shrink-0 overflow-hidden rounded-full',
        size === 'xs' ? 'h-4 w-4' : 'h-6 w-6'
      )}
    >
      <span
        data-slot="avatar-fallback"
        className={cn(
          'bg-muted flex size-full items-center justify-center rounded-full',
          size === 'xs' ? 'text-[8px]' : 'text-[0.8em]'
        )}
      >
        {login.slice(0, 2).toUpperCase()}
      </span>
    </span>
  );
}

function CardHeader({ children, wrap }: { children: ReactNode; wrap?: boolean }) {
  return (
    <header
      className={cn(
        'flex items-center gap-2 border-b border-border bg-muted/30 px-3 py-2',
        wrap && 'flex-wrap'
      )}
    >
      {children}
    </header>
  );
}

function ConversationCard({
  item,
  labels,
  intlLocale,
}: {
  item: PowerPrConversationItem;
  labels: PowerPrLabels;
  intlLocale: string;
}) {
  if (item.kind === 'comment') {
    return (
      <article className="overflow-hidden rounded-md border border-border bg-background">
        <CardHeader>
          <UserAvatar login={item.author} />
          <span className="text-[0.9em] font-medium leading-none">{item.author}</span>
          <span className="text-[0.8em] text-muted-foreground leading-none">
            {labels.commented} · {formatDate(item.createdAt, intlLocale)}
          </span>
        </CardHeader>
        <div className="px-3 py-2">
          <PlainMarkdown body={item.body} />
        </div>
      </article>
    );
  }
  return (
    <article className="overflow-hidden rounded-md border border-border bg-background">
      <CardHeader wrap>
        <UserAvatar login={item.author} />
        <span className="text-[0.9em] font-medium leading-none">{item.author}</span>
        <span className="inline-flex items-center gap-1 rounded-full border border-status-success/40 bg-status-success/10 px-1.5 py-0.5 text-[0.75em] font-medium uppercase tracking-wide text-status-success">
          <CheckCircle2 className="h-3 w-3" />
          {labels.reviewApproved}
        </span>
        <span className="text-[0.8em] leading-none text-muted-foreground">
          {formatDate(item.submittedAt, intlLocale)}
        </span>
      </CardHeader>
      <div className="px-3 py-2">
        <PlainMarkdown body={item.body} />
      </div>
    </article>
  );
}

export function PowerPrView({ data, labels, intlLocale }: PowerPrViewProps) {
  return (
    <div className="@container/pr-tab flex h-full min-h-0 flex-col bg-background">
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-5">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-md font-normal transition px-1.5 py-0.5 text-[11px] bg-foreground/[0.06] text-github-open">
            <GitPullRequest className="h-3 w-3" strokeWidth={2.25} />
            <span>#{data.number}</span>
          </span>
          <span className="min-w-0 truncate text-[0.9em] font-medium text-muted-foreground">
            {data.repoFullName}
          </span>
        </div>
        <div className="shrink-0">
          <div data-pr-merge-action="" className="flex items-stretch overflow-hidden rounded-md">
            <Button
              size="sm"
              tabIndex={-1}
              className={cn(PR_ACTION_BTN, PR_MERGE_BTN_GREEN, 'rounded-r-none border-transparent')}
            >
              <GitMerge className="h-3.5 w-3.5" />
              {labels.mergeShortSquash}
            </Button>
            <Button
              size="sm"
              tabIndex={-1}
              aria-label={labels.moreActions}
              className={cn('h-7 rounded-l-none px-1.5', PR_MERGE_BTN_GREEN, PR_SPLIT_DIVIDER)}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>

      {/* The landing power section drives this viewport's scrollTop from page
          scroll; it looks it up by `data-power-scrollport`. */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div
          data-power-scrollport=""
          className="h-full w-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <div className="mx-auto w-full max-w-3xl space-y-3.5 px-5 pt-5 pb-5">
            <section className="space-y-1">
              <h2 className="font-semibold leading-snug text-pretty text-[1em]">
                {data.title}
                <span className="ml-2 font-normal text-muted-foreground text-[0.9em]">
                  #{data.number}
                </span>
              </h2>
              <div className="flex flex-col gap-1 text-[0.8em] text-muted-foreground @min-[420px]/pr-tab:flex-row @min-[420px]/pr-tab:flex-wrap @min-[420px]/pr-tab:items-center @min-[420px]/pr-tab:gap-x-2">
                <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <UserAvatar login={data.author} size="xs" />
                  <span className="font-normal text-foreground">{data.author}</span>
                  <span>{labels.opened(formatDate(data.createdAt, intlLocale))}</span>
                  <span aria-hidden>·</span>
                  <span>{labels.commits(data.commits)}</span>
                </span>
                <span className="inline-flex items-center gap-1.5 tabular-nums">
                  <span className="text-status-success">+{data.additions}</span>
                  <span className="text-status-danger">-{data.deletions}</span>
                  <span aria-hidden>·</span>
                  <span>{labels.files(data.changedFiles)}</span>
                </span>
              </div>
              <div className="mt-1 text-[0.9em] leading-relaxed text-foreground/90">
                <Markdown blocks={data.body} />
              </div>
            </section>

            <section className="overflow-hidden rounded-md border border-border">
              <div className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
                <span className="flex min-w-0 items-center gap-2 text-[0.9em] font-medium">
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-status-success" />
                  <span className="truncate">{labels.checksPassed}</span>
                </span>
                <span className="flex shrink-0 items-center gap-1.5 text-[0.8em] tabular-nums text-muted-foreground">
                  {labels.checksCount(data.checksTotal)}
                  <ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </span>
              </div>
            </section>

            <section className="space-y-2">
              <ul className="space-y-1.5">
                {data.conversation.map((item) => (
                  <li key={item.id}>
                    <ConversationCard item={item} labels={labels} intlLocale={intlLocale} />
                  </li>
                ))}
              </ul>
              <div className="space-y-2">
                <textarea
                  readOnly
                  tabIndex={-1}
                  rows={3}
                  placeholder={labels.composerPlaceholder}
                  className="flex w-full rounded-md border border-input-border px-3 py-2 text-sm text-input-foreground placeholder:text-input-placeholder min-h-[72px] resize-none overflow-hidden bg-background"
                />
                <div className="flex justify-end">
                  <Button size="sm" disabled tabIndex={-1} className="gap-1">
                    {labels.composerSubmit}
                  </Button>
                </div>
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  );
}
