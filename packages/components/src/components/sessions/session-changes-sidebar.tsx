import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronRight } from 'lucide-react';
import { useId, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import * as stylex from '@stylexjs/stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import type { FileTreeItem } from '@lody/shared';
import {
  createFileIconComponent,
  createFolderIconComponent,
  DefaultFileIcon,
  DefaultFolderIcon,
  FileIcon,
} from '@/components/icons/file-icons';
import { TreeView, type TreeDataItem, type TreeRenderItemParams } from '@/components/tree-view';
import { getBasename } from '@/lib';
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

const accordionDown = stylex.keyframes({
  from: { height: 0 },
  to: {
    height:
      'var(--radix-accordion-content-height, var(--bits-accordion-content-height, var(--reka-accordion-content-height, var(--kb-accordion-content-height, var(--ngp-accordion-content-height, auto)))))',
  },
});
const accordionUp = stylex.keyframes({
  from: {
    height:
      'var(--radix-accordion-content-height, var(--bits-accordion-content-height, var(--reka-accordion-content-height, var(--kb-accordion-content-height, var(--ngp-accordion-content-height, auto)))))',
  },
  to: { height: 0 },
});
const accordionTriggerMarker = stylex.defaultMarker();

export type SessionChangesSidebarProps = {
  ready: boolean;
  synced: boolean;
  unavailableMessage?: string;
  changeEntries: SessionDiffChangeEntry[];
  changeFilePaths: string[];
  initialViewMode?: ChangesViewMode;
  onOpenChangesDiff: (focusFilePath: string, filePaths: string[]) => void;
};

const styles = stylex.create({
  scope: { display: 'flex', height: '100%', flexDirection: 'column' },
  header: {
    display: 'flex',
    height: '40px',
    flexShrink: 0,
    alignItems: 'center',
    gap: space[2],
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderBottomColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    paddingInline: space[3],
  },
  heading: {
    color: 'hsl(var(--muted-foreground))',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  },
  totals: {
    display: 'flex',
    alignItems: 'baseline',
    gap: space[1],
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
  },
  subdued: { color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)' },
  viewSwitch: {
    display: 'inline-flex',
    height: '24px',
    alignItems: 'center',
    marginInlineStart: 'auto',
    borderWidth: '1px',
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
    borderRadius: 'var(--radius-md)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--muted)) 40%, transparent)',
    padding: '2px',
    fontSize: '11px',
  },
  scrollContent: { minHeight: 0, flex: '1 1 0%' },
  fileTreePadding: { paddingBlock: space[1], paddingInline: space[1] },
  categoryList: {
    display: 'flex',
    flexDirection: 'column',
    paddingBlock: space[2],
    paddingInline: space[1.5],
  },
  categoryHeader: { display: 'flex' },
  categoryTrigger: {
    display: 'flex',
    width: '100%',
    height: '24px',
    alignItems: 'center',
    gap: space[1.5],
    borderRadius: 'var(--radius-md)',
    paddingInline: space[1],
    textAlign: 'left',
    backgroundColor: {
      default: null,
      ':hover': 'color-mix(in oklab, hsl(var(--hover)) 60%, transparent)',
    },
    outline: {
      default: null,
      ':focus-visible': 'none',
    },
    boxShadow: {
      default: null,
      ':focus-visible': '0 0 0 1px hsl(var(--ring))',
    },
  },
  categoryIcon: {
    width: '12px',
    height: '12px',
    flexShrink: 0,
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
    transitionProperty: 'transform',
    transitionDuration: '150ms',
    transform: {
      default: 'rotate(0deg)',
      [stylex.when.ancestor('[data-state="open"]')]: 'rotate(90deg)',
    },
  },
  categoryLabel: {
    color: 'hsl(var(--muted-foreground))',
    fontSize: '11px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  },
  categoryCount: {
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 60%, transparent)',
    fontSize: '11px',
    fontVariantNumeric: 'tabular-nums',
  },
  categoryContent: {
    overflow: 'hidden',
    animationName: {
      default: 'none',
      '[data-state="open"]': accordionDown,
      '[data-state="closed"]': accordionUp,
    },
    animationDuration: {
      default: 'var(--tw-animation-duration, var(--tw-duration, .2s))',
      '[data-state="open"]': 'var(--tw-animation-duration, var(--tw-duration, .2s))',
      '[data-state="closed"]': 'var(--tw-animation-duration, var(--tw-duration, .2s))',
    },
    animationTimingFunction: {
      default: 'var(--tw-ease, ease-out)',
      '[data-state="open"]': 'var(--tw-ease, ease-out)',
      '[data-state="closed"]': 'var(--tw-ease, ease-out)',
    },
    animationDelay: 'var(--tw-animation-delay, 0s)',
    animationIterationCount: 'var(--tw-animation-iteration-count, 1)',
    animationDirection: 'var(--tw-animation-direction, normal)',
    animationFillMode: 'var(--tw-animation-fill-mode, none)',
  },
  categoryRows: {
    display: 'flex',
    flexDirection: 'column',
    marginTop: '2px',
    paddingBottom: space[2],
  },
  fileRow: {
    display: 'flex',
    width: '100%',
    minHeight: '36px',
    alignItems: 'center',
    gap: space[1.5],
    borderRadius: 'var(--radius-md)',
    paddingBlock: space[1],
    paddingInline: space[2],
    color: {
      default: 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)',
      ':hover': 'hsl(var(--hover-foreground))',
    },
    textAlign: 'left',
    backgroundColor: {
      default: null,
      ':hover': 'hsl(var(--hover))',
    },
    outline: {
      default: null,
      ':focus-visible': 'none',
    },
    boxShadow: {
      default: null,
      ':focus-visible': '0 0 0 1px hsl(var(--ring))',
    },
  },
  fileIcon: { width: '16px', height: '16px', flexShrink: 0 },
  fileNameStack: {
    display: 'flex',
    minWidth: 0,
    flex: '1 1 0%',
    flexDirection: 'column',
    justifyContent: 'center',
    lineHeight: 1.25,
  },
  fileName: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '14px',
    lineHeight: '20px',
  },
  parentPath: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    color: 'color-mix(in oklab, hsl(var(--muted-foreground)) 70%, transparent)',
    fontSize: '10px',
  },
  treeIcon: { width: '16px', height: '16px', flexShrink: 0, marginInlineEnd: space[1.5] },
  treeName: {
    minWidth: 0,
    flex: '1 1 0%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: '14px',
    lineHeight: '20px',
  },
  treeLeafName: { color: 'color-mix(in oklab, hsl(var(--foreground)) 90%, transparent)' },
  treeDirectoryName: { color: 'hsl(var(--foreground))' },
  stats: {
    display: 'inline-block',
    minWidth: '2.25rem',
    textAlign: 'right',
    fontVariantNumeric: 'tabular-nums',
  },
  aggregateStats: {
    display: 'inline-block',
    minWidth: '4.75rem',
    color: 'hsl(var(--muted-foreground))',
    textAlign: 'right',
  },
  rowTrailing: {
    display: 'flex',
    flexShrink: 0,
    alignItems: 'baseline',
    gap: space[1],
    marginInlineStart: space[1],
    fontSize: '11px',
  },
  added: { color: 'hsl(var(--github-addition))' },
  deleted: { color: 'hsl(var(--github-deletion))' },
  segmentButton: {
    height: '20px',
    borderRadius: 'var(--radius-sm)',
    paddingInline: space[2],
    fontSize: '11px',
    fontWeight: 500,
    transitionProperty: 'color, background-color',
    transitionDuration: '150ms',
  },
  segmentActive: {
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)',
  },
  segmentInactive: {
    color: {
      default: 'hsl(var(--muted-foreground))',
      ':hover': 'hsl(var(--foreground))',
    },
  },
  emptyState: {
    display: 'flex',
    height: '100%',
    minHeight: '120px',
    alignItems: 'center',
    justifyContent: 'center',
    paddingBlock: space[6],
    paddingInline: space[4],
    color: 'hsl(var(--muted-foreground))',
    fontSize: '14px',
    lineHeight: '20px',
    textAlign: 'center',
  },
});

function getParentPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const separatorIndex = normalized.lastIndexOf('/');
  return separatorIndex > 0 ? normalized.slice(0, separatorIndex) : '';
}

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
        <Icon className={stylex.props(styles.treeIcon).className} />
        <span
          {...stylex.props(
            styles.treeName,
            isLeaf ? styles.treeLeafName : styles.treeDirectoryName
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
    const parentPath = getParentPath(entry.filePath);
    return (
      <button
        key={entry.filePath}
        type="button"
        data-id={`change:${entry.filePath}`}
        data-scope-item="row"
        {...stylex.props(styles.fileRow)}
        title={entry.filePath}
        onClick={() => onOpenChangesDiff(entry.filePath, changeFilePaths)}
      >
        <FileIcon filePath={entry.filePath} className={stylex.props(styles.fileIcon).className} />
        <span {...stylex.props(styles.fileNameStack)} title={entry.filePath}>
          <span {...stylex.props(styles.fileName)}>{getBasename(entry.filePath)}</span>
          {parentPath ? <span {...stylex.props(styles.parentPath)}>{parentPath}/</span> : null}
        </span>
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
        <div {...stylex.props(styles.fileTreePadding)}>
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
        {...stylex.props(styles.categoryList)}
      >
        {groups.map((group) => (
          <AccordionPrimitive.Item key={group.category} value={group.category}>
            <AccordionPrimitive.Header {...stylex.props(styles.categoryHeader)}>
              <AccordionPrimitive.Trigger
                {...stylex.props(styles.categoryTrigger, accordionTriggerMarker)}
              >
                <ChevronRight {...stylex.props(styles.categoryIcon)} />
                <span {...stylex.props(styles.categoryLabel)}>{categoryLabel[group.category]}</span>
                <span {...stylex.props(styles.categoryCount)}>{group.entries.length}</span>
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
            <AccordionPrimitive.Content {...stylex.props(styles.categoryContent)}>
              <ul {...stylex.props(styles.categoryRows)}>{group.entries.map(renderEntryRow)}</ul>
            </AccordionPrimitive.Content>
          </AccordionPrimitive.Item>
        ))}
      </AccordionPrimitive.Root>
    );
  };

  return (
    <FocusScope id={scopeId} {...stylex.props(styles.scope)}>
      <div {...stylex.props(styles.header)}>
        <span {...stylex.props(styles.heading)}>{t('sessions.changes.title', 'Changes')}</span>
        {statusMessage === null && (
          <span {...stylex.props(styles.totals)}>
            <span {...stylex.props(styles.subdued)}>{totals.count}</span>
            <AggregateStats
              add={totals.add}
              del={totals.del}
              statsUnavailableLabel={
                totals.statsUnavailable ? diffStatsUnavailableLabel : undefined
              }
            />
          </span>
        )}
        <div {...stylex.props(styles.viewSwitch)}>
          <SegmentButton active={viewMode === 'types'} onClick={() => setViewMode('types')}>
            {t('sessions.changes.view.types', 'Types')}
          </SegmentButton>
          <SegmentButton active={viewMode === 'files'} onClick={() => setViewMode('files')}>
            {t('sessions.changes.view.files', 'Files')}
          </SegmentButton>
        </div>
      </div>
      <ScrollArea className={stylex.props(styles.scrollContent).className}>
        {renderBody()}
      </ScrollArea>
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
      {...stylex.props(
        styles.segmentButton,
        active ? styles.segmentActive : styles.segmentInactive
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
      <span {...stylex.props(styles.aggregateStats)} title={statsUnavailableLabel}>
        --
      </span>
    );
  }

  return (
    <>
      <span {...stylex.props(styles.stats, styles.added)}>+{add}</span>
      <span {...stylex.props(styles.stats, styles.deleted)}>−{del}</span>
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
    <span {...stylex.props(styles.rowTrailing)}>
      {statsUnavailableLabel ? (
        <span {...stylex.props(styles.aggregateStats)}>
          <span title={statsUnavailableLabel}>--</span>
        </span>
      ) : (
        <>
          <span {...stylex.props(styles.stats, styles.added)}>+{add}</span>
          <span {...stylex.props(styles.stats, styles.deleted)}>−{del}</span>
        </>
      )}
    </span>
  );
}

function EmptyState({ children }: { children: ReactNode }) {
  return <div {...stylex.props(styles.emptyState)}>{children}</div>;
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
