import type { Meta, StoryObj } from '@storybook/react';
import { useMemo, useRef, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import type { DiffLineAnnotation } from '@pierre/diffs';
import { DiffViewer } from '../ui/diff-viewer/diff-viewer';
import { DiffFileHeaderActions } from '../ui/diff-viewer/diff-file-header-actions';
import { SessionCommentAddButton } from '../ui/diff-viewer/session-comment-add-button';
import { SessionCommentAnnotation } from '../ui/diff-viewer/session-comment-annotation';
import type {
  CommentAnchor,
  CommentAnnotationMeta,
  DiffViewerCommentCallbacks,
  GitHubReviewComment,
  GitHubReviewThread,
} from '../ui/diff-viewer/session-comment-types';
import { themeColors } from '../style/theme-colors.stylex';
import { themeSpace } from '../style/theme-scale.stylex';

const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: themeSpace[4],
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  column: { width: 760, maxWidth: '100%' },
  controls: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: themeSpace[2],
    marginBottom: themeSpace[4],
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: themeSpace[3],
    padding: themeSpace[3],
    border: `1px solid ${themeColors.border}`,
  },
  path: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 },
  buttons: { display: 'flex', alignItems: 'center', gap: themeSpace[5] },
  codeParent: {
    fontFamily: 'var(--font-mono)',
    fontSize: 11,
    border: `1px solid ${themeColors.border}`,
  },
});
const path = 'src/synthetic/评论与特殊值/very-long-nested-component-path.tsx';
const anchor: CommentAnchor = {
  anchorType: 'diff',
  path,
  side: 'additions',
  lineNumber: 2,
  lineContent: 'export const count = 2;',
};
const annotation: DiffLineAnnotation<CommentAnnotationMeta> = {
  side: 'additions',
  lineNumber: 2,
  metadata: { key: 'additions-2', kind: 'github-thread', source: 'github' },
};
const hunk =
  '@@ -1,3 +1,4 @@\n export const heading = "Synthetic";\n-export const count = 1;\n+export const count = 2;\n export const enabled = true;\n+export const ready = true;';
function comment(id: number, body: string): GitHubReviewComment {
  return {
    id,
    nodeId: `synthetic-${id}`,
    pullRequestReviewId: 1,
    body,
    path,
    commitId: 'synthetic-new',
    originalCommitId: 'synthetic-old',
    diffHunk: hunk,
    subjectType: 'line',
    user: { login: `reviewer-${id}`, id, avatarUrl: '', htmlUrl: 'https://example.com/synthetic' },
    authorAssociation: 'MEMBER',
    createdAt: '2026-10-01T09:00:00Z',
    updatedAt: '2026-10-01T09:00:00Z',
    htmlUrl: `https://example.com/synthetic/thread-${id}`,
    line: 2,
    originalLine: 2,
    side: 'RIGHT',
    startLine: null,
    originalStartLine: null,
    startSide: null,
  };
}
const threads: GitHubReviewThread[] = [
  {
    id: 101,
    anchor: { path, line: 2, side: 'RIGHT' },
    comments: [
      comment(101, '请保留原有间距。 **Keep the existing layout** and `inline code`.'),
      comment(102, 'A second reply verifies the real thread layout.'),
    ],
    outdated: false,
    diffHunk: hunk,
    subjectType: 'line',
  },
  {
    id: 201,
    anchor: { path, line: 2, side: 'RIGHT' },
    comments: [
      comment(201, 'Second thread on the same line.\n\n- Preserve wrapping\n- Preserve typography'),
    ],
    outdated: true,
    diffHunk: hunk,
    subjectType: 'line',
  },
];

