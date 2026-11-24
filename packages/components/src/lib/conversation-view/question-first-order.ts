import { isUnloadedTurnId } from './types';

type OrderedTurn = { readonly id: string; readonly role: string; readonly userTurnId?: string };

type OrderedTurnSource<T extends OrderedTurn> = {
  readonly turnCount: number;
  index(i: number): T | undefined;
  indexOf(turnId: string): number;
};

const ASSISTANT_TURN_PREFIX = 'assistant:';

/** The user turn an assistant row answers, from index facts only (no body read). */
export const answeredUserTurnId = (row: OrderedTurn): string | undefined =>
  row.role !== 'assistant'
    ? undefined
    : (row.userTurnId ??
      (row.id.startsWith(ASSISTANT_TURN_PREFIX)
        ? row.id.slice(ASSISTANT_TURN_PREFIX.length)
        : undefined));

/**
 * Visits turns in display order: a user turn stored AFTER a reply to it is
 * visited just ahead of that reply and skipped at its stored position. A
 * concurrent Loro insert (an RPC fast-path reply written before the user entry
 * synced, #1753) can leave `[assistant:U, …, U]` permanently; every reader must
 * still see the question before its answer. Unloaded sentinels are skipped, and
 * a reply for which `canHoist` is false (one that renders nothing) moves nothing.
 */
export function visitQuestionFirst<T extends OrderedTurn>(
  source: OrderedTurnSource<T>,
  visit: (turnIndex: number, row: T) => void,
  canHoist: (turnIndex: number, row: T) => boolean = () => true
): void {
  let hoisted: Set<number> | undefined;
  for (let turnIndex = 0; turnIndex < source.turnCount; turnIndex += 1) {
    if (hoisted?.has(turnIndex)) continue;
    const row = source.index(turnIndex);
    if (!row || isUnloadedTurnId(row.id)) continue;
    const userTurnId = answeredUserTurnId(row);
    const userIndex = userTurnId ? source.indexOf(userTurnId) : -1;
    const userRow =
      userIndex > turnIndex && !hoisted?.has(userIndex) ? source.index(userIndex) : undefined;
    if (userRow?.role === 'user' && !isUnloadedTurnId(userRow.id) && canHoist(turnIndex, row)) {
      (hoisted ??= new Set()).add(userIndex);
      visit(userIndex, userRow);
    }
    visit(turnIndex, row);
  }
}

/**
 * A full history in display order, as in the chat stream: an empty reply moves
 * nothing, and a repeated id appears once, at its first position, with the
 * newest body, which is what `readTurn` resolves and the reader view renders.
 */
export function inQuestionFirstOrder<
  T extends OrderedTurn & {
    readonly items?: readonly unknown[];
    readonly plan?: readonly unknown[];
  },
>(history: readonly T[]): T[] {
  const positions = new Map<string, number>();
  const unique: T[] = [];
  for (const entry of history) {
    const position = positions.get(entry.id);
    if (position === undefined) {
      positions.set(entry.id, unique.length);
      unique.push(entry);
    } else unique[position] = entry;
  }
  const ordered: T[] = [];
  visitQuestionFirst(
    {
      turnCount: unique.length,
      index: (index) => unique[index],
      indexOf: (turnId) => positions.get(turnId) ?? -1,
    },
    (_, entry) => ordered.push(entry),
    (_, entry) => (entry.items?.length ?? 0) > 0 || (entry.plan?.length ?? 0) > 0
  );
  return ordered;
}
