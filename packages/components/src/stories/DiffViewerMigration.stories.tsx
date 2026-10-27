import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { DiffViewer, type DiffViewerProps } from '../ui/diff-viewer/diff-viewer';
import type { DiffTextChunkSource } from '../lib/diff-text-chunk-source';
import type { GitHubReviewThread } from '../ui/diff-viewer/session-comment-types';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    padding: themeSpace[4],
    minHeight: '100vh',
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  controls: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: themeSpace[2],
    marginBottom: themeSpace[3],
  },
  custom: {
    display: 'flex',
    gap: themeSpace[2],
    padding: themeSpace[2],
    alignItems: 'center',
    minWidth: 0,
  },
  path: {
    flex: '1 1 0%',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
});
const path = 'src/local/diff-migration.ts';
const oldText = `export const title = 'Local workspace';\nexport const count = 1;\n\nexport function summarize(value: number) {\n  const label = 'Original';\n  return label + ': ' + value;\n}\n`;
const newText = `export const title = 'Local workspace';\nexport const count = 2;\n\nexport function summarize(value: number) {\n  const label = 'Reviewed';\n  const suffix = ' ✓';\n  return label + ': ' + value + suffix;\n}\n`;
const longLine = `export const longDescription = '${'保留原始布局 · local-only workspace / '.repeat(24)}';\n`;
const contextOld =
  Array.from({ length: 75 }, (_, i) => `export const local_${i} = ${i};`).join('\n') + '\n';
const contextNew = contextOld
  .replace('local_5 = 5', 'local_5 = 105')
  .replace('local_65 = 65', 'local_65 = 165');
const thread: GitHubReviewThread = {
  id: 41,
  anchor: { path, line: 5, side: 'RIGHT' },
  outdated: false,
  subjectType: 'line',
  diffHunk:
    "@@ -4,3 +4,4 @@\n export function summarize(value: number) {\n-  const label = 'Original';\n+  const label = 'Reviewed';\n+  const suffix = ' ✓';\n",
  comments: [
    {
      id: 401,
      nodeId: 'synthetic-review-comment',
      pullRequestReviewId: null,
      body: 'Keep the original spacing and local workflow.',
      path,
      commitId: 'synthetic',
      originalCommitId: 'synthetic-before',
      subjectType: 'line',
      user: {
        id: 7,
        login: 'local-reviewer',
        avatarUrl: '',
        htmlUrl: 'https://example.invalid/local-reviewer',
      },
      authorAssociation: 'CONTRIBUTOR',
      createdAt: '2026-10-22T08:00:00Z',
      updatedAt: '2026-10-22T08:00:00Z',
      htmlUrl: 'https://example.invalid/review/401',
      line: 5,
      originalLine: 5,
      side: 'RIGHT',
      startLine: null,
      originalStartLine: null,
      startSide: null,
      diffHunk: '@@ -4,3 +4,4 @@\n-Original\n+Reviewed\n',
    },
  ],
};
type Mode =
  | 'unified'
  | 'split'
  | 'long-lines'
  | 'headerless'
  | 'custom'
  | 'collapsed'
  | 'comments'
  | 'responsive'
  | 'error'
  | 'loading'
  | 'caller';
