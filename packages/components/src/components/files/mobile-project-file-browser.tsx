import {
  forwardRef,
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, CloudOff, FileText, FolderOpen, Home, Loader2 } from 'lucide-react';
import { Spinner } from '@/ui/spinner';
import type { FileTreeItem } from '@lody/shared';

import { useAtomValue } from 'jotai';
import { conversationFontSizeAtom } from '@/atoms';
import { FileIcon, FolderIcon } from '@/components/icons/file-icons';
import { MobileEdgeBackSwipeZone } from '@/components/mobile/mobile-edge-back-swipe';
import { SessionFileImagePreview } from '@/components/sessions/session-file-image-preview';
import { MarkdownRenderer } from '@/components/ai-gui/markdown-renderer';
import { SessionMonacoTextViewer } from '@/components/sessions/session-monaco-text-viewer';
import { useFileWorkspaceTree } from '@/hooks/use-code-session';
import { isNativeAppShell } from '@/lib/native-platform';
import type { FileWorkspaceProvider, FileWorkspaceSnapshot } from '@/lib/file-workspace-provider';
import { getImageMimeTypeForPath, isSvgPath } from '@/lib/image-file-preview';
import { getSessionFileMonacoLanguageId, isSessionMarkdownPath } from '@/lib/session-file-language';
import { cn } from '@/lib/utils';
import { useActiveVSCodeTheme, useResolvedTheme } from '../../theme-provider';

/* Duration of the level slide. Keep in sync with the
   `.mobile-drill-out` keyframe in `tailwind/index.css`. */
const MOBILE_DRILL_EXIT_MS = 280;

/* The bottom tab bar floats fixed over the viewport, so the scrollable
   level body needs padding to clear it (height + safe-area). Same trick
   `mobile-project-screen.tsx` uses on its list scroller. */
const MOBILE_TABBAR_CLEARANCE =
  'pb-[calc(var(--mobile-tabbar-height)+var(--k-safe-area-bottom,0px)+1rem)]';
const MOBILE_SAFE_AREA_CLEARANCE = 'pb-[calc(var(--k-safe-area-bottom,0px)+1rem)]';

const ROOT_PATH = '';

export type MobileProjectFileBrowserHandle = {
  /** Pop one level (folder listing or file preview). No-op at the root. */
  goBack: () => void;
  /** True when there is a level to pop. */
  canGoBack: () => boolean;
};

type MobileProjectFileBrowserProps = {
  readonly provider: FileWorkspaceProvider | null;
  readonly pending?: boolean;
  readonly message?: string;
  /** Notified with the current location's path segments relative to the
     project root (empty at the root) so a shared, single header can
     render the breadcrumb and own the back affordance — the browser
     itself renders no header. */
  readonly onPathChange?: (segments: string[]) => void;
  /** Take over opening a file instead of pushing the built-in preview
     level. Set by hosts that already own a file viewer — the session
     surface routes taps into its viewer tabs so a file opened from the
     tree behaves exactly like one opened from the conversation (save,
     LSP, tab persistence). Left unset, the browser previews in place. */
  readonly onOpenFile?: (path: string) => void;
  readonly onScrollActivity?: (scrollTop: number) => void;
  readonly bottomTabBarVisible?: boolean;
  readonly className?: string;
};

/* A level in the navigation stack: either a directory listing or an
   opened file preview. The path drives both content and the external
   breadcrumb, so the stack stays a plain list of (kind, path). */
type Frame = { readonly kind: 'dir' | 'file'; readonly path: string };

type FileContentState =
  | { readonly status: 'loading'; readonly path: string }
  | { readonly status: 'ready'; readonly path: string; readonly snapshot: FileWorkspaceSnapshot }
  | { readonly status: 'error'; readonly path: string; readonly message: string };

