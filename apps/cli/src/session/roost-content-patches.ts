import { applicationJsonText, type HistoryIdentity } from '@loro-dev/roost/lody-history';
import type { ContentOp, IndexPut } from '@loro-dev/roost-node';
import { encodeRoostContentText } from './roost-history-port';

export const AGENT_RECEIPTS_TABLE = 'lody_agent_operation_receipts_v1';
export const agentReceiptKey = (identity: HistoryIdentity) =>
  new TextEncoder().encode(applicationJsonText(identity));
export const agentReceiptPut = (identity: HistoryIdentity, digest: string): IndexPut => ({
  table: AGENT_RECEIPTS_TABLE,
  key: agentReceiptKey(identity),
  value: new TextEncoder().encode(JSON.stringify({ version: 1, digest })),
});

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Diff validated content, preserving unchanged subtrees and native scalar text offsets. */
export function roostContentPatches(before: unknown, after: unknown): ContentOp[] {
  const ops: ContentOp[] = [];
  const walk = (left: unknown, right: unknown, path: ContentOp['path']) => {
    if (Object.is(left, right)) return;
    if (right === undefined) {
      if (left !== undefined) ops.push({ kind: 'remove', path });
      return;
    }
    if (typeof left === 'string' && typeof right === 'string') {
      if (right.startsWith(left)) {
        ops.push({ kind: 'appendText', path, text: right.slice(left.length) });
        return;
      }
      const old = Array.from(left),
        next = Array.from(right);
      let from = 0,
        suffix = 0;
      while (from < old.length && from < next.length && old[from] === next[from]) from++;
      while (
        suffix < old.length - from &&
        suffix < next.length - from &&
        old[old.length - 1 - suffix] === next[next.length - 1 - suffix]
      )
        suffix++;
      ops.push({
        kind: 'spliceText',
        path,
        index: BigInt(from),
        delete: BigInt(old.length - from - suffix),
        text: next.slice(from, next.length - suffix).join(''),
      });
      return;
    }
    if (Array.isArray(left) && Array.isArray(right)) {
      if (left.length === right.length) {
        for (let i = 0; i < left.length; i++)
          walk(left[i], right[i] === undefined ? null : right[i], [...path, { index: BigInt(i) }]);
      } else {
        let from = 0;
        // Equal-length prefixes may contain edits: preserve those identities and
        // splice only the changed membership after their common length.
        const common = Math.min(left.length, right.length);
        while (from < common) {
          walk(left[from], right[from] === undefined ? null : right[from], [
            ...path,
            { index: BigInt(from) },
          ]);
          from++;
        }
        ops.push({
          kind: 'spliceArray',
          path,
          index: BigInt(common),
          delete: BigInt(left.length - common),
          valuesJson: encodeRoostContentText(right.slice(common)),
        });
      }
      return;
    }
    if (object(left) && object(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        walk(left[key], right[key], [...path, { key }]);
      return;
    }
    ops.push({ kind: 'set', path, contentJson: encodeRoostContentText(right) });
  };
  walk(before, after, [{ key: 'content' }]);
  return ops;
}
