'use client';

import type { CSSProperties, ReactNode } from 'react';
import { useMemo, useState, useEffect, useRef, useCallback, useLayoutEffect, memo } from 'react';
import {
  FileDiff,
  WorkerPoolContext,
  type FileDiffProps,
  type WorkerInitializationRenderOptions,
} from '@pierre/diffs/react';
import type { DiffLineAnnotation, FileDiffMetadata, SupportedLanguages } from '@pierre/diffs';
import { parseDiffFromFile } from '@pierre/diffs';
import { useTranslation } from 'react-i18next';

import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronDown, MessageSquare } from 'lucide-react';

import {
  CollapsibleCard,
  CollapsibleCardHeader,
  CollapsibleCardContent,
} from '@/ui/collapsible-card';
import { Button } from '@lody/ui/button';
import { FileIcon } from '@/components/icons/file-icons';

import { getSessionDiffErrorMessage } from '@/lib/session-diff-diagnostics';
import { getDiffPerfNow, isDiffPerfEnabled, logDiffPerfDurationLazy } from '@/lib/diff-perf';
import { observeResizeOnAnimationFrame } from '@/lib/resize-observer';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { DEFAULT_VSCODE_DIFF_THEME_FALLBACK } from '@/lib/vscode-theme';
import { parseDiffInWorker, parseDiffTextSourceInWorker } from '@/lib/diff-parse-worker';
import type { DiffTextChunkSource } from '@/lib/diff-text-chunk-source';
import {
  configureDiffRenderWorkerPool,
  createDiffRenderWorkerPool,
} from '@/ui/diff-viewer/diff-render-worker';
import { useActiveVSCodeDiffThemeName, useResolvedTheme } from '../../theme-provider';
import type {
  CommentAnnotationMeta,
  CommentUser,
  GitHubReviewThread,
  DiffCommentSide,
  DiffViewerCommentCallbacks,
} from './session-comment-types';
import { useSessionComments } from './use-session-comments';
import { SessionCommentAnnotation } from './session-comment-annotation';
import { SessionCommentAddButton } from './session-comment-add-button';
import { isCommentableDiffLineType } from './session-comment-line';
import { EMPTY_COMMENT_REFERENCE_KEYS } from '@/components/chat/comment-reference-state';
import { DiffFileHeaderActions } from './diff-file-header-actions';

/** Minimum container width (in pixels) to auto-switch to split view */
const SPLIT_VIEW_MIN_WIDTH = 1024;
const MAX_PARSED_DIFF_CACHE = 96;
const MAX_PRERENDERED_HTML_CACHE = 24;
const MAX_WORD_LEVEL_LINE_DIFF_PAIRS = 320;
const DIFF_PARSE_WORKER_MIN_TEXT_LENGTH = 200_000;
const parsedDiffCache = new Map<string, FileDiffMetadata>();
const prerenderedHtmlCache = new Map<string, string>();
type DiffLineEnterProps = Parameters<
  NonNullable<NonNullable<FileDiffProps<CommentAnnotationMeta>['options']>['onLineEnter']>
>[0];
type DiffLineClickHandler = NonNullable<
  NonNullable<FileDiffProps<CommentAnnotationMeta>['options']>['onLineClick']
>;

const MemoizedFileDiff = memo(
  function MemoizedFileDiff({
    fileDiff,
    options,
    prerenderedHTML,
    lineAnnotations,
    renderAnnotation,
    renderHoverUtility,
  }: {
    fileDiff: FileDiffMetadata;
    options: FileDiffProps<CommentAnnotationMeta>['options'];
    prerenderedHTML?: string;
    lineAnnotations?: DiffLineAnnotation<CommentAnnotationMeta>[];
    renderAnnotation?: (annotation: DiffLineAnnotation<CommentAnnotationMeta>) => ReactNode;
    renderHoverUtility?: FileDiffProps<CommentAnnotationMeta>['renderHoverUtility'];
  }) {
    return (
      <FileDiff
        fileDiff={fileDiff}
        options={options}
        prerenderedHTML={prerenderedHTML}
        lineAnnotations={lineAnnotations}
        renderAnnotation={renderAnnotation}
        renderHoverUtility={renderHoverUtility}
        className="w-full"
      />
    );
  },
  (prev, next) =>
    prev.fileDiff === next.fileDiff &&
    prev.options === next.options &&
    prev.prerenderedHTML === next.prerenderedHTML &&
    prev.lineAnnotations === next.lineAnnotations &&
    prev.renderAnnotation === next.renderAnnotation &&
    prev.renderHoverUtility === next.renderHoverUtility
);

const readParsedDiffCache = (cacheKey: string): FileDiffMetadata | undefined => {
  const cached = parsedDiffCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  // LRU touch
  parsedDiffCache.delete(cacheKey);
  parsedDiffCache.set(cacheKey, cached);
  return cached;
};

const writeParsedDiffCache = (cacheKey: string, parsed: FileDiffMetadata): void => {
  if (parsedDiffCache.has(cacheKey)) {
    parsedDiffCache.delete(cacheKey);
  }
  parsedDiffCache.set(cacheKey, parsed);
  if (parsedDiffCache.size <= MAX_PARSED_DIFF_CACHE) {
    return;
  }
  const oldestKey = parsedDiffCache.keys().next().value;
  if (oldestKey) {
    parsedDiffCache.delete(oldestKey);
  }
};