function basename(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function frameKey(frame: Frame): string {
  return `${frame.kind}:${frame.path}`;
}

/**
 * Walk the already-built provider tree to the directory at `path` and
 * return its immediate children (folders first, then files — the
 * builder pre-sorts them). `lazyDirectoryId` is surfaced so the caller
 * can hydrate a not-yet-expanded directory on demand.
 *
 * Matches by basename within each level (never by full-path equality):
 * provider paths may or may not carry a leading slash, and basenames are
 * unique within a directory, so this stays correct either way.
 */
function resolveDirectory(
  tree: readonly FileTreeItem[],
  path: string
): {
  readonly children: readonly FileTreeItem[];
  readonly lazyDirectoryId?: string;
  readonly found: boolean;
} {
  if (!path) return { children: tree, found: true };
  const segments = path.split('/').filter(Boolean);
  let level: readonly FileTreeItem[] = tree;
  let item: FileTreeItem | undefined;
  for (const segment of segments) {
    item = level.find(
      (candidate) => candidate.type === 'directory' && basename(candidate.path) === segment
    );
    if (!item) return { children: [], found: false };
    level = item.children ?? [];
  }
  return {
    children: level,
    found: true,
    ...(item?.lazyDirectoryId ? { lazyDirectoryId: item.lazyDirectoryId } : {}),
  };
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * Mobile file browser: an iOS-style drill-down. Each hierarchy level is
 * a full-bleed page; tapping a folder pushes the next level and tapping
 * a file pushes a content preview, both with a slide animation. Reuses
 * the desktop file model (`useFileWorkspaceTree`) and the shared
 * file/folder icons — only the presentation is mobile-native.
 *
 * The browser renders NO header of its own: every level shares one
 * header owned by the surrounding screen, fed the current path via
 * `onPathChange` and popping levels through the imperative `goBack`
 * handle. Rejected: a per-level header bar — it stacked a redundant
 * title + back on top of the screen's existing project header.
 */
export const MobileProjectFileBrowser = forwardRef<
  MobileProjectFileBrowserHandle,
  MobileProjectFileBrowserProps
>(function MobileProjectFileBrowser(
  {
    provider,
    pending,
    message,
    onPathChange,
    onOpenFile,
    onScrollActivity,
    bottomTabBarVisible = true,
    className,
  },
  ref
) {
  const tree = useFileWorkspaceTree(provider, { enabled: Boolean(provider) });

  const [stack, setStack] = useState<readonly Frame[]>([{ kind: 'dir', path: ROOT_PATH }]);
  const stackRef = useRef(stack);
  stackRef.current = stack;
  const framesRef = useRef<HTMLDivElement>(null);
  const topFrameRef = useRef<HTMLDivElement>(null);
  const onPathChangeRef = useRef(onPathChange);
  onPathChangeRef.current = onPathChange;
  const onOpenFileRef = useRef(onOpenFile);
  onOpenFileRef.current = onOpenFile;

  const notifyPath = useCallback((path: string) => {
    onPathChangeRef.current?.(path.split('/').filter(Boolean));
  }, []);

  // Notify the parent header of the initial root path whenever this browser
  // instance is created (including after a provider switch, which is keyed).
  useEffect(() => {
    notifyPath(ROOT_PATH);
  }, [notifyPath]);

  const pushFrame = useCallback(
    (frame: Frame) => {
      setStack((prev) => [...prev, frame]);
      notifyPath(frame.path);
    },
    [notifyPath]
  );

  /* Collapse the stack down to `targetLength` frames (>= 1) with the same
     clone-overlay slide the route-level drill pages use: snapshot the
     live top level into a static clone, slide that off to the right, and
     drop the React frames underneath immediately so the destination
     (already mounted behind) shows through with no flash. Cloning the
     DOM — rather than re-rendering the popped frame — avoids a file
     preview re-fetching and flickering mid-slide. One slide reveals the
     destination regardless of how many levels are dropped, so this backs
     both single-level back and breadcrumb multi-level jumps. */
  const popTo = useCallback(
    (targetLength: number) => {
      const prev = stackRef.current;
      const target = Math.max(1, targetLength);
      if (target >= prev.length) return;
      const destination = prev[target - 1];

      const source = topFrameRef.current;
      const container = framesRef.current;
      if (source && container && !prefersReducedMotion()) {
        const clone = source.cloneNode(true) as HTMLElement;
        clone.classList.remove('mobile-drill-in');
        clone.classList.add('mobile-drill-out');
        clone.style.position = 'absolute';
        /* Pin to the captured size (not inset:0) so the clone doesn't
           stretch if the frames area resizes mid-slide — e.g. popping to
           the root removes the breadcrumb strip and grows the area. */
        clone.style.top = '0';
        clone.style.left = '0';
        clone.style.width = `${source.offsetWidth}px`;
        clone.style.height = `${source.offsetHeight}px`;
        clone.style.zIndex = '50';
        clone.style.pointerEvents = 'none';
        container.appendChild(clone);
        window.setTimeout(() => clone.remove(), MOBILE_DRILL_EXIT_MS);
      }

      setStack(prev.slice(0, target));
      notifyPath(destination ? destination.path : ROOT_PATH);
    },
    [notifyPath]
  );

  const popFrame = useCallback(() => {
    popTo(stackRef.current.length - 1);
  }, [popTo]);

  useImperativeHandle(
    ref,
    () => ({
      goBack: popFrame,
      canGoBack: () => stackRef.current.length > 1,
    }),
    [popFrame]
  );

  const handleOpenDir = useCallback(
    (path: string) => pushFrame({ kind: 'dir', path }),
    [pushFrame]
  );
  /* Delegating hosts keep the browser on its directory level: the file
     opens in their viewer, and coming back lands on the folder the user
     was in rather than an orphaned preview level. */
  const handleOpenFile = useCallback(
    (path: string) => {
      const delegate = onOpenFileRef.current;
      if (delegate) {
        delegate(path);
        return;
      }
      pushFrame({ kind: 'file', path });
    },
    [pushFrame]
  );

  const topPath = stack[stack.length - 1]?.path ?? ROOT_PATH;
  const segments = topPath ? topPath.split('/').filter(Boolean) : [];
  const bottomClearanceClassName = bottomTabBarVisible
    ? MOBILE_TABBAR_CLEARANCE
    : MOBILE_SAFE_AREA_CLEARANCE;

  useEffect(() => {
    onScrollActivity?.(0);
  }, [onScrollActivity, topPath]);

  return (
    <div
      className={cn(
        'absolute inset-0 flex min-h-0 flex-col overflow-hidden bg-background',
        className
      )}
    >
      {/* The breadcrumb sits at the top of the body (not in the screen
          header) and is shared across every level — the levels slide
          beneath it. Hidden at the root: the project header already
          names the project, so a root-only crumb would be redundant. */}
      {segments.length > 0 ? (
        <FilesBreadcrumb
          segments={segments}
          onNavigateRoot={() => popTo(1)}
          onNavigateSegment={(index) => popTo(index + 2)}
        />
      ) : null}
      <div ref={framesRef} className="relative min-h-0 flex-1">
        {stack.map((frame, index) => {
          const isTop = index === stack.length - 1;
          return (
            <div
              key={frameKey(frame)}
              ref={isTop ? topFrameRef : undefined}
              aria-hidden={!isTop}
              className={cn(
                'absolute inset-0 flex flex-col bg-background',
                index > 0 && 'mobile-drill-in',
                !isTop && 'pointer-events-none'
              )}
            >
              <FrameContent
                frame={frame}
                onOpenDir={handleOpenDir}
                onOpenFile={handleOpenFile}
                treeState={tree.state}
                treeReady={tree.ready}
                treeMessage={tree.message}
                provider={provider}
                pending={pending}
                providerMessage={message}
                onScrollActivity={onScrollActivity}
                bottomClearanceClassName={bottomClearanceClassName}
              />
            </div>
          );
        })}

        {stack.length > 1 ? (
          <MobileEdgeBackSwipeZone isNativeApp={isNativeAppShell()} onBack={popFrame} zIndex={60} />
        ) : null}
      </div>
    </div>
  );
});

/* Horizontally-scrollable breadcrumb shown at the top of the file body.
   Auto-scrolls to the end so the *current* folder is always visible; the
   user scrolls left to reach (and tap) ancestors. Each segment jumps
   straight to that depth — far less tapping than one-level back for deep
   trees, and the current location stays readable no matter how long the
   path gets (a plain truncated string hid the tail, the part that
   matters most). */
function FilesBreadcrumb({
  segments,
  onNavigateRoot,
  onNavigateSegment,
}: {
  readonly segments: string[];
  readonly onNavigateRoot: () => void;
  readonly onNavigateSegment: (index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    setOverflowing(el.scrollWidth > el.clientWidth + 1);
  }, [segments]);
  return (
    <div className="relative z-30 flex shrink-0 items-center border-b border-border/50 px-3 py-2 text-[0.78rem] leading-none text-muted-foreground">
      {/* Root crumb lives OUTSIDE the scroll area so it stays visible and
          tappable even on deep paths — the segment row auto-scrolls to its
          end, which would otherwise push the leftmost root off-screen. */}
      <button
        type="button"
        onClick={onNavigateRoot}
        aria-label="Root"
        className="mr-0.5 flex shrink-0 items-center rounded p-1 active:bg-muted/50"
      >
        <Home className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      <div
        ref={scrollRef}
        className={cn(
          'flex min-w-0 flex-1 items-center gap-1 overflow-x-auto whitespace-nowrap',
          '[scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          /* Fade the left edge (auto-scrolled to the end, so hidden
             ancestors sit on the left) to hint the row scrolls — only
             when it overflows. `-webkit-` for iOS WKWebView. */
          overflowing && [
            '[mask-image:linear-gradient(to_right,transparent,#000_14px)]',
            '[-webkit-mask-image:linear-gradient(to_right,transparent,#000_14px)]',
          ]
        )}
      >
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          return (
            <span key={`${index}:${segment}`} className="flex shrink-0 items-center gap-1">
              <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-40" aria-hidden="true" />
              <button
                type="button"
                disabled={isLast}
                onClick={() => onNavigateSegment(index)}
                className={cn(
                  'shrink-0 rounded px-0.5',
                  isLast ? 'font-medium text-foreground' : 'active:bg-muted/50'
                )}
              >
                {segment}
              </button>
            </span>
          );
        })}
      </div>
    </div>
  );
}

