import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { parseDiffFromFile } from '@pierre/diffs';
import { FileDiff, type FileDiffProps } from '@pierre/diffs/react';
import './pierre-diffs-element';
import { Button } from './button';
import { FileIcon } from './icons';
import type { ReplicaChangeFile, ReplicaLocale } from './types';
import { cn } from './utils';

/* Display-only replicas of the right panel's All-Changes list
   (`sessions/session-changes-sidebar.tsx`, "Types" view) and the diff card
   (`ui/diff-viewer/diff-viewer.tsx` default-header mode). Radix Accordion /
   Collapsible / ScrollArea wrappers are flattened to plain elements that keep
   the app's `data-state="open"` so its state-driven classes still apply. */

type ChangeCategory = 'code' | 'doc' | 'test' | 'dev';

const CATEGORY_ORDER: readonly ChangeCategory[] = ['code', 'doc', 'test', 'dev'];

const LABELS = {
  en: {
    title: 'Changes',
    types: 'Types',
    files: 'Files',
    category: { code: 'Code', doc: 'Docs', test: 'Tests', dev: 'Dev' },
  },
  zh: {
    title: '变更',
    types: '类型',
    files: '文件',
    category: { code: '代码', doc: '文档', test: '测试', dev: '开发' },
  },
} satisfies Record<
  ReplicaLocale,
  { title: string; types: string; files: string; category: Record<ChangeCategory, string> }
>;

// Stat columns are fixed-width so +N / -N line up across rows (same as the app).
const STAT_COL_CLASS = 'inline-block min-w-[2.25rem] text-right tabular-nums';

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

// Condensed `lib/file-change-category.ts`: enough to bucket demo paths the same way.
function categorize(path: string): ChangeCategory {
  const segments = path.toLowerCase().split('/').filter(Boolean);
  const name = segments.at(-1) ?? '';
  const dirs = segments.slice(0, -1);
  if (
    /\.(adoc|markdown|md|mdx|rst)$/.test(name) ||
    dirs.some((s) => s === 'doc' || s === 'docs' || s === 'documentation')
  ) {
    return 'doc';
  }
  if (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(name) ||
    dirs.some((s) => ['__test__', '__tests__', 'spec', 'test', 'tests'].includes(s))
  ) {
    return 'test';
  }
  if (
    name.startsWith('.') ||
    /(^|\.)config\.[cm]?[jt]s$|\.lock$|lock\.ya?ml$|package-lock\.json$/.test(name) ||
    dirs.some((s) => s === '.github' || s === '.vscode' || s === '.husky')
  ) {
    return 'dev';
  }
  return 'code';
}

function AggregateStats({ add, del }: { add: number; del: number }) {
  return (
    <>
      <span className={cn(STAT_COL_CLASS, 'text-code-added')}>+{add}</span>
      <span className={cn(STAT_COL_CLASS, 'text-code-removed')}>−{del}</span>
    </>
  );
}

function SegmentButton({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        'h-5 rounded px-2 text-[11px] font-medium transition-colors',
        active
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground'
      )}
    >
      {children}
    </button>
  );
}

