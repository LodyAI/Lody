import React from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import { Tooltip } from '@lody/ui/tooltip';
import { cn } from '@/lib/utils';
import { themeColors } from '../style/theme-colors.stylex';
import {
  themeDuration,
  themeEasing,
  themeFontSize,
  themeLineHeight,
  themeSpace,
} from '../style/theme-scale.stylex';

// VSCode-inspired tree layout constants
// Row height: 22px (VSCode standard for file explorer items)
// Indent per level: 8px (configurable in VSCode via workbench.tree.indent)
const TREE_INDENT_PX = 8;

/**
 * A tree row's look. The `group` marker and the `group-hover:` reveal of the
 * trailing actions stay Tailwind: StyleX cannot select an ancestor, so the
 * hover that reveals the actions is the one rule a row keeps in the old
 * vocabulary.
 */
const GROUP_CLASS = 'group';
const GROUP_HOVER_REVEAL_CLASS = 'group-hover:block';
/** The twisty follows the group's open state; StyleX cannot select a child. */
const OPEN_CHEVRON_CLASS = '[&[data-state=open]>svg:first-child]:rotate-90';

const styles = stylex.create({
  root: {
    position: 'relative',
    padding: themeSpace[2],
    overflow: 'hidden',
  },
  /** The strip below the tree that accepts a drop on the tree itself. */
  dropTarget: { width: '100%', height: '48px' },

  /**
   * A row at rest: no fill, the pointer's wash on hover, the row's own ink.
   * The selected and dragged-over rows restate the whole pair, because a
   * later StyleX style replaces a property rather than adding a condition to
   * it.
   */
  rowIdle: {
    position: 'relative',
    paddingInlineEnd: themeSpace[2],
    backgroundColor: { default: 'transparent', ':hover': themeColors.hover },
    color: { default: 'inherit', ':hover': themeColors.hoverForeground },
  },
  rowSelected: {
    position: 'relative',
    paddingInlineEnd: themeSpace[2],
    backgroundColor: { default: themeColors.selection, ':hover': themeColors.selection },
    color: { default: themeColors.selectionForeground, ':hover': themeColors.selectionForeground },
  },
  rowDragOver: {
    position: 'relative',
    paddingInlineEnd: themeSpace[2],
    backgroundColor: { default: 'hsl(var(--primary) / 0.3)', ':hover': themeColors.hover },
    color: { default: 'inherit', ':hover': themeColors.hoverForeground },
  },
  rowSelectedDragOver: {
    position: 'relative',
    paddingInlineEnd: themeSpace[2],
    backgroundColor: { default: 'hsl(var(--primary) / 0.3)', ':hover': themeColors.selection },
    color: { default: themeColors.selectionForeground, ':hover': themeColors.selectionForeground },
  },

  /** A leaf row: the box a file name sits in. */
  leaf: {
    display: 'flex',
    textAlign: 'left',
    alignItems: 'center',
    height: '22px',
    cursor: 'pointer',
  },
  leafDisabled: { opacity: 0.5, cursor: 'not-allowed', pointerEvents: 'none' },

  /** A node's trigger: the same box, plus the twisty. */
  trigger: {
    display: 'flex',
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: '0%',
    width: '100%',
    alignItems: 'center',
    height: '22px',
    textAlign: 'left',
  },
  accordionContent: {
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  chevron: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    marginRight: themeSpace[0.5],
    color: 'hsl(var(--muted-foreground) / 0.7)',
    transitionProperty: 'transform, translate, scale, rotate',
    transitionDuration: themeDuration[200],
    transitionTimingFunction: themeEasing['in-out'],
  },
  icon: {
    width: themeSpace[4],
    height: themeSpace[4],
    flexShrink: 0,
    marginRight: themeSpace[1],
  },
  label: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontSize: themeFontSize.sm,
    lineHeight: themeLineHeight.sm,
  },
  /** The trailing actions: hidden until the row is hovered or selected. */
  actions: {
    position: 'absolute',
    right: themeSpace[3],
  },
  actionsVisible: { display: 'block' },
  actionsHidden: { display: 'none' },
});