type FrameContentProps = {
  readonly frame: Frame;
  readonly onOpenDir: (path: string) => void;
  readonly onOpenFile: (path: string) => void;
  readonly treeState: readonly FileTreeItem[];
  readonly treeReady: boolean;
  readonly treeMessage?: string;
  readonly provider: FileWorkspaceProvider | null;
  readonly pending?: boolean;
  readonly providerMessage?: string;
  readonly onScrollActivity?: (scrollTop: number) => void;
  readonly bottomClearanceClassName: string;
};

function FrameContent({
  frame,
  onOpenDir,
  onOpenFile,
  treeState,
  treeReady,
  treeMessage,
  provider,
  pending,
  providerMessage,
  onScrollActivity,
  bottomClearanceClassName,
}: FrameContentProps) {
  if (frame.kind === 'file') {
    return (
      <MobileFilePreview
        provider={provider}
        path={frame.path}
        onScrollActivity={onScrollActivity}
        bottomClearanceClassName={bottomClearanceClassName}
      />
    );
  }
  return (
    <MobileDirectoryList
      treeState={treeState}
      treeReady={treeReady}
      treeMessage={treeMessage}
      path={frame.path}
      provider={provider}
      pending={pending}
      providerMessage={providerMessage}
      onScrollActivity={onScrollActivity}
      bottomClearanceClassName={bottomClearanceClassName}
      onOpenDir={onOpenDir}
      onOpenFile={onOpenFile}
    />
  );
}

