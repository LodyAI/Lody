import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ComponentProps,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { appendClassName } from '../internal/class-name';
import { ChevronDownGlyph, ChevronUpGlyph } from '../internal/glyphs';
import { scrollerHeight, tableSurface as surface } from './surface';

/** The control ladder a row is on: 28, 32 and 36. */
export type TableSize = 'small' | 'medium' | 'large';

/** Which way a sorted column is sorted. */
export type TableSort = 'ascending' | 'descending';

/** Where a cell's content sits in its column. */
export type TableAlign = 'start' | 'center' | 'end';

export interface TableRootProps extends Omit<ComponentProps<'table'>, 'className'> {
  /** The height of every row in it, and the padding in every cell. Medium by default. */
  size?: TableSize;
  /** Columns share the width they are given instead of following their contents. */
  layout?: 'auto' | 'fixed';
  /**
   * How tall the table may be. It scrolls in a box that tall and **its head
   * stays**: the two are one decision, because a head that scrolls out of its
   * own box is not a thing a surface would ask for.
   */
  maxHeight?: string | number;
  /** Carried by the scroller around the table rather than by the table. */
  containerClassName?: string;
  className?: string;
}

export interface TableSectionProps extends Omit<ComponentProps<'tbody'>, 'className'> {
  /** Where the rows stack, the head is no longer over them, so it goes. */
  stacked?: boolean;
  className?: string;
}

export interface TableRowProps extends Omit<ComponentProps<'tr'>, 'className'> {
  /**
   * This row is one a bulk action would act on. It is a fill, and the tick in
   * the row is what says so to everyone else: `aria-selected` belongs to a row
   * in a grid, so a table that lets a person pick rows puts a `Checkbox` in one
   * — which is both what they press and what announces it.
   */
  selected?: boolean;
  /**
   * Pressing this row does something, so it answers the pointer, takes the
   * keyboard, and rings where the keyboard is. Enter and Space press it, so a
   * caller wires `onClick` and gets all three.
   */
  pressable?: boolean;
  /**
   * This is the last row, and draws no line to a next one there is none of. A
   * row assembled by a caller reads that from `:last-child`; a table that
   * renders its own rows says it, because a pseudo-class cannot compose with
   * the focus ring a pressable row also carries.
   */
  last?: boolean;
  /** Where this row is too narrow for columns, it becomes a stack of lines. */
  stacked?: boolean;
  className?: string;
}

export interface TableCellProps extends Omit<ComponentProps<'td'>, 'className' | 'align'> {
  /** Where the content sits. The token step, not the deprecated HTML attribute. */
  align?: TableAlign;
  /** Figures read down the column: tabular digits, and aligned to the end unless said otherwise. */
  numeric?: boolean;
  /** This column holds sentences, so they wrap instead of ending in an ellipsis. */
  wrap?: boolean;
  /**
   * The column's name, for where the row is stacked and the head is no longer
   * over it. It is the head's own words rather than a second copy of them.
   */
  label?: ReactNode;
  className?: string;
}

export interface TableColumnHeaderProps extends Omit<ComponentProps<'th'>, 'className' | 'align'> {
  align?: TableAlign;
  numeric?: boolean;
  wrap?: boolean;
  /**
   * Which way this column is sorted, or `null` when the table is sorted by
   * another one. Passing `onSortChange` is what makes the name a control; the
   * direction on its own only says which column the table is ordered by.
   */
  sort?: TableSort | null;
  /** Take this column. The part works out which way round, and draws the arrow. */
  onSortChange?: (sort: TableSort) => void;
  className?: string;
}

export interface TableCaptionProps extends Omit<ComponentProps<'caption'>, 'className'> {
  className?: string;
}

/**
 * What the table was told, for the parts inside it. A row's height and a cell's
 * padding both follow from the size, and whether the head stays is a fact about
 * the table rather than about the head, so both are stated once on the root —
 * where two of them cannot disagree.
 */
const TableContext = createContext<{ size: TableSize; sticky: boolean }>({
  size: 'medium',
  sticky: false,
});

/** Which section a row is in, which is what decides where its line goes. */
const TableSection = createContext<'head' | 'body' | 'foot'>('body');

