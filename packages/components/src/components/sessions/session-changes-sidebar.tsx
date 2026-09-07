import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import type { FileTreeItem } from '@lody/shared';
import {
  createFileIconComponent,
  createFolderIconComponent,
  DefaultFileIcon,
  DefaultFolderIcon,
  FileIcon,
} from '@/components/icons/file-icons';
import { TreeView, type TreeDataItem, type TreeRenderItemParams } from '@/components/tree-view';
import { cn, getBasename } from '@/lib';
import { buildFileTreeFromPaths } from '@/lib/file-tree';
import {
  FILE_CHANGE_CATEGORY_ORDER,
  groupFileChangesByCategory,
  type FileChangeCategory,
} from '@/lib/file-change-category';
import { ScrollArea } from '@/ui/scroll-area';
import type { SessionDiffChangeEntry } from './session-diff-summary';
import { FocusScope, useListKeyboardNavigation } from '@/ui/focus-scope';

export type ChangesViewMode = 'files' | 'types';

type DisplayChangeEntry = SessionDiffChangeEntry & {
  add: number;
  del: number;
  statsUnavailable: boolean;
};

export type SessionChangesSidebarProps = {
  ready: boolean;
  synced: boolean;
  unavailableMessage?: string;
  changeEntries: SessionDiffChangeEntry[];
  changeFilePaths: string[];
  initialViewMode?: ChangesViewMode;
  onOpenChangesDiff: (focusFilePath: string, filePaths: string[]) => void;
};

// Stat columns are fixed-width so +N / -N line up in a clean column across
// every row, instead of jittering with content length.
const STAT_COL_CLASS = 'inline-block min-w-[2.25rem] text-right tabular-nums';

