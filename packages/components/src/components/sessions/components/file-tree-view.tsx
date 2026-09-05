import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useAtomValue } from 'jotai';
import { useTranslation } from 'react-i18next';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, CloudOff, FileWarning, FolderOpen, RefreshCw } from 'lucide-react';
import { getMachineFlockLocalProjects, type FileTreeItem, type SessionMeta } from '@lody/shared';
import { type TreeDataItem } from '@/components/tree-view';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from '@/ui/context-menu';
import { useSessionFileActions, type SessionFileMenuItem } from '@/hooks/use-session-file-actions';
import { FileTreeSkeleton, FileTreeStatePanel } from './file-tree-states';
import { useFileWorkspaceTree } from '@/hooks/use-code-session';
import { useCodeCollabSessionFileProvider } from '@/hooks/use-code-collab-session-file-provider';
import { useCodeCollabRequestedRole } from '@/hooks/use-code-collab-requested-role';
import { useMachineFlockRows } from '@/hooks/use-machine-flock-rows';
import {
  useLocalProjectFilePaths,
  type LocalProjectFilePathsSource,
} from '@/hooks/use-local-project-file-paths';
import { buildFileTreeFromPaths, markFileTreeModified } from '@/lib/file-tree';
import { getBasename } from '@/lib';
import { cn } from '@/lib/utils';
import {
  flattenVisibleFileTreeRows,
  pruneExpandedFileTreeIds,
  shouldVirtualizeVisibleFileTreeRows,
  type VirtualFileTreeRow as VirtualFileTreeRowModel,
} from '@/lib/file-tree-virtualization';
import {
  EMPTY_FILE_TREE_VIEW_STATE,
  readFileTreeViewState,
  writeFileTreeViewState,
  type FileTreeViewState,
} from '@/lib/file-tree-view-state';
import {
  resolveSessionLocalFileSource,
  resolveSessionLocalProjectRootPath,
  resolveSessionRepoFullName,
} from '@/lib/session-local-file-source';
import { chooseSessionFileSurfaceSource } from '@/lib/session-file-source-selection';
import { logCodeCollabDebug } from '@/lib/code-collab-debug';
import { resolveEffectiveCodeCollabWorkspaceId } from '@/lib/code-collab-workspace-id';
import { currentWorkspaceIdAtom, getMachineMetaByIdAtomFamily, userAtom } from '@/atoms';
import { localMachineIdAtom } from '@/atoms/local-probe';
import { runtimeAtom } from '@/atoms/runtime';
import type { FileWorkspaceProvider } from '@/lib/file-workspace-provider';
import { Button, ScrollArea } from '@/ui';
import {
  createFileIconComponent,
  createFolderIconComponent,
  DefaultFileIcon,
  DefaultFolderIcon,
} from '@/components/icons/file-icons';

interface FileTreeViewProps {
  session: SessionMeta;
  handleOpenFile: (filePath: string) => void;
  fileProvider?: FileWorkspaceProvider | null;
  fileProviderPending?: boolean;
  fileProviderMessage?: string;
  autoCodeCollab?: boolean;
  /**
   * Right-click actions for file rows, from `useSessionFileActions`. The owner
   * passes them because it also renders the same actions in the side panel ⋯
   * menu, and both must offer exactly the same set. Must be stable.
   */
  fileMenuItems?: readonly SessionFileMenuItem[];
  // Paths of files that appear in the session "Changes" list. When provided,
  // these drive the modified-file highlight in the tree (provider metadata does
  // not carry per-file modified state in live mode). Omitted by Storybook /
  // playground callers, which fall back to the tree's own `modified` flags.
  changedFilePaths?: readonly string[];
  // Identifies this tree so its expanded folders and selected row survive an
  // unmount (the side panel swaps the Files tab out for a file/diff viewer).
  // Callers that stay mounted can omit it and keep component-local state.
  viewStateKey?: string;
}

type ControlledFileTreeViewProps = Omit<FileTreeViewProps, 'session' | 'autoCodeCollab'>;

const LOCAL_FILE_REFRESH_HEARTBEAT_BUCKET_MS = 5_000;
const VIRTUAL_FILE_TREE_ROW_HEIGHT_PX = 22;
const VIRTUAL_FILE_TREE_OVERSCAN = 12;
const TREE_INDENT_PX = 8;
const EMPTY_FILE_TREE: FileTreeItem[] = [];