type MobileDirectoryListProps = {
  readonly treeState: readonly FileTreeItem[];
  readonly treeReady: boolean;
  readonly treeMessage?: string;
  readonly path: string;
  readonly provider: FileWorkspaceProvider | null;
  readonly pending?: boolean;
  readonly providerMessage?: string;
  readonly onScrollActivity?: (scrollTop: number) => void;
  readonly bottomClearanceClassName: string;
  readonly onOpenDir: (path: string) => void;
  readonly onOpenFile: (path: string) => void;
};

function MobileDirectoryList({
  treeState,
  treeReady,
  treeMessage,
  path,
  provider,
  pending,
  providerMessage,
  onScrollActivity,
  bottomClearanceClassName,
  onOpenDir,
  onOpenFile,
}: MobileDirectoryListProps) {
  const { t } = useTranslation();
  const resolved = useMemo(() => resolveDirectory(treeState, path), [treeState, path]);
  const lazyDirectoryId = resolved.lazyDirectoryId;
  const childCount = resolved.children.length;
  const isLazyPending = Boolean(lazyDirectoryId) && childCount === 0;

  /* Hydrate a not-yet-expanded directory the first time it's opened.
     `subscribeFiles` then re-emits the tree with this directory's
     children filled in, re-rendering this level reactively. */
  const initializedRef = useRef(false);
  useEffect(() => {
    initializedRef.current = false;
  }, [path]);
  useEffect(() => {
    if (!provider?.initializeDirectory || !lazyDirectoryId || childCount > 0) return;
    if (initializedRef.current) return;
    initializedRef.current = true;
    void provider.initializeDirectory(lazyDirectoryId).catch(() => {
      initializedRef.current = false;
    });
  }, [provider, lazyDirectoryId, childCount]);

  if (!provider) {
    return (
      <StatusPanel
        icon={CloudOff}
        title={t('sessions.codeSession.files.unavailableTitle', 'Files unavailable')}
        description={
          providerMessage ?? t('workspace.projects.filesUnavailable', 'Files are unavailable.')
        }
      />
    );
  }

  if ((pending || !treeReady) && childCount === 0) {
    return (
      <StatusPanel
        icon={Loader2}
        spin
        title={t('workspace.projects.loadingFiles', 'Loading files')}
      />
    );
  }

  if (isLazyPending) {
    return (
      <StatusPanel
        icon={Loader2}
        spin
        title={t('workspace.projects.loadingFiles', 'Loading files')}
      />
    );
  }

  if (childCount === 0) {
    return (
      <StatusPanel
        icon={FolderOpen}
        title={t('sessions.codeSession.files.emptyTitle', 'No files here')}
        description={treeMessage ?? t('workspace.projects.emptyFolder', 'This folder is empty.')}
      />
    );
  }

  return (
    <div
      className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain', bottomClearanceClassName)}
      onScroll={(event) => onScrollActivity?.(event.currentTarget.scrollTop)}
    >
      {resolved.children.map((item, index) => (
        <Fragment key={item.path}>
          {index > 0 ? <div className="ml-[3.75rem] h-px bg-border/40" aria-hidden /> : null}
          <FileRow item={item} onOpenDir={onOpenDir} onOpenFile={onOpenFile} />
        </Fragment>
      ))}
    </div>
  );
}