const readPrerenderedHtmlCache = (cacheKey: string): string | undefined => {
  const cached = prerenderedHtmlCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  prerenderedHtmlCache.delete(cacheKey);
  prerenderedHtmlCache.set(cacheKey, cached);
  return cached;
};

const writePrerenderedHtmlCache = (cacheKey: string, html: string): void => {
  if (prerenderedHtmlCache.has(cacheKey)) {
    prerenderedHtmlCache.delete(cacheKey);
  }
  prerenderedHtmlCache.set(cacheKey, html);
  if (prerenderedHtmlCache.size <= MAX_PRERENDERED_HTML_CACHE) {
    return;
  }
  const oldestKey = prerenderedHtmlCache.keys().next().value;
  if (oldestKey) {
    prerenderedHtmlCache.delete(oldestKey);
  }
};

/**
 * Hook to track whether we should use split view based on the component's own width.
 * Uses ResizeObserver to monitor the container element.
 * Returns 'split' when the element width >= minWidth, otherwise 'unified'.
 */
function useResponsiveDiffStyle(
  enabled: boolean,
  minWidth: number = SPLIT_VIEW_MIN_WIDTH
): {
  style: 'unified' | 'split';
  containerRef: (node: HTMLElement | null) => void;
} {
  const [style, setStyle] = useState<'unified' | 'split'>('unified');
  const cleanupObserverRef = useRef<(() => void) | null>(null);

  const containerRef = useCallback(
    (node: HTMLElement | null) => {
      // Cleanup previous observer
      if (cleanupObserverRef.current) {
        cleanupObserverRef.current();
        cleanupObserverRef.current = null;
      }

      if (!enabled || !node) return;

      // Create new observer
      cleanupObserverRef.current = observeResizeOnAnimationFrame(node, (entries) => {
        const entry = entries[0];
        if (entry) {
          const width = entry.contentRect.width;
          setStyle(width >= minWidth ? 'split' : 'unified');
        }
      });
    },
    [enabled, minWidth]
  );

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupObserverRef.current?.();
    };
  }, []);

  return { style: enabled ? style : 'unified', containerRef: enabled ? containerRef : () => {} };
}

export interface DiffViewerProps {
  path: string;
  oldText: string;
  newText: string;
  /** Pre-parsed diff metadata for large provider-backed diffs where full text is not on the main thread. */
  preparsedDiff?: FileDiffMetadata;
  preparsedOldTextLength?: number;
  preparsedNewTextLength?: number;
  lazyTextDiffSource?: DiffTextChunkSource;
  /**
   * Diff display style. If not specified and responsiveSplit is true,
   * the style will be automatically determined based on the component's width.
   * @default 'unified'
   */
  diffStyle?: 'unified' | 'split';
  /**
   * When true, automatically switches to split view when the component's width >= 1024px.
   * This is ignored if diffStyle is explicitly set.
   * @default false
   */
  responsiveSplit?: boolean;
  /**
   * Class name for the container
   */
  className?: string;
  /**
   * Whether to show the collapsible header
   * @default true
   */
  showHeader?: boolean;
  /**
   * Whether the default header should stick to the nearest scroll container.
   * Disable this when rendering inside a transformed virtual row.
   * @default true
   */
  stickyHeader?: boolean;
  /**
   * Whether to capture rendered shadow-sm DOM HTML for reuse after remounts.
   * Disable this for virtualized rows where copying large HTML strings can block scrolling.
   * @default true
   */
  cachePrerenderedHtml?: boolean;
  /**
   * FileDiff options passed to @pierre/diffs
   */
  options?: FileDiffProps<undefined>['options'];
  /**
   * Custom header render function. Receives fileName, full path, line stats, and a CollapseToggle component.
   * The CollapseToggle can be placed anywhere in your custom header to control collapse state.
   */
  renderHeader?: (info: {
    fileName: string;
    path: string;
    additions: number;
    deletions: number;
    CollapseToggle: React.FC<{ className?: string }>;
  }) => ReactNode;
  /**
   * Whether the collapsible card is open by default (uncontrolled mode)
   * @default true
   */
  defaultOpen?: boolean;
  /**
   * Controlled open state. If provided, the component becomes controlled.
   */
  open?: boolean;
  /**
   * Callback when open state changes (for controlled mode)
   */
  onOpenChange?: (open: boolean) => void;
  /**
   * Defer heavy diff parsing/rendering until the card is opened for the first time.
   * Works only when header/collapsible UI is enabled.
   * @default false
   */
  deferRenderUntilOpen?: boolean;
  /** Optional stable key for cross-mount parsed diff cache reuse. */
  parseCacheKey?: string;

  // --- Session comment props (all optional — no-op when omitted) ---

  /** Enable inline comment UI (hover + button, threads, draft) */
  commentsEnabled?: boolean;
  /** Current user info for authoring comments */
  currentUser?: CommentUser | null;
  /** GitHub PR review threads for this file (read-only display) */
  githubThreads?: GitHubReviewThread[];
  /** Whether a PR is linked (controls "Sync to GitHub" checkbox) */
  prLinked?: boolean;
  /** Turn ID for conversation-mode diffs */
  turnId?: string;
  /** Diff mode */
  mode?: 'conversation' | 'base';
  /** Comment action callbacks */
  commentCallbacks?: DiffViewerCommentCallbacks;
  /** Comment references currently attached to the chat input, keyed by comment identity. */
  commentReferenceKeys?: readonly string[];
  /** Called when an async comment action fails. */
  onCommentError?: (error: unknown) => void;
  /**
   * Open this file in a file-preview viewer. When provided, the default
   * header shows an "Open file" button next to the path.
   */
  onOpenFile?: (path: string) => void;
}

