import {
  buildSessionFileRootMounts,
  toSessionFileDisplayPath,
} from '@/lib/session-file-root-mounts';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import {
  githubCreatePRReviewComment,
  githubFetchPullRequestHeadSha,
  getSessionPullRequestLegacyFields,
  githubReplyPRReviewComment,
  lodyAnchorToGitHubParams,
  type CommentReferencePayload,
  type CommentUser,
  type DiffViewerCommentCallbacks,
  type GitHubReviewComment,
  type GitHubReviewThread,
  type FileDiff,
  type CodeCollabAllChangesScope,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { Toggle } from '@lody/ui/toggle';
import { ToggleGroup } from '@lody/ui/toggle-group';
import { useAtomValue } from 'jotai';
import { usePostHog } from '@posthog/react';
import { toast } from '@/lib/toast';
import { currentWorkspaceIdAtom, userAtom } from '@/atoms';
import { getDurationSinceMs, getPerformanceNowMs } from '@/lib/posthog-analytics';
import {
  captureDiffCommentGithubThreadCreated,
  captureDiffCommentGithubThreadFailed,
  captureDiffCommentSentToChat,
  classifyGithubThreadError,
} from './diff-pr-analytics';
import { DiffViewer } from '@/ui/diff-viewer/diff-viewer';
import { ScrollArea } from '@lody/ui/scroll-area';
import { Skeleton } from '@lody/ui/skeleton';
import { withClassName } from '@/lib/stylex';
import { observeDiffPerfLongTasks } from '@/lib/diff-perf';
import { FileIcon } from '@/components/icons/file-icons';
import { EMPTY_COMMENT_REFERENCE_KEYS } from '@/components/chat/comment-reference-state';
import { areStringArraysEqual } from './session-diff-summary';
import {
  areDiffCommentFocusTargetsEqual,
  arePathsEquivalent,
  type DiffCommentFocusTarget,
  type FileDiffData,
} from './session-conversation-diff-types';
import { useDiffFocusScroll } from './use-diff-focus-scroll';
import { useSessionAllChangesDiffData } from './use-session-all-changes-diff-data';
import { useSessionConversationDiffData } from './use-session-conversation-diff-data';
import { useDiffViewport } from './use-diff-viewport';
import { useGitHubReviewComments } from '@/hooks/use-github-review-comments';
import {
  getPullRequestNumber,
  getPullRequestRepoFullName,
  getSessionGitHubState,
} from '@/lib/session-github-state';
import { GitHubReviewErrorNotice } from './github-review-error-notice';
import { SessionFileDiffNoticeCard } from './session-file-diff-notice-card';
import { DiffFileHeaderActions } from '@/ui/diff-viewer/diff-file-header-actions';
import type { SessionFileProvider } from '@/lib/session-file-provider';

const DIFF_LOAD_SCROLL_PAUSE_MS = 500;
const EMPTY_GITHUB_THREADS: GitHubReviewThread[] = [];
const styles = stylex.create({
  diffCard: {
    width: '100%',
    overflow: 'hidden',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'hsl(var(--background))',
    boxShadow: '0 1px 2px hsl(0 0% 0% / 0.04)',
    borderColor: {
      default: 'hsl(var(--foreground) / 0.12)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'hsl(var(--border))',
    },
  },
  diffCardHeader: {
    display: 'flex',
    height: '32px',
    alignItems: 'center',
    gap: space[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: {
      default: 'hsl(var(--foreground) / 0.08)',
      ':where(.dark, .dark *, .dark-scope, .dark-scope *):not(:where(.light-scope, .light-scope *))':
        'hsl(var(--border))',
    },
    backgroundColor: 'hsl(var(--background))',
    paddingInlineStart: space[1],
    paddingInlineEnd: space[4],
  },
  fileIcon: { width: '16px', height: '16px', flexShrink: 0 },
  filePathRow: {
    display: 'flex',
    minWidth: 0,
    flex: '1 1 0%',
    alignItems: 'center',
    gap: space[1],
  },
  filePath: {
    minWidth: 0,
    overflow: 'hidden',
    color: 'hsl(var(--foreground) / 0.9)',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '14px',
    lineHeight: '20px',
  },
  diffCardHeaderOnly: { borderBottomWidth: 0 },
  skeletonBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: space[1.5],
    paddingBlock: space[3],
    paddingInline: space[4],
  },
  errorMessage: { color: 'hsl(var(--muted-foreground))', fontSize: '12px', lineHeight: '16px' },
  emptyMessage: {
    padding: space[3],
    color: 'hsl(var(--muted-foreground))',
    fontSize: '14px',
    lineHeight: '20px',
  },
  root: { display: 'flex', height: '100%', minHeight: 0, flexDirection: 'column' },
  baseHeader: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: space[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    paddingBlock: space[2],
    paddingInline: space[3],
  },
  baseHeaderLabel: {
    color: 'hsl(var(--muted-foreground))',
    fontSize: '12px',
    lineHeight: '16px',
  },
  baseHeaderValue: {
    color: 'hsl(var(--foreground))',
    fontSize: '12px',
    fontVariantNumeric: 'tabular-nums',
    lineHeight: '16px',
  },
  fileBlock: { width: '100%' },
  deferredBody: { height: '160px' },
  panelContent: {
    overflowAnchor: 'none',
    display: 'flex',
    width: '100%',
    flexDirection: 'column',
    gap: space[4],
    paddingBlock: space[2],
  },
  baseScrollFrame: { minHeight: 0, flex: '1 1 0%', paddingInlineEnd: space[1] },
  baseScrollArea: { height: '100%', overflow: 'hidden' },
  baseScrollContent: { paddingInline: space[3] },
  conversationScroll: {
    minHeight: 0,
    flex: '1 1 0%',
    overflow: 'auto',
    paddingInline: space[3],
  },
});

function FileDiffSkeleton({
  filePath,
  showBody,
  onOpenFile,
  expanded,
}: {
  filePath: string;
  showBody: boolean;
  onOpenFile?: (path: string) => void;
  expanded: boolean;
}) {
  return (
    <div {...stylex.props(styles.diffCard)}>
      <div {...stylex.props(styles.diffCardHeader, !expanded && styles.diffCardHeaderOnly)}>
        <FileIcon filePath={filePath} className={stylex.props(styles.fileIcon).className} />
        <div {...stylex.props(styles.filePathRow)}>
          <span {...stylex.props(styles.filePath)} title={filePath}>
            {filePath}
          </span>
          <DiffFileHeaderActions path={filePath} onOpenFile={onOpenFile} />
        </div>
      </div>
      {expanded &&
        (showBody ? (
          <div {...stylex.props(styles.skeletonBody)}>
            <Skeleton width="100%" height={12} />
            <Skeleton width="91%" height={12} />
            <Skeleton width="80%" height={12} />
            <Skeleton width="100%" height={12} />
            <Skeleton width="75%" height={12} />
          </div>
        ) : (
          <div {...stylex.props(styles.deferredBody)} />
        ))}
    </div>
  );
}

/**
 * How many loading cards may draw a skeleton body. Every skeleton line pulses,
 * and WebKit composites each pulsing element into its own layer, so one body
 * per file turned a diff of a few thousand files into a WebContent process
 * kill on iOS before any diff arrived. The first few open cards fill the
 * screen; the rest use static placeholders.
 */
export const MAX_DIFF_SKELETON_BODIES = 3;

/**
 * The loading cards that draw a skeleton body: only cards that will open (a
 * collapsed card has no body to stand in for), and at most
 * {@link MAX_DIFF_SKELETON_BODIES} of them, in list order.
 */
export function selectDiffSkeletonBodyPaths(input: {
  readonly paths: readonly string[];
  readonly isLoaded: (path: string) => boolean;
  readonly opensByDefault: (path: string) => boolean;
}): ReadonlySet<string> {
  const selected = new Set<string>();
  for (const path of input.paths) {
    if (selected.size >= MAX_DIFF_SKELETON_BODIES) break;
    if (!input.isLoaded(path) && input.opensByDefault(path)) selected.add(path);
  }
  return selected;
}

function getThreadsForPath<T extends { anchor: { path: string } }>(
  byPath: Map<string, T[]>,
  filePath: string
): T[] {
  const direct = byPath.get(filePath);
  if (direct) {
    return direct;
  }
  for (const [candidatePath, candidateThreads] of byPath) {
    if (arePathsEquivalent(candidatePath, filePath)) {
      return candidateThreads;
    }
  }
  return [];
}

function githubSideToLody(side: 'LEFT' | 'RIGHT'): 'additions' | 'deletions' {
  return side === 'RIGHT' ? 'additions' : 'deletions';
}

function githubReviewCommentToReference(
  comment: GitHubReviewComment,
  fallback: { lineNumber: number; mode?: 'conversation' | 'base'; turnId?: string }
): CommentReferencePayload {
  return {
    source: 'github',
    path: comment.path,
    lineNumber:
      comment.line ??
      comment.originalLine ??
      comment.startLine ??
      comment.originalStartLine ??
      fallback.lineNumber,
    side: githubSideToLody(comment.side),
    commentBody: comment.body,
    authorName: comment.user?.login ?? 'ghost',
    authorImage: comment.user?.avatarUrl,
    replies: [],
    turnId: fallback.turnId,
    mode: fallback.mode,
    githubThreadId: comment.inReplyToId ?? comment.id,
  };
}

function getMatchingPath(paths: string[], filePath?: string | null): string | null {
  if (!filePath) {
    return null;
  }

  const direct = paths.find((path) => path === filePath);
  if (direct) {
    return direct;
  }

  return paths.find((path) => arePathsEquivalent(path, filePath)) ?? null;
}

export function shouldOpenDiffFileByDefault(input: {
  readonly mode: 'conversation' | 'base';
  readonly filePath: string;
  readonly focusFilePath?: string | null;
}): boolean {
  if (input.focusFilePath == null) {
    // A direct turn diff has no file selection and keeps its historical
    // all-files-open view. An unfocused All Changes panel starts collapsed so
    // opening it from the summary does not render every file at once.
    return input.mode === 'conversation';
  }

  // A precise file action is the same interaction in both surfaces: open the
  // requested file and leave unrelated cards collapsed.
  return arePathsEquivalent(input.filePath, input.focusFilePath);
}

export type SessionConversationDiffPanelProps = {
  active?: boolean;
  sessionId: SessionId;
  turnId?: string;
  filePaths: string[];
  fileDiffs?: readonly FileDiff[];
  fileDiffsPending?: boolean;
  focusFilePath?: string | null;
  focusComment?: DiffCommentFocusTarget | null;
  focusRequestSeq?: number;
  mode?: 'conversation' | 'base';
  /** All Changes comparison scope; the panel falls back to `branch` when omitted. */
  allChangesScope?: CodeCollabAllChangesScope;
  /** Whether the target daemon advertises the scope protocol capability. */
  allChangesScopeSupported?: boolean;
  onAllChangesScopeChange?: (scope: CodeCollabAllChangesScope) => void;
  refreshToken?: number;
  session?: SessionMeta | null;
  workspaceSession?: SessionMeta | null;
  onSendToChat?: (reference: CommentReferencePayload) => boolean | void;
  commentReferenceKeys?: readonly string[];
  className?: string;
  fileProvider?: SessionFileProvider | null;
  fileProviderPending?: boolean;
  onOpenFile?: (path: string) => void;
};

type DiffFileBlockProps = {
  renderContent: boolean;
  filePath: string;
  data: FileDiffData | undefined;
  defaultOpen: boolean;
  /** Whether a card still loading draws a skeleton body; see {@link selectDiffSkeletonBodyPaths}. */
  showSkeletonBody: boolean;
  commentsEnabled: boolean;
  currentUser: CommentUser | null;
  githubThreads: GitHubReviewThread[];
  prLinked: boolean;
  turnId?: string;
  mode: 'conversation' | 'base';
  cacheKey: string | null;
  commentCallbacks: DiffViewerCommentCallbacks;
  commentReferenceKeys: readonly string[];
  onCommentError: (error: unknown) => void;
  onOpenFile?: (path: string) => void;
};

export function createConversationDiffViewerParseCacheKey(input: {
  readonly mode: 'conversation' | 'base';
  readonly cacheKey: string | null;
  readonly filePath: string;
}): string | undefined {
  return input.mode === 'conversation' && input.cacheKey
    ? `${input.cacheKey}:${input.filePath}`
    : undefined;
}

const DiffFileBlock = memo(function DiffFileBlock({
  renderContent,
  filePath,
  data,
  defaultOpen,
  showSkeletonBody,
  commentsEnabled,
  currentUser,
  githubThreads,
  prLinked,
  turnId,
  mode,
  cacheKey,
  commentCallbacks,
  commentReferenceKeys,
  onCommentError,
  onOpenFile,
}: DiffFileBlockProps) {
  const { t } = useTranslation();
  const diffViewerParseCacheKey = createConversationDiffViewerParseCacheKey({
    mode,
    cacheKey,
    filePath,
  });

  if (!data) {
    return (
      <FileDiffSkeleton
        filePath={filePath}
        onOpenFile={onOpenFile}
        expanded={defaultOpen}
        showBody={showSkeletonBody}
      />
    );
  }

  if (data.status === 'error') {
    return <div {...stylex.props(styles.errorMessage)}>{data.message}</div>;
  }

  if (data.status === 'ready-parsed') {
    return (
      <DiffViewer
        preferParseWorker
        renderContent={renderContent}
        key={`${mode}:${defaultOpen ? 'open' : 'closed'}`}
        path={filePath}
        oldText=""
        newText=""
        preparsedDiff={data.fileDiff}
        preparsedOldTextLength={data.oldTextLength}
        preparsedNewTextLength={data.newTextLength}
        commentsEnabled={commentsEnabled}
        currentUser={currentUser}
        githubThreads={githubThreads}
        prLinked={prLinked}
        turnId={turnId}
        mode={mode}
        commentCallbacks={commentCallbacks}
        commentReferenceKeys={commentReferenceKeys}
        onCommentError={onCommentError}
        onOpenFile={onOpenFile}
        defaultOpen={defaultOpen}
        deferRenderUntilOpen
        parseCacheKey={diffViewerParseCacheKey}
        cachePrerenderedHtml={false}
      />
    );
  }

  if (data.status === 'ready-text-source') {
    return (
      <DiffViewer
        preferParseWorker
        renderContent={renderContent}
        key={`${mode}:${defaultOpen ? 'open' : 'closed'}`}
        path={filePath}
        oldText=""
        newText=""
        lazyTextDiffSource={data.source}
        commentsEnabled={commentsEnabled}
        currentUser={currentUser}
        githubThreads={githubThreads}
        prLinked={prLinked}
        turnId={turnId}
        mode={mode}
        commentCallbacks={commentCallbacks}
        commentReferenceKeys={commentReferenceKeys}
        onCommentError={onCommentError}
        onOpenFile={onOpenFile}
        defaultOpen={defaultOpen}
        deferRenderUntilOpen
        parseCacheKey={diffViewerParseCacheKey}
        cachePrerenderedHtml={false}
      />
    );
  }

  if (data.oldSnapshot.kind === 'binary' || data.newSnapshot.kind === 'binary') {
    return (
      <SessionFileDiffNoticeCard
        filePath={filePath}
        message={t(
          'sessions.fileDiff.binary.message',
          "This file is binary and can't be diffed yet."
        )}
        onOpenFile={onOpenFile}
      />
    );
  }

  if (data.newSnapshot.kind === 'large' || data.oldSnapshot.kind === 'large') {
    return (
      <SessionFileDiffNoticeCard
        filePath={filePath}
        message={t('sessions.fileDiff.large.message', 'This file is too large (>1MB) to diff.')}
        onOpenFile={onOpenFile}
      />
    );
  }

  if (data.newSnapshot.kind === 'filtered' || data.oldSnapshot.kind === 'filtered') {
    return (
      <SessionFileDiffNoticeCard
        filePath={filePath}
        message={t(
          'sessions.fileDiff.filtered.message',
          "This file type's diff has been filtered."
        )}
        onOpenFile={onOpenFile}
      />
    );
  }

  return (
    <DiffViewer
      preferParseWorker
      renderContent={renderContent}
      key={`${mode}:${defaultOpen ? 'open' : 'closed'}`}
      path={filePath}
      oldText={data.oldSnapshot.kind === 'text' ? data.oldSnapshot.text : ''}
      newText={data.newSnapshot.kind === 'text' ? data.newSnapshot.text : ''}
      commentsEnabled={commentsEnabled}
      currentUser={currentUser}
      githubThreads={githubThreads}
      prLinked={prLinked}
      turnId={turnId}
      mode={mode}
      commentCallbacks={commentCallbacks}
      commentReferenceKeys={commentReferenceKeys}
      onCommentError={onCommentError}
      onOpenFile={onOpenFile}
      defaultOpen={defaultOpen}
      deferRenderUntilOpen
      responsiveSplit
      cachePrerenderedHtml={false}
      parseCacheKey={diffViewerParseCacheKey}
    />
  );
});

DiffFileBlock.displayName = 'DiffFileBlock';

function SessionConversationDiffPanelImpl({
  active = true,
  sessionId,
  turnId,
  filePaths: rawFilePaths,
  fileDiffs: rawFileDiffs,
  fileDiffsPending,
  focusFilePath: rawFocusFilePath,
  focusComment,
  focusRequestSeq,
  mode = 'conversation',
  allChangesScope,
  allChangesScopeSupported = false,
  onAllChangesScopeChange,
  refreshToken: _refreshToken,
  session,
  workspaceSession,
  onSendToChat,
  commentReferenceKeys = EMPTY_COMMENT_REFERENCE_KEYS,
  className,
  fileProvider,
  fileProviderPending,
  onOpenFile,
}: SessionConversationDiffPanelProps) {
  const { t } = useTranslation();
  const postHog = usePostHog();
  const currentWorkspaceId = useAtomValue(currentWorkspaceIdAtom);
  const user = useAtomValue(userAtom);
  // Turn diffs of Project group members outside the main directory are
  // recorded under encoded keys. Shown, matched and opened as display paths;
  // the file provider splits them back into `rootId` for the machine.
  const projectRun = (workspaceSession ?? session)?.projectRun;
  const mounts = useMemo(() => buildSessionFileRootMounts(projectRun), [projectRun]);
  const filePaths = useMemo(
    () =>
      mounts.length === 0 && !rawFilePaths.some((path) => path.startsWith('\0'))
        ? rawFilePaths
        : rawFilePaths.map((path) => toSessionFileDisplayPath(path, mounts)),
    [mounts, rawFilePaths]
  );
  const fileDiffs = useMemo(
    () =>
      rawFileDiffs?.some((diff) => diff.filePath.startsWith('\0'))
        ? rawFileDiffs.map((diff) => ({
            ...diff,
            filePath: toSessionFileDisplayPath(diff.filePath, mounts),
          }))
        : rawFileDiffs,
    [mounts, rawFileDiffs]
  );
  const focusFilePath =
    rawFocusFilePath?.startsWith('\0') === true
      ? toSessionFileDisplayPath(rawFocusFilePath, mounts)
      : rawFocusFilePath;
  const diffCommentAnalyticsBase = useMemo(
    () => ({ workspaceId: currentWorkspaceId ?? null, sessionId, mode }),
    [currentWorkspaceId, mode, sessionId]
  );
  const currentUser = useMemo<CommentUser | null>(
    () => (user ? { id: user.id, name: user.name, image: user.image ?? null } : null),
    [user]
  );
  const normalizedInputPaths = useMemo(
    () => Array.from(new Set(filePaths.filter(Boolean))).toSorted((a, b) => a.localeCompare(b)),
    [filePaths]
  );
  const [isUserScrolling, setIsUserScrolling] = useState(false);
  const userScrollingRef = useRef(false);
  const userScrollIdleTimeoutRef = useRef<number | null>(null);
  const handleDiffScroll = useCallback(() => {
    if (!userScrollingRef.current) {
      userScrollingRef.current = true;
      setIsUserScrolling(true);
    }

    if (userScrollIdleTimeoutRef.current !== null) {
      clearTimeout(userScrollIdleTimeoutRef.current);
    }

    userScrollIdleTimeoutRef.current = window.setTimeout(() => {
      userScrollIdleTimeoutRef.current = null;
      userScrollingRef.current = false;
      setIsUserScrolling(false);
    }, DIFF_LOAD_SCROLL_PAUSE_MS);
  }, []);

  useEffect(
    () => () => {
      if (userScrollIdleTimeoutRef.current !== null) {
        clearTimeout(userScrollIdleTimeoutRef.current);
      }
    },
    []
  );

  const focusedLoadPath = useMemo(
    () => getMatchingPath(normalizedInputPaths, focusFilePath),
    [focusFilePath, normalizedInputPaths]
  );
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const { loadPaths, registerPath, anchorTarget } = useDiffViewport({
    active,
    paths: normalizedInputPaths,
    priorityPath: focusedLoadPath,
    scrollContainerRef: viewportRef,
  });
  const visiblePaths = useMemo(() => new Set(loadPaths), [loadPaths]);
  // "All Changes" (base) mode loads every file's diff with one batched RPC; conversation/turn
  // mode keeps the per-file loader. Both hooks are called (rules of hooks) but only the active
  // one fetches — the other is gated inert via `enabled`.
  const isBaseMode = mode === 'base';
  const conversationDiffData = useSessionConversationDiffData({
    sessionId,
    turnId,
    filePaths: normalizedInputPaths,
    fileDiffs,
    fileDiffsPending,
    mode,
    priorityFilePath: focusedLoadPath,
    loadFilePaths: loadPaths,
    loadPaused: isUserScrolling,
    fileProvider,
    fileProviderPending,
    enabled: active && !isBaseMode,
  });
  const allChangesDiffData = useSessionAllChangesDiffData({
    sessionId,
    filePaths: normalizedInputPaths,
    loadFilePaths: loadPaths,
    focusPath: focusedLoadPath,
    fileProvider,
    fileProviderPending,
    enabled: active && isBaseMode,
    scope: allChangesScope ?? 'branch',
  });
  const { cacheKey, normalizedPaths, resolvedByPath, isDiffUnavailable } = isBaseMode
    ? allChangesDiffData
    : conversationDiffData;
  const allChangesBase = isBaseMode ? allChangesDiffData.base : null;
  const allChangesUnavailableScopeReason = isBaseMode
    ? allChangesDiffData.unavailableScopeReason
    : null;
  const allChangesUnavailableMessage = isBaseMode ? allChangesDiffData.unavailableMessage : null;
  const allChangesBatchReady = isBaseMode ? allChangesDiffData.batchReady : false;
  const effectiveScope = allChangesScope ?? 'branch';
  const {
    sourceSessionId: prSessionId,
    repoFullName,
    latestPr,
  } = useMemo(
    () => getSessionGitHubState(session ?? null, workspaceSession ?? null),
    [session, workspaceSession]
  );
  const latestPrNumber = getPullRequestNumber(latestPr);
  const githubReviewComments = useGitHubReviewComments({
    sessionId: prSessionId,
    workspaceId: currentWorkspaceId,
    repoFullName: getPullRequestRepoFullName(latestPr) ?? repoFullName,
    prNumber: latestPrNumber,
    enabled: active && normalizedPaths.length > 0 && Boolean(latestPrNumber),
  });
  const {
    threads: githubReviewCommentThreads,
    refresh: refreshGitHubReviewComments,
    runWithToken: runWithGitHubReviewToken,
  } = githubReviewComments;

  useEffect(() => observeDiffPerfLongTasks() ?? undefined, []);

  const isFocusFileResolved = useMemo(() => {
    if (!focusFilePath) return false;
    const direct = resolvedByPath[focusFilePath];
    if (direct) return true;
    return normalizedPaths.some(
      (p) => arePathsEquivalent(p, focusFilePath) && Boolean(resolvedByPath[p])
    );
  }, [focusFilePath, normalizedPaths, resolvedByPath]);

  const githubThreadsByPath = useMemo(() => {
    const byPath = new Map<string, GitHubReviewThread[]>();
    for (const thread of githubReviewCommentThreads) {
      const existing = byPath.get(thread.anchor.path);
      if (existing) {
        existing.push(thread);
      } else {
        byPath.set(thread.anchor.path, [thread]);
      }
    }
    return byPath;
  }, [githubReviewCommentThreads]);

  const isFocusCommentResolved = useMemo(() => {
    if (!focusComment) {
      return true;
    }

    if (focusComment.source !== 'github') {
      return true;
    }

    const threads = getThreadsForPath(githubThreadsByPath, focusComment.path);
    if (focusComment.githubThreadId != null) {
      return threads.some((thread) => thread.id === focusComment.githubThreadId);
    }
    return threads.some(
      (thread) =>
        thread.anchor.line === focusComment.lineNumber &&
        githubSideToLody(thread.anchor.side) === focusComment.side
    );
  }, [focusComment, githubThreadsByPath]);

  const focusCommentForScroll = focusComment?.source === 'github' ? focusComment : null;

  const { scrollContainerRef, registerPathBlock } = useDiffFocusScroll({
    onScrollTarget: anchorTarget,
    focusFilePath,
    focusComment: focusCommentForScroll,
    focusRequestSeq,
    isFocusTargetResolved: active && isFocusFileResolved && isFocusCommentResolved,
    contextKey: cacheKey,
  });
  const pathRefs = useMemo(
    () =>
      new Map(
        normalizedPaths.map((path) => [
          path,
          (node: HTMLDivElement | null) => {
            registerPathBlock(path, node);
            registerPath(path, node);
          },
        ])
      ),
    [normalizedPaths, registerPath, registerPathBlock]
  );
  const setConversationScroll = useCallback(
    (node: HTMLDivElement | null) => {
      viewportRef.current = node;
      scrollContainerRef.current = node;
    },
    [scrollContainerRef]
  );

  const baseViewportScrollCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      baseViewportScrollCleanupRef.current?.();
      baseViewportScrollCleanupRef.current = null;
    },
    []
  );

  const setScrollAreaViewport = useCallback(
    (viewport: HTMLDivElement | null) => {
      baseViewportScrollCleanupRef.current?.();
      baseViewportScrollCleanupRef.current = null;
      if (mode !== 'base') return;
      if (!viewport) {
        scrollContainerRef.current = null;
        viewportRef.current = null;
        return;
      }
      scrollContainerRef.current = viewport instanceof HTMLDivElement ? viewport : null;
      viewportRef.current = scrollContainerRef.current;
      if (viewport instanceof HTMLDivElement) {
        viewport.addEventListener('scroll', handleDiffScroll, { passive: true });
        baseViewportScrollCleanupRef.current = () => {
          viewport.removeEventListener('scroll', handleDiffScroll);
        };
      }
    },
    [handleDiffScroll, mode, scrollContainerRef]
  );

  const resolvePrHeadCommitSha = useCallback(async (): Promise<string> => {
    if (!currentWorkspaceId || !repoFullName || !latestPr || !latestPrNumber) {
      throw new Error('This session is not linked to a GitHub pull request');
    }
    const legacyHeadCommitSha = getSessionPullRequestLegacyFields(latestPr).headCommitSha;
    if (legacyHeadCommitSha?.trim()) {
      return legacyHeadCommitSha.trim();
    }
    return await runWithGitHubReviewToken('read', (token, canonicalRepo) =>
      githubFetchPullRequestHeadSha(token, canonicalRepo, latestPrNumber)
    );
  }, [currentWorkspaceId, latestPr, latestPrNumber, repoFullName, runWithGitHubReviewToken]);

  const addCommentReferenceToChatInput = useCallback(
    (reference: CommentReferencePayload): boolean => {
      if (!onSendToChat) {
        return false;
      }
      const accepted = onSendToChat(reference) !== false;
      captureDiffCommentSentToChat(postHog, diffCommentAnalyticsBase, {
        source: reference.source,
        accepted,
        replyCount: reference.replies?.length ?? 0,
      });
      return accepted;
    },
    [diffCommentAnalyticsBase, onSendToChat, postHog]
  );

  const commentCallbacks = useMemo<DiffViewerCommentCallbacks>(
    () => ({
      onCreateThreadToGitHub: async (input) => {
        if (!currentWorkspaceId || !repoFullName || !latestPr || !latestPrNumber) {
          throw new Error('This session is not linked to a GitHub pull request');
        }
        const startedAt = getPerformanceNowMs();
        try {
          const headCommitSha = await resolvePrHeadCommitSha();
          const position = lodyAnchorToGitHubParams(input.anchor, latestPr, headCommitSha);
          const comment = await runWithGitHubReviewToken('write', (token, canonicalRepo) =>
            githubCreatePRReviewComment(token, canonicalRepo, latestPrNumber, {
              body: input.body,
              path: position.path,
              commitId: position.commit_id,
              line: position.line,
              side: position.side,
            })
          );
          await refreshGitHubReviewComments();
          captureDiffCommentGithubThreadCreated(postHog, diffCommentAnalyticsBase, {
            durationMs: getDurationSinceMs(startedAt),
          });
          addCommentReferenceToChatInput(
            githubReviewCommentToReference(comment, {
              lineNumber: input.anchor.lineNumber,
              mode: input.anchor.mode,
              turnId: input.anchor.turnId,
            })
          );
        } catch (error) {
          captureDiffCommentGithubThreadFailed(postHog, diffCommentAnalyticsBase, {
            errorKind: classifyGithubThreadError(error),
            durationMs: getDurationSinceMs(startedAt),
          });
          throw error;
        }
      },
      onReplyGitHubThread: async (input) => {
        if (!currentWorkspaceId || !repoFullName || !latestPrNumber) {
          throw new Error('This session is not linked to a GitHub pull request');
        }
        await runWithGitHubReviewToken('write', (token, canonicalRepo) =>
          githubReplyPRReviewComment(
            token,
            canonicalRepo,
            latestPrNumber,
            input.githubCommentId,
            input.body
          )
        );
        await refreshGitHubReviewComments();
      },
      onSendToChat: onSendToChat ? addCommentReferenceToChatInput : undefined,
    }),
    [
      addCommentReferenceToChatInput,
      currentWorkspaceId,
      diffCommentAnalyticsBase,
      latestPr,
      latestPrNumber,
      onSendToChat,
      postHog,
      refreshGitHubReviewComments,
      repoFullName,
      resolvePrHeadCommitSha,
      runWithGitHubReviewToken,
    ]
  );

  const handleCommentError = useCallback(
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      toast.error(t('comments.error', 'Failed to save comment'), {
        description: message,
      });
    },
    [t]
  );

  const allChangesBaseValue =
    allChangesBase === null
      ? '…'
      : allChangesBase === 'diff-store'
        ? t('sessions.fileDiff.baseSessionChanges', 'Session changes')
        : /^[0-9a-f]{12,}$/i.test(allChangesBase)
          ? allChangesBase.slice(0, 7)
          : allChangesBase;
  const allChangesBasePrefix =
    effectiveScope === 'uncommitted'
      ? 'HEAD'
      : session?.baseBranch?.trim() || t('sessions.fileDiff.baseBranchFallback', 'Branch base');
  const allChangesBaseLabel =
    allChangesBase === 'diff-store'
      ? allChangesBaseValue
      : `${allChangesBasePrefix} · ${allChangesBaseValue}`;

  const baseHeader = isBaseMode ? (
    <div {...stylex.props(styles.baseHeader)}>
      {allChangesScopeSupported && onAllChangesScopeChange ? (
        <ToggleGroup<CodeCollabAllChangesScope>
          size="mini"
          shape="pill"
          aria-label={t('sessions.fileDiff.scopeLabel', 'Comparison scope')}
          value={[effectiveScope]}
          onValueChange={(value) => {
            const next = value[0];
            if (next) onAllChangesScopeChange(next);
          }}
        >
          <Toggle value="branch">{t('sessions.fileDiff.scopeBranch', 'Branch')}</Toggle>
          <Toggle value="uncommitted">
            {t('sessions.fileDiff.scopeUncommitted', 'Uncommitted')}
          </Toggle>
        </ToggleGroup>
      ) : null}
      <span {...stylex.props(styles.baseHeaderLabel)}>
        {t('sessions.fileDiff.baseLabel', 'Compared with')}
      </span>
      <span {...stylex.props(styles.baseHeaderValue)}>{allChangesBaseLabel}</span>
    </div>
  ) : null;

  const baseEmptyText =
    !isBaseMode || effectiveScope !== 'uncommitted'
      ? null
      : allChangesUnavailableScopeReason !== null || allChangesUnavailableMessage !== null
        ? allChangesUnavailableScopeReason === 'not_a_git_worktree'
          ? t(
              'sessions.fileDiff.scopeUnavailableNotGit',
              'Uncommitted comparison requires a Git worktree.'
            )
          : allChangesUnavailableScopeReason === 'no_commits'
            ? t(
                'sessions.fileDiff.scopeUnavailableNoCommits',
                'This worktree has no commits yet, so there is no HEAD to compare against.'
              )
            : (allChangesUnavailableMessage ??
              t('sessions.fileDiff.unavailable', 'Diff unavailable'))
        : normalizedPaths.length === 0
          ? allChangesBatchReady
            ? t('sessions.fileDiff.noUncommittedChanges', 'No uncommitted changes.')
            : t('sessions.fileDiff.loadingChanges', 'Loading changes…')
          : null;

  if (baseEmptyText !== null) {
    return (
      <div {...withClassName(stylex.props(styles.root), className)}>
        {baseHeader}
        <div {...stylex.props(styles.emptyMessage)}>{baseEmptyText}</div>
      </div>
    );
  }

  if (normalizedPaths.length === 0) {
    return (
      <div {...withClassName(stylex.props(styles.emptyMessage), className)}>
        {t('sessions.fileDiff.selectFile', 'Select a file to view its diff.')}
      </div>
    );
  }

  if (isDiffUnavailable) {
    return (
      <div {...withClassName(stylex.props(styles.emptyMessage), className)}>
        {t('sessions.fileDiff.unavailable', 'Diff unavailable')}
      </div>
    );
  }

  const skeletonBodyPaths = selectDiffSkeletonBodyPaths({
    paths: normalizedPaths,
    isLoaded: (path) => resolvedByPath[path] !== undefined,
    opensByDefault: (path) =>
      visiblePaths.has(path) &&
      shouldOpenDiffFileByDefault({ mode, filePath: path, focusFilePath }),
  });

  const renderFileBlock = (filePath: string) => (
    <div
      key={filePath}
      ref={pathRefs.get(filePath)}
      data-diff-path={filePath}
      {...stylex.props(styles.fileBlock)}
    >
      <DiffFileBlock
        renderContent={visiblePaths.has(filePath)}
        filePath={filePath}
        data={resolvedByPath[filePath]}
        defaultOpen={shouldOpenDiffFileByDefault({ mode, filePath, focusFilePath })}
        showSkeletonBody={skeletonBodyPaths.has(filePath)}
        commentsEnabled={Boolean(latestPrNumber && repoFullName)}
        currentUser={currentUser}
        githubThreads={githubThreadsByPath.get(filePath) ?? EMPTY_GITHUB_THREADS}
        prLinked={Boolean(latestPrNumber && repoFullName)}
        turnId={turnId}
        mode={mode}
        cacheKey={cacheKey}
        commentCallbacks={commentCallbacks}
        commentReferenceKeys={commentReferenceKeys}
        onCommentError={handleCommentError}
        onOpenFile={onOpenFile}
      />
    </div>
  );

  const focusPathOutsideUncommittedScope =
    isBaseMode &&
    effectiveScope === 'uncommitted' &&
    allChangesBatchReady &&
    focusFilePath !== null &&
    focusFilePath !== undefined &&
    !normalizedPaths.some((path) => arePathsEquivalent(path, focusFilePath));

  const panelContent = (
    <div {...stylex.props(styles.panelContent)}>
      {focusPathOutsideUncommittedScope ? (
        <div {...stylex.props(styles.emptyMessage)}>
          {t(
            'sessions.fileDiff.focusNoUncommittedChanges',
            'This file has no uncommitted changes.'
          )}
        </div>
      ) : null}
      {githubReviewComments.error && (
        <GitHubReviewErrorNotice
          message={githubReviewComments.error.message}
          onRetry={() => void refreshGitHubReviewComments()}
        />
      )}
      {normalizedPaths.map(renderFileBlock)}
    </div>
  );

  return (
    <div {...withClassName(stylex.props(styles.root), className)}>
      {mode === 'base' ? (
        <>
          {baseHeader}
          <div {...stylex.props(styles.baseScrollFrame)}>
            <ScrollArea
              viewportRef={setScrollAreaViewport}
              className={stylex.props(styles.baseScrollArea).className}
              visibility="always"
            >
              <div {...stylex.props(styles.baseScrollContent)}>{panelContent}</div>
            </ScrollArea>
          </div>
        </>
      ) : (
        <div
          ref={setConversationScroll}
          {...withClassName(stylex.props(styles.conversationScroll), 'scrollbar-pro')}
          onScroll={handleDiffScroll}
        >
          {panelContent}
        </div>
      )}
    </div>
  );
}

