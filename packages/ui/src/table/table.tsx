import * as stylex from '@stylexjs/stylex';
import {
  createContext,
  forwardRef,
  useContext,
  useMemo,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { appendClassName } from '../internal/class-name';
import { ChevronDownGlyph, ChevronUpGlyph } from '../internal/glyphs';
import { tableSurface as surface } from './surface';

/** The control ladder a row is on: 28, 32 and 36. */
export type TableSize = 'small' | 'medium' | 'large';

/** Which way a sorted column is sorted, and `null` for a column that is not. */
export type TableSort = 'ascending' | 'descending';

/** Where a cell's content sits in its column. */
export type TableAlign = 'start' | 'center' | 'end';

export interface TableRootProps extends Omit<ComponentProps<'table'>, 'className'> {
  /** The height of every row in it, and the padding in every cell. Medium by default. */
  size?: TableSize;
  /**
   * Something happens when a row is pressed, so the rows answer the pointer. A
   * table of facts takes nothing: a row that lights up under the pointer and
   * does nothing when pressed is a promise the table cannot keep.
   */
  interactive?: boolean;
  /** Columns share the width equally instead of following their contents. */
  layout?: 'auto' | 'fixed';
  /** Carried by the scroller around the table rather than by the table. */
  containerClassName?: string;
  className?: string;
}

export interface TableSectionProps extends Omit<ComponentProps<'tbody'>, 'className'> {
  className?: string;
}

export interface TableRowProps extends Omit<ComponentProps<'tr'>, 'className'> {
  /**
   * This row holds the value, and stays marked while the pointer is elsewhere.
   * It is a fill and nothing else: `aria-selected` belongs to a row in a grid,
   * and a table that lets a person select rows puts a `Checkbox` in one — which
   * is the part that announces it, and the part they can press.
   */
  selected?: boolean;
  className?: string;
}

export interface TableCellProps extends Omit<ComponentProps<'td'>, 'className' | 'align'> {
  /** Where the content sits. The token step, not the deprecated HTML attribute. */
  align?: TableAlign;
  /** Figures read down the column: tabular digits, and aligned to the end unless said otherwise. */
  numeric?: boolean;
  className?: string;
}

export interface TableColumnHeaderProps extends Omit<ComponentProps<'th'>, 'className' | 'align'> {
  align?: TableAlign;
  numeric?: boolean;
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
 * padding both follow from the size, and whether a row answers the pointer is a
 * fact about the table rather than about one row, so both are stated once on
 * the root — where two of them cannot disagree.
 */
const TableContext = createContext<{ size: TableSize; interactive: boolean }>({
  size: 'medium',
  interactive: false,
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
  { size = 'medium', interactive = false, layout = 'auto', containerClassName, className, ...rest },
  ref
) {
  const scroller = stylex.props(surface.scroller);
  const sx = stylex.props(surface.root, layout === 'fixed' && surface.fixed);
  const value = useMemo(() => ({ size, interactive }), [size, interactive]);
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

/** The row of column names. */
export const TableHead = forwardRef<HTMLTableSectionElement, TableSectionProps>(function TableHead(
  { className, ...rest },
  ref
) {
  return (
    <TableSection.Provider value="head">
      <thead ref={ref} {...rest} className={className} />
    </TableSection.Provider>
  );
});

/** The records. */
export const TableBody = forwardRef<HTMLTableSectionElement, TableSectionProps>(function TableBody(
  { className, ...rest },
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
  { className, ...rest },
  ref
) {
  return (
    <TableSection.Provider value="foot">
      <tfoot ref={ref} {...rest} className={className} />
    </TableSection.Provider>
  );
});

/**
 * One record, and the line to the next one.
 *
 * The last row in the body draws no line, because there is no next row there —
 * the same reading a disclosure row makes of its own position. A head row keeps
 * its line: the row after it is the first record.
 */
export const TableRow = forwardRef<HTMLTableRowElement, TableRowProps>(function TableRow(
  { selected = false, className, ...rest },
  ref
) {
  const { interactive } = useContext(TableContext);
  const section = useContext(TableSection);
  const sx = stylex.props(
    surface.row,
    section === 'body' && surface.bodyRow,
    section === 'foot' && surface.footRow,
    section === 'body' && interactive && surface.interactiveRow,
    selected && surface.selectedRow
  );
  return (
    <tr
      ref={ref}
      data-selected={selected ? '' : undefined}
      {...rest}
      className={appendClassName(sx.className, className)}
      style={sx.style}
    />
  );
});

/** One value. */
export const TableCell = forwardRef<HTMLTableCellElement, TableCellProps>(function TableCell(
  { align, numeric = false, className, ...rest },
  ref
) {
  const { size } = useContext(TableContext);
  const sx = stylex.props(
    surface.cell,
    CELL_SIZES[size],
    ALIGNMENTS[align ?? (numeric ? 'end' : 'start')],
    numeric && surface.numeric
  );
  return (
    <td ref={ref} {...rest} className={appendClassName(sx.className, className)} style={sx.style} />
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
    { align, numeric = false, sort = null, onSortChange, className, children, ...rest },
    ref
  ) {
    const { size } = useContext(TableContext);
    const sx = stylex.props(
      surface.cell,
      CELL_SIZES[size],
      surface.headCell,
      ALIGNMENTS[align ?? (numeric ? 'end' : 'start')],
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
          <SortButton sort={sort} onSortChange={onSortChange}>
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
  onSortChange,
  children,
}: {
  sort: TableSort | null;
  onSortChange: (sort: TableSort) => void;
  children: ReactNode;
}) {
  const sx = stylex.props(surface.sortButton);
  const mark = stylex.props(surface.sortMark);
  return (
    <button
      type="button"
      className={sx.className}
      style={sx.style}
      onClick={() => onSortChange(sort === 'ascending' ? 'descending' : 'ascending')}
    >
      {children}
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

export const Table = {
  Root: TableRoot,
  Head: TableHead,
  Body: TableBody,
  Foot: TableFoot,
  Row: TableRow,
  ColumnHeader: TableColumnHeader,
  Cell: TableCell,
  Caption: TableCaption,
};