interface TreeDataItem {
  id: string;
  name: string;
  icon?: React.ComponentType<{ className?: string }>;
  selectedIcon?: React.ComponentType<{ className?: string }>;
  openIcon?: React.ComponentType<{ className?: string }>;
  children?: TreeDataItem[];
  forceNode?: boolean;
  actions?: React.ReactNode;
  onClick?: () => void;
  draggable?: boolean;
  droppable?: boolean;
  disabled?: boolean;
  className?: string;
}

type TreeRenderItemParams = {
  item: TreeDataItem;
  level: number;
  isLeaf: boolean;
  isSelected: boolean;
  isOpen?: boolean;
  hasChildren: boolean;
};

type TreeProps = React.HTMLAttributes<HTMLDivElement> & {
  data: TreeDataItem[] | TreeDataItem;
  initialSelectedItemId?: string;
  onSelectChange?: (item: TreeDataItem | undefined) => void;
  expandAll?: boolean;
  defaultNodeIcon?: React.ComponentType<{ className?: string }>;
  defaultLeafIcon?: React.ComponentType<{ className?: string }>;
  onDocumentDrag?: (sourceItem: TreeDataItem, targetItem: TreeDataItem) => void;
  renderItem?: (params: TreeRenderItemParams) => React.ReactNode;
};

const TreeView = React.forwardRef<HTMLDivElement, TreeProps>(
  (
    {
      data,
      initialSelectedItemId,
      onSelectChange,
      expandAll,
      defaultLeafIcon,
      defaultNodeIcon,
      className,
      onDocumentDrag,
      renderItem,
      ...props
    },
    ref
  ) => {
    const [selectedItemId, setSelectedItemId] = React.useState<string | undefined>(
      initialSelectedItemId
    );

    const [draggedItem, setDraggedItem] = React.useState<TreeDataItem | null>(null);

    const handleSelectChange = React.useCallback(
      (item: TreeDataItem | undefined) => {
        setSelectedItemId(item?.id);
        if (onSelectChange) {
          onSelectChange(item);
        }
      },
      [onSelectChange]
    );

    const handleDragStart = React.useCallback((item: TreeDataItem) => {
      setDraggedItem(item);
    }, []);

    const handleDrop = React.useCallback(
      (targetItem: TreeDataItem) => {
        if (draggedItem && onDocumentDrag && draggedItem.id !== targetItem.id) {
          onDocumentDrag(draggedItem, targetItem);
        }
        setDraggedItem(null);
      },
      [draggedItem, onDocumentDrag]
    );

    const expandedItemIds = React.useMemo(() => {
      const ids: string[] = [];

      function collectExpandableItemIds(items: TreeDataItem[] | TreeDataItem) {
        if (Array.isArray(items)) {
          for (const item of items) {
            collectExpandableItemIds(item);
          }
          return;
        }

        if (items.children?.length) {
          ids.push(items.id);
          collectExpandableItemIds(items.children);
        }
      }

      if (expandAll) {
        collectExpandableItemIds(data);
        return ids;
      }

      if (!initialSelectedItemId) {
        return ids;
      }

      function walkTreeItems(items: TreeDataItem[] | TreeDataItem, targetId: string) {
        if (Array.isArray(items)) {
          for (let i = 0; i < items.length; i++) {
            ids.push(items[i].id);
            if (walkTreeItems(items[i], targetId)) {
              return true;
            }
            ids.pop();
          }
        } else if (items.id === targetId) {
          return true;
        } else if (items.children) {
          return walkTreeItems(items.children, targetId);
        }
        return false;
      }

      walkTreeItems(data, initialSelectedItemId);
      return ids;
    }, [data, expandAll, initialSelectedItemId]);

    const rootProps = stylex.props(styles.root);
    return (
      <Tooltip.Provider delay={500}>
        <div {...rootProps} className={clsx(rootProps.className, className)}>
          <TreeItem
            data={data}
            ref={ref}
            selectedItemId={selectedItemId}
            handleSelectChange={handleSelectChange}
            expandedItemIds={expandedItemIds}
            defaultLeafIcon={defaultLeafIcon}
            defaultNodeIcon={defaultNodeIcon}
            handleDragStart={handleDragStart}
            handleDrop={handleDrop}
            draggedItem={draggedItem}
            renderItem={renderItem}
            level={0}
            {...props}
          />
          <div
            {...stylex.props(styles.dropTarget)}
            onDrop={() => {
              handleDrop({ id: '', name: 'parent_div' });
            }}
          ></div>
        </div>
      </Tooltip.Provider>
    );
  }
);
TreeView.displayName = 'TreeView';