function HeaderFixture({
  copyOnly = false,
  empty = false,
  overrides = false,
}: {
  copyOnly?: boolean;
  empty?: boolean;
  overrides?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [pointerBubbles, setPointerBubbles] = useState(0);
  const [action, setAction] = useState('Ready');
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.column)}>
        <div
          data-header-host
          {...stylex.props(styles.header)}
          onClick={() => setCollapsed((v) => !v)}
          onPointerDown={() => setPointerBubbles((v) => v + 1)}
        >
          <span {...stylex.props(styles.path)}>{empty ? '(empty path)' : path}</span>
          <DiffFileHeaderActions
            path={empty ? '' : path}
            className={overrides ? 'gap-3 p-2' : undefined}
            onOpenFile={copyOnly ? undefined : (value) => setAction(`Opened: ${value}`)}
          />
        </div>
        {!collapsed && (
          <p data-header-content>Header content stays open when an action is activated.</p>
        )}
        <output
          data-header-output
        >{`${action} · collapsed=${collapsed} · parent pointerdowns=${pointerBubbles}`}</output>
      </div>
    </div>
  );
}
function AddFixture() {
  const [action, setAction] = useState('Ready');
  const [parentClicks, setParentClicks] = useState(0);
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.buttons)} onClick={() => setParentClicks((v) => v + 1)}>
          <div data-add-default>
            <SessionCommentAddButton onClick={() => setAction('Default add activated')} />
          </div>
          <div data-add-override>
            <SessionCommentAddButton
              className="h-8 w-8"
              onClick={() => setAction('Override add activated')}
            />
          </div>
        </div>
        <output data-add-output>{`${action} · parent clicks=${parentClicks}`}</output>
      </div>
    </div>
  );
}
function AnnotationFixture({
  empty = false,
  noDraft = false,
  anonymous = false,
  pending = false,
}: {
  empty?: boolean;
  noDraft?: boolean;
  anonymous?: boolean;
  pending?: boolean;
}) {
  const [visible, setVisible] = useState(!noDraft && !empty);
  const [action, setAction] = useState('Ready');
  const complete = useRef<(() => void) | null>(null);
  const callbacks = useMemo<DiffViewerCommentCallbacks>(
    () => ({
      onReplyGitHubThread: (input) => {
        setAction(`Reply: ${input.body}`);
      },
      onCreateThreadToGitHub: (input) => {
        setAction(`Submitted: ${input.body}`);
        return pending
          ? new Promise<void>((resolve) => {
              complete.current = resolve;
            })
          : undefined;
      },
      onSendToChat: () => {
        setAction('Sent synthetic reference');
        return true;
      },
    }),
    [pending]
  );
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.column)}>
        <div {...stylex.props(styles.controls)}>
          <Button onClick={() => setVisible((v) => !v)}>Toggle draft</Button>
          {pending && (
            <Button
              onClick={() => {
                complete.current?.();
                complete.current = null;
              }}
            >
              Complete request
            </Button>
          )}
          <output data-annotation-output>{action}</output>
        </div>
        <div {...stylex.props(styles.codeParent)} data-annotation-parent>
          <SessionCommentAnnotation
            annotation={annotation}
            currentUser={
              anonymous
                ? null
                : { id: 'synthetic-author', name: 'Synthetic author 中文', image: null }
            }
            prLinked={!anonymous}
            draft={visible ? { anchor } : null}
            getGitHubThreadsAtLine={() => (empty ? [] : threads)}
            callbacks={callbacks}
            onCancelDraft={() => {
              setVisible(false);
              setAction('Draft closed');
            }}
          />
        </div>
      </div>
    </div>
  );
}
function SlottedFixture({ split = false }: { split?: boolean }) {
  const [action, setAction] = useState('Ready');
  const callbacks = useMemo<DiffViewerCommentCallbacks>(
    () => ({
      onReplyGitHubThread: (input) => {
        setAction(`Reply: ${input.body}`);
      },
      onCreateThreadToGitHub: (input) => {
        setAction(`Submitted: ${input.body}`);
      },
      onSendToChat: () => {
        setAction('Sent synthetic reference');
        return true;
      },
    }),
    []
  );
  return (
    <div {...stylex.props(styles.canvas)}>
      <div {...stylex.props(styles.column)}>
        <output data-slotted-output>{action}</output>
        <DiffViewer
          path={path}
          oldText={
            'export const heading = "Synthetic";\nexport const count = 1;\nexport const enabled = true;\n'
          }
          newText={
            'export const heading = "Synthetic";\nexport const count = 2;\nexport const enabled = true;\nexport const ready = true;\n'
          }
          diffStyle={split ? 'split' : 'unified'}
          commentsEnabled
          currentUser={{ id: 'synthetic-author', name: 'Synthetic author 中文', image: null }}
          prLinked
          githubThreads={threads}
          commentCallbacks={callbacks}
          onOpenFile={(value) => setAction(`Opened: ${value}`)}
          cachePrerenderedHtml={false}
        />
      </div>
    </div>
  );
}
const meta = {
  title: 'UI/DiffLeavesMigration',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const HeaderActions: Story = { render: () => <HeaderFixture /> };
export const CopyOnly: Story = { render: () => <HeaderFixture copyOnly /> };
export const EmptyPath: Story = { render: () => <HeaderFixture empty /> };
export const HeaderOverrides: Story = { render: () => <HeaderFixture overrides /> };
export const AddButtons: Story = { render: () => <AddFixture /> };
export const AnnotationStack: Story = { render: () => <AnnotationFixture /> };
export const AnnotationThreads: Story = { render: () => <AnnotationFixture noDraft /> };
export const AnnotationEmpty: Story = { render: () => <AnnotationFixture empty /> };
export const AnnotationAnonymous: Story = { render: () => <AnnotationFixture anonymous /> };
export const AnnotationPending: Story = { render: () => <AnnotationFixture pending /> };
export const SlottedUnified: Story = { render: () => <SlottedFixture /> };
export const SlottedSplit: Story = { render: () => <SlottedFixture split /> };
