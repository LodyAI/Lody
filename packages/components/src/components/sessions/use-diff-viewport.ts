import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { logDiffPerfLazy } from '@/lib/diff-perf';

/** Keep file shells for navigation; only nearby bodies acquire data and mount code. */
export function useDiffViewport({
  active,
  paths,
  priorityPath,
  scrollContainerRef,
}: {
  active: boolean;
  paths: readonly string[];
  priorityPath: string | null;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const nodes = useRef(new Map<string, HTMLDivElement>());
  const observerRef = useRef<IntersectionObserver | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const anchorTargetRef = useRef<((node: HTMLElement) => void) | null>(null);
  const anchorTarget = useCallback((node: HTMLElement) => anchorTargetRef.current?.(node), []);
  const [nearbyPaths, setNearbyPaths] = useState<ReadonlySet<string>>(new Set());
  const [observing, setObserving] = useState(false);

  const registerPath = useCallback((path: string, node: HTMLDivElement | null) => {
    const previous = nodes.current.get(path);
    if (previous) observerRef.current?.unobserve(previous);
    if (previous) resizeObserverRef.current?.unobserve(previous);
    if (node) {
      nodes.current.set(path, node);
      observerRef.current?.observe(node);
      resizeObserverRef.current?.observe(node);
    } else {
      nodes.current.delete(path);
    }
  }, []);

  useEffect(() => {
    if (!active || !scrollContainerRef.current) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      // Browsers without an observer must still make every file reachable.
      setNearbyPaths(new Set(paths));
      setObserving(true);
      return undefined;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        setNearbyPaths((previous) => {
          const next = new Set(previous);
          let changed = false;
          for (const entry of entries) {
            const path = (entry.target as HTMLElement).dataset.diffPath;
            if (path === undefined) continue;
            changed ||= previous.has(path) !== entry.isIntersecting;
            if (entry.isIntersecting) next.add(path);
            else next.delete(path);
          }
          return changed ? next : previous;
        });
        setObserving(true);
      },
      { root: scrollContainerRef.current, rootMargin: '600px 0px' }
    );
    observerRef.current = observer;
    const viewport = scrollContainerRef.current;
    let anchor: { node: HTMLElement; offset: number } | undefined;
    let adjustedScrollTop: number | undefined;
    let measuredScrollHeight = viewport.scrollHeight;
    anchorTargetRef.current = (node) => {
      anchor = {
        node,
        offset: node.getBoundingClientRect().top - viewport.getBoundingClientRect().top,
      };
      measuredScrollHeight = viewport.scrollHeight;
      adjustedScrollTop = viewport.scrollTop;
    };
    const captureAnchor = () => {
      // Shrinking/loading bodies can clamp scrollTop before ResizeObserver runs.
      // That is a layout correction, not a request to choose another file.
      if (
        viewport.scrollTop === adjustedScrollTop ||
        viewport.scrollHeight !== measuredScrollHeight
      ) {
        return;
      }
      adjustedScrollTop = undefined;
      const rect = viewport.getBoundingClientRect();
      const atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < 4;
      anchor = undefined;
      for (const node of nodes.current.values()) {
        const bounds = node.getBoundingClientRect();
        if (bounds.bottom > rect.top && bounds.top < rect.bottom) {
          anchor = { node, offset: bounds.top - rect.top };
          if (!atBottom) break;
        }
      }
      logDiffPerfLazy('viewport:anchor', () => ({
        path: anchor?.node.dataset.diffPath,
        offset: anchor?.offset,
        atBottom,
        scrollTop: viewport.scrollTop,
      }));
    };
    captureAnchor();
    viewport.addEventListener('scroll', captureAnchor, { passive: true });
    // Newly loaded overscan files can grow above the viewport by thousands of
    // lines. Preserve the user's visible file, including during worker commits.
    // Native scroll anchoring is disabled on the panel content to avoid applying
    // the same correction twice or anchoring an unrelated focused header.
    const resizeObserver =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (!anchor?.node.isConnected) return;
            const delta =
              anchor.node.getBoundingClientRect().top -
              viewport.getBoundingClientRect().top -
              anchor.offset;
            if (Math.abs(delta) > 0.5) {
              viewport.scrollTop += delta;
              adjustedScrollTop = viewport.scrollTop;
              logDiffPerfLazy('viewport:adjust', () => ({
                path: anchor?.node.dataset.diffPath,
                delta,
                scrollTop: viewport.scrollTop,
              }));
            }
            measuredScrollHeight = viewport.scrollHeight;
            adjustedScrollTop = viewport.scrollTop;
          });
    resizeObserverRef.current = resizeObserver;
    for (const node of nodes.current.values()) {
      observer.observe(node);
      resizeObserver?.observe(node);
    }
    return () => {
      observer.disconnect();
      resizeObserver?.disconnect();
      viewport.removeEventListener('scroll', captureAnchor);
      observerRef.current = null;
      resizeObserverRef.current = null;
      anchorTargetRef.current = null;
    };
  }, [active, paths, scrollContainerRef]);

  const loadPaths = useMemo(
    () =>
      paths.filter(
        (path, index) =>
          active && (path === priorityPath || nearbyPaths.has(path) || (!observing && index < 2))
      ),
    [active, nearbyPaths, observing, paths, priorityPath]
  );
  return { loadPaths, registerPath, anchorTarget };
}
