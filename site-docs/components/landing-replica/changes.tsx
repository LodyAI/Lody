import * as stylex from '@stylexjs/stylex';
import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Copy } from 'lucide-react';
import { parseDiffFromFile } from '@pierre/diffs';
import { FileDiff, type FileDiffProps } from '@pierre/diffs/react';
import './pierre-diffs-element';
import { Button } from './button';
import { FileIcon } from './icons';
import type { ReplicaChangeFile, ReplicaLocale } from './types';

const skeletonPulse = stylex.keyframes({ '50%': { opacity: 0.5 } });

const diffSkeleton = stylex.create({
  root: {
    height: '100%',
    overflow: 'hidden',
    backgroundColor: 'hsl(var(--background))',
    padding: 'calc(var(--spacing) * 3)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 3)',
    },
  },
  rows: {
    padding: 'calc(var(--spacing) * 3)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 2)',
    },
  },
  pulse: {
    animationName: skeletonPulse,
    animationDuration: '2s',
    animationTimingFunction: 'cubic-bezier(0.4,0,0.6,1)',
    animationIterationCount: 'infinite',
    borderRadius: '.25rem',
  },
  glyph: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
    backgroundColor: 'color-mix(in oklab,hsl(var(--muted-foreground)) 20%,transparent)',
  },
  title: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(100% * 1 / 3)',
    backgroundColor: 'color-mix(in oklab,hsl(var(--muted-foreground)) 20%,transparent)',
  },
  count: {
    marginLeft: 'auto',
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 12)',
    backgroundColor: 'color-mix(in oklab,hsl(var(--muted-foreground)) 15%,transparent)',
  },
  lineNumber: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 6)',
    backgroundColor: 'color-mix(in oklab,hsl(var(--muted-foreground)) 10%,transparent)',
  },
  line: {
    height: 'calc(var(--spacing) * 3)',
    backgroundColor: 'color-mix(in oklab,hsl(var(--muted-foreground)) 15%,transparent)',
  },
  full: { width: '100%' },
});

const changesComposition = stylex.create({
  part1: {
    display: 'inline-block',
    'min-width': '2.25rem',
    'text-align': 'right',
    'font-variant-numeric': '   tabular-nums ',
  },
  part2: {
    color: 'hsl(var(--code-added))',
  },
  part3: {
    color: 'hsl(var(--code-removed))',
  },
  part4: {
    height: 'calc(var(--spacing) * 5)',
    'border-radius': '0.25rem',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'font-size': '11px',
    'font-weight': 'var(--font-weight-medium)',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
  },
  part5: {
    'background-color': 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, var(--shadow-sm)',
  },
  part6: {
    color: 'hsl(var(--muted-foreground))',
    '@media (hover: hover)': {
      ':is(*):hover': {
        color: 'hsl(var(--foreground))',
      },
    },
  },
  part7: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    width: '100%',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'var(--spacing)',
    'text-align': 'left',
  },
  part8: {
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'color-mix(in oklab, hsl(var(--hover)) 60%, transparent)',
      },
    },
    ':is(*):focus-visible': {
      'box-shadow':
        '0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(1px + 0px) currentcolor, 0 0 #0000',
      'outline-style': 'none',
    },
  },
  part9: {
    display: 'flex',
    height: 'calc(var(--spacing) * 7)',
    width: '100%',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-md)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'text-align': 'left',
  },
  part10: {
    color: 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
    '@media (hover: hover)': {
      ':is(*):hover': {
        'background-color': 'hsl(var(--hover))',
        color: 'hsl(var(--hover-foreground))',
      },
    },
  },
  part11: {
    ':is(*):focus-visible': {
      'box-shadow':
        '0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(1px + 0px) currentcolor, 0 0 #0000',
      'outline-style': 'none',
    },
  },
});

const changesStylesNative = stylex.create({
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': '0.25rem',
    color: 'hsl(var(--muted-foreground))',
    'transition-property':
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': 'var(--default-transition-duration)',
    '@media (hover: hover)': {
      ':is(*):hover': {
        color: 'hsl(var(--foreground))',
      },
    },
  },
});