function FileRow({
  item,
  onOpenDir,
  onOpenFile,
}: {
  readonly item: FileTreeItem;
  readonly onOpenDir: (path: string) => void;
  readonly onOpenFile: (path: string) => void;
}) {
  const isDirectory = item.type === 'directory';
  return (
    <button
      type="button"
      onClick={() => (isDirectory ? onOpenDir(item.path) : onOpenFile(item.path))}
      className="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors active:bg-muted/50"
    >
      {isDirectory ? (
        <FolderIcon folderPath={item.path} className="h-7 w-7 shrink-0" />
      ) : (
        <FileIcon filePath={item.path} className="h-7 w-7 shrink-0" />
      )}
      <span
        className={cn(
          'min-w-0 flex-1 truncate text-[1.0625rem] text-foreground',
          item.modified && 'text-amber-500'
        )}
      >
        {basename(item.path)}
      </span>
      {isDirectory ? (
        <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground/40" aria-hidden />
      ) : null}
    </button>
  );
}

function MobileFilePreview({
  provider,
  path,
  onScrollActivity,
  bottomClearanceClassName,
}: {
  readonly provider: FileWorkspaceProvider | null;
  readonly path: string;
  readonly onScrollActivity?: (scrollTop: number) => void;
  readonly bottomClearanceClassName: string;
}) {
  const { t } = useTranslation();
  const [content, setContent] = useState<FileContentState>({ status: 'loading', path });

  useEffect(() => {
    if (!provider) {
      setContent({
        status: 'error',
        path,
        message: t('workspace.projects.fileUnavailable', 'File unavailable'),
      });
      return undefined;
    }

    let cancelled = false;
    setContent({ status: 'loading', path });
    void provider
      .openFile(path)
      .then((result) => {
        if (cancelled) return;
        if (result.status === 'unavailable') {
          setContent({
            status: 'error',
            path,
            message: result.message ?? t('workspace.projects.fileUnavailable', 'File unavailable'),
          });
          return;
        }
        setContent({ status: 'ready', path, snapshot: result.snapshot });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setContent({
          status: 'error',
          path,
          message: error instanceof Error ? error.message : String(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [provider, path, t]);

  if (content.status === 'loading') {
    return (
      <StatusPanel
        icon={Loader2}
        spin
        title={t('workspace.projects.loadingFile', 'Loading file')}
      />
    );
  }

  if (content.status === 'error') {
    return <StatusPanel icon={FileText} title={content.message} tone="destructive" />;
  }

  const snapshot = content.snapshot;
  const isImage = getImageMimeTypeForPath(path) !== undefined;

  // Raster/binary images (png/jpeg/gif/webp/…) arrive as raw bytes. A binary
  // snapshot without bytes is an image that was too large to transfer.
  if (snapshot.kind === 'binary') {
    if (isImage && snapshot.bytes && snapshot.bytes.byteLength > 0) {
      return (
        <MobileImagePreview
          path={path}
          bytes={snapshot.bytes}
          bottomClearanceClassName={bottomClearanceClassName}
        />
      );
    }
    return (
      <StatusPanel
        icon={FileText}
        title={
          isImage
            ? t('workspace.projects.imageTooLarge', 'Image is too large to preview.')
            : t(
                'workspace.projects.binaryPreviewUnavailable',
                'Preview is unavailable for this file.'
              )
        }
      />
    );
  }

  if (snapshot.kind !== 'text') {
    return (
      <StatusPanel
        icon={FileText}
        title={t(
          'workspace.projects.binaryPreviewUnavailable',
          'Preview is unavailable for this file.'
        )}
      />
    );
  }

  // SVG is XML text but is an image: render it rather than showing its source.
  if (isSvgPath(path)) {
    return (
      <MobileImagePreview
        path={path}
        svgText={snapshot.text}
        bottomClearanceClassName={bottomClearanceClassName}
      />
    );
  }

  return (
    <MobileTextPreview
      path={path}
      text={snapshot.text}
      onScrollActivity={onScrollActivity}
      bottomClearanceClassName={bottomClearanceClassName}
    />
  );
}

/* Full-bleed image preview for the file browser. Wraps the shared
   `SessionFileImagePreview` (object-URL backed <img>) in the mobile frame's
   flex/scroll container plus the bottom tab-bar clearance so the image clears
   the floating tab bar. */
function MobileImagePreview({
  path,
  bytes,
  svgText,
  bottomClearanceClassName,
}: {
  readonly path: string;
  readonly bytes?: Uint8Array;
  readonly svgText?: string;
  readonly bottomClearanceClassName: string;
}) {
  return (
    <div className={cn('min-h-0 flex-1 overflow-hidden', bottomClearanceClassName)}>
      <SessionFileImagePreview path={path} bytes={bytes} svgText={svgText} />
    </div>
  );
}

function MobileTextPreview({
  path,
  text,
  onScrollActivity,
  bottomClearanceClassName,
}: {
  readonly path: string;
  readonly text: string;
  readonly onScrollActivity?: (scrollTop: number) => void;
  readonly bottomClearanceClassName: string;
}) {
  const resolvedTheme = useResolvedTheme();
  const activeVSCodeTheme = useActiveVSCodeTheme();
  const conversationFontSize = useAtomValue(conversationFontSizeAtom);

  if (isSessionMarkdownPath(path)) {
    return (
      <div
        className={cn('min-h-0 flex-1 overflow-auto overscroll-contain', bottomClearanceClassName)}
        data-native-selection-allow
        onScroll={(event) => onScrollActivity?.(event.currentTarget.scrollTop)}
      >
        <div className="mx-auto w-full max-w-3xl px-3 py-3 sm:px-4 sm:py-4">
          <MarkdownRenderer text={text} size={conversationFontSize} />
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('min-h-0 flex-1 overflow-hidden overscroll-contain', bottomClearanceClassName)}
    >
      <SessionMonacoTextViewer
        key={path}
        text={text}
        language={getSessionFileMonacoLanguageId(path)}
        resolvedTheme={resolvedTheme}
        vscodeTheme={activeVSCodeTheme ?? null}
        readOnly
        className="h-full min-h-0"
        onScrollChange={({ scrollTop }) => onScrollActivity?.(scrollTop)}
      />
    </div>
  );
}

function StatusPanel({
  icon: Icon,
  title,
  description,
  spin = false,
  tone = 'muted',
}: {
  readonly icon: typeof FileText;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /**
   * Rotates the icon: the panel is a loading state. Defaults to false, and
   * MUST keep a default here — `Spinner` treats an omitted `spinning` as a
   * loading indicator, so forwarding this prop while it is `undefined` would
   * spin the resting states' icons forever.
   */
  readonly spin?: boolean;
  readonly tone?: 'muted' | 'destructive';
}) {
  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center',
        tone === 'destructive' ? 'text-destructive' : 'text-muted-foreground'
      )}
    >
      <Spinner icon={Icon} spinning={spin} className="h-6 w-6" aria-hidden />
      <span className="text-[0.95rem]">{title}</span>
      {description ? (
        <span className="text-[0.8125rem] text-muted-foreground">{description}</span>
      ) : null}
    </div>
  );
}