const CELL_SIZES = {
  small: surface.cellSmall,
  medium: surface.cellMedium,
  large: surface.cellLarge,
} as const;

const ALIGNMENTS = {
  start: surface.alignStart,
  center: surface.alignCenter,
  end: surface.alignEnd,
} as const;

/**
 * Rows of records, and no surface of their own.
 *
 * A table is the one part of this package that draws no background, no shadow
 * and no radius: it is rows on whatever the surface around it already was, so a
 * card holding one keeps owning its own edges. What it draws is the single edge
 * the rules give a list — `separator`, between one row and the next.
 *
 * The scroller around it is the primitive's, because a table is as wide as its
 * columns need and the column holding it rarely is; without one a wide table
 * pushes the whole page sideways.
 */
export const TableRoot = forwardRef<HTMLTableElement, TableRootProps>(function TableRoot(
  { size = 'medium', layout = 'auto', maxHeight, containerClassName, className, ...rest },
  ref
) {
  const scroller = stylex.props(
    surface.scroller,
    maxHeight != null && surface.scrollerBounded,
    maxHeight != null && scrollerHeight.maxHeight(maxHeight)
  );
  const sx = stylex.props(surface.root, layout === 'fixed' && surface.fixed);
  const value = useMemo(() => ({ size, sticky: maxHeight != null }), [size, maxHeight]);
  return (
    <div className={appendClassName(scroller.className, containerClassName)} style={scroller.style}>
      <TableContext.Provider value={value}>
        <table
          ref={ref}
          data-size={size}
          {...rest}
          className={appendClassName(sx.className, className)}
          style={sx.style}
        />
      </TableContext.Provider>
    </div>
  );
});

/**
 * The row of column names — and, where the table owns a scroll box, the band
 * that stays over the rows moving under it. A head that stays is no longer a
 * row, so it takes the rung the ladder gives a band over the page; one with no
 * fill is not a quieter design, it is rows painted through the column names.
 */
export const TableHead = forwardRef<HTMLTableSectionElement, TableSectionProps>(function TableHead(
  { stacked = false, className, ...rest },
  ref
) {
  const { sticky } = useContext(TableContext);
  const sx = stylex.props(sticky && surface.headSticky, stacked && surface.stackedHead);
  return (
    <TableSection.Provider value="head">
      <thead
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    </TableSection.Provider>
  );
});

/** The records. */
export const TableBody = forwardRef<HTMLTableSectionElement, TableSectionProps>(function TableBody(
  { stacked: _stacked, className, ...rest },
  ref
) {
  return (
    <TableSection.Provider value="body">
      <tbody ref={ref} {...rest} className={className} />
    </TableSection.Provider>
  );
});

/** What the records add up to, under a line of its own. */
export const TableFoot = forwardRef<HTMLTableSectionElement, TableSectionProps>(function TableFoot(
  { stacked: _stacked, className, ...rest },
  ref
) {
  return (
    <TableSection.Provider value="foot">
      <tfoot ref={ref} {...rest} className={className} />
    </TableSection.Provider>
  );
});

/** Enter and Space press a row, the way they press the button it stands for. */
function pressOnKey(event: KeyboardEvent<HTMLTableRowElement>) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  if (event.target !== event.currentTarget) return;
  event.preventDefault();
  event.currentTarget.click();
}

/**
 * One record, and the line to the next one.
 *
 * The last row in the body draws no line, because there is no next row there —
 * the same reading a disclosure row makes of its own position. A head row keeps
 * its line: the row after it is the first record.
 */