type TreeItemProps = TreeProps & {
  selectedItemId?: string;
  handleSelectChange: (item: TreeDataItem | undefined) => void;
  expandedItemIds: string[];
  defaultNodeIcon?: React.ComponentType<{ className?: string }>;
  defaultLeafIcon?: React.ComponentType<{ className?: string }>;
  handleDragStart?: (item: TreeDataItem) => void;
  handleDrop?: (item: TreeDataItem) => void;
  draggedItem: TreeDataItem | null;
  level?: number;
};

const TreeItem = React.forwardRef<HTMLDivElement, TreeItemProps>(
  (
    {
      className,
      data,
      selectedItemId,
      handleSelectChange,
      expandedItemIds,
      defaultNodeIcon,
      defaultLeafIcon,
      handleDragStart,
      handleDrop,
      draggedItem,
      renderItem,
      level,
      // onSelectChange,
      // expandAll,
      // initialSelectedItemId,
      // onDocumentDrag,
      ...props
    },
    ref
  ) => {
    if (!Array.isArray(data)) {
      data = [data];
    }
    return (
      <div ref={ref} role="tree" className={className} {...props}>
        <ul>
          {data.map((item) => (
            <li key={item.id}>
              {item.children ? (
                <TreeNode
                  item={item}
                  level={level ?? 0}
                  selectedItemId={selectedItemId}
                  expandedItemIds={expandedItemIds}
                  handleSelectChange={handleSelectChange}
                  defaultNodeIcon={defaultNodeIcon}
                  defaultLeafIcon={defaultLeafIcon}
                  handleDragStart={handleDragStart}
                  handleDrop={handleDrop}
                  draggedItem={draggedItem}
                  renderItem={renderItem}
                />
              ) : (
                <TreeLeaf
                  item={item}
                  level={level ?? 0}
                  selectedItemId={selectedItemId}
                  handleSelectChange={handleSelectChange}
                  defaultLeafIcon={defaultLeafIcon}
                  handleDragStart={handleDragStart}
                  handleDrop={handleDrop}
                  draggedItem={draggedItem}
                  renderItem={renderItem}
                />
              )}
            </li>
          ))}
        </ul>
      </div>
    );
  }
);
TreeItem.displayName = 'TreeItem';