// All loading phases map to the same skeleton surface for the user; the distinct
// branch names are kept only so the debug console can tell them apart.
type FileTreeRenderBranch =
  | 'loading'
  | 'local-loading'
  | 'provider-loading'
  | 'provider-pending'
  | 'local-error'
  | 'unavailable'
  | 'provider-unavailable'
  | 'empty'
  | 'tree';

// Full-height wrapper so the skeleton fills the panel and clips overflow instead
// of introducing its own scrollbar while real content is still loading.
function FileTreeSkeletonSurface() {
  return (
    <div className="h-full overflow-hidden">
      <FileTreeSkeleton />
    </div>
  );
}

const buildLocalFileRefreshToken = (session: SessionMeta): string => {
  const lastMessageAt =
    typeof session.lastMessageAt === 'number' && Number.isFinite(session.lastMessageAt)
      ? session.lastMessageAt
      : '';
  const lastRunningSeenBucket =
    typeof session.lastRunningSeen === 'number' && Number.isFinite(session.lastRunningSeen)
      ? Math.floor(session.lastRunningSeen / LOCAL_FILE_REFRESH_HEARTBEAT_BUCKET_MS)
      : '';
  const changedLineTotals =
    session.diffStats === undefined
      ? ''
      : `${session.diffStats.allChange.add}:${session.diffStats.allChange.del}`;

  return [session.status?.type ?? '', lastMessageAt, lastRunningSeenBucket, changedLineTotals].join(
    '\0'
  );
};

const fileTreeToTreeData = (
  items: FileTreeItem[],
  onFileOpen: (filePath: string) => void,
  onLazyDirectoryOpen?: (directoryId: string) => void
): TreeDataItem[] => {
  const walk = (item: FileTreeItem): TreeDataItem => {
    const name = getBasename(item.path);
    if (item.type === 'directory') {
      const FolderIcon = createFolderIconComponent(item.path);
      const lazyDirectoryId = item.lazyDirectoryId;
      return {
        id: item.path,
        name,
        icon: FolderIcon,
        openIcon: FolderIcon,
        forceNode: lazyDirectoryId !== undefined,
        children: (item.children ?? []).map(walk),
        ...(lazyDirectoryId === undefined || onLazyDirectoryOpen === undefined
          ? {}
          : { onClick: () => onLazyDirectoryOpen(lazyDirectoryId) }),
        className: item.modified ? 'text-modified-file' : undefined,
      };
    }

    const FileIcon = createFileIconComponent(item.path);
    return {
      id: item.path,
      name,
      icon: FileIcon,
      onClick: () => onFileOpen(item.path),
      className: item.modified ? 'text-modified-file' : undefined,
    };
  };

  return items.map(walk);
};

// Memoize the changed-paths lookup so a stable `changedFilePaths` array does not
// rebuild the marked tree every render. Returns `undefined` when no list is
// provided so callers fall back to the tree's own `modified` flags.
const useChangedFilePathSet = (
  changedFilePaths: readonly string[] | undefined
): ReadonlySet<string> | undefined =>
  useMemo(() => (changedFilePaths ? new Set(changedFilePaths) : undefined), [changedFilePaths]);

/**
 * View state that survives an unmount when the caller supplies a `viewStateKey`.
 *
 * The tree is unmounted whenever another side-panel tab is selected, so keeping
 * the expanded set purely in component state collapsed every folder on the way
 * back. Falls back to plain component state when no key is given.
 */
function useFileTreeViewState(
  viewStateKey: string | undefined
): [FileTreeViewState, (update: (current: FileTreeViewState) => FileTreeViewState) => void] {
  const [tracked, setTracked] = useState<{
    readonly key: string | undefined;
    readonly value: FileTreeViewState;
  }>(() => ({ key: viewStateKey, value: readFileTreeViewState(viewStateKey) }));

  // Render-phase resync: an in-place key change (session switch) must adopt that
  // tree's own state instead of carrying the previous tree's expanded folders.
  const value = tracked.key === viewStateKey ? tracked.value : readFileTreeViewState(viewStateKey);
  if (tracked.key !== viewStateKey) {
    setTracked({ key: viewStateKey, value });
  }

  useEffect(() => {
    if (tracked.value === EMPTY_FILE_TREE_VIEW_STATE) return;
    writeFileTreeViewState(tracked.key, tracked.value);
  }, [tracked]);

  const update = useCallback((next: (current: FileTreeViewState) => FileTreeViewState) => {
    setTracked((current) => {
      const nextValue = next(current.value);
      if (nextValue === current.value) return current;
      return { key: current.key, value: nextValue };
    });
  }, []);

  return [value, update];
}