/**
 * Compute extension from file path
 */
function getExtensionFromPath(filePath: string): string | undefined {
  const lastDot = filePath.lastIndexOf('.');
  if (lastDot === -1 || lastDot === filePath.length - 1) {
    return undefined;
  }
  return filePath.slice(lastDot + 1).toLowerCase();
}

/**
 * Get file name from path for display
 */
function getFileNameFromPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? filePath;
}

function createParsedDiffCacheKey(
  parseCacheKey: string | undefined,
  oldTextLength: number,
  newTextLength: number
): string | null {
  return parseCacheKey === undefined ? null : `${parseCacheKey}:${oldTextLength}:${newTextLength}`;
}

function createDiffParseRequestKey(input: {
  readonly path: string;
  readonly oldText: string;
  readonly newText: string;
  readonly oldTextLength?: number;
  readonly newTextLength?: number;
  readonly parseCacheKey?: string;
}): string {
  const oldTextLength = input.oldTextLength ?? input.oldText.length;
  const newTextLength = input.newTextLength ?? input.newText.length;
  const cacheKey = createParsedDiffCacheKey(input.parseCacheKey, oldTextLength, newTextLength);
  if (cacheKey !== null) {
    return cacheKey;
  }
  return [
    input.path,
    oldTextLength,
    sampleTextForDiffParseKey(input.oldText),
    newTextLength,
    sampleTextForDiffParseKey(input.newText),
  ].join('\0');
}

function sampleTextForDiffParseKey(text: string): string {
  if (text.length <= 384) {
    return text;
  }
  const midpoint = Math.floor(text.length / 2);
  return `${text.slice(0, 128)}\0${text.slice(midpoint, midpoint + 128)}\0${text.slice(-128)}`;
}

/**
 * A collapse toggle button that can be used in custom headers.
 * Must be used inside a Collapsible.Root context.
 */
function CollapseToggle({ className }: { className?: string }) {
  return (
    <Collapsible.Trigger asChild>
      <Button variant="ghost" size="mini" icon className={cn('shrink-0', className)}>
        <ChevronDown className="h-4 w-4 transition-transform duration-200 [[data-state=closed]_&]:-rotate-90" />
      </Button>
    </Collapsible.Trigger>
  );
}

function DiffViewerErrorState({ message }: { message: string }) {
  const { t } = useTranslation();

  return (
    <div className="px-4 py-3">
      <div className="text-sm font-medium text-foreground">
        {t('sessions.fileDiff.unavailable', 'Diff unavailable')}
      </div>
      <div className="mt-1 break-words text-xs text-muted-foreground">{message}</div>
    </div>
  );
}

function DiffViewerLoadingState({ path }: { path: string }) {
  const { t } = useTranslation();

  return (
    <div className="px-4 py-3">
      <div className="text-sm font-medium text-foreground">
        {t('sessions.fileDiff.preparingLargeDiff', 'Preparing large diff')}
      </div>
      <div className="mt-1 break-words text-xs text-muted-foreground">
        {t(
          'sessions.fileDiff.preparingLargeDiffDescription',
          'The diff for {{path}} is being parsed off the main thread.',
          { path }
        )}
      </div>
    </div>
  );
}

type WorkerParsedDiffState =
  | {
      readonly status: 'loading';
      readonly requestKey: string;
    }
  | {
      readonly status: 'ready';
      readonly requestKey: string;
      readonly fileDiff: FileDiffMetadata;
    }
  | {
      readonly status: 'error';
      readonly requestKey: string;
      readonly message: string;
    };

function DiffRenderWorkerProvider({
  children,
  renderOptions,
}: {
  readonly children: ReactNode;
  readonly renderOptions: WorkerInitializationRenderOptions;
}) {
  const workerPool = useMemo(() => createDiffRenderWorkerPool(renderOptions), [renderOptions]);

  useEffect(() => {
    if (workerPool === undefined) {
      return;
    }
    void configureDiffRenderWorkerPool(workerPool, renderOptions).catch((error: unknown) => {
      console.warn('[DiffViewer] Failed to update diff render worker options:', error);
    });
  }, [renderOptions, workerPool]);

  return <WorkerPoolContext.Provider value={workerPool}>{children}</WorkerPoolContext.Provider>;
}