const TreeNode = ({
  item,
  handleSelectChange,
  expandedItemIds,
  selectedItemId,
  defaultNodeIcon,
  defaultLeafIcon,
  handleDragStart,
  handleDrop,
  draggedItem,
  renderItem,
  level = 0,
}: {
  item: TreeDataItem;
  handleSelectChange: (item: TreeDataItem | undefined) => void;
  expandedItemIds: string[];
  selectedItemId?: string;
  defaultNodeIcon?: React.ComponentType<{ className?: string }>;
  defaultLeafIcon?: React.ComponentType<{ className?: string }>;
  handleDragStart?: (item: TreeDataItem) => void;
  handleDrop?: (item: TreeDataItem) => void;
  draggedItem: TreeDataItem | null;
  renderItem?: (params: TreeRenderItemParams) => React.ReactNode;
  level?: number;
}) => {
  const [value, setValue] = React.useState(expandedItemIds.includes(item.id) ? [item.id] : []);
  const [isDragOver, setIsDragOver] = React.useState(false);
  const hasChildren = !!item.children?.length || item.forceNode === true;
  const isSelected = selectedItemId === item.id;
  const isOpen = value.includes(item.id);

  const onDragStart = (e: React.DragEvent) => {
    if (!item.draggable) {
      e.preventDefault();
      return;
    }
    e.dataTransfer.setData('text/plain', item.id);
    handleDragStart?.(item);
  };

  const onDragOver = (e: React.DragEvent) => {
    if (item.droppable !== false && draggedItem && draggedItem.id !== item.id) {
      e.preventDefault();
      setIsDragOver(true);
    }
  };

  const onDragLeave = () => {
    setIsDragOver(false);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    handleDrop?.(item);
  };

  const rowProps = stylex.props(
    isSelected
      ? isDragOver
        ? styles.rowSelectedDragOver
        : styles.rowSelected
      : isDragOver
        ? styles.rowDragOver
        : styles.rowIdle
  );

  return (
    <AccordionPrimitive.Root type="multiple" value={value} onValueChange={(s) => setValue(s)}>
      <AccordionPrimitive.Item value={item.id}>
        <AccordionTrigger
          level={level}
          role="treeitem"
          aria-level={level + 1}
          aria-selected={isSelected}
          aria-disabled={item.disabled === true ? true : undefined}
          className={clsx(rowProps.className, GROUP_CLASS, item.className)}
          onClick={() => {
            handleSelectChange(item);
            item.onClick?.();
          }}
          draggable={!!item.draggable}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          {renderItem ? (
            renderItem({
              item,
              level,
              isLeaf: false,
              isSelected,
              isOpen,
              hasChildren,
            })
          ) : (
            <>
              <TreeIcon
                item={item}
                isSelected={isSelected}
                isOpen={isOpen}
                default={defaultNodeIcon}
              />
              <TreeItemLabel name={item.name} />
              <TreeActions isSelected={isSelected}>{item.actions}</TreeActions>
            </>
          )}
        </AccordionTrigger>
        <AccordionContent>
          <TreeItem
            data={item.children ? item.children : item}
            selectedItemId={selectedItemId}
            handleSelectChange={handleSelectChange}
            expandedItemIds={expandedItemIds}
            defaultLeafIcon={defaultLeafIcon}
            defaultNodeIcon={defaultNodeIcon}
            handleDragStart={handleDragStart}
            handleDrop={handleDrop}
            draggedItem={draggedItem}
            renderItem={renderItem}
            level={level + 1}
          />
        </AccordionContent>
      </AccordionPrimitive.Item>
    </AccordionPrimitive.Root>
  );
};

const TreeLeaf = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement> & {
    item: TreeDataItem;
    level: number;
    selectedItemId?: string;
    handleSelectChange: (item: TreeDataItem | undefined) => void;
    defaultLeafIcon?: React.ComponentType<{ className?: string }>;
    handleDragStart?: (item: TreeDataItem) => void;
    handleDrop?: (item: TreeDataItem) => void;
    draggedItem: TreeDataItem | null;
    renderItem?: (params: TreeRenderItemParams) => React.ReactNode;
  }
>(
  (
    {
      className,
      item,
      level,
      selectedItemId,
      handleSelectChange,
      defaultLeafIcon,
      handleDragStart,
      handleDrop,
      draggedItem,
      renderItem,
      ...props
    },
    ref
  ) => {
    const [isDragOver, setIsDragOver] = React.useState(false);
    const isSelected = selectedItemId === item.id;

    const onDragStart = (e: React.DragEvent) => {
      if (!item.draggable || item.disabled) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/plain', item.id);
      handleDragStart?.(item);
    };

    const onDragOver = (e: React.DragEvent) => {
      if (item.droppable !== false && !item.disabled && draggedItem && draggedItem.id !== item.id) {
        e.preventDefault();
        setIsDragOver(true);
      }
    };

    const onDragLeave = () => {
      setIsDragOver(false);
    };

    const onDrop = (e: React.DragEvent) => {
      if (item.disabled) return;
      e.preventDefault();
      setIsDragOver(false);
      handleDrop?.(item);
    };

    const activate = () => {
      if (item.disabled) return;
      handleSelectChange(item);
      item.onClick?.();
    };

    // Leaf padding: level indent + 8px base + 18px for chevron alignment
    const leafPaddingLeft = level * TREE_INDENT_PX + 8 + 18;

    const rowProps = stylex.props(
      isSelected
        ? isDragOver
          ? styles.rowSelectedDragOver
          : styles.rowSelected
        : isDragOver
          ? styles.rowDragOver
          : styles.rowIdle
    );
    const leafProps = stylex.props(styles.leaf, item.disabled && styles.leafDisabled);

    return (
      <div
        ref={ref}
        role="treeitem"
        tabIndex={item.disabled ? undefined : 0}
        aria-level={level + 1}
        aria-selected={isSelected}
        aria-disabled={item.disabled === true ? true : undefined}
        className={clsx(
          leafProps.className,
          rowProps.className,
          GROUP_CLASS,
          cn(className, item.className)
        )}
        style={{ paddingLeft: leafPaddingLeft }}
        onClick={activate}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            activate();
          }
        }}
        draggable={!!item.draggable && !item.disabled}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        {...props}
      >
        {renderItem ? (
          renderItem({
            item,
            level,
            isLeaf: true,
            isSelected,
            hasChildren: false,
          })
        ) : (
          <>
            <TreeIcon item={item} isSelected={isSelected} default={defaultLeafIcon} />
            <TreeItemLabel name={item.name} className="grow" />
            <TreeActions isSelected={isSelected && !item.disabled}>{item.actions}</TreeActions>
          </>
        )}
      </div>
    );
  }
);
TreeLeaf.displayName = 'TreeLeaf';