const changesStyles = stylex.create({
  stack: {
    display: 'flex',
    height: '100%',
    'flex-direction': 'column',
  },
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 10)',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3)',
  },
  label: {
    'font-size': '11px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wider)',
    color: 'hsl(var(--muted-foreground))',
    'text-transform': 'uppercase',
  },
  row2: {
    display: 'flex',
    'align-items': 'baseline',
    gap: 'var(--spacing)',
    'font-size': '11px',
    'font-variant-numeric': '   tabular-nums ',
  },
  label2: {
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
  },
  row3: {
    'margin-left': 'auto',
    display: 'inline-flex',
    height: 'calc(var(--spacing) * 6)',
    'align-items': 'center',
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    padding: 'calc(var(--spacing) * 0.5)',
    'font-size': '11px',
  },
  frame: {
    position: 'relative',
    'min-height': '0px',
    flex: '1',
    overflow: 'hidden',
  },
  frame2: {
    height: '100%',
    width: '100%',
    'border-radius': 'inherit',
  },
  stack2: {
    display: 'flex',
    'flex-direction': 'column',
    'padding-inline': 'calc(var(--spacing) * 1.5)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  row4: {
    display: 'flex',
  },
  glyph: {
    height: 'calc(var(--spacing) * 3)',
    width: 'calc(var(--spacing) * 3)',
    'flex-shrink': '0',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
    'transition-property': 'transform, translate, scale, rotate',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': '150ms',
    ':is(*):is(:where(.group)[data-state="open"] *)': {
      rotate: '90deg',
    },
  },
  label3: {
    'font-size': '11px',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': '0.08em',
    color: 'hsl(var(--muted-foreground))',
    'text-transform': 'uppercase',
  },
  label4: {
    'font-size': '11px',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 60%, transparent)',
    'font-variant-numeric': '   tabular-nums ',
  },
  section: {
    overflow: 'hidden',
  },
  stack3: {
    'margin-top': 'calc(var(--spacing) * 0.5)',
    display: 'flex',
    'flex-direction': 'column',
    'padding-bottom': 'calc(var(--spacing) * 2)',
  },
  label5: {
    'min-width': '0px',
    flex: '1',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
  row5: {
    'margin-left': 'var(--spacing)',
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'baseline',
    gap: 'var(--spacing)',
    'font-size': '11px',
  },
  frame3: {
    width: '100%',
  },
  stack4: {
    position: 'relative',
    display: 'flex',
    'min-height': 'calc(var(--spacing) * 8)',
    width: '100%',
    'flex-direction': 'column',
    overflow: 'hidden',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground)) 12%, transparent)',
    'background-color': 'hsl(var(--background))',
    'font-size': '0.8rem',
    'box-shadow':
      '0 0 #0000, 0 0 #0000, 0 0 #0000,  0 0 0 calc(0px + 0px) currentcolor, 0 1px 2px hsl(0 0% 0%/0.04)',
    ':is(*):where(.dark, .dark *)': {
      'border-color': 'hsl(var(--border))',
    },
  },
  row6: {
    position: 'relative',
    'inset-inline': '0px',
    'z-index': '20',
    display: 'flex',
    height: 'calc(var(--spacing) * 8)',
    'align-items': 'center',
    'justify-content': 'space-between',
    gap: 'calc(var(--spacing) * 2)',
    'border-radius': '0',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--foreground)) 8%, transparent)',
    'background-color': 'hsl(var(--background))',
    'padding-right': 'calc(var(--spacing) * 4)',
    'padding-left': 'var(--spacing)',
    ':is(*):where(.dark, .dark *)': {
      'border-color': 'hsl(var(--border))',
    },
  },
  row7: {
    display: 'flex',
    'min-width': '0px',
    flex: '1',
    'align-items': 'center',
    gap: 'var(--spacing)',
  },
  label6: {
    'min-width': '0px',
    overflow: 'hidden',
    'text-overflow': 'ellipsis',
    'white-space': 'nowrap',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
  },
  row8: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 0.5)',
  },
  glyph2: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
  row9: {
    display: 'flex',
    'flex-shrink': '0',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
  label7: {
    color: 'hsl(var(--code-added))',
  },
  label8: {
    color: 'hsl(var(--code-removed))',
  },
  section2: {
    position: 'relative',
    'overflow-x': 'auto',
  },
  section3: {
    'padding-bottom': '0px',
  },
  surface: {
    width: '100%',
    'background-color': 'hsl(var(--background))',
  },
  surface2: {
    overflow: 'hidden',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border))',
  },
  row10: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
    'border-bottom-style': 'solid',
    'border-bottom-width': '1px',
    'border-color': 'hsl(var(--border))',
    'background-color': 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 3)',
    'padding-block': 'calc(var(--spacing) * 2)',
  },
  row11: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 3)',
  },
});

const buttonChildStyles = stylex.create({
  icon: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
    'transition-property': 'transform, translate, scale, rotate',
    'transition-timing-function': 'var(--default-transition-timing-function)',
    'transition-duration': '200ms',
  },
});

const buttonStyles = stylex.create({
  file: { height: 'calc(var(--spacing) * 4)', width: 'calc(var(--spacing) * 4)', flexShrink: 0 },
  toggle: {
    height: 'calc(var(--spacing) * 6)',
    width: 'calc(var(--spacing) * 6)',
    backgroundColor: {
      default: null,
      ':hover': { default: null, '@media (hover: hover)': 'transparent' },
    },
  },
});

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
const statColumnStyle = changesComposition.part1;

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
      <span {...stylex.props([statColumnStyle, changesComposition.part2])}>+{add}</span>
      <span {...stylex.props([statColumnStyle, changesComposition.part3])}>−{del}</span>
    </>
  );
}