export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(function TableRow(
  { selected = false, pressable = false, last, stacked = false, className, onKeyDown, ...rest },
  ref
) {
  const { sticky } = useContext(TableContext);
  const section = useContext(TableSection);
  const body = section === 'body';
  const sx = stylex.props(
    surface.row,
    section === 'head' && surface.headRow,
    section === 'head' && sticky && surface.headStickyRow,
    section === 'foot' && surface.footRow,
    body && (last === undefined ? surface.bodyRow : last ? undefined : surface.bodyRowLined),
    body && pressable && surface.pressableRow,
    body && pressable && last === true && surface.pressableRowLast,
    body && !pressable && last === true && surface.bodyRowLast,
    body && pressable && surface.hoverRow,
    selected && surface.selectedRow,
    stacked && section !== 'head' && surface.stackedRow
  );
  return (
    <tr
      ref={ref}
      data-selected={selected ? '' : undefined}
      tabIndex={pressable ? 0 : undefined}
      onKeyDown={pressable ? (onKeyDown ?? pressOnKey) : onKeyDown}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/** One value. */
export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(function TableCell(
  { align, numeric = false, wrap = false, label, className, children, ...rest },
  ref
) {
  const { size } = useContext(TableContext);
  const sx = stylex.props(
    surface.cell,
    CELL_SIZES[size],
    wrap && surface.cellWrap,
    ALIGNMENTS[align ?? (numeric ? 'end' : 'start')],
    numeric && surface.numeric,
    label !== undefined && surface.stackedCell
  );
  const name = stylex.props(surface.cellLabel);
  return (
    <td ref={ref} {...rest} className={appendClassName(sx.className, className)} style={sx.style}>
      {label !== undefined ? (
        <span className={name.className} style={name.style}>
          {label}
        </span>
      ) : null}
      {children}
    </td>
  );
});

/**
 * A column's name, and — when the table can be ordered by it — the control that
 * takes it.
 *
 * The arrow is drawn by the part rather than passed to it, the way a submenu's
 * chevron is drawn by its row: a sortable header assembled without one is a
 * column whose order a person cannot see. `aria-sort` is the same fact on the
 * cell, so what a screen reader is told and what the arrow shows cannot
 * disagree, and the direction is the caller's state rather than the part's —
 * only the caller knows what the rows are actually sorted by.
 */
export const TableColumnHeader = forwardRef<HTMLTableCellElement, TableColumnHeaderProps>(
  function TableColumnHeader(
    {
      align,
      numeric = false,
      wrap = false,
      sort = null,
      onSortChange,
      className,
      children,
      ...rest
    },
    ref
  ) {
    const { size } = useContext(TableContext);
    const resolved = align ?? (numeric ? 'end' : 'start');
    const sx = stylex.props(
      surface.cell,
      CELL_SIZES[size],
      surface.headCell,
      wrap && surface.cellWrap,
      ALIGNMENTS[resolved],
      numeric && surface.numeric,
      sort != null && surface.headCellSorted
    );
    return (
      <th
        ref={ref}
        scope="col"
        aria-sort={onSortChange ? (sort ?? 'none') : undefined}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      >
        {onSortChange ? (
          <SortButton sort={sort} align={resolved} onSortChange={onSortChange}>
            {children}
          </SortButton>
        ) : (
          children
        )}
      </th>
    );
  }
);

/**
 * The name as a control. Taking a column that is already taken turns it over,
 * and taking a new one starts ascending: a person asking to sort by a name
 * means A first, and the part not the caller is where that is decided so two
 * tables cannot answer the same press differently.
 */
function SortButton({
  sort,
  align,
  onSortChange,
  children,
}: {
  sort: TableSort | null;
  align: TableAlign;
  onSortChange: (sort: TableSort) => void;
  children: ReactNode;
}) {
  const sx = stylex.props(surface.sortButton, align === 'end' && surface.sortButtonEnd);
  const label = stylex.props(surface.sortLabel);
  const mark = stylex.props(surface.sortMark);
  return (
    <button
      type="button"
      className={sx.className}
      style={sx.style}
      onClick={() => onSortChange(sort === 'ascending' ? 'descending' : 'ascending')}
    >
      <span className={label.className} style={label.style}>
        {children}
      </span>
      {sort ? (
        <span className={mark.className} style={mark.style}>
          {sort === 'ascending' ? <ChevronUpGlyph /> : <ChevronDownGlyph />}
        </span>
      ) : null}
    </button>
  );
}

/** What the table is, under it. */
export const TableCaption = forwardRef<HTMLTableCaptionElement, TableCaptionProps>(
  function TableCaption({ className, ...rest }, ref) {
    const sx = stylex.props(surface.caption);
    return (
      <caption
        ref={ref}
        {...rest}
        className={appendClassName(sx.className, className)}
        style={sx.style}
      />
    );
  }
);