function VirtualFileTree({
  data,
  viewportRef,
  viewStateKey,
  fileMenuItems,
}: {
  readonly data: readonly TreeDataItem[];
  readonly viewportRef: RefObject<HTMLDivElement | null>;
  readonly viewStateKey?: string;
  /**
   * Right-click actions for FILE rows. Must be referentially stable — the rows
   * are memoized against per-frame scroll re-renders.
   */
  readonly fileMenuItems?: readonly SessionFileMenuItem[];
}) {
  const [viewState, updateViewState] = useFileTreeViewState(viewStateKey);
  const selectedId = viewState.selectedId;

  // Prune for RENDERING only. The stored set is the user's intent and must keep
  // ids the current tree cannot resolve yet: a lazily loaded directory is empty
  // until it is initialized, so trimming the state itself would silently drop
  // every nested folder each time the tree is rebuilt from the provider.
  // `pruneExpandedFileTreeIds` returns the same reference on a no-op prune, so a
  // churning `data` reference does not force an extra flatten.
  const expandedIds = useMemo(
    () => pruneExpandedFileTreeIds(viewState.expandedIds, data),
    [data, viewState.expandedIds]
  );

  const rows = useMemo(() => flattenVisibleFileTreeRows(data, expandedIds), [data, expandedIds]);
  const getVirtualItemKey = useCallback((index: number) => rows[index]?.item.id ?? index, [rows]);
  const shouldVirtualizeRows = shouldVirtualizeVisibleFileTreeRows(rows.length);
  const rowVirtualizer = useVirtualizer<HTMLDivElement, HTMLDivElement>({
    count: rows.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => VIRTUAL_FILE_TREE_ROW_HEIGHT_PX,
    getItemKey: getVirtualItemKey,
    overscan: VIRTUAL_FILE_TREE_OVERSCAN,
    enabled: shouldVirtualizeRows,
    useAnimationFrameWithResizeObserver: true,
  });

  // The virtualizer reads `getScrollElement()` from a layout effect, and the
  // Radix ScrollArea viewport it points at is an ANCESTOR host node: React
  // attaches that ref only after this child's layout effects have already run,
  // so the first pass always sees `null` and produces an empty range. The
  // viewport can also legitimately measure 0 while the panel is still being
  // laid out. Re-measure once the scrollport is attached and on every resize.
  //
  // This must never fall back to rendering every row: doing so mounted the
  // entire expanded tree at exactly the moment virtualization was needed.
  useEffect(() => {
    if (!shouldVirtualizeRows) return undefined;
    const viewport = viewportRef.current;
    if (!viewport) return undefined;
    rowVirtualizer.measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => rowVirtualizer.measure());
    observer.observe(viewport);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- rowVirtualizer is stable; re-run when the gate flips.
  }, [shouldVirtualizeRows, viewportRef]);

  const virtualItems = rowVirtualizer.getVirtualItems();
  const renderMode = shouldVirtualizeRows ? 'virtualized' : 'static-visible';

  // Log transitions only. This used to re-log on every range change, which put
  // an allocation into the debug ring buffer on each scroll frame.
  useEffect(() => {
    logCodeCollabDebug('file tree virtual rows state', {
      visibleRowCount: rows.length,
      renderMode,
    });
  }, [renderMode, rows.length]);

  const toggleDirectory = useCallback(
    (itemId: string) => {
      updateViewState((current) => {
        const nextExpandedIds = new Set(current.expandedIds);
        if (nextExpandedIds.has(itemId)) {
          nextExpandedIds.delete(itemId);
        } else {
          nextExpandedIds.add(itemId);
        }
        return { ...current, expandedIds: nextExpandedIds };
      });
    },
    [updateViewState]
  );

  const selectRow = useCallback(
    (itemId: string) => {
      updateViewState((current) =>
        current.selectedId === itemId ? current : { ...current, selectedId: itemId }
      );
    },
    [updateViewState]
  );

  if (!shouldVirtualizeRows) {
    return (
      <div role="tree" className="min-w-0">
        {rows.map((row) => (
          <VirtualFileTreeRow
            key={row.item.id}
            row={row}
            selected={selectedId === row.item.id}
            onSelect={selectRow}
            onToggleDirectory={toggleDirectory}
            fileMenuItems={fileMenuItems}
          />
        ))}
      </div>
    );
  }

  // Keep the total-size spacer even while the range is empty: it gives the
  // scrollport the scrollable height that lets a measure pass resolve a real
  // range, instead of collapsing to zero height and never recovering.
  return (
    <div
      role="tree"
      className="relative min-w-0"
      style={{ height: `${rowVirtualizer.getTotalSize()}px` }}
    >
      {virtualItems.map((virtualItem) => {
        const row = rows[virtualItem.index];
        if (!row) return null;
        return (
          <VirtualFileTreeRow
            key={virtualItem.key}
            row={row}
            selected={selectedId === row.item.id}
            virtualStart={virtualItem.start}
            virtualSize={virtualItem.size}
            onSelect={selectRow}
            onToggleDirectory={toggleDirectory}
            fileMenuItems={fileMenuItems}
          />
        );
      })}
    </div>
  );
}