function SegmentButton({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <button
      type="button"
      {...stylex.props([
        changesComposition.part4,
        active ? changesComposition.part5 : changesComposition.part6,
      ])}
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
    <div data-power-demo-layout="fill" {...stylex.props(changesStyles.stack)}>
      <div {...stylex.props(changesStyles.row)}>
        <span {...stylex.props(changesStyles.label)}>{labels.title}</span>
        {files.length > 0 ? (
          <span {...stylex.props(changesStyles.row2)}>
            <span {...stylex.props(changesStyles.label2)}>{totals.count}</span>
            <AggregateStats add={totals.add} del={totals.del} />
          </span>
        ) : null}
        <div {...stylex.props(changesStyles.row3)}>
          <SegmentButton active>{labels.types}</SegmentButton>
          <SegmentButton active={false}>{labels.files}</SegmentButton>
        </div>
      </div>
      <div {...stylex.props(changesStyles.frame)}>
        <div {...stylex.props(changesStyles.frame2)}>
          <div {...stylex.props(changesStyles.stack2)}>
            {groups.map((group) => (
              <div key={group.category} data-state="open">
                <h3 {...stylex.props(changesStyles.row4)} data-state="open">
                  <button
                    type="button"
                    data-state="open"
                    aria-expanded
                    className={[
                      stylex.props([changesComposition.part7, changesComposition.part8]).className,
                      'group',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <ChevronRight {...stylex.props(changesStyles.glyph)} />
                    <span {...stylex.props(changesStyles.label3)}>
                      {labels.category[group.category]}
                    </span>
                    <span {...stylex.props(changesStyles.label4)}>{group.entries.length}</span>
                    <AggregateStats add={group.add} del={group.del} />
                  </button>
                </h3>
                <div role="region" data-state="open" {...stylex.props(changesStyles.section)}>
                  <ul {...stylex.props(changesStyles.stack3)}>
                    {group.entries.map((file) => (
                      <button
                        key={file.path}
                        type="button"
                        data-id={`change:${file.path}`}
                        className={[
                          stylex.props([
                            changesComposition.part9,
                            changesComposition.part10,
                            changesComposition.part11,
                          ]).className,
                          'group',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                        title={file.path}
                        onClick={() => onOpenFile?.(file.path)}
                      >
                        <FileIcon path={file.path} xstyle={buttonStyles.file} />
                        <span {...stylex.props(changesStyles.label5)}>{basename(file.path)}</span>
                        <span {...stylex.props(changesStyles.row5)}>
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
    <div {...stylex.props(changesStyles.frame3)}>
      <div
        data-state="open"
        data-section-id="diff-viewer"
        // CollapsibleCard base merged with DiffViewer's card chrome.
        {...stylex.props(changesStyles.stack4)}
      >
        <div data-state="open" aria-expanded {...stylex.props(changesStyles.row6)}>
          <Button
            variant="ghost"
            size="icon"
            xstyle={buttonStyles.toggle}
            aria-label="Toggle section"
          >
            <ChevronDown {...stylex.props(buttonChildStyles.icon)} aria-hidden="true" />
          </Button>
          <FileIcon path={file.path} xstyle={buttonStyles.file} />
          <div {...stylex.props(changesStyles.row7)}>
            <span {...stylex.props(changesStyles.label6)} title={file.path}>
              {file.path}
            </span>
            <div {...stylex.props(changesStyles.row8)}>
              <button
                type="button"
                title="Copy file path"
                aria-label="Copy file path"
                className={[stylex.props(changesStylesNative.row).className]
                  .filter(Boolean)
                  .join(' ')}
              >
                <Copy {...stylex.props(changesStyles.glyph2)} aria-hidden="true" />
              </button>
            </div>
          </div>
          {additions > 0 || deletions > 0 ? (
            <div {...stylex.props(changesStyles.row9)}>
              {additions > 0 ? (
                <span {...stylex.props(changesStyles.label7)}>+{additions}</span>
              ) : null}
              {deletions > 0 ? (
                <span {...stylex.props(changesStyles.label8)}>-{deletions}</span>
              ) : null}
            </div>
          ) : null}
        </div>
        <div data-state="open" {...stylex.props(changesStyles.section2)}>
          <div {...stylex.props(changesStyles.section3)}>
            <div
              className={[stylex.props(changesStyles.surface).className, 'lody-pierre-diff']
                .filter(Boolean)
                .join(' ')}
              style={PIERRE_HOST_STYLE}
            >
              <FileDiff
                fileDiff={fileDiff}
                options={dark ? DARK_OPTIONS : LIGHT_OPTIONS}
                className={stylex.props(diffSkeleton.full).className}
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
    <div {...stylex.props(diffSkeleton.root)} aria-hidden="true">
      {[0, 1].map((i) => (
        <div key={i} {...stylex.props(changesStyles.surface2)}>
          <div {...stylex.props(changesStyles.row10)}>
            <div {...stylex.props(diffSkeleton.pulse, diffSkeleton.glyph)} />
            <div {...stylex.props(diffSkeleton.pulse, diffSkeleton.title)} />
            <div {...stylex.props(diffSkeleton.pulse, diffSkeleton.count)} />
          </div>
          <div {...stylex.props(diffSkeleton.rows)}>
            {Array.from({ length: 5 + i }).map((_, row) => (
              <div key={row} {...stylex.props(changesStyles.row11)}>
                <div {...stylex.props(diffSkeleton.pulse, diffSkeleton.lineNumber)} />
                <div
                  {...stylex.props(diffSkeleton.pulse, diffSkeleton.line)}
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