function DiffViewerImpl({
  path,
  oldText,
  newText,
  preparsedDiff,
  preparsedOldTextLength,
  preparsedNewTextLength,
  lazyTextDiffSource,
  diffStyle,
  responsiveSplit = false,
  className,
  showHeader = true,
  // stickyHeader remains on DiffViewerProps for API compatibility, but sticky is
  // forced off below so overflow-hidden can clip the rounded card border.
  cachePrerenderedHtml = true,
  options,
  renderHeader,
  defaultOpen = true,
  open,
  onOpenChange,
  deferRenderUntilOpen = false,
  parseCacheKey,
  commentsEnabled = false,
  currentUser,
  githubThreads,
  prLinked,
  turnId,
  mode,
  commentCallbacks,
  commentReferenceKeys = EMPTY_COMMENT_REFERENCE_KEYS,
  onCommentError,
  onOpenFile,
}: DiffViewerProps) {
  const renderStartedAt = isDiffPerfEnabled() ? getDiffPerfNow() : 0;
  const resolvedTheme = useResolvedTheme();
  const activeDiffThemeName = useActiveVSCodeDiffThemeName();
  const isMobile = useIsMobile();
  // Use responsive style when diffStyle is not explicitly set and responsiveSplit is enabled
  const { style: responsiveStyle, containerRef } = useResponsiveDiffStyle(
    responsiveSplit && diffStyle === undefined
  );
  const effectiveDiffStyle = diffStyle ?? responsiveStyle;
  const diffHostRef = useRef<HTMLDivElement | null>(null);
  const isControlledOpen = open !== undefined;
  const [internalOpen, setInternalOpen] = useState<boolean>(defaultOpen);
  const [hasEverOpened, setHasEverOpened] = useState<boolean>(
    isControlledOpen ? Boolean(open) : defaultOpen
  );
  const isOpen = isControlledOpen ? Boolean(open) : internalOpen;
  const shouldRenderDiff = !deferRenderUntilOpen || !showHeader || isOpen || hasEverOpened;
  const effectiveOldTextLength =
    lazyTextDiffSource?.oldTextLength ?? preparsedOldTextLength ?? oldText.length;
  const effectiveNewTextLength =
    lazyTextDiffSource?.newTextLength ?? preparsedNewTextLength ?? newText.length;
  const parsedDiffCacheKey = useMemo(
    () => createParsedDiffCacheKey(parseCacheKey, effectiveOldTextLength, effectiveNewTextLength),
    [effectiveNewTextLength, effectiveOldTextLength, parseCacheKey]
  );
  const diffParseRequestKey = useMemo(
    () =>
      createDiffParseRequestKey({
        path,
        oldText,
        newText,
        oldTextLength: effectiveOldTextLength,
        newTextLength: effectiveNewTextLength,
        parseCacheKey,
      }),
    [effectiveNewTextLength, effectiveOldTextLength, newText, oldText, parseCacheKey, path]
  );
  const shouldUseDiffParseWorker =
    preparsedDiff === undefined &&
    shouldRenderDiff &&
    (lazyTextDiffSource !== undefined ||
      effectiveOldTextLength + effectiveNewTextLength >= DIFF_PARSE_WORKER_MIN_TEXT_LENGTH);
  const [workerParsedDiffState, setWorkerParsedDiffState] = useState<WorkerParsedDiffState | null>(
    null
  );

  useEffect(() => {
    if (isOpen) {
      setHasEverOpened(true);
    }
  }, [isOpen]);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (!isControlledOpen) {
        setInternalOpen(nextOpen);
      }
      if (nextOpen) {
        setHasEverOpened(true);
      }
      onOpenChange?.(nextOpen);
    },
    [isControlledOpen, onOpenChange]
  );

  useEffect(() => {
    if (!shouldRenderDiff || !shouldUseDiffParseWorker) {
      setWorkerParsedDiffState(null);
      return undefined;
    }

    if (parsedDiffCacheKey !== null && readParsedDiffCache(parsedDiffCacheKey) !== undefined) {
      setWorkerParsedDiffState(null);
      return undefined;
    }

    let cancelled = false;
    setWorkerParsedDiffState((current) =>
      current?.status === 'loading' && current.requestKey === diffParseRequestKey
        ? current
        : { status: 'loading', requestKey: diffParseRequestKey }
    );

    const ext = getExtensionFromPath(path) as SupportedLanguages | undefined;
    const parsedPromise =
      lazyTextDiffSource === undefined
        ? parseDiffInWorker({
            path,
            oldText,
            newText,
            lang: ext,
            oldCacheKey: parseCacheKey ? `${parseCacheKey}:old` : undefined,
            newCacheKey: parseCacheKey ? `${parseCacheKey}:new` : undefined,
          })
        : parseDiffTextSourceInWorker({
            path,
            source: lazyTextDiffSource,
            lang: ext,
            oldCacheKey: parseCacheKey ? `${parseCacheKey}:old` : undefined,
            newCacheKey: parseCacheKey ? `${parseCacheKey}:new` : undefined,
          });
    void parsedPromise.then(
      (parsed) => {
        if (cancelled) {
          return;
        }
        if (parsed === undefined) {
          setWorkerParsedDiffState({
            status: 'error',
            requestKey: diffParseRequestKey,
            message: 'Large diff parsing is unavailable in this browser.',
          });
          return;
        }
        if (parsedDiffCacheKey !== null) {
          writeParsedDiffCache(parsedDiffCacheKey, parsed);
        }
        setWorkerParsedDiffState({
          status: 'ready',
          requestKey: diffParseRequestKey,
          fileDiff: parsed,
        });
      },
      (error: unknown) => {
        if (cancelled) {
          return;
        }
        setWorkerParsedDiffState({
          status: 'error',
          requestKey: diffParseRequestKey,
          message: getSessionDiffErrorMessage(error),
        });
      }
    );

    return () => {
      cancelled = true;
    };
  }, [
    diffParseRequestKey,
    lazyTextDiffSource,
    newText,
    oldText,
    parseCacheKey,
    parsedDiffCacheKey,
    path,
    shouldRenderDiff,
    shouldUseDiffParseWorker,
  ]);

  const { fileDiff, parseErrorMessage, isParsingLargeDiff } = useMemo(() => {
    if (!shouldRenderDiff) {
      return { fileDiff: null, parseErrorMessage: null, isParsingLargeDiff: false };
    }
    if (preparsedDiff !== undefined) {
      return { fileDiff: preparsedDiff, parseErrorMessage: null, isParsingLargeDiff: false };
    }
    if (parsedDiffCacheKey) {
      const cached = readParsedDiffCache(parsedDiffCacheKey);
      if (cached) {
        return { fileDiff: cached, parseErrorMessage: null, isParsingLargeDiff: false };
      }
    }

    if (shouldUseDiffParseWorker) {
      if (workerParsedDiffState?.requestKey === diffParseRequestKey) {
        if (workerParsedDiffState.status === 'ready') {
          return {
            fileDiff: workerParsedDiffState.fileDiff,
            parseErrorMessage: null,
            isParsingLargeDiff: false,
          };
        }
        if (workerParsedDiffState.status === 'error') {
          return {
            fileDiff: null,
            parseErrorMessage: workerParsedDiffState.message,
            isParsingLargeDiff: false,
          };
        }
      }
      return { fileDiff: null, parseErrorMessage: null, isParsingLargeDiff: true };
    }

    if (lazyTextDiffSource !== undefined) {
      return {
        fileDiff: null,
        parseErrorMessage: 'Large diff parsing is unavailable in this browser.',
        isParsingLargeDiff: false,
      };
    }

    try {
      const parseStartedAt = getDiffPerfNow();
      const ext = getExtensionFromPath(path);
      const parsed = parseDiffFromFile(
        {
          name: path,
          contents: oldText,
          lang: ext as never,
          cacheKey: parseCacheKey ? `${parseCacheKey}:old` : undefined,
        },
        {
          name: path,
          contents: newText,
          lang: ext as never,
          cacheKey: parseCacheKey ? `${parseCacheKey}:new` : undefined,
        }
      );
      if (parsedDiffCacheKey) {
        writeParsedDiffCache(parsedDiffCacheKey, parsed);
      }
      logDiffPerfDurationLazy(
        'diff:parse',
        parseStartedAt,
        () => ({
          path,
          oldTextLength: oldText.length,
          newTextLength: newText.length,
          hunkCount: parsed.hunks.length,
        }),
        8
      );
      return { fileDiff: parsed, parseErrorMessage: null, isParsingLargeDiff: false };
    } catch (error) {
      const nextParseErrorMessage = getSessionDiffErrorMessage(error);
      return {
        fileDiff: null,
        parseErrorMessage: nextParseErrorMessage,
        isParsingLargeDiff: false,
      };
    }
  }, [
    diffParseRequestKey,
    newText,
    oldText,
    parseCacheKey,
    parsedDiffCacheKey,
    path,
    lazyTextDiffSource,
    preparsedDiff,
    shouldRenderDiff,
    shouldUseDiffParseWorker,
    workerParsedDiffState,
  ]);

  useLayoutEffect(() => {
    logDiffPerfDurationLazy(
      'diff:commit',
      renderStartedAt,
      () => ({
        path,
        oldTextLength: effectiveOldTextLength,
        newTextLength: effectiveNewTextLength,
        hasFileDiff: Boolean(fileDiff),
        hasPreparsedDiff: preparsedDiff !== undefined,
        hasParseError: Boolean(parseErrorMessage),
        diffStyle: effectiveDiffStyle,
        commentsEnabled,
      }),
      16
    );
  });

  useEffect(() => {
    return () => {
      lazyTextDiffSource?.dispose?.();
    };
  }, [lazyTextDiffSource]);

  const fileName = getFileNameFromPath(path);

  // Compute line stats from hunks
  const { additions, deletions } = useMemo(() => {
    if (fileDiff === null) {
      return { additions: 0, deletions: 0 };
    }
    let nextAdditions = 0;
    let nextDeletions = 0;
    for (const hunk of fileDiff.hunks) {
      nextAdditions += hunk.additionLines;
      nextDeletions += hunk.deletionLines;
    }
    return { additions: nextAdditions, deletions: nextDeletions };
  }, [fileDiff]);

  const commentCount = githubThreads?.length ?? 0;

  const changedLinePairCount = useMemo(() => {
    if (!fileDiff) {
      return 0;
    }
    let total = 0;
    for (const hunk of fileDiff.hunks) {
      total += Math.max(hunk.additionLines, hunk.deletionLines);
      if (total > MAX_WORD_LEVEL_LINE_DIFF_PAIRS) {
        break;
      }
    }
    return total;
  }, [fileDiff]);

  const defaultLineDiffType: NonNullable<FileDiffProps<undefined>['options']>['lineDiffType'] =
    changedLinePairCount > MAX_WORD_LEVEL_LINE_DIFF_PAIRS ? 'none' : 'word';
  const diffRenderWorkerOptions = useMemo<WorkerInitializationRenderOptions>(
    () => ({
      lineDiffType: defaultLineDiffType,
      theme: activeDiffThemeName ?? DEFAULT_VSCODE_DIFF_THEME_FALLBACK,
      tokenizeMaxLineLength: 20_000,
    }),
    [activeDiffThemeName, defaultLineDiffType]
  );

  const prerenderCacheKey = useMemo(() => {
    if (!fileDiff) {
      return null;
    }
    if (
      !cachePrerenderedHtml ||
      parseCacheKey === undefined ||
      options !== undefined ||
      preparsedDiff !== undefined ||
      lazyTextDiffSource !== undefined
    ) {
      return null;
    }
    return `${parseCacheKey}:${effectiveOldTextLength}:${effectiveNewTextLength}:${effectiveDiffStyle}:${defaultLineDiffType}:${resolvedTheme}:${activeDiffThemeName ?? 'lody-default'}`;
  }, [
    activeDiffThemeName,
    cachePrerenderedHtml,
    defaultLineDiffType,
    effectiveDiffStyle,
    fileDiff,
    effectiveOldTextLength,
    effectiveNewTextLength,
    options,
    parseCacheKey,
    preparsedDiff,
    lazyTextDiffSource,
    resolvedTheme,
  ]);

  const cachedPrerenderedHTML = useMemo(
    () => (prerenderCacheKey ? readPrerenderedHtmlCache(prerenderCacheKey) : undefined),
    [prerenderCacheKey]
  );

  // --- Session comments integration ---
  const {
    lineAnnotations: commentAnnotations,
    draft,
    hoveredLine,
    startDraft,
    cancelDraft,
    setHoveredLine,
    getGitHubThreadsAtLine,
  } = useSessionComments({
    path,
    githubThreads,
    commentsEnabled,
    turnId,
    mode,
  });

  const safeCommentCallbacks = useMemo<DiffViewerCommentCallbacks>(() => {
    const wrap = <Input,>(callback: ((input: Input) => void | Promise<void>) | undefined) =>
      callback
        ? async (input: Input) => {
            try {
              await callback(input);
            } catch (error) {
              onCommentError?.(error);
              throw error;
            }
          }
        : undefined;

    return {
      onReplyGitHubThread: wrap(commentCallbacks?.onReplyGitHubThread),
      onCreateThreadToGitHub: wrap(commentCallbacks?.onCreateThreadToGitHub),
      onSendToChat: commentCallbacks?.onSendToChat,
    };
  }, [commentCallbacks, onCommentError]);

  const commentLineEnter = useCallback(
    (props: DiffLineEnterProps) => {
      if (!commentsEnabled) return;
      if (!isCommentableDiffLineType(props.lineType)) return;
      setHoveredLine({ side: props.annotationSide, lineNumber: props.lineNumber });
    },
    [commentsEnabled, setHoveredLine]
  );

  const commentLineLeave = useCallback(() => {
    if (!commentsEnabled) return;
    setHoveredLine(null);
  }, [commentsEnabled, setHoveredLine]);

  const commentLineClick = useCallback<DiffLineClickHandler>(
    (props) => {
      if (!commentsEnabled || !isMobile) return;
      if (!isCommentableDiffLineType(props.lineType)) return;
      props.event.preventDefault();
      startDraft(props.annotationSide, props.lineNumber);
    },
    [commentsEnabled, isMobile, startDraft]
  );

  const renderCommentAnnotation = useCallback(
    (annotation: DiffLineAnnotation<CommentAnnotationMeta>) => (
      <SessionCommentAnnotation
        annotation={annotation}
        currentUser={currentUser}
        prLinked={prLinked}
        draft={draft}
        getGitHubThreadsAtLine={getGitHubThreadsAtLine}
        callbacks={safeCommentCallbacks}
        commentReferenceKeys={commentReferenceKeys}
        onCancelDraft={cancelDraft}
      />
    ),
    [
      currentUser,
      prLinked,
      draft,
      getGitHubThreadsAtLine,
      safeCommentCallbacks,
      commentReferenceKeys,
      cancelDraft,
    ]
  );

  const renderCommentHoverUtility = useCallback<
    NonNullable<FileDiffProps<CommentAnnotationMeta>['renderHoverUtility']>
  >(
    (getHoveredLine) => {
      if (!commentsEnabled) return null;
      const hovered = getHoveredLine();
      if (!hovered) return null;
      if (
        !hoveredLine ||
        hovered.side !== hoveredLine.side ||
        hovered.lineNumber !== hoveredLine.lineNumber
      ) {
        return null;
      }
      return (
        <div className="flex h-full items-center justify-center">
          <SessionCommentAddButton
            onClick={() => startDraft(hovered.side as DiffCommentSide, hovered.lineNumber)}
          />
        </div>
      );
    },
    [commentsEnabled, hoveredLine, startDraft]
  );

  const mergedOptions: FileDiffProps<CommentAnnotationMeta>['options'] = useMemo(
    () => ({
      diffStyle: effectiveDiffStyle,
      expandUnchanged: false,
      expansionLineCount: 20,
      theme: activeDiffThemeName ?? DEFAULT_VSCODE_DIFF_THEME_FALLBACK,
      themeType: resolvedTheme,
      hunkSeparators: 'line-info' as const,
      lineDiffType: defaultLineDiffType,
      overflow: 'wrap',
      disableFileHeader: true,
      ...(options as FileDiffProps<CommentAnnotationMeta>['options']),
      ...(commentsEnabled
        ? {
            enableHoverUtility: !isMobile,
            onLineClick: isMobile ? commentLineClick : undefined,
            onLineEnter: isMobile ? undefined : commentLineEnter,
            onLineLeave: isMobile ? undefined : commentLineLeave,
          }
        : {}),
    }),
    [
      activeDiffThemeName,
      defaultLineDiffType,
      effectiveDiffStyle,
      options,
      resolvedTheme,
      commentsEnabled,
      isMobile,
      commentLineClick,
      commentLineEnter,
      commentLineLeave,
    ]
  );

  useEffect(() => {
    if (!shouldRenderDiff || !prerenderCacheKey) {
      return undefined;
    }
    if (cachedPrerenderedHTML) {
      return undefined;
    }

    let cancelled = false;
    let timeoutId: number | undefined;
    let attempts = 0;
    const maxAttempts = 60;
    const captureStartedAt = getDiffPerfNow();

    const tryCapture = () => {
      if (cancelled) {
        return;
      }
      attempts += 1;
      const host = diffHostRef.current;
      const diffContainer = host?.querySelector('diffs-container');
      const shadowRoot =
        diffContainer instanceof HTMLElement && diffContainer.shadowRoot
          ? diffContainer.shadowRoot
          : null;
      const html = shadowRoot?.innerHTML;
      if (typeof html === 'string' && html.length > 0 && html.includes('<pre')) {
        writePrerenderedHtmlCache(prerenderCacheKey, html);
        logDiffPerfDurationLazy(
          'diff:shadow-ready',
          captureStartedAt,
          () => ({
            path,
            attempts,
            htmlLength: html.length,
          }),
          0
        );
        return;
      }
      if (attempts >= maxAttempts) {
        return;
      }
      timeoutId = window.setTimeout(tryCapture, 100);
    };

    const rafId = requestAnimationFrame(tryCapture);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
    };
  }, [cachedPrerenderedHTML, path, prerenderCacheKey, shouldRenderDiff]);

  const renderedFileDiff =
    fileDiff !== null ? (
      <MemoizedFileDiff
        fileDiff={fileDiff}
        options={mergedOptions}
        prerenderedHTML={commentsEnabled ? undefined : cachedPrerenderedHTML}
        lineAnnotations={commentsEnabled ? commentAnnotations : undefined}
        renderAnnotation={commentsEnabled ? renderCommentAnnotation : undefined}
        renderHoverUtility={commentsEnabled && !isMobile ? renderCommentHoverUtility : undefined}
      />
    ) : null;

  const diffContentCore = isParsingLargeDiff ? (
    <DiffViewerLoadingState path={path} />
  ) : parseErrorMessage ? (
    <DiffViewerErrorState message={parseErrorMessage} />
  ) : renderedFileDiff ? (
    <DiffRenderWorkerProvider renderOptions={diffRenderWorkerOptions}>
      {renderedFileDiff}
    </DiffRenderWorkerProvider>
  ) : null;
  const diffContent = diffContentCore;
  // Host-level Pierre overrides: keep GitHub-accurate add/remove tints on the
  // white canvas. Without these, a VS Code theme's muddy greens bleed into
  // addition rows and the last hunk leaves a mismatched card-colored band.
  const pierreDiffHostStyle = useMemo(
    (): CSSProperties =>
      ({
        // Pierre reads these as CSS variables (inherited into its shadow root).
        ['--diffs-light-bg' as string]: 'hsl(var(--background))',
        ['--diffs-dark-bg' as string]: 'hsl(var(--background))',
        ['--diffs-bg-buffer-override' as string]: 'hsl(var(--background))',
        ['--diffs-bg-context-override' as string]: 'hsl(var(--background))',
        // Default separator is only ~4% black on white (and the pill also has
        // opacity 0.65) — nearly invisible on a cool-white canvas. Use a
        // stronger muted fill so "N unmodified lines" reads as a control.
        ['--diffs-bg-separator-override' as string]:
          'color-mix(in oklab, hsl(var(--foreground)) 10%, hsl(var(--background)))',
        ['--diffs-addition-color-override' as string]: 'hsl(var(--github-addition))',
        ['--diffs-deletion-color-override' as string]: 'hsl(var(--github-deletion))',
        ['--diffs-bg-addition-override' as string]:
          'color-mix(in oklab, hsl(var(--github-addition)) 12%, hsl(var(--background)))',
        ['--diffs-bg-addition-number-override' as string]:
          'color-mix(in oklab, hsl(var(--github-addition)) 18%, hsl(var(--background)))',
        ['--diffs-bg-addition-emphasis-override' as string]:
          'color-mix(in oklab, hsl(var(--github-addition)) 28%, hsl(var(--background)))',
        ['--diffs-bg-deletion-override' as string]:
          'color-mix(in oklab, hsl(var(--github-deletion)) 12%, hsl(var(--background)))',
        ['--diffs-bg-deletion-number-override' as string]:
          'color-mix(in oklab, hsl(var(--github-deletion)) 18%, hsl(var(--background)))',
        ['--diffs-bg-deletion-emphasis-override' as string]:
          'color-mix(in oklab, hsl(var(--github-deletion)) 28%, hsl(var(--background)))',
      }) as CSSProperties,
    []
  );
  const diffContentContainer = (
    <div
      ref={diffHostRef}
      className="lody-pierre-diff w-full bg-background"
      style={pierreDiffHostStyle}
    >
      {diffContent}
    </div>
  );

  // No header mode - just render the diff content
  if (!showHeader && !renderHeader) {
    return (
      <div ref={containerRef} className={cn('text-[0.8rem] w-full min-h-8', className)}>
        {diffContentContainer}
      </div>
    );
  }

  // Shared chrome for both header modes. White canvas + light page needs a
  // stronger edge than default --border (≈90% L), which vanishes on white.
  // Always overflow-hidden so full-bleed addition rows clip to rounded corners
  // without painting over the border.
  const diffCardChromeClass = cn(
    'relative flex min-h-8 w-full flex-col overflow-hidden rounded-xl bg-background text-[0.8rem]',
    'border border-foreground/[0.12] dark:border-border',
    'shadow-[0_1px_2px_hsl(0_0%_0%/0.04)]'
  );

  // Custom header mode - user provides their own header with CollapseToggle
  if (renderHeader) {
    return (
      <Collapsible.Root
        ref={containerRef}
        open={isControlledOpen ? open : undefined}
        onOpenChange={handleOpenChange}
        defaultOpen={isControlledOpen ? undefined : defaultOpen}
        className={cn(diffCardChromeClass, className)}
      >
        {renderHeader({ fileName, path, additions, deletions, CollapseToggle })}
        <Collapsible.Content className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up data-[state=closed]:h-0">
          <div className="pb-0">{diffContentContainer}</div>
        </Collapsible.Content>
      </Collapsible.Root>
    );
  }

  // Default header mode - use CollapsibleCard
  return (
    <div ref={containerRef} className="w-full">
      <CollapsibleCard
        data-section-id="diff-viewer"
        id="diff-viewer"
        className={cn(diffCardChromeClass, className)}
        open={isControlledOpen ? open : undefined}
        onOpenChange={handleOpenChange}
        defaultOpen={isControlledOpen ? undefined : defaultOpen}
        // Keep overflow-hidden (allowStickyChildren false) so the rounded border
        // always clips content. Sticky headers inside overflow:hidden only stick
        // within the card; page-level stickiness is not worth a missing border.
        allowStickyChildren={false}
      >
        <CollapsibleCardHeader
          sticky={false}
          position="relative"
          className={cn(
            'inset-x-0 h-8 rounded-none bg-background pl-1 pr-4',
            // Separator only when open — collapsed cards must not stack border-b
            // on the outer bottom edge (dirty corner AA).
            isOpen && 'border-b border-foreground/[0.08] dark:border-border'
          )}
        >
          <FileIcon filePath={path} className="h-4 w-4 shrink-0" />
          <div className="flex min-w-0 flex-1 items-center gap-1">
            <span className="min-w-0 truncate text-sm text-foreground/90" title={path}>
              {path}
            </span>
            <DiffFileHeaderActions path={path} onOpenFile={onOpenFile} />
          </div>
          {commentCount > 0 && (
            <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              <span>{commentCount}</span>
            </div>
          )}
          {(additions > 0 || deletions > 0) && (
            <div className="flex shrink-0 items-center gap-1.5 text-xs">
              {additions > 0 && <span className="text-code-added">+{additions}</span>}
              {deletions > 0 && <span className="text-code-removed">-{deletions}</span>}
            </div>
          )}
        </CollapsibleCardHeader>
        {/* No bottom padding: green/red last rows meet the clipped card edge. */}
        <CollapsibleCardContent noInternalScroll className="pb-0">
          {diffContentContainer}
        </CollapsibleCardContent>
      </CollapsibleCard>
    </div>
  );
}

