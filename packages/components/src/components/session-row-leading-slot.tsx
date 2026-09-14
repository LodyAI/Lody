import type { TFunction } from 'i18next';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { cn } from '@/lib/utils';

// Shared presentation only: anonymous readers must not import sidebar workspace controls.
export type SessionRowOpenedByTreeSlot =
  | {
      kind: 'opener';
      expanded: boolean;
      label: string;
      onToggle: () => void;
    }
  | {
      kind: 'child';
      isLastChild: boolean;
    };

const TREE_CHILD_SLOT_CLASS = 'w-[26px] justify-start';
const TREE_CONTROL_LEFT_CLASS = 'left-[7px]';
const TREE_LINE_CLASS = 'bg-sidebar-foreground/20';
/** Cover row padding/border from the 14px slot, plus 1px for list `gap-px`. */
const TREE_TRUNK_FROM_PREV_CLASS = '-top-2';
const TREE_TRUNK_INTO_NEXT_CLASS = '-bottom-[9px]';

/**
 * Maps one {@link OpenedBySessionTreeNode} to the leading slot's tree state.
 * Every session list renders the same three cases (opener with a disclosure,
 * nested child with a connector, plain flat row), so the mapping — including
 * the disclosure's i18n label — lives here rather than in each list.
 *
 * `onToggle` absent means the caller cannot fold, so an opener degrades to a
 * plain row rather than showing a dead control.
 */
export function buildSessionRowOpenedByTreeSlot(
  node: { depth: 0 | 1; childCount: number; expanded: boolean; isLastChild: boolean },
  t: TFunction,
  onToggle?: () => void
): SessionRowOpenedByTreeSlot | undefined {
  if (node.childCount > 0 && onToggle) {
    return {
      kind: 'opener',
      expanded: node.expanded,
      label: node.expanded
        ? t('sessions.openedBy.collapse', 'Hide opened sessions')
        : t('sessions.openedBy.expand', 'Show {{count}} opened sessions', {
            count: node.childCount,
          }),
      onToggle,
    };
  }
  return node.depth === 1 ? { kind: 'child', isLastChild: node.isLastChild } : undefined;
}

export function SessionRowLeadingSlot({
  showMenuButton,
  menuLabel,
  openedByTree,
  /** Fade the rest state while hovering (e.g. 'group-hover/row:opacity-0' for named groups). */
  fadeClassName = 'group-hover:opacity-0 group-data-[menu-open]:opacity-0',
  /** Disable an opener disclosure while its ⋯ replacement is active. */
  restPointerClassName = 'group-hover:pointer-events-none group-data-[menu-open]:pointer-events-none',
  /** Reveal the ⋯ button while hovering. */
  revealClassName = 'group-hover:opacity-100 group-hover:pointer-events-auto group-data-[menu-open]:opacity-100 group-data-[menu-open]:pointer-events-auto',
}: {
  showMenuButton?: boolean;
  menuLabel: string;
  openedByTree?: SessionRowOpenedByTreeSlot;
  fadeClassName?: string;
  restPointerClassName?: string;
  revealClassName?: string;
}) {
  const childTree = openedByTree?.kind === 'child' ? openedByTree : null;
  const openerTree = openedByTree?.kind === 'opener' ? openedByTree : null;
  const restClassName = showMenuButton
    ? cn('transition-opacity duration-100', fadeClassName)
    : undefined;
  const controlLeftClassName = childTree ? TREE_CONTROL_LEFT_CLASS : 'left-1/2';

  return (
    <div
      data-session-row-leading-slot=""
      className={cn(
        'relative flex h-3.5 shrink-0 items-center',
        childTree ? TREE_CHILD_SLOT_CLASS : 'w-3.5 justify-center'
      )}
    >
      {openerTree ? (
        <button
          type="button"
          data-session-opened-by-toggle=""
          aria-label={openerTree.label}
          aria-expanded={openerTree.expanded}
          title={openerTree.label}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            openerTree.onToggle();
          }}
          className={cn(
            'relative z-20 flex h-3.5 w-3.5 items-center justify-center rounded-sm',
            'text-sidebar-foreground-muted transition-[opacity,color] duration-100',
            'hover:text-sidebar-foreground focus-visible:outline-hidden',
            showMenuButton && cn(restClassName, restPointerClassName)
          )}
        >
          <ChevronDown
            className={cn(
              'h-3.5 w-3.5 transition-transform duration-150 ease-out',
              openerTree.expanded ? 'rotate-0' : '-rotate-90'
            )}
            aria-hidden="true"
          />
        </button>
      ) : childTree ? (
        <div className={cn('absolute inset-0', restClassName)}>
          <span
            aria-hidden="true"
            data-session-tree-connector="trunk"
            className={cn(
              'absolute w-px',
              TREE_LINE_CLASS,
              TREE_CONTROL_LEFT_CLASS,
              TREE_TRUNK_FROM_PREV_CLASS,
              childTree.isLastChild ? 'bottom-1/2' : TREE_TRUNK_INTO_NEXT_CLASS
            )}
          />
          <span
            aria-hidden="true"
            data-session-tree-connector="elbow"
            className={cn(
              'absolute top-1/2 h-px w-[13px]',
              TREE_LINE_CLASS,
              TREE_CONTROL_LEFT_CLASS
            )}
          />
        </div>
      ) : null}
      {showMenuButton ? (
        <button
          type="button"
          aria-label={menuLabel}
          onClick={(event) => {
            // Open the row's existing right-click menu from a left click on ⋯.
            event.preventDefault();
            event.stopPropagation();
            const rect = event.currentTarget.getBoundingClientRect();
            event.currentTarget.dispatchEvent(
              new MouseEvent('contextmenu', {
                bubbles: true,
                cancelable: true,
                clientX: Math.round(rect.left),
                clientY: Math.round(rect.bottom),
              })
            );
          }}
          className={cn(
            // Overlay a 20px hit target centered on the 14px leading slot so the ⋯
            // gets a visible rounded hover chip (it reads as clickable) without
            // the tiny slot footprint clipping the background.
            'absolute top-1/2 z-20 flex h-5 w-5 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-md opacity-0 pointer-events-none',
            controlLeftClassName,
            'text-sidebar-foreground-muted transition-[opacity,color,background-color] duration-100',
            'hover:bg-sidebar-foreground/15 hover:text-sidebar-foreground',
            // The trigger itself stays pressed-looking while its menu is open,
            // not just the row around it.
            'group-data-[menu-open]:bg-sidebar-foreground/15 group-data-[menu-open]:text-sidebar-foreground',
            revealClassName
          )}
        >
          <MoreHorizontal className="relative -top-px h-3.5 w-3.5" />
        </button>
      ) : null}
    </div>
  );
}
