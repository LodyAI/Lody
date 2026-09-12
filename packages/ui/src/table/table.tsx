import * as stylex from '@stylexjs/stylex';
import { useMemo, type ComponentProps, type ReactNode } from 'react';
import { Checkbox } from '../field/checkbox';
import { columnWidth, tableSurface as surface } from './surface';
import {
  TableBody,
  TableCaption,
  TableCell,
  TableColumnHeader,
  TableFoot,
  TableHead,
  TableRoot,
  TableRow,
  type TableAlign,
  type TableCaptionProps,
  type TableCellProps,
  type TableColumnHeaderProps,
  type TableRootProps,
  type TableRowProps,
  type TableSectionProps,
  type TableSize,
  type TableSort,
} from './parts';

export type {
  TableAlign,
  TableCaptionProps,
  TableCellProps,
  TableColumnHeaderProps,
  TableRootProps,
  TableRowProps,
  TableSectionProps,
  TableSize,
  TableSort,
};

/**
 * One column, stated once.
 *
 * This is the whole of the design. A table's hard parts — how wide a column is,
 * which way its values align, whether they are figures, whether the table can
 * be ordered by it, what a totals row holds under it — are facts about a
 * *column*, and a column that exists twice (a name in the head, a cell in every
 * row) is a fact the caller has to keep in two places. Both surfaces in this
 * repository that draw a table today write their column template as a literal
 * `grid-cols-[…]` string in the header and again in the row, by hand; one of
 * them writes every cell a second time for a narrow window. Stated here, the
 * two cannot drift — and the table can answer for the rest: the width, the
 * ordering, the selection, the row that says there is nothing.
 */
export interface TableColumn<Row> {
  /** Identity. It is what a sort reports, not something a person reads. */
  key: string;
  /** The column's name, in the head. */
  header: ReactNode;
  /** What this column holds for one record. */
  cell: (row: Row) => ReactNode;
  align?: TableAlign;
  /** Figures: tabular digits, and the end of the column unless told otherwise. */
  numeric?: boolean;
  /** How much room it takes. A number is pixels; a string is a CSS length. */
  width?: string | number;
  /** The table can be ordered by this column. */
  sortable?: boolean;
  /** Its values are sentences, so they wrap rather than ending in an ellipsis. */
  wrap?: boolean;
  /** What a totals row holds under it. A table with none draws no totals row. */
  footer?: ReactNode;
}

/** Which column the records are ordered by, and which way. One at a time. */
export interface TableSorting {
  column: string;
  direction: TableSort;
}

/** The two things a table says that are words rather than values. */
export interface TableLabels {
  /** The name of the box that takes every row at once. */
  selectAll: string;
  /** The name of a row's own box, where the table cannot name the record. */
  select: string;
}

const DEFAULT_LABELS: TableLabels = { selectAll: 'Select all', select: 'Select row' };

export interface TableProps<Row> extends Omit<
  ComponentProps<'table'>,
  'className' | 'children' | 'onSelect'
> {
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  /** What makes a record itself, for React and for the selection. */
  rowKey: (row: Row) => string;
  size?: TableSize;
  layout?: 'auto' | 'fixed';
  /** How tall the table may be. It scrolls in a box that tall, and its head stays. */
  maxHeight?: string | number;
  /** What the table is, under it. */
  caption?: ReactNode;
  /**
   * Which column the records are ordered by. One column at a time, because two
   * columns wearing the arrow is a state a table cannot be in — and it is
   * stated on the table rather than on each column so a caller cannot put it in
   * one and forget to take it out of the other.
   */
  sort?: TableSorting | null;
  onSortChange?: (sort: TableSorting) => void;
  /**
   * The records a bulk action would act on. Passing it draws the column of
   * boxes and the one in the head, whose mixed state the table derives.
   */
  selected?: readonly string[];
  onSelectedChange?: (selected: string[]) => void;
  /** What to call a record, for the box that picks it. */
  rowLabel?: (row: Row) => string;
  /** Pressing a record does something. The row takes the keyboard with it. */
  onRowPress?: (row: Row) => void;
  /**
   * Where the table's own box is too narrow for its columns, each record
   * becomes a stack of label-and-value lines instead. It is on by default and
   * asks about the table's width rather than the window's, so a table in a
   * narrow side panel stacks on a wide screen — which is the case every surface
   * in this repository hand-rolls today. A table whose columns must stay a grid
   * says `stack={false}` and keeps the scrollbar.
   */
  stack?: boolean;
  /** What the table says while it is holding nothing. */
  empty?: ReactNode;
  labels?: Partial<TableLabels>;
  className?: string;
  containerClassName?: string;
}

/**
 * A list of records, and everything that follows from stating its columns.
 *
 * The parts hanging off it are the elements a table is made of, and they are
 * there for a table that is not a list of records — a two-column list of facts,
 * or markup produced from a Markdown document. Reach for this one otherwise:
 * what it owns is what a caller assembling those parts has to get right every
 * time, and what neither a head nor a row can work out alone.
 *
 * It does **not reorder the rows**. Which records are shown and in what order
 * is the surface's — a server sorts, a comparator breaks ties, a page is one
 * slice of many — so the table owns the control, the arrow, `aria-sort` and the
 * shape of the state, and the caller owns the data. A table that quietly sorted
 * what it was handed would be wrong exactly once: on the surface that had
 * already sorted it.
 */