export function ReplicaChangesList({
  files,
  locale,
  onOpenFile,
}: {
  files: ReplicaChangeFile[];
  locale: ReplicaLocale;
  onOpenFile?: (path: string) => void;
}) {
  const labels = LABELS[locale];
  const groups = useMemo(
    () =>
      CATEGORY_ORDER.map((category) => {
        const entries = files.filter((file) => categorize(file.path) === category);
        return {
          category,
          entries,
          add: entries.reduce((sum, file) => sum + file.add, 0),
          del: entries.reduce((sum, file) => sum + file.del, 0),
        };
      }).filter((group) => group.entries.length > 0),
    [files]
  );
  const totals = {
    count: files.length,
    add: files.reduce((sum, file) => sum + file.add, 0),
    del: files.reduce((sum, file) => sum + file.del, 0),
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {labels.title}
        </span>
        {files.length > 0 ? (
          <span className="flex items-baseline gap-1 text-[11px] tabular-nums">
            <span className="text-muted-foreground/70">{totals.count}</span>
            <AggregateStats add={totals.add} del={totals.del} />
          </span>
        ) : null}
        <div className="ml-auto inline-flex h-6 items-center rounded-md border border-border/60 bg-muted/40 p-0.5 text-[11px]">
          <SegmentButton active>{labels.types}</SegmentButton>
          <SegmentButton active={false}>{labels.files}</SegmentButton>
        </div>
      </div>
      <div className="relative min-h-0 flex-1 overflow-hidden">
        <div className="h-full w-full rounded-[inherit]">
          <div className="flex flex-col px-1.5 py-2">
            {groups.map((group) => (
              <div key={group.category} data-state="open">
                <h3 className="flex" data-state="open">
                  <button
                    type="button"
                    data-state="open"
                    aria-expanded
                    className={cn(
                      'group flex h-6 w-full items-center gap-1.5 rounded-md px-1 text-left',
                      'hover:bg-hover/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                    )}
                  >
                    <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform duration-150 group-data-[state=open]:rotate-90" />
                    <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                      {labels.category[group.category]}
                    </span>
                    <span className="text-[11px] tabular-nums text-muted-foreground/60">
                      {group.entries.length}
                    </span>
                    <AggregateStats add={group.add} del={group.del} />
                  </button>
                </h3>
                <div role="region" data-state="open" className="overflow-hidden">
                  <ul className="mt-0.5 flex flex-col pb-2">
                    {group.entries.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        data-id={`change:${file.path}`}
                        className={cn(
                          'group flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left',
                          'text-foreground/90 hover:bg-hover hover:text-hover-foreground',
                          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                        )}
                        title={file.path}
                        onClick={() => onOpenFile?.(file.path)}
                      >
                        <FileIcon path={file.path} className="h-4 w-4 shrink-0" />
                        <span className="min-w-0 flex-1 truncate text-sm">
                          {basename(file.path)}
                        </span>
                        <span className="ml-1 flex shrink-0 items-baseline gap-1 text-[11px]">
                          <AggregateStats add={file.add} del={file.del} />
                        </span>
                      </button>
                    ))}
                  </ul>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- Diff card ---------------------------------------------------------------

// Pierre reads these CSS variables through its shadow root: GitHub-accurate
// add/remove tints on the panel background (copied from the app's DiffViewer).
const PIERRE_HOST_STYLE = {
  '--diffs-light-bg': 'hsl(var(--background))',
  '--diffs-dark-bg': 'hsl(var(--background))',
  '--diffs-bg-buffer-override': 'hsl(var(--background))',
  '--diffs-bg-context-override': 'hsl(var(--background))',
  '--diffs-bg-separator-override':
    'color-mix(in oklab, hsl(var(--foreground)) 10%, hsl(var(--background)))',
  '--diffs-addition-color-override': 'hsl(var(--github-addition))',
  '--diffs-deletion-color-override': 'hsl(var(--github-deletion))',
  '--diffs-bg-addition-override':
    'color-mix(in oklab, hsl(var(--github-addition)) 12%, hsl(var(--background)))',
  '--diffs-bg-addition-number-override':
    'color-mix(in oklab, hsl(var(--github-addition)) 18%, hsl(var(--background)))',
  '--diffs-bg-addition-emphasis-override':
    'color-mix(in oklab, hsl(var(--github-addition)) 28%, hsl(var(--background)))',
  '--diffs-bg-deletion-override':
    'color-mix(in oklab, hsl(var(--github-deletion)) 12%, hsl(var(--background)))',
  '--diffs-bg-deletion-number-override':
    'color-mix(in oklab, hsl(var(--github-deletion)) 18%, hsl(var(--background)))',
  '--diffs-bg-deletion-emphasis-override':
    'color-mix(in oklab, hsl(var(--github-deletion)) 28%, hsl(var(--background)))',
} as CSSProperties;

type DiffOptions = FileDiffProps<undefined>['options'];

// The app's merged FileDiff options for a small unified diff, with the theme
// forced to the landing's light/dark (the app would read the VS Code theme).
const LIGHT_OPTIONS: DiffOptions = {
  diffStyle: 'unified',
  expandUnchanged: false,
  expansionLineCount: 20,
  theme: 'pierre-light',
  themeType: 'light',
  hunkSeparators: 'line-info',
  lineDiffType: 'word',
  overflow: 'wrap',
  disableFileHeader: true,
};
const DARK_OPTIONS: DiffOptions = {
  ...LIGHT_OPTIONS,
  theme: 'github-dark-default',
  themeType: 'dark',
};

export function ReplicaDiffViewer({ file, dark }: { file: ReplicaChangeFile; dark: boolean }) {
  const fileDiff = useMemo(() => {
    const lang = file.path.slice(file.path.lastIndexOf('.') + 1) as never;
    return parseDiffFromFile(
      { name: file.path, contents: file.oldText, lang },
      { name: file.path, contents: file.newText, lang }
    );
  }, [file.path, file.oldText, file.newText]);
  let additions = 0;
  let deletions = 0;
  for (const hunk of fileDiff.hunks) {
    additions += hunk.additionLines;
    deletions += hunk.deletionLines;
  }

  return (
    <div className="w-full">
      <div
        data-state="open"
        data-section-id="diff-viewer"
        // CollapsibleCard base merged with DiffViewer's card chrome.
        className="relative flex min-h-8 w-full flex-col overflow-hidden rounded-xl border border-foreground/[0.12] bg-background text-[0.8rem] shadow-[0_1px_2px_hsl(0_0%_0%/0.04)] ring-0 dark:border-border"
      >
        <div
          data-state="open"
          aria-expanded
          className="relative inset-x-0 z-20 flex h-8 items-center justify-between gap-2 rounded-none border-b border-foreground/[0.08] bg-background pl-1 pr-4 dark:border-border"
        >
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 hover:bg-transparent"
            aria-label="Toggle section"
          >
            <ChevronDown className="h-4 w-4 transition-transform duration-200" aria-hidden="true" />
          </Button>
          <FileIcon path={file.path} className="h-4 w-4 shrink-0" />
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span className="min-w-0 truncate text-sm text-foreground/90" title={file.path}>
              {file.path}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                title="Copy file path"
                aria-label="Copy file path"
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
          {additions > 0 || deletions > 0 ? (
            <div className="flex shrink-0 items-center gap-1.5 text-xs">
              {additions > 0 ? <span className="text-code-added">+{additions}</span> : null}
              {deletions > 0 ? <span className="text-code-removed">-{deletions}</span> : null}
            </div>
          ) : null}
        </div>
        <div data-state="open" className="relative overflow-x-auto">
          <div className="pb-0">
            <div className="lody-pierre-diff w-full bg-background" style={PIERRE_HOST_STYLE}>
              <FileDiff
                fileDiff={fileDiff}
                options={dark ? DARK_OPTIONS : LIGHT_OPTIONS}
                className="w-full"
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// All-Changes loading placeholder: pulsing cards shaped like the diff cards.
export function ReplicaDiffSkeleton() {
  return (
    <div className="h-full space-y-3 overflow-hidden bg-background p-3" aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} className="overflow-hidden rounded-lg border border-border">
          <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
            <div className="h-3.5 w-3.5 animate-pulse rounded bg-muted-foreground/20" />
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted-foreground/20" />
            <div className="ml-auto h-3 w-12 animate-pulse rounded bg-muted-foreground/15" />
          </div>
          <div className="space-y-2 p-3">
            {Array.from({ length: 5 + i }).map((_, row) => (
              <div key={row} className="flex items-center gap-3">
                <div className="h-3 w-6 animate-pulse rounded bg-muted-foreground/10" />
                <div
                  className="h-3 animate-pulse rounded bg-muted-foreground/15"
                  style={{ width: `${45 + ((row * 13) % 45)}%` }}
                />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
