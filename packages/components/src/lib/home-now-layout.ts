/**
 * How the "now" board spends its height, whatever the lists hold: a long list, four long
 * lists, or one long list beside three short ones, in a tall window or a short one. The
 * arithmetic only; the picture is `components/chat/home/now-board.tsx`.
 *
 * Four rules keep it calm under load:
 * - A row budget. The board shows at most `HOME_NOW_ROW_BUDGET` rows in all. Every list with
 *   something gets one row; the rest goes by priority (needs you, running, just finished, worth
 *   continuing), each up to its own cap. When it is busy the lower lists give way first, never
 *   what needs the person. Whatever is not shown stays one press away ("Show all").
 * - The window's height. Given the rows the stage has room for (`maxRows`, per column), the
 *   budget shrinks until the taller column fits, down to one row per list. Below that the board
 *   does not fit (`fits: false`) and the dashboard folds it into its line.
 * - Two balanced columns, not rows of pairs. A tile is as tall as what it shows, and each goes,
 *   in priority order, to whichever column is shorter so far (the usage starts the right one),
 *   so a long list never stretches a short neighbour into an empty box.
 * - Level bottoms. The shorter column then shows more of its own lists, row by row, until it
 *   reaches the taller one or has nothing left to show, so the board ends on one line with
 *   real rows rather than an empty band.
 */

export type HomeNowListKey = 'attention' | 'running' | 'finished' | 'next';

/** Priority order: what needs the person first. */
export const HOME_NOW_LISTS: readonly HomeNowListKey[] = [
  'attention',
  'running',
  'finished',
  'next',
];

export const HOME_NOW_ROW_BUDGET = 12;
export const HOME_NOW_ROW_CAP: Readonly<Record<HomeNowListKey, number>> = {
  attention: 6,
  running: 4,
  finished: 3,
  next: 3,
};

export type HomeNowBlock =
  | { kind: 'list'; key: HomeNowListKey; shown: number }
  | { kind: 'usage' }
  | { kind: 'quiet' };

/**
 * One column spanning the board, or two halves. `fits` is false when even one row per list is
 * taller than `maxRows`; the columns are then that smallest layout.
 */
export type HomeNowLayout = { columns: HomeNowBlock[][]; fits: boolean };

export type HomeNowTotals = Readonly<Record<HomeNowListKey, number>>;

/** Rows each list shows: one for every list with something, then the budget by priority. */
export function allocateHomeNowRows(
  totals: HomeNowTotals,
  budget: number = HOME_NOW_ROW_BUDGET
): Record<HomeNowListKey, number> {
  const shown: Record<HomeNowListKey, number> = { attention: 0, running: 0, finished: 0, next: 0 };
  let left = budget;
  for (const key of HOME_NOW_LISTS) {
    if (totals[key] > 0 && left > 0) {
      shown[key] = 1;
      left -= 1;
    }
  }
  for (const key of HOME_NOW_LISTS) {
    const more = Math.min(HOME_NOW_ROW_CAP[key], totals[key]) - shown[key];
    const add = Math.max(0, Math.min(more, left));
    shown[key] += add;
    left -= add;
  }
  return shown;
}

/** A block's height in rows: its title, its rows, and a "Show all" line when some are hidden. */
export function homeNowBlockHeight(block: HomeNowBlock, totals: HomeNowTotals): number {
  if (block.kind === 'usage') return 4;
  if (block.kind === 'quiet') return 3;
  return 2 + block.shown + (totals[block.key] > block.shown ? 1 : 0);
}

function columnHeight(column: readonly HomeNowBlock[], totals: HomeNowTotals): number {
  return column.reduce((sum, block) => sum + homeNowBlockHeight(block, totals), 0);
}

function placeHomeNow(
  shown: Record<HomeNowListKey, number>,
  totals: HomeNowTotals,
  hasUsage: boolean
): HomeNowBlock[][] {
  const blocks: HomeNowBlock[] = HOME_NOW_LISTS.filter((key) => shown[key] > 0).map((key) => ({
    kind: 'list',
    key,
    shown: shown[key],
  }));
  if (blocks.length === 0) blocks.push({ kind: 'quiet' });
  // A lone tile takes the whole board rather than half of it beside nothing.
  if (!hasUsage && blocks.length === 1) return [blocks];

  const columns: HomeNowBlock[][] = [[], []];
  const heights = [0, 0];
  if (hasUsage) {
    columns[1]!.push({ kind: 'usage' });
    heights[1] = homeNowBlockHeight({ kind: 'usage' }, totals);
  }
  for (const block of blocks) {
    const column = heights[0]! <= heights[1]! ? 0 : 1;
    columns[column]!.push(block);
    heights[column] = (heights[column] ?? 0) + homeNowBlockHeight(block, totals);
  }
  return columns;
}

/**
 * Brings the shorter column up to the taller one with rows of its own lists: the lowest list
 * first, one row at a time, while the column stays within the taller one. Showing a list's last
 * hidden row also drops its "Show all" line, so that row costs nothing.
 */
function levelHomeNow(columns: HomeNowBlock[][], totals: HomeNowTotals): void {
  if (columns.length < 2) return;
  const target = Math.max(...columns.map((column) => columnHeight(column, totals)));
  for (const column of columns) {
    let grew = true;
    while (grew) {
      grew = false;
      for (let index = column.length - 1; index >= 0; index -= 1) {
        const block = column[index]!;
        if (block.kind !== 'list' || block.shown >= totals[block.key]) continue;
        const next: HomeNowBlock = { ...block, shown: block.shown + 1 };
        const height =
          columnHeight(column, totals) -
          homeNowBlockHeight(block, totals) +
          homeNowBlockHeight(next, totals);
        if (height > target) continue;
        column[index] = next;
        grew = true;
        break;
      }
    }
  }
}

/**
 * The board for these lists. With `maxRows` (the rows one column has room for, in
 * `homeNowBlockHeight` units) the budget gives way until the taller column fits; without it the
 * board is as tall as the budget makes it.
 */
export function layoutHomeNow(
  totals: HomeNowTotals,
  hasUsage: boolean,
  maxRows: number = Number.POSITIVE_INFINITY
): HomeNowLayout {
  const lists = HOME_NOW_LISTS.filter((key) => totals[key] > 0).length;
  let columns: HomeNowBlock[][] = [];
  for (let budget = HOME_NOW_ROW_BUDGET; budget >= lists; budget -= 1) {
    columns = placeHomeNow(allocateHomeNowRows(totals, budget), totals, hasUsage);
    const tallest = Math.max(...columns.map((column) => columnHeight(column, totals)));
    if (tallest <= maxRows) {
      levelHomeNow(columns, totals);
      return { columns, fits: true };
    }
  }
  return { columns, fits: false };
}