// Memoized: TanStack Virtual re-renders the list on every scroll frame, so
// without this each frame re-ran every mounted row. `flattenVisibleFileTreeRows`
// allocates fresh row objects per flatten, but a flatten only happens when the
// tree data or the expanded set actually changes — scrolling alone reuses the
// same row objects, so a plain reference comparison is enough to skip the work.
const VirtualFileTreeRow = memo(function VirtualFileTreeRow({
  row,
  selected,
  virtualStart,
  virtualSize,
  onSelect,
  onToggleDirectory,
  fileMenuItems,
}: {
  readonly row: VirtualFileTreeRowModel;
  readonly selected: boolean;
  readonly virtualStart?: number;
  readonly virtualSize?: number;
  readonly onSelect: (itemId: string) => void;
  readonly onToggleDirectory: (itemId: string) => void;
  readonly fileMenuItems?: readonly SessionFileMenuItem[];
}) {
  const item = row.item;
  const disabled = item.disabled === true;
  const isLeaf = !row.hasChildren;
  const Icon =
    selected && item.selectedIcon
      ? item.selectedIcon
      : row.isOpen && item.openIcon
        ? item.openIcon
        : (item.icon ?? (isLeaf ? DefaultFileIcon : DefaultFolderIcon));
  const paddingLeft = row.level * TREE_INDENT_PX + 8 + (isLeaf ? 18 : 0);

  const activate = () => {
    if (disabled) return;
    onSelect(item.id);
    if (row.hasChildren) {
      onToggleDirectory(item.id);
      item.onClick?.();
      return;
    }
    item.onClick?.();
  };

  // A directory always carries a `children` array (empty while a lazy one is
  // uninitialized); only a file has none. `hasChildren` cannot stand in for
  // this — an empty directory has none either.
  const isFile = item.children === undefined;
  const rowButton = (
    <button
      type="button"
      role="treeitem"
      aria-expanded={row.hasChildren ? row.isOpen : undefined}
      aria-level={row.level + 1}
      aria-selected={selected}
      disabled={disabled}
      className={cn(
        'group flex w-full items-center pr-2 text-left text-sm outline-none hover:bg-hover hover:text-hover-foreground focus-visible:bg-hover focus-visible:ring-1 focus-visible:ring-ring',
        // `w-full` resolves against the positioned ancestor once absolute, so
        // the hover/selection background still spans the full row.
        virtualStart !== undefined && 'absolute left-0 top-0',
        selected &&
          'bg-selection text-selection-foreground hover:bg-selection hover:text-selection-foreground',
        disabled && 'cursor-not-allowed opacity-50',
        item.className
      )}
      style={{
        height: `${virtualSize ?? VIRTUAL_FILE_TREE_ROW_HEIGHT_PX}px`,
        paddingLeft,
        ...(virtualStart === undefined ? {} : { transform: `translateY(${virtualStart}px)` }),
      }}
      onClick={activate}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          activate();
          return;
        }
        if (!row.hasChildren) return;
        if (event.key === 'ArrowRight' && !row.isOpen) {
          event.preventDefault();
          onSelect(item.id);
          onToggleDirectory(item.id);
          item.onClick?.();
        } else if (event.key === 'ArrowLeft' && row.isOpen) {
          event.preventDefault();
          onSelect(item.id);
          onToggleDirectory(item.id);
        }
      }}
    >
      {row.hasChildren ? (
        <ChevronRight
          className={cn(
            'mr-0.5 h-4 w-4 shrink-0 text-muted-foreground/70 transition-transform duration-200',
            row.isOpen && 'rotate-90'
          )}
        />
      ) : null}
      <Icon className="mr-1 h-4 w-4 shrink-0" />
      <span className="min-w-0 truncate" title={item.id}>
        {item.name}
      </span>
    </button>
  );

  // Only files get a menu, and only when the surface resolved actions for this
  // session — no menu at all beats a menu that can only disappoint.
  if (!isFile || !fileMenuItems || fileMenuItems.length === 0) return rowButton;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{rowButton}</ContextMenuTrigger>
      <ContextMenuContent className="min-w-[190px]">
        {fileMenuItems.map((menuItem) => {
          const ItemIcon = menuItem.icon;
          return (
            <ContextMenuItem key={menuItem.id} onSelect={() => menuItem.run(item.id)}>
              <ItemIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {menuItem.label}
            </ContextMenuItem>
          );
        })}
      </ContextMenuContent>
    </ContextMenu>
  );
});

