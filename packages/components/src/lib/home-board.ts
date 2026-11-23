/**
 * Which board the new-chat page shows under its line: what the agents are doing now, the last
 * seven days, or neither (everything folded into the line). A device-local view preference,
 * like a collapsed panel: not workspace state, and not a cache, so a cache clear keeps it.
 */
export type HomeBoard = 'now' | 'week';

export const HOME_BOARDS: readonly HomeBoard[] = ['now', 'week'];
export const HOME_BOARD_KEY = 'lody:homeBoard';
/** The board "unfold" brings back when everything is folded (and the fallback for a value this
 *  build does not know). A first visit starts folded, so it is not the default open board. */
export const DEFAULT_HOME_BOARD: HomeBoard = 'now';

const FOLDED = 'none';

/** The stored choice: a board, `null` for everything folded, or the default when unknown. */
export function parseHomeBoard(raw: string | null): HomeBoard | null {
  // A first visit (no stored choice) stays folded; only an explicit stored board unfolds.
  if (raw === null) return null;
  if (raw === FOLDED) return null;
  return HOME_BOARDS.find((board) => board === raw) ?? DEFAULT_HOME_BOARD;
}

export function serializeHomeBoard(board: HomeBoard | null): string {
  return board ?? FOLDED;
}