function TableView<Row>({
  columns,
  rows,
  rowKey,
  size = 'medium',
  layout = 'auto',
  maxHeight,
  caption,
  sort = null,
  onSortChange,
  selected,
  onSelectedChange,
  rowLabel,
  onRowPress,
  stack = true,
  empty,
  labels,
  className,
  containerClassName,
  ...rest
}: TableProps<Row>) {
  const words = { ...DEFAULT_LABELS, ...labels };
  const selectable = selected != null && onSelectedChange != null;
  const picked = useMemo(() => new Set(selected ?? []), [selected]);
  const keys = rows.map((row) => rowKey(row));
  const held = keys.filter((key) => picked.has(key)).length;
  const all = held > 0 && held === keys.length;
  const some = held > 0 && !all;
  const totals = columns.some((column) => column.footer !== undefined);
  const span = columns.length + (selectable ? 1 : 0);

  const toggleAll = () => {
    if (!onSelectedChange) return;
    // The box in the head answers for the rows on screen. A table showing one
    // page of a long selection therefore never drops the pages a person
    // already took, and never reports a key it is not showing.
    const shown = new Set(keys);
    const elsewhere = (selected ?? []).filter((key) => !shown.has(key));
    onSelectedChange(all ? elsewhere : [...elsewhere, ...keys]);
  };
  const toggleRow = (key: string) => {
    if (!onSelectedChange) return;
    const without = (selected ?? []).filter((current) => current !== key);
    onSelectedChange(picked.has(key) ? without : [...without, key]);
  };

  return (
    <TableRoot
      size={size}
      layout={layout}
      maxHeight={maxHeight}
      className={className}
      containerClassName={containerClassName}
      {...rest}
    >
      {caption ? <TableCaption>{caption}</TableCaption> : null}
      {/*
        A column's width is stated on a `<col>`, so the name and every cell
        under it take it from one place. It is also the only way to give a width
        to cells the caller never writes.
      */}
      <colgroup>
        {selectable ? <col {...stylex.props(columnWidth.width(undefined))} /> : null}
        {columns.map((column) => (
          <col key={column.key} {...stylex.props(columnWidth.width(column.width))} />
        ))}
      </colgroup>
      <TableHead stacked={stack}>
        <TableRow>
          {selectable ? (
            <SelectCell>
              <Checkbox
                aria-label={words.selectAll}
                checked={all}
                indeterminate={some}
                onCheckedChange={toggleAll}
              />
            </SelectCell>
          ) : null}
          {columns.map((column) => (
            <TableColumnHeader
              key={column.key}
              align={column.align}
              numeric={column.numeric}
              wrap={column.wrap}
              sort={sort?.column === column.key ? sort.direction : null}
              onSortChange={
                column.sortable && onSortChange
                  ? (direction) => onSortChange({ column: column.key, direction })
                  : undefined
              }
            >
              {column.header}
            </TableColumnHeader>
          ))}
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.length === 0 && empty !== undefined ? (
          <TableRow last>
            <EmptyCell span={span}>{empty}</EmptyCell>
          </TableRow>
        ) : (
          rows.map((row, index) => {
            const key = keys[index];
            return (
              <TableRow
                key={key}
                last={index === rows.length - 1}
                stacked={stack}
                selected={picked.has(key)}
                pressable={onRowPress != null}
                onClick={onRowPress ? () => onRowPress(row) : undefined}
              >
                {selectable ? (
                  <SelectCell stacked={stack}>
                    <Checkbox
                      aria-label={rowLabel ? rowLabel(row) : words.select}
                      checked={picked.has(key)}
                      onCheckedChange={() => toggleRow(key)}
                      // Opening a record and picking it are two actions in one
                      // row, so the box keeps the press that lands on it.
                      onClick={(event) => event.stopPropagation()}
                    />
                  </SelectCell>
                ) : null}
                {columns.map((column) => (
                  <TableCell
                    key={column.key}
                    align={column.align}
                    numeric={column.numeric}
                    wrap={column.wrap}
                    label={stack ? column.header : undefined}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            );
          })
        )}
      </TableBody>
      {totals ? (
        <TableFoot>
          <TableRow stacked={stack}>
            {selectable ? <SelectCell stacked={stack} /> : null}
            {columns.map((column) => (
              <TableCell
                key={column.key}
                align={column.align}
                numeric={column.numeric}
                // Only a column that holds a total is named in a stacked record:
                // the others would be a column's name with nothing after it.
                label={stack && column.footer !== undefined ? column.header : undefined}
              >
                {column.footer}
              </TableCell>
            ))}
          </TableRow>
        </TableFoot>
      ) : null}
    </TableRoot>
  );
}

/** The column that holds nothing but the box that picks a row. */
function SelectCell({ children, stacked = false }: { children?: ReactNode; stacked?: boolean }) {
  // A stacked record is a run of block lines, and a cell left as a table cell
  // among them is wrapped in an anonymous table by the browser and lands on a
  // line of its own. The box takes the same line the values take.
  const sx = stylex.props(surface.cell, surface.selectCell, stacked && surface.stackedCell);
  const box = stylex.props(surface.selectBox);
  return (
    <td className={sx.className} style={sx.style}>
      {children ? (
        <span className={box.className} style={box.style}>
          {children}
        </span>
      ) : null}
    </td>
  );
}

/**
 * Nothing to show. It is a row of the table rather than a panel over it, so the
 * column names stay where they are and a person can still read what was going
 * to be here. Only the table knows how many columns to cross, which is one more
 * thing a caller assembling the parts would have to work out.
 */
function EmptyCell({ span, children }: { span: number; children: ReactNode }) {
  const sx = stylex.props(surface.empty);
  return (
    <td colSpan={span} className={sx.className} style={sx.style}>
      {children}
    </td>
  );
}

export const Table = Object.assign(TableView, {
  Root: TableRoot,
  Head: TableHead,
  Body: TableBody,
  Foot: TableFoot,
  Row: TableRow,
  ColumnHeader: TableColumnHeader,
  Cell: TableCell,
  Caption: TableCaption,
});