const areDiffViewerPropsEqual = (prev: DiffViewerProps, next: DiffViewerProps): boolean =>
  prev.path === next.path &&
  prev.oldText === next.oldText &&
  prev.newText === next.newText &&
  prev.preparsedDiff === next.preparsedDiff &&
  prev.preparsedOldTextLength === next.preparsedOldTextLength &&
  prev.preparsedNewTextLength === next.preparsedNewTextLength &&
  prev.lazyTextDiffSource === next.lazyTextDiffSource &&
  prev.diffStyle === next.diffStyle &&
  prev.responsiveSplit === next.responsiveSplit &&
  prev.className === next.className &&
  prev.showHeader === next.showHeader &&
  prev.stickyHeader === next.stickyHeader &&
  prev.cachePrerenderedHtml === next.cachePrerenderedHtml &&
  prev.options === next.options &&
  prev.renderHeader === next.renderHeader &&
  prev.defaultOpen === next.defaultOpen &&
  prev.open === next.open &&
  prev.onOpenChange === next.onOpenChange &&
  prev.deferRenderUntilOpen === next.deferRenderUntilOpen &&
  prev.parseCacheKey === next.parseCacheKey &&
  prev.commentsEnabled === next.commentsEnabled &&
  prev.currentUser === next.currentUser &&
  prev.githubThreads === next.githubThreads &&
  prev.prLinked === next.prLinked &&
  prev.turnId === next.turnId &&
  prev.mode === next.mode &&
  prev.commentCallbacks === next.commentCallbacks &&
  prev.commentReferenceKeys === next.commentReferenceKeys &&
  prev.onCommentError === next.onCommentError &&
  prev.onOpenFile === next.onOpenFile;

export const DiffViewer = memo(DiffViewerImpl, areDiffViewerPropsEqual);

DiffViewer.displayName = 'DiffViewer';