function Fixture({ mode = 'unified' }: { mode?: Mode }) {
  const [action, setAction] = useState('Ready');
  const [open, setOpen] = useState(false);
  const [containerWidth, setContainerWidth] = useState<number | undefined>(undefined);
  const [released, setReleased] = useState(false);
  const gate = useMemo(() => {
    let release: () => void = () => {};
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }, []);
  const source = useMemo<DiffTextChunkSource | undefined>(
    () =>
      mode === 'error' || mode === 'loading'
        ? {
            oldTextLength: oldText.length,
            newTextLength: newText.length,
            readChunk: async ({ side, startOffset, endOffset }) => {
              if (mode === 'error')
                throw new Error(
                  'Synthetic source read failed for a local diff. No network request was made.'
                );
              await gate.promise;
              return (side === 'old' ? oldText : newText).slice(startOffset, endOffset);
            },
          }
        : undefined,
    [mode, gate]
  );
  const props: DiffViewerProps = {
    path:
      mode === 'long-lines'
        ? `src/非常长的本地路径/${'nested-directory/'.repeat(6)}component.ts`
        : path,
    oldText:
      mode === 'long-lines' ? oldText + longLine : mode === 'responsive' ? contextOld : oldText,
    newText:
      mode === 'long-lines'
        ? newText + longLine.replace('local-only', 'offline')
        : mode === 'responsive'
          ? contextNew
          : newText,
    diffStyle: mode === 'split' ? 'split' : mode === 'responsive' ? undefined : 'unified',
    responsiveSplit: mode === 'responsive',
    showHeader: mode !== 'headerless',
    options: mode === 'long-lines' ? { overflow: 'scroll' } : undefined,
    cachePrerenderedHtml: false,
    onOpenFile: (value) => setAction(`Opened ${value}`),
    lazyTextDiffSource: source,
    ...(mode === 'collapsed' ? { open, onOpenChange: setOpen, deferRenderUntilOpen: true } : {}),
    ...(mode === 'comments'
      ? {
          commentsEnabled: true,
          githubThreads: [thread],
          currentUser: { id: 'synthetic-user', name: 'Local reviewer' },
          commentCallbacks: {
            onSendToChat: () => {
              setAction('Sent comment to chat');
              return true;
            },
            onCreateThreadToGitHub: () => {
              setAction('Draft submitted');
            },
          },
        }
      : {}),
    ...(mode === 'caller'
      ? { className: 'max-w-[680px] rounded-none border-2 border-primary/40 shadow-none' }
      : {}),
    ...(mode === 'custom'
      ? {
          renderHeader: ({ fileName, additions, deletions, CollapseToggle }) => (
            <div {...stylex.props(styles.custom)} data-diff-custom-header>
              <CollapseToggle />
              <span {...stylex.props(styles.path)}>{fileName}</span>
              <span>
                +{additions} / -{deletions}
              </span>
            </div>
          ),
        }
      : {}),
  };
  return (
    <div {...stylex.props(styles.canvas)} data-diff-migration={mode}>
      <div {...stylex.props(styles.controls)}>
        <output aria-label="Diff action">{action}</output>
        {mode === 'collapsed' && (
          <output aria-label="Controlled diff state">{open ? 'Open' : 'Closed'}</output>
        )}
        {mode === 'responsive' && (
          <>
            <Button onClick={() => setContainerWidth(1023)}>Container 1023</Button>
            <Button onClick={() => setContainerWidth(1024)}>Container 1024</Button>
            <Button onClick={() => setContainerWidth(undefined)}>Fit container</Button>
          </>
        )}
        {mode === 'loading' && (
          <Button
            disabled={released}
            onClick={() => {
              gate.release();
              setReleased(true);
            }}
          >
            Release local text
          </Button>
        )}
      </div>
      <div
        data-diff-width-host
        style={containerWidth === undefined ? undefined : { width: containerWidth }}
      >
        <DiffViewer {...props} />
      </div>
    </div>
  );
}
const meta = {
  title: 'UI/DiffViewerMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unified: Story = { render: () => <Fixture /> };
export const Split: Story = { render: () => <Fixture mode="split" /> };
export const LongLines: Story = { render: () => <Fixture mode="long-lines" /> };
export const Headerless: Story = { render: () => <Fixture mode="headerless" /> };
export const CustomHeader: Story = { render: () => <Fixture mode="custom" /> };
export const DeferredCollapsed: Story = { render: () => <Fixture mode="collapsed" /> };
export const Comments: Story = { render: () => <Fixture mode="comments" /> };
export const ResponsiveContext: Story = { render: () => <Fixture mode="responsive" /> };
export const SourceError: Story = { render: () => <Fixture mode="error" /> };
export const SourceLoading: Story = { render: () => <Fixture mode="loading" /> };
export const CallerOverrides: Story = { render: () => <Fixture mode="caller" /> };
