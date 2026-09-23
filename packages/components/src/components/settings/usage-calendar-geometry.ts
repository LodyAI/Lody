/**
 * Heatmap grid geometry shared by the real usage calendar and its loading
 * skeleton. Kept in a leaf with no three.js imports so the skeleton stays out
 * of the lazy R3F module boundary.
 */
export const USAGE_CALENDAR_COLUMNS = 53;
export const USAGE_CALENDAR_ROWS = 7;
export const USAGE_CALENDAR_CELLS = USAGE_CALENDAR_COLUMNS * USAGE_CALENDAR_ROWS;

/** Floor on a day's rendered size in a compact panel. */
export const CELL_MIN_SIZE_PX = 8;
// One additional pixel keeps a wide 53-week calendar airy without making the
// calendar itself narrower; the tracks still consume the entire container.
export const CELL_GAP_PX = 4;

export const HEATMAP_COLUMN_TEMPLATE = `repeat(${USAGE_CALENDAR_COLUMNS}, minmax(0, 1fr))`;
// The compact panel keeps its own minimum track width. Once its actual container
// is wide enough, the grid itself owns all available width instead of introducing
// a desktop scrollbar from an unrelated fixed width.
export const HEATMAP_MIN_TRACK_WIDTH =
  USAGE_CALENDAR_COLUMNS * CELL_MIN_SIZE_PX + (USAGE_CALENDAR_COLUMNS - 1) * CELL_GAP_PX;
