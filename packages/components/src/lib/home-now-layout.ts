/**
 * How the "now" board spends its height, whatever the lists hold: a long list, four long
 * lists, or one long list beside three short ones, in a tall window or a short one. The
 * arithmetic only; the picture is `components/chat/home/now-board.tsx`.
 *
 * Four rules keep it calm under load, and one keeps it still:
 * - Fixed places. Every list always has its tile in the same place: needs you over just
 *   finished on the left, the usage over running over worth continuing on the right. A list with
 *   nothing is a one-line tile, not a gap, so no tile ever changes column or disappears from
 *   under the pointer while the lists change; tiles only grow and shrink in place.
 * - One statement when nothing happens. With every list empty, one card on the left says that
 *   all is quiet while usage keeps its place on the right; the busy lists return the moment
 *   anything is happening.
 * - A row budget. The board shows at most `HOME_NOW_ROW_BUDGET` rows in all. Every list with
 *   something gets one row; the rest goes by priority (needs you, running, just finished, worth
 *   continuing), each up to its own cap. When it is busy the lower lists give way first, never
 *   what needs the person. Whatever is not shown stays one press away ("Show all").
 * - The window's height. Given the rows the stage has room for (`maxRows`, per column), the
 *   budget shrinks until the taller column fits, down to one row per list. Below that the board
 *   does not fit (`fits: false`) and the dashboard folds it into its line.
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
 * The fixed column of each list. What waits on the person's reply (needs you, just finished)
 * reads first at the left; what is in motion and what can wait sit under the usage at the right.
 * The two longest lists, needs you and running, stand in different columns, so a busy board
 * spends both.
 */
const HOME_NOW_COLUMN: Readonly<Record<HomeNowListKey, 0 | 1>> = {
  attention: 0,
  finished: 0,
  running: 1,
  next: 1,
};

/**
 * Two halves when usage is present. `fits` is false when even one row per list is taller than
 * `maxRows`; the columns are then that smallest layout.
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

/**
 * A block's height in rows: its title, its rows, and a "Show all" line when some are hidden. A
 * list with nothing is its title.
 */
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
  hasUsage: boolean,
  nothingHappening: boolean
): HomeNowBlock[][] {
  // Nothing at all is happening: one statement about it, instead of four empty lists.
  if (nothingHappening) {
    const columns: HomeNowBlock[][] = [[{ kind: 'quiet' }]];
    if (hasUsage) columns.push([{ kind: 'usage' }]);
    return columns;
  }
  const columns: HomeNowBlock[][] = [[], hasUsage ? [{ kind: 'usage' }] : []];
  for (const key of HOME_NOW_LISTS) {
    columns[HOME_NOW_COLUMN[key]]!.push({ kind: 'list', key, shown: shown[key] });
  }
  return columns;
}

/**
 * Brings the shorter column up to the taller one with rows of its own lists: the lowest list
 * first, one row at a time, while the column stays within the taller one. Showing a list's last
 * hidden row also drops its "Show all" line, so that row costs nothing.
 */
function levelHomeNow(columns: HomeNowBlock[][], totals: HomeNowTotals): void {
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
  const nothingHappening = lists === 0;
  let columns: HomeNowBlock[][] = [];
  for (let budget = HOME_NOW_ROW_BUDGET; budget >= lists; budget -= 1) {
    columns = placeHomeNow(allocateHomeNowRows(totals, budget), hasUsage, nothingHappening);
    const tallest = Math.max(...columns.map((column) => columnHeight(column, totals)));
    if (tallest <= maxRows) {
      levelHomeNow(columns, totals);
      return { columns, fits: true };
    }
  }
  return { columns, fits: false };
}

/**
 * The tallest column any lists can make, in `homeNowBlockHeight` rows: the height the dashboard
 * keeps for its board, so that what the lists hold never moves the line above them. Levelling
 * only fills up to the taller column, and a list's rows never pass its cap before it, so lists
 * up to one past their caps (one more brings the "Show all" line) are every case there is.
 */
export const HOME_NOW_TALLEST_COLUMN: number = (() => {
  let tallest = 0;
  const range = (key: HomeNowListKey) =>
    Array.from({ length: HOME_NOW_ROW_CAP[key] + 2 }, (_, index) => index);
  for (const attention of range('attention'))
    for (const running of range('running'))
      for (const finished of range('finished'))
        for (const next of range('next'))
          for (const hasUsage of [false, true]) {
            const totals = { attention, running, finished, next };
            const { columns } = layoutHomeNow(totals, hasUsage);
            tallest = Math.max(tallest, ...columns.map((column) => columnHeight(column, totals)));
          }
  return tallest;
})();