const AccordionTrigger = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Trigger> & { level?: number }
>(({ className, children, level = 0, ...props }, ref) => {
  const triggerProps = stylex.props(styles.trigger);
  return (
    <AccordionPrimitive.Header>
      <AccordionPrimitive.Trigger
        ref={ref}
        className={clsx(triggerProps.className, className, OPEN_CHEVRON_CLASS)}
        style={{ paddingLeft: level * TREE_INDENT_PX + 8 }}
        {...props}
      >
        {/* Twisty arrow */}
        <ChevronRight {...stylex.props(styles.chevron)} />
        {children}
      </AccordionPrimitive.Trigger>
    </AccordionPrimitive.Header>
  );
});
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;

const AccordionContent = React.forwardRef<
  React.ElementRef<typeof AccordionPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof AccordionPrimitive.Content>
>(({ className, children, ...props }, ref) => {
  const contentProps = stylex.props(styles.accordionContent);
  return (
    <AccordionPrimitive.Content
      ref={ref}
      className={clsx(contentProps.className, className)}
      {...props}
    >
      <div>{children}</div>
    </AccordionPrimitive.Content>
  );
});
AccordionContent.displayName = AccordionPrimitive.Content.displayName;

const TreeIcon = ({
  item,
  isOpen,
  isSelected,
  default: defaultIcon,
}: {
  item: TreeDataItem;
  isOpen?: boolean;
  isSelected?: boolean;
  default?: React.ComponentType<{ className?: string }>;
}) => {
  let Icon: React.ComponentType<{ className?: string }> | undefined = defaultIcon;
  if (isSelected && item.selectedIcon) {
    Icon = item.selectedIcon;
  } else if (isOpen && item.openIcon) {
    Icon = item.openIcon;
  } else if (item.icon) {
    Icon = item.icon;
  }
  return Icon ? <Icon {...stylex.props(styles.icon)} /> : <></>;
};

const TreeItemLabel = ({ name, className }: { name: string; className?: string }) => {
  const textRef = React.useRef<HTMLSpanElement>(null);
  const [isTruncated, setIsTruncated] = React.useState(false);

  React.useEffect(() => {
    const el = textRef.current;
    if (el) {
      setIsTruncated(el.scrollWidth > el.clientWidth);
    }
  }, [name]);

  const labelProps = stylex.props(styles.label);
  const label = (
    <span ref={textRef} className={clsx(labelProps.className, className)}>
      {name}
    </span>
  );

  if (!isTruncated) {
    return label;
  }

  return (
    <Tooltip.Root>
      <Tooltip.Trigger render={label} />
      <Tooltip.Content side="top" align="start">
        {name}
      </Tooltip.Content>
    </Tooltip.Root>
  );
};

const TreeActions = ({
  children,
  isSelected,
}: {
  children: React.ReactNode;
  isSelected: boolean;
}) => {
  const actionsProps = stylex.props(
    styles.actions,
    isSelected ? styles.actionsVisible : styles.actionsHidden
  );
  return <div className={clsx(actionsProps.className, GROUP_HOVER_REVEAL_CLASS)}>{children}</div>;
};

export {
  TreeView,
  type TreeDataItem,
  type TreeRenderItemParams,
  AccordionTrigger,
  AccordionContent,
  TreeLeaf,
  TreeNode,
  TreeItem,
};