function ControlledFileTreeView({
  handleOpenFile,
  fileProvider,
  fileProviderPending,
  fileProviderMessage,
  changedFilePaths,
  viewStateKey,
  fileMenuItems,
}: ControlledFileTreeViewProps) {
  const { t } = useTranslation();
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const initializingDirectoriesRef = useRef<Set<string>>(new Set());
  const providerFileTree = useFileWorkspaceTree(fileProvider, {
    enabled: Boolean(fileProvider),
  });
  const changedFilePathSet = useChangedFilePathSet(changedFilePaths);
  const handleLazyDirectoryOpen = useCallback(
    (directoryId: string) => {
      if (!fileProvider?.initializeDirectory) return;
      if (initializingDirectoriesRef.current.has(directoryId)) return;
      initializingDirectoriesRef.current.add(directoryId);
      void fileProvider.initializeDirectory(directoryId).finally(() => {
        initializingDirectoriesRef.current.delete(directoryId);
      });
    },
    [fileProvider]
  );
  const fileTreeData = useMemo(() => {
    const tree = changedFilePathSet
      ? markFileTreeModified(providerFileTree.state, changedFilePathSet)
      : providerFileTree.state;
    return fileTreeToTreeData(tree, handleOpenFile, handleLazyDirectoryOpen);
  }, [changedFilePathSet, providerFileTree.state, handleOpenFile, handleLazyDirectoryOpen]);
  const message = providerFileTree.message ?? fileProviderMessage;

  // Collapse the connecting/ready phases into a single "loading" surface: the
  // user only needs to know files are loading, not which internal phase we're
  // in. The phase still goes to the debug console for diagnostics.
  const renderBranch: FileTreeRenderBranch = fileProviderPending
    ? 'loading'
    : !fileProvider
      ? 'unavailable'
      : !providerFileTree.ready
        ? 'loading'
        : !providerFileTree.synced
          ? 'unavailable'
          : providerFileTree.state.length === 0
            ? 'empty'
            : 'tree';

  useEffect(() => {
    logCodeCollabDebug('file tree (controlled) render branch', {
      renderBranch,
      fileProviderPending: fileProviderPending === true,
      hasFileProvider: Boolean(fileProvider),
      ready: providerFileTree.ready,
      synced: providerFileTree.synced,
      rootCount: providerFileTree.state.length,
    });
  }, [
    fileProvider,
    fileProviderPending,
    providerFileTree.ready,
    providerFileTree.state.length,
    providerFileTree.synced,
    renderBranch,
  ]);

  if (renderBranch === 'loading') {
    return <FileTreeSkeletonSurface />;
  }
  if (renderBranch === 'unavailable') {
    return (
      <FileTreeStatePanel
        icon={CloudOff}
        title={t('sessions.codeSession.files.unavailableTitle', 'Files unavailable')}
        description={
          message ?? t('sessions.codeSession.files.unavailable', 'Files are unavailable.')
        }
      />
    );
  }
  if (renderBranch === 'empty') {
    return (
      <FileTreeStatePanel
        icon={FolderOpen}
        title={t('sessions.codeSession.files.emptyTitle', 'No files here')}
        description={message ?? t('sessions.codeSession.noFiles', 'This directory is empty.')}
      />
    );
  }

  return (
    <ScrollArea className="h-full" viewportRef={scrollViewportRef}>
      <div className="p-1">
        <VirtualFileTree
          data={fileTreeData}
          viewportRef={scrollViewportRef}
          viewStateKey={viewStateKey}
          {...(fileMenuItems === undefined ? {} : { fileMenuItems })}
        />
      </div>
    </ScrollArea>
  );
}

