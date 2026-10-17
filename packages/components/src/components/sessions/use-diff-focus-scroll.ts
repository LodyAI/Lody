import { useCallback, useEffect, useRef, type MutableRefObject } from 'react';
import { arePathsEquivalent, type DiffCommentFocusTarget } from './session-conversation-diff-types';

const getDiffCommentFocusKey = (focusComment?: DiffCommentFocusTarget | null): string => {
  if (!focusComment) {
    return '';
  }
  return [
    focusComment.source,
    focusComment.path,
    focusComment.side,
    String(focusComment.lineNumber),
    focusComment.threadId ?? '',
    focusComment.githubThreadId == null ? '' : String(focusComment.githubThreadId),
  ].join(':');
};

const findDiffCommentFocusElement = (
  root: HTMLElement,
  focusComment: DiffCommentFocusTarget
): HTMLElement | null => {
  const threadId =
    focusComment.source === 'github'
      ? focusComment.githubThreadId == null
        ? null
        : String(focusComment.githubThreadId)
      : (focusComment.threadId ?? null);

  if (threadId) {
    const threadNodes = root.querySelectorAll<HTMLElement>('[data-diff-comment-thread-source]');
    for (const node of threadNodes) {
      if (
        node.dataset.diffCommentThreadSource === focusComment.source &&
        node.dataset.diffCommentThreadId === threadId
      ) {
        return node;
      }
    }
  }

  const lineNodes = root.querySelectorAll<HTMLElement>('[data-diff-comment-line]');
  const lineNumber = String(focusComment.lineNumber);
  for (const node of lineNodes) {
    if (
      node.dataset.diffCommentSide === focusComment.side &&
      node.dataset.diffCommentLine === lineNumber
    ) {
      return node;
    }
  }

  return null;
};

const scrollTargetIntoContainer = (
  target: HTMLElement,
  container: HTMLDivElement | null,
  block: ScrollLogicalPosition
): void => {
  if (!container) {
    target.scrollIntoView({ block, behavior: 'auto' });
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const offset = targetRect.top - containerRect.top;
  const targetTop =
    block === 'center'
      ? container.scrollTop + offset - Math.max(0, (container.clientHeight - targetRect.height) / 2)
      : container.scrollTop + offset - 8;
  container.scrollTo({ top: Math.max(0, targetTop), behavior: 'auto' });
};

export const useDiffFocusScroll = ({
  focusFilePath,
  focusComment,
  focusRequestSeq,
  isFocusTargetResolved,
  contextKey,
  onScrollTarget,
}: {
  focusFilePath?: string | null;
  focusComment?: DiffCommentFocusTarget | null;
  focusRequestSeq?: number;
  /** Whether the focused file or nested target has been resolved (allows early scroll). */
  isFocusTargetResolved: boolean;
  contextKey?: string | null;
  onScrollTarget?: (target: HTMLElement) => void;
}): {
  scrollContainerRef: MutableRefObject<HTMLDivElement | null>;
  registerPathBlock: (filePath: string, node: HTMLDivElement | null) => void;
} => {
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const blockRefs = useRef(new Map<string, HTMLDivElement>());
  const completedFocusRequestKeyRef = useRef<string | null>(null);
  const focusCommentKey = getDiffCommentFocusKey(focusComment);
  const focusRequestKey =
    focusFilePath == null
      ? null
      : `${contextKey ?? ''}::${focusFilePath}::${focusCommentKey}::${String(
          focusRequestSeq ?? 0
        )}`;

  const scrollToFocusedPath = useCallback(() => {
    if (!focusFilePath) {
      return false;
    }

    let node = blockRefs.current.get(focusFilePath);
    if (!node) {
      for (const [candidatePath, candidateNode] of blockRefs.current.entries()) {
        if (arePathsEquivalent(candidatePath, focusFilePath)) {
          node = candidateNode;
          break;
        }
      }
    }

    if (!node) {
      return false;
    }

    const container = scrollContainerRef.current;
    const target = focusComment ? findDiffCommentFocusElement(node, focusComment) : node;

    if (!target) {
      return false;
    }

    scrollTargetIntoContainer(target, container, focusComment ? 'center' : 'start');
    onScrollTarget?.(target);
    return true;
  }, [focusComment, focusFilePath, onScrollTarget]);

  // Scroll as soon as the focused file is resolved — don't wait for all files.
  useEffect(() => {
    if (!isFocusTargetResolved) {
      return undefined;
    }
    if (!focusFilePath || !focusRequestKey) {
      return undefined;
    }
    if (completedFocusRequestKeyRef.current === focusRequestKey) {
      return undefined;
    }

    let cancelled = false;
    let completed = false;
    let retryTimeoutId: number | null = null;
    const startedAt = performance.now();
    const maxRetryWindowMs = focusComment ? 6_000 : 4_000;

    const scheduleRetry = (delayMs: number, run: () => void) => {
      if (cancelled || completed || retryTimeoutId !== null) {
        return;
      }
      retryTimeoutId = window.setTimeout(() => {
        retryTimeoutId = null;
        run();
      }, delayMs);
    };

    const tryScroll = () => {
      if (cancelled || completed) {
        return;
      }
      const didScroll = scrollToFocusedPath();
      if (didScroll) {
        completed = true;
        completedFocusRequestKeyRef.current = focusRequestKey;
        return;
      }
      if (performance.now() - startedAt >= maxRetryWindowMs) {
        return;
      }
      scheduleRetry(64, tryScroll);
    };

    const tryScrollOnce = () => {
      if (cancelled || completed || retryTimeoutId !== null) {
        return;
      }
      tryScroll();
    };

    tryScrollOnce();
    const rafId = requestAnimationFrame(() => {
      tryScrollOnce();
      requestAnimationFrame(() => {
        tryScrollOnce();
      });
    });
    const timeoutId = window.setTimeout(() => {
      tryScrollOnce();
    }, 220);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
      if (retryTimeoutId !== null) {
        clearTimeout(retryTimeoutId);
      }
    };
  }, [focusComment, focusFilePath, focusRequestKey, isFocusTargetResolved, scrollToFocusedPath]);

  const registerPathBlock = useCallback((filePath: string, node: HTMLDivElement | null) => {
    if (!node) {
      blockRefs.current.delete(filePath);
      return;
    }

    blockRefs.current.set(filePath, node);
  }, []);

  return {
    scrollContainerRef,
    registerPathBlock,
  };
};
