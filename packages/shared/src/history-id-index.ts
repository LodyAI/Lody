import { isContainer, type LoroDoc, type LoroList, type LoroMap } from 'loro-crdt';

/**
 * Positions of every turn id in a document's `history` list, so a writer finds
 * a turn, or every stored copy of it, without reading each row. A whole-list
 * scan reads every row through wasm: about 130 ms per call at 50,000 turns, and
 * five times that on a replica loaded from a snapshot.
 *
 * The index is built by one scan on first use and kept exact by the document's
 * own events, which Loro delivers synchronously on commit and import: appends
 * at the tail extend it, and any other list edit or id edit discards it for the
 * next rebuild. It answers nothing while a transaction is pending (its edits
 * have no events yet); callers then scan, and they verify every position they
 * are given against the row itself.
 */
export type HistoryIdIndex = {
  /** Ascending positions of `id`, `[]` when absent, `undefined` when the caller must scan. */
  positionsOf(id: string): readonly number[] | undefined;
  /** Every id with its positions, or `undefined` when the caller must scan. */
  entries(): ReadonlyMap<string, readonly number[]> | undefined;
  /** Discard the index after a caller found a position that no longer holds its id. */
  invalidate(): void;
};

type State = { positions: Map<string, number[]>; length: number };

const HISTORY = 'history';
const indexes = new WeakMap<LoroDoc, HistoryIdIndex>();

/** The row's stored id, read exactly as the writer matches it. */
export const storedHistoryRowId = (row: unknown): string | undefined => {
  if (isContainer(row)) {
    if (row.kind() !== 'Map') return undefined;
    const id = (row as LoroMap).get('id');
    return typeof id === 'string' ? id : undefined;
  }
  if (row !== null && typeof row === 'object' && !Array.isArray(row)) {
    const id = (row as { id?: unknown }).id;
    return typeof id === 'string' ? id : undefined;
  }
  return undefined;
};

const add = (positions: Map<string, number[]>, id: string | undefined, position: number) => {
  if (id === undefined) return;
  const copies = positions.get(id);
  if (copies) copies.push(position);
  else positions.set(id, [position]);
};

/** The shared index of `doc`'s history list; one subscription per document. */
export function historyIdIndex(doc: LoroDoc): HistoryIdIndex {
  const existing = indexes.get(doc);
  if (existing) return existing;
  const list: LoroList = doc.getList(HISTORY);
  let state: State | undefined;
  doc.subscribe((batch) => {
    if (!state) return;
    let appendedFrom: number | undefined;
    for (const event of batch.events) {
      const path = event.path;
      if (path[0] !== HISTORY) continue;
      if (path.length === 1) {
        const diff = event.diff;
        if (diff.type !== 'list') {
          state = undefined;
          return;
        }
        // Only an append at the current tail keeps every earlier position.
        const [first, second, ...rest] = diff.diff;
        const tailInsert =
          rest.length === 0 &&
          ((first?.insert !== undefined && second === undefined && state.length === 0) ||
            (first?.retain === state.length && second?.insert !== undefined));
        if (!tailInsert || appendedFrom !== undefined) {
          state = undefined;
          return;
        }
        appendedFrom = state.length;
        continue;
      }
      // A turn's own id edit re-keys it; a just-appended turn is read below.
      if (
        path.length === 2 &&
        event.diff.type === 'map' &&
        'id' in event.diff.updated &&
        !(appendedFrom !== undefined && typeof path[1] === 'number' && path[1] >= appendedFrom)
      ) {
        state = undefined;
        return;
      }
    }
    if (appendedFrom === undefined) return;
    const length = list.length;
    for (let position = appendedFrom; position < length; position++)
      add(state.positions, storedHistoryRowId(list.get(position)), position);
    state.length = length;
  });
  const current = (): State | undefined => {
    if (doc.getPendingTxnLength() > 0) return undefined;
    if (state && state.length === list.length) return state;
    const positions = new Map<string, number[]>();
    const length = list.length;
    for (let position = 0; position < length; position++)
      add(positions, storedHistoryRowId(list.get(position)), position);
    state = { positions, length };
    return state;
  };
  const index: HistoryIdIndex = {
    positionsOf: (id) => {
      const known = current();
      return known ? (known.positions.get(id) ?? []) : undefined;
    },
    entries: () => current()?.positions,
    invalidate: () => {
      state = undefined;
    },
  };
  indexes.set(doc, index);
  return index;
}