export const FileTreeView = (props: FileTreeViewProps) => {
  const hasControlledFileProvider =
    props.fileProvider !== undefined || props.fileProviderPending !== undefined;
  if (hasControlledFileProvider || props.autoCodeCollab === false) {
    return <ControlledFileTreeView {...props} />;
  }
  return <AutoFileTreeView {...props} />;
};

export function FileTreeProviderView(props: ControlledFileTreeViewProps) {
  return <ControlledFileTreeView {...props} />;
}

const AutoFileTreeView = ({
  session,
  handleOpenFile,
  fileProvider,
  fileProviderPending,
  fileProviderMessage,
  autoCodeCollab = true,
  changedFilePaths,
  viewStateKey,
  fileMenuItems,
}: FileTreeViewProps) => {
  const { t } = useTranslation();
  const scrollViewportRef = useRef<HTMLDivElement | null>(null);
  const initializingDirectoriesRef = useRef<Set<string>>(new Set());
  // Bumping this nonce changes the local file refresh token, which re-triggers a
  // load in useLocalProjectFilePaths — the cheap way to expose a "Try again" for
  // read errors without threading an imperative refetch through the hook.
  const [localRetryNonce, setLocalRetryNonce] = useState(0);
  const localMachineId = useAtomValue(localMachineIdAtom);
  const workspaceId = useAtomValue(currentWorkspaceIdAtom);
  const workspaceRuntime = useAtomValue(runtimeAtom);
  const effectiveWorkspaceId = resolveEffectiveCodeCollabWorkspaceId({
    currentWorkspaceId: workspaceId,
    runtimeWorkspaceId: workspaceRuntime?.workspaceId,
  });
  const currentUser = useAtomValue(userAtom);
  const sessionMachine = useAtomValue(getMachineMetaByIdAtomFamily(session.machineId));
  const machineFlockRows = useMachineFlockRows(session.machineId, {
    families: ['localProject'],
  });
  const sessionMachineLocalProjects = useMemo(
    () => ({
      ...(sessionMachine?.localProjects ?? {}),
      ...getMachineFlockLocalProjects(machineFlockRows),
    }),
    [machineFlockRows, sessionMachine?.localProjects]
  );
  const isElectronRenderer = typeof window !== 'undefined' && window.__LODY_ELECTRON__ === true;
  const localProjectRootPath = useMemo(
    () => resolveSessionLocalProjectRootPath(session, sessionMachineLocalProjects),
    [session, sessionMachineLocalProjects]
  );
  const localFileSource = useMemo(
    () =>
      resolveSessionLocalFileSource(session, {
        isElectronRenderer,
        localMachineId,
        workspaceId: effectiveWorkspaceId,
        localProjectRootPath,
      }),
    [effectiveWorkspaceId, isElectronRenderer, localMachineId, localProjectRootPath, session]
  );
  const localFilePathsSource = useMemo<LocalProjectFilePathsSource | undefined>(() => {
    if (!localFileSource) {
      return undefined;
    }
    if (localFileSource.kind === 'local-project') {
      return {
        kind: 'project',
        workspaceId: localFileSource.workspaceId,
        machineId: session.machineId,
        localProjectId: localFileSource.localProjectId,
      };
    }
    return {
      kind: 'worktree',
      repoKey: localFileSource.repoKey,
      sessionId: localFileSource.sessionId,
    };
  }, [localFileSource, session.machineId]);
  const hasControlledFileProvider = fileProvider !== undefined || fileProviderPending !== undefined;
  const shouldPreferLocalBeforeAutoProvider =
    !hasControlledFileProvider && Boolean(localFilePathsSource);
  const codeCollabRequestedRole = useCodeCollabRequestedRole();
  // Child-session tabs share the parent's worktree, so the Code Collab space is
  // keyed by the workspace-owning (parent) session. Mirrors localFileSource and
  // the chat-input mention provider; using the raw child id would miss the
  // owner-session file tree and All Changes state.
  const codeCollabSessionId = session.parentSessionId ?? session.id;
  const autoCodeCollabProvider = useCodeCollabSessionFileProvider({
    workspaceId: effectiveWorkspaceId,
    sessionId: codeCollabSessionId,
    enabled: autoCodeCollab && !hasControlledFileProvider && !shouldPreferLocalBeforeAutoProvider,
    requestedRole: codeCollabRequestedRole,
    machineId: session.machineId,
    requestedByUserId: currentUser?.id ?? session.userId,
    githubRepoFullName: resolveSessionRepoFullName(session) || null,
    debugLabel: 'file-tree:auto-provider',
  });
  const activeFileProvider = fileProvider ?? autoCodeCollabProvider.provider;
  const autoCodeCollabProviderPending =
    autoCodeCollab &&
    !hasControlledFileProvider &&
    !shouldPreferLocalBeforeAutoProvider &&
    !autoCodeCollabProvider.provider &&
    (autoCodeCollabProvider.status === 'checking' || autoCodeCollabProvider.status === 'loading');
  const effectiveFileProviderPending =
    fileProviderPending === true || autoCodeCollabProviderPending;
  const effectiveFileProviderMessage = fileProviderMessage ?? autoCodeCollabProvider.message;
  const fileTreeSource = chooseSessionFileSurfaceSource({
    hasFileProvider: Boolean(activeFileProvider),
    fileProviderPending: effectiveFileProviderPending,
    hasLocalFileSource: Boolean(localFilePathsSource),
    allowLocalFileSource: shouldPreferLocalBeforeAutoProvider || !effectiveFileProviderPending,
  });
  const shouldUseLocalFileList = fileTreeSource === 'local';
  const shouldUseProviderFileList = fileTreeSource === 'provider';

  const localFileRefreshToken = useMemo(
    () => `${buildLocalFileRefreshToken(session)}:${localRetryNonce}`,
    [session, localRetryNonce]
  );
  const localProjectFileData = useLocalProjectFilePaths(localFilePathsSource, {
    refreshToken: shouldUseLocalFileList ? localFileRefreshToken : null,
    refreshOnMount: shouldUseLocalFileList,
  });
  const handleRetryLocalFiles = useCallback(() => {
    setLocalRetryNonce((nonce) => nonce + 1);
  }, []);
  const providerFileTree = useFileWorkspaceTree(activeFileProvider, {
    enabled: shouldUseProviderFileList,
  });
  const sessionFileActions = useSessionFileActions({ session, fileProvider: activeFileProvider });

  const localFileTree = useMemo(
    () => buildFileTreeFromPaths(localProjectFileData.entry?.paths ?? []),
    [localProjectFileData.entry?.paths]
  );

  const changedFilePathSet = useChangedFilePathSet(changedFilePaths);
  const activeFileTree = useMemo(() => {
    const baseTree = shouldUseLocalFileList
      ? localFileTree
      : shouldUseProviderFileList
        ? providerFileTree.state
        : EMPTY_FILE_TREE;
    return changedFilePathSet ? markFileTreeModified(baseTree, changedFilePathSet) : baseTree;
  }, [
    changedFilePathSet,
    localFileTree,
    providerFileTree.state,
    shouldUseLocalFileList,
    shouldUseProviderFileList,
  ]);
  const handleLazyDirectoryOpen = useCallback(
    (directoryId: string) => {
      if (!activeFileProvider?.initializeDirectory) return;
      if (initializingDirectoriesRef.current.has(directoryId)) return;
      initializingDirectoriesRef.current.add(directoryId);
      void activeFileProvider.initializeDirectory(directoryId).finally(() => {
        initializingDirectoriesRef.current.delete(directoryId);
      });
    },
    [activeFileProvider]
  );
  const fileTreeData = useMemo(
    () => fileTreeToTreeData(activeFileTree, handleOpenFile, handleLazyDirectoryOpen),
    [activeFileTree, handleLazyDirectoryOpen, handleOpenFile]
  );
  const localStatus = localProjectFileData.status;
  const localError = localProjectFileData.error;
  const localHasEntry = Boolean(localProjectFileData.entry);
  const localIsLoading = localStatus === 'idle' || localStatus === 'loading';
  const localIsErrorWithoutData = localStatus === 'error' && !localHasEntry;
  const localListTruncated = localProjectFileData.entry?.truncated === true;
  const providerMessage = providerFileTree.message;
  const emptyFileTreeMessage = shouldUseProviderFileList
    ? providerMessage
    : !shouldUseLocalFileList
      ? effectiveFileProviderMessage
      : undefined;
  const fileTreeRenderBranch = shouldUseLocalFileList
    ? localIsLoading
      ? 'local-loading'
      : localIsErrorWithoutData
        ? 'local-error'
        : activeFileTree.length === 0
          ? 'empty'
          : 'tree'
    : shouldUseProviderFileList
      ? !providerFileTree.ready
        ? 'provider-loading'
        : !providerFileTree.synced
          ? 'provider-unavailable'
          : activeFileTree.length === 0
            ? 'empty'
            : 'tree'
      : effectiveFileProviderPending
        ? 'provider-pending'
        : 'unavailable';

  useEffect(() => {
    logCodeCollabDebug('file tree source state', {
      sessionId: session.id,
      source: fileTreeSource,
      renderBranch: fileTreeRenderBranch,
      autoCodeCollab,
      hasControlledFileProvider,
      hasLocalFileSource: Boolean(localFilePathsSource),
      hasActiveFileProvider: Boolean(activeFileProvider),
      providerKind: activeFileProvider?.kind ?? null,
      effectiveFileProviderPending,
      effectiveFileProviderMessage: effectiveFileProviderMessage ?? null,
      providerTreeReady: providerFileTree.ready,
      providerTreeSynced: providerFileTree.synced,
      providerTreeRootCount: providerFileTree.state.length,
      providerTreeMessage: providerFileTree.message ?? null,
      activeFileTreeRootCount: activeFileTree.length,
      treeDataRootCount: fileTreeData.length,
      localStatus: localProjectFileData.status,
      localHasEntry: Boolean(localProjectFileData.entry),
    });
  }, [
    activeFileProvider,
    activeFileTree.length,
    autoCodeCollab,
    effectiveFileProviderMessage,
    effectiveFileProviderPending,
    fileTreeData.length,
    fileTreeRenderBranch,
    fileTreeSource,
    hasControlledFileProvider,
    localFilePathsSource,
    localProjectFileData.entry,
    localProjectFileData.status,
    providerFileTree.message,
    providerFileTree.ready,
    providerFileTree.synced,
    providerFileTree.state.length,
    session.id,
  ]);
  const localTruncatedLabel =
    localFileSource?.kind === 'session-worktree'
      ? t(
          'sessions.worktree.files.truncated',
          'Worktree is very large; local file list was truncated.'
        )
      : t(
          'sessions.localProject.files.truncated',
          'Project is very large; local file list was truncated.'
        );

  if (
    fileTreeRenderBranch === 'local-loading' ||
    fileTreeRenderBranch === 'provider-loading' ||
    fileTreeRenderBranch === 'provider-pending'
  ) {
    return <FileTreeSkeletonSurface />;
  }

  if (fileTreeRenderBranch === 'local-error') {
    return (
      <FileTreeStatePanel
        icon={FileWarning}
        tone="error"
        title={t('sessions.codeSession.files.loadErrorTitle', "Couldn't load files")}
        description={
          localError ?? t('sessions.localProject.files.loadFailed', 'Failed to load files.')
        }
        action={
          <Button variant="outline" size="sm" className="gap-1.5" onClick={handleRetryLocalFiles}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t('sessions.codeSession.files.retry', 'Try again')}
          </Button>
        }
      />
    );
  }

  if (fileTreeRenderBranch === 'provider-unavailable' || fileTreeRenderBranch === 'unavailable') {
    return (
      <FileTreeStatePanel
        icon={CloudOff}
        title={t('sessions.codeSession.files.unavailableTitle', 'Files unavailable')}
        description={
          emptyFileTreeMessage ??
          providerMessage ??
          t('sessions.codeSession.files.unavailable', 'Files are unavailable.')
        }
      />
    );
  }

  if (fileTreeRenderBranch === 'empty') {
    return (
      <FileTreeStatePanel
        icon={FolderOpen}
        title={t('sessions.codeSession.files.emptyTitle', 'No files here')}
        description={
          emptyFileTreeMessage ?? t('sessions.codeSession.noFiles', 'This directory is empty.')
        }
      />
    );
  }

  return (
    <ScrollArea className="h-full" viewportRef={scrollViewportRef}>
      <div className="p-1">
        <VirtualFileTree
          data={fileTreeData}
          viewportRef={scrollViewportRef}
          viewStateKey={viewStateKey}
          fileMenuItems={fileMenuItems ?? sessionFileActions.menuItems}
        />

        {shouldUseLocalFileList && localListTruncated ? (
          <div className="pt-2 text-xs text-muted-foreground">{localTruncatedLabel}</div>
        ) : null}
      </div>
    </ScrollArea>
  );
};
