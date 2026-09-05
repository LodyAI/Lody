import { isContainer, type Container, type Diff } from 'loro-crdt';

/**
 * Copy-on-write application of one Loro event to a hydrated turn object.
 *
 * `relPath` is the event path with the leading `['history', turnIndex]`
 * removed, so `[]` addresses the turn map itself, `['items']` the item list,
 * `['items', 3, 'text']` a streamed text. Every object/array on the path gets a
 * fresh identity and everything else keeps its identity — the same structural
 * sharing loro-mirror's immer state has, which is what the per-turn render
 * caches key on.
 *
 * Returns `null` when the path does not resolve to a compatible node (a shape
 * the view did not expect); the caller then re-reads the whole turn instead of
 * guessing.
 */
export function applyEventToTurn<T extends object>(
  turn: T,
  relPath: readonly (string | number)[],
  diff: Diff,
  materialize: (container: Container) => unknown
): T | null {
  const next = patchAt(turn, relPath, 0, (leaf) => applyDiffToLeaf(leaf, diff, materialize));
  return next === FAILED ? null : (next as T);
}

const FAILED: unique symbol = Symbol('apply-turn-event-failed');

type Patched = unknown | typeof FAILED;

function patchAt(
  node: unknown,
  path: readonly (string | number)[],
  depth: number,
  apply: (leaf: unknown) => Patched
): Patched {
  if (depth === path.length) return apply(node);
  const key = path[depth];
  if (typeof key === 'number') {
    if (!Array.isArray(node) || key < 0 || key >= node.length) return FAILED;
    const child = patchAt(node[key], path, depth + 1, apply);
    if (child === FAILED) return FAILED;
    const copy = node.slice();
    copy[key] = child;
    return copy;
  }
  if (typeof key !== 'string') return FAILED;
  if (typeof node !== 'object' || node === null || Array.isArray(node)) return FAILED;
  const record = node as Record<string, unknown>;
  const child = patchAt(record[key], path, depth + 1, apply);
  if (child === FAILED) return FAILED;
  return { ...record, [key]: child };
}

function applyDiffToLeaf(
  leaf: unknown,
  diff: Diff,
  materialize: (container: Container) => unknown
): Patched {
  switch (diff.type) {
    case 'map': {
      const base =
        typeof leaf === 'object' && leaf !== null && !Array.isArray(leaf)
          ? { ...(leaf as Record<string, unknown>) }
          : {};
      for (const [key, value] of Object.entries(diff.updated)) {
        if (value === undefined) {
          delete base[key];
        } else if (isContainer(value)) {
          base[key] = materialize(value);
        } else {
          base[key] = value;
        }
      }
      return base;
    }
    case 'list': {
      const base = Array.isArray(leaf) ? leaf.slice() : [];
      let cursor = 0;
      for (const delta of diff.diff) {
        if (delta.retain !== undefined) {
          cursor += delta.retain;
        } else if (delta.delete !== undefined) {
          if (delta.delete > 0) base.splice(cursor, delta.delete);
        } else if (delta.insert !== undefined) {
          const inserted = delta.insert.map((item) =>
            isContainer(item) ? materialize(item) : item
          );
          base.splice(cursor, 0, ...inserted);
          cursor += inserted.length;
        }
      }
      return base;
    }
    case 'text': {
      const base = typeof leaf === 'string' ? leaf : '';
      let out = '';
      let cursor = 0;
      for (const delta of diff.diff) {
        if (delta.retain !== undefined) {
          out += base.slice(cursor, cursor + delta.retain);
          cursor += delta.retain;
        } else if (delta.delete !== undefined) {
          cursor += delta.delete;
        } else if (delta.insert !== undefined) {
          out += delta.insert;
        }
      }
      return out + base.slice(cursor);
    }
    default:
      return FAILED;
  }
}