// Content equality, not identity: per-turn fileDiffs come from summary lookups that
// rebuild arrays (`fileDiffsByTurn[turnId] ?? []`), so identity comparison would either
// always re-render (fresh `[]`) or — worse — never re-render once the comparator bails.
// Field set mirrors the hook's `fileDiffCacheKey`, which drives reset/reload.
export const areFileDiffListsEqual = (
  prev: readonly FileDiff[] | undefined,
  next: readonly FileDiff[] | undefined
): boolean => {
  if (prev === next) {
    return true;
  }
  if (prev === undefined || next === undefined || prev.length !== next.length) {
    return false;
  }
  for (let index = 0; index < prev.length; index += 1) {
    const left = prev[index];
    const right = next[index];
    if (!left || !right) {
      return false;
    }
    if (
      left.filePath !== right.filePath ||
      left.add !== right.add ||
      left.del !== right.del ||
      left.cc?.v !== right.cc?.v ||
      left.cc?.fileId !== right.cc?.fileId ||
      left.cc?.opId !== right.cc?.opId ||
      left.cc?.baseOpId !== right.cc?.baseOpId ||
      left.cc?.base !== right.cc?.base ||
      left.cc?.deleted !== right.cc?.deleted
    ) {
      return false;
    }
  }
  return true;
};