export function SessionChangesSidebar({
  ready,
  synced,
  unavailableMessage,
  changeEntries,
  changeFilePaths,
  initialViewMode = 'types',
  onOpenChangesDiff,
}: SessionChangesSidebarProps) {
  const { t } = useTranslation();
  const scopeId = useId();
  useListKeyboardNavigation({ scopeId });
  const [viewMode, setViewMode] = useState<ChangesViewMode>(initialViewMode);
  const displayEntries = useMemo<DisplayChangeEntry[]>(
    () =>
      changeEntries.map((entry) => ({
        ...entry,
        add: entry.add ?? 0,
        del: entry.del ?? 0,
        statsUnavailable: entry.add === undefined || entry.del === undefined,
      })),
    [changeEntries]
  );

  const groups = useMemo(
    () => groupFileChangesByCategory(displayEntries).filter((g) => g.entries.length > 0),
    [displayEntries]
  );
  const changeEntryByPath = useMemo(
    () => new Map(displayEntries.map((entry) => [entry.filePath, entry])),
    [displayEntries]
  );
  const fileTreeData = useMemo(() => {
    const tree = buildFileTreeFromPaths(displayEntries.map((entry) => entry.filePath));
    return changeFileTreeToTreeData(tree, (filePath) =>
      onOpenChangesDiff(filePath, changeFilePaths)
    );
  }, [displayEntries, changeFilePaths, onOpenChangesDiff]);

  const totals = useMemo(() => {
    let add = 0;
    let del = 0;
    let count = 0;
    let statsUnavailable = false;
    for (const group of groups) {
      add += group.add;
      del += group.del;
      count += group.entries.length;
      if (group.entries.some((entry) => entry.statsUnavailable)) {
        statsUnavailable = true;
      }
    }
    return { add, del, count, statsUnavailable };
  }, [groups]);

  const categoryLabel: Record<FileChangeCategory, string> = {
    code: t('sessions.changes.category.code', 'Code'),
    doc: t('sessions.changes.category.doc', 'Docs'),
    test: t('sessions.changes.category.test', 'Tests'),
    dev: t('sessions.changes.category.dev', 'Dev'),
  };
  const diffStatsUnavailableLabel = t(
    'sessions.changes.diffStatsUnavailable',
    'Diff stats unavailable'
  );

  const renderTreeItem = ({ item, isLeaf, isOpen }: TreeRenderItemParams) => {
    const entry = isLeaf ? changeEntryByPath.get(item.id) : undefined;
    const Icon = resolveTreeItemIcon(item, { isLeaf, isOpen });

    return (
      <>
        <Icon className="mr-1.5 h-4 w-4 shrink-0" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-sm',
            isLeaf ? 'text-foreground/90' : 'text-foreground'
          )}
        >
          {item.name}
        </span>
        {isLeaf && entry ? (
          <RowTrailing
            add={entry.add}
            del={entry.del}
            statsUnavailableLabel={entry.statsUnavailable ? diffStatsUnavailableLabel : undefined}
          />
        ) : null}
      </>
    );
  };

  const renderEntryRow = (entry: DisplayChangeEntry) => {
    return (
      <button
        key={entry.filePath}
        type="button"
        data-id={`change:${entry.filePath}`}
        data-scope-item="row"
        className={cn(
          'group flex h-7 w-full items-center gap-1.5 rounded-md px-2 text-left',
          'text-foreground/90 hover:bg-hover hover:text-hover-foreground',
          'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
        )}
        title={entry.filePath}
        onClick={() => onOpenChangesDiff(entry.filePath, changeFilePaths)}
      >
        <FileIcon filePath={entry.filePath} className="h-4 w-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-sm">{getBasename(entry.filePath)}</span>
        <RowTrailing
          add={entry.add}
          del={entry.del}
          statsUnavailableLabel={entry.statsUnavailable ? diffStatsUnavailableLabel : undefined}
        />
      </button>
    );
  };

  const statusMessage: string | null = !ready
    ? t('sessions.changes.loading', 'Loading changes…')
    : unavailableMessage !== undefined
      ? unavailableMessage
      : !synced
        ? t('sessions.changes.syncing', 'Syncing changes…')
        : changeEntries.length === 0
          ? t('sessions.changes.empty', 'No changes yet.')
          : null;

  const renderBody = (): ReactNode => {
    if (statusMessage !== null) {
      return <EmptyState>{statusMessage}</EmptyState>;
    }
    if (viewMode === 'files') {
      return (
        <div className="px-1 py-1">
          <TreeView
            data={fileTreeData}
            expandAll
            defaultNodeIcon={DefaultFolderIcon}
            defaultLeafIcon={DefaultFileIcon}
            renderItem={renderTreeItem}
            className="p-0"
          />
        </div>
      );
    }
    return (
      <AccordionPrimitive.Root
        type="multiple"
        // Pre-open every category, including ones not currently in `groups`. As
        // entries stream in and new categories appear, they'll show up expanded
        // to mirror the original "always expanded" layout.
        defaultValue={[...FILE_CHANGE_CATEGORY_ORDER]}
        className="flex flex-col px-1.5 py-2"
      >
        {groups.map((group) => (
          <AccordionPrimitive.Item key={group.category} value={group.category}>
            <AccordionPrimitive.Header className="flex">
              <AccordionPrimitive.Trigger
                className={cn(
                  'group flex h-6 w-full items-center gap-1.5 rounded-md px-1 text-left',
                  'hover:bg-hover/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring'
                )}
              >
                <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/70 transition-transform duration-150 group-data-[state=open]:rotate-90" />
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {categoryLabel[group.category]}
                </span>
                <span className="text-[11px] tabular-nums text-muted-foreground/60">
                  {group.entries.length}
                </span>
                <AggregateStats
                  add={group.add}
                  del={group.del}
                  statsUnavailableLabel={
                    group.entries.some((entry) => entry.statsUnavailable)
                      ? diffStatsUnavailableLabel
                      : undefined
                  }
                />
              </AccordionPrimitive.Trigger>
            </AccordionPrimitive.Header>
            <AccordionPrimitive.Content className="overflow-hidden data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down">
              <ul className="mt-0.5 flex flex-col pb-2">{group.entries.map(renderEntryRow)}</ul>
            </AccordionPrimitive.Content>
          </AccordionPrimitive.Item>
        ))}
      </AccordionPrimitive.Root>
    );
  };

  return (
    <FocusScope id={scopeId} className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {t('sessions.changes.title', 'Changes')}
        </span>
        {statusMessage === null && (
          <span className="flex items-baseline gap-1 text-[11px] tabular-nums">
            <span className="text-muted-foreground/70">{totals.count}</span>
            <AggregateStats
              add={totals.add}
              del={totals.del}
              statsUnavailableLabel={
                totals.statsUnavailable ? diffStatsUnavailableLabel : undefined
              }
            />
          </span>
        )}
        <div className="ml-auto inline-flex h-6 items-center rounded-md border border-border/60 bg-muted/40 p-0.5 text-[11px]">
          <SegmentButton active={viewMode === 'types'} onClick={() => setViewMode('types')}>
            {t('sessions.changes.view.types', 'Types')}
          </SegmentButton>
          <SegmentButton active={viewMode === 'files'} onClick={() => setViewMode('files')}>
            {t('sessions.changes.view.files', 'Files')}
          </SegmentButton>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">{renderBody()}</ScrollArea>
    </FocusScope>
  );
}

function SegmentButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
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

function AggregateStats({
  add,
  del,
  statsUnavailableLabel,
}: {
  add: number;
  del: number;
  statsUnavailableLabel?: string;
}) {
  if (statsUnavailableLabel) {
    return (
      <span
        className="inline-block min-w-[4.75rem] text-right text-muted-foreground"
        title={statsUnavailableLabel}
      >
        --
      </span>
    );
  }

  return (
    <>
      <span className={cn(STAT_COL_CLASS, 'text-code-added')}>+{add}</span>
      <span className={cn(STAT_COL_CLASS, 'text-code-removed')}>−{del}</span>
    </>
  );
}

function RowTrailing({
  add,
  del,
  statsUnavailableLabel,
}: {
  add: number;
  del: number;
  statsUnavailableLabel?: string;
}) {
  return (
    <span className="ml-1 flex shrink-0 items-baseline gap-1 text-[11px]">
      {statsUnavailableLabel ? (
        <span className="inline-block min-w-[4.75rem] text-right text-muted-foreground">
          <span title={statsUnavailableLabel}>--</span>
        </span>
      ) : (
        <>
          <span className={cn(STAT_COL_CLASS, 'text-code-added')}>+{add}</span>
          <span className={cn(STAT_COL_CLASS, 'text-code-removed')}>−{del}</span>
        </>
      )}
    </span>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full min-h-[120px] items-center justify-center px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

const changeFileTreeToTreeData = (
  items: FileTreeItem[],
  onFileOpen: (filePath: string) => void
): TreeDataItem[] => {
  const walk = (item: FileTreeItem): TreeDataItem => {
    const name = getBasename(item.path);
    if (item.type === 'directory') {
      const FolderIcon = createFolderIconComponent(item.path);
      return {
        id: item.path,
        name,
        icon: FolderIcon,
        openIcon: FolderIcon,
        children: (item.children ?? []).map(walk),
      };
    }

    const FileIconComponent = createFileIconComponent(item.path);
    return {
      id: item.path,
      name,
      icon: FileIconComponent,
      onClick: () => onFileOpen(item.path),
    };
  };

  return items.map(walk);
};

const resolveTreeItemIcon = (
  item: TreeDataItem,
  state: { isLeaf: boolean; isOpen?: boolean }
): ComponentType<{ className?: string }> => {
  if (state.isLeaf) {
    return item.icon ?? DefaultFileIcon;
  }
  if (state.isOpen) {
    return item.openIcon ?? item.icon ?? DefaultFolderIcon;
  }
  return item.icon ?? DefaultFolderIcon;
};