export const areSessionConversationDiffPanelPropsEqual = (
  prev: SessionConversationDiffPanelProps,
  next: SessionConversationDiffPanelProps
): boolean =>
  prev.active === next.active &&
  prev.sessionId === next.sessionId &&
  prev.turnId === next.turnId &&
  prev.focusFilePath === next.focusFilePath &&
  areDiffCommentFocusTargetsEqual(prev.focusComment, next.focusComment) &&
  prev.focusRequestSeq === next.focusRequestSeq &&
  prev.mode === next.mode &&
  prev.allChangesScope === next.allChangesScope &&
  prev.allChangesScopeSupported === next.allChangesScopeSupported &&
  prev.onAllChangesScopeChange === next.onAllChangesScopeChange &&
  prev.refreshToken === next.refreshToken &&
  prev.session === next.session &&
  prev.workspaceSession === next.workspaceSession &&
  prev.onSendToChat === next.onSendToChat &&
  prev.fileProvider === next.fileProvider &&
  prev.fileProviderPending === next.fileProviderPending &&
  prev.onOpenFile === next.onOpenFile &&
  prev.fileDiffsPending === next.fileDiffsPending &&
  areFileDiffListsEqual(prev.fileDiffs, next.fileDiffs) &&
  areStringArraysEqual(
    prev.commentReferenceKeys ?? EMPTY_COMMENT_REFERENCE_KEYS,
    next.commentReferenceKeys ?? EMPTY_COMMENT_REFERENCE_KEYS
  ) &&
  prev.className === next.className &&
  areStringArraysEqual(prev.filePaths, next.filePaths);

export const SessionConversationDiffPanel = memo(
  SessionConversationDiffPanelImpl,
  areSessionConversationDiffPanelPropsEqual
);

SessionConversationDiffPanel.displayName = 'SessionConversationDiffPanel';
