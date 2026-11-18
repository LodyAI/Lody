import { assertNativeFlockRewriteValue as assertLosslessNativeWireInteger } from './native-flock-value';
import { historyValuesEqual } from '../history-values-equal';
import { HistoryWriteError } from '../history-write-schema';
import { sessionHistorySchema } from '../schema';
import {
  getMapFieldSchema,
  isMapSchema,
  isListSchema,
  containerTypeOfSchema,
  schemaHasTransform,
} from '../history-materializer';
import type { SchemaType } from '../index';
import {
  LODY_SESSION_DOC_SCHEMA,
  type DocSchema,
  type JsonPatch,
  type JsonValue,
} from '@loro-dev/loro-repo-client';
import {
  supportsNativeSessionLiteralValues,
  supportsNativeSessionI64,
  type NativeSessionSdkCompatibility,
} from './native-session-compatibility';
import type { NativeSessionReadView } from './native-session-reader';

type Path = readonly (string | number)[];
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Uint8Array);

// History materialization skips undefined map entries. Zod's optional fields
// can retain those own properties; the native JSON codec correctly rejects them.
export const nativeDocumentWireValue = (
  value: unknown,
  compatibility?: NativeSessionSdkCompatibility
): JsonValue => {
  if (Array.isArray(value))
    return value.map((item) => nativeDocumentWireValue(item, compatibility));
  if (record(value))
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([key, item]) => [key, nativeDocumentWireValue(item, compatibility)])
    ) as JsonValue;
  try {
    assertLosslessNativeWireInteger(
      value,
      supportsNativeSessionI64(compatibility) ? { losslessWireI64: true } : undefined
    );
  } catch {
    throw new HistoryWriteError([{ path: [], code: 'unsupported_unsafe_integer' }]);
  }
  return value as JsonValue;
};

// Derive native insertion hints from HistoryWriter's actual public storage
// schema. The SDK preset predates the current `history[*].items[*]` layout.
// Do not declare history[*] as map: legacy inline rows need to stay values.
const historyRules: NonNullable<DocSchema['rules']>[number][] = [];
const describe = (schema: SchemaType, path: (string | number)[], root = false) => {
  const type = schemaHasTransform(schema) ? undefined : containerTypeOfSchema(schema);
  const kind =
    type === 'Map'
      ? 'map'
      : type === 'List'
        ? 'list'
        : type === 'MovableList'
          ? 'movable_list'
          : type === 'Text'
            ? 'text'
            : undefined;
  if (!root && (kind || schema.type !== 'any'))
    historyRules.push({ pattern: path, kind: kind ?? 'value' });
  if (isMapSchema(schema)) {
    for (const key of Object.keys(schema.definition)) {
      const child = getMapFieldSchema(schema, key);
      if (child) describe(child, [...path, key]);
    }
  } else if (isListSchema(schema) && schema.itemSchema) describe(schema.itemSchema, [...path, '*']);
};
describe(sessionHistorySchema, ['history', '*'], true);
export const NATIVE_SESSION_HISTORY_SCHEMA: DocSchema = {
  ...LODY_SESSION_DOC_SCHEMA,
  rules: [
    ...(LODY_SESSION_DOC_SCHEMA.rules ?? []),
    ...historyRules,
    { pattern: ['nativeAgentOperations'], kind: 'map' },
  ],
};

export interface NativeHistoryPatchPlan {
  agentReceipt(key: string, digest: string): void;
  sparse(change: import('../history-agent-window').AgentHistoryPatch): void;
  replace(position: number, before: unknown, next: unknown): void;
  fields(position: number, fields: Readonly<Record<string, unknown>>): void;
  control(root: string, before: unknown, next: unknown): void;
  append(at: number, entries: readonly unknown[]): void;
  restore(at: number, entries: readonly unknown[], atomic: readonly boolean[]): void;
  remove(at: number, count: number): void;
  finish(): { patch: JsonPatch; docSchema: DocSchema };
}
/** Local patches from validated field plans; never a public arbitrary-patch endpoint. */
export function createNativeHistoryPatchPlan(
  view: Pick<NativeSessionReadView, 'valueAt' | 'kindAt'>,
  schema: DocSchema = NATIVE_SESSION_HISTORY_SCHEMA,
  compatibility?: NativeSessionSdkCompatibility
): NativeHistoryPatchPlan {
  const patch: JsonPatch[number][] = [];
  const wire = (value: unknown) => nativeDocumentWireValue(value, compatibility);
  const canSetValue = supportsNativeSessionLiteralValues(compatibility);
  let atomicRows = false,
    newRows = false;
  const set = (path: Path, value: unknown) =>
    patch.push(
      value === undefined ? { op: 'unset', path } : { op: 'set', path, value: wire(value) }
    );
  const literal = (path: Path, value: unknown) => {
    if (value === undefined) {
      set(path, undefined);
      return;
    }
    if (canSetValue)
      patch.push({ op: 'set_value', path, value: wire(value) } as unknown as JsonPatch[number]);
    else {
      atomicRows = true;
      set(path, value);
    }
  };
  const visit = (
    path: Path,
    before: unknown,
    next: unknown,
    storagePath: Path = path,
    arrayOffset = 0
  ) => {
    if (historyValuesEqual(before, next)) return;
    const kind = view.kindAt(storagePath);
    if (kind === 'value' && before !== null && typeof before === 'object') {
      if (!canSetValue && path[0] !== 'history')
        throw new HistoryWriteError([{ path, code: 'unsupported_atomic_object_replacement' }]);
      // The supporting engine's literal opcode preserves an existing opaque
      // value without overriding the schema for other writes in this CAS batch.
      literal(path, next);
      return;
    }
    if (kind === 'text' && typeof before === 'string' && typeof next === 'string') {
      // Keep token appends proportional to the changed suffix, retaining Text.
      let at = 0;
      while (at < before.length && at < next.length && before[at] === next[at]) at++;
      const splitPair = (text: string, position: number) =>
        position > 0 &&
        position < text.length &&
        text.charCodeAt(position - 1) >= 0xd800 &&
        text.charCodeAt(position - 1) <= 0xdbff &&
        text.charCodeAt(position) >= 0xdc00 &&
        text.charCodeAt(position) <= 0xdfff;
      if (splitPair(before, at) || splitPair(next, at)) at--;
      let oldEnd = before.length,
        newEnd = next.length;
      while (oldEnd > at && newEnd > at && before[oldEnd - 1] === next[newEnd - 1]) {
        oldEnd--;
        newEnd--;
      }
      if (splitPair(before, oldEnd) || splitPair(next, newEnd)) {
        oldEnd++;
        newEnd++;
      }
      patch.push({ op: 'str_splice', path, at, del: oldEnd - at, ins: next.slice(at, newEnd) });
      return;
    }
    if (kind === 'map' && record(before) && record(next)) {
      for (const key of Object.keys(before))
        if (key !== '$cid' && !Object.hasOwn(next, key)) set([...path, key], undefined);
      for (const key of Object.keys(next))
        if (key !== '$cid') visit([...path, key], before[key], next[key], [...storagePath, key]);
      return;
    }
    if (
      (kind === 'list' || kind === 'movable_list') &&
      Array.isArray(before) &&
      Array.isArray(next)
    ) {
      // Equal retained values anchor old containers, including opaque items
      // shifted by an insertion/deletion. Only each changed block is planned.
      let oldStart = 0,
        newStart = 0;
      let lastAnchor = -1;
      const anchors = next.map((item) => {
        const index = before.findIndex(
          (candidate, index) => index > lastAnchor && historyValuesEqual(candidate, item)
        );
        if (index >= 0) lastAnchor = index;
        return index;
      });
      const block = (oldEnd: number, newEnd: number) => {
        const oldLength = oldEnd - oldStart,
          newLength = newEnd - newStart;
        const overlap = Math.min(oldLength, newLength);
        for (let offset = 0; offset < overlap; offset++)
          visit(
            [...path, arrayOffset + newStart + offset],
            before[oldStart + offset],
            next[newStart + offset],
            [...storagePath, arrayOffset + oldStart + offset]
          );
        if (oldLength > overlap)
          patch.push({
            op: 'arr_splice',
            path,
            at: arrayOffset + newStart + overlap,
            del: oldLength - overlap,
            items: [],
          });
        if (newLength > overlap)
          patch.push({
            op: 'arr_splice',
            path,
            at: arrayOffset + newStart + overlap,
            del: 0,
            items: next.slice(newStart + overlap, newEnd).map(wire),
          });
      };
      for (let index = 0; index < next.length; index++) {
        const oldIndex = anchors[index]!;
        if (oldIndex < oldStart) continue;
        block(oldIndex, index);
        oldStart = oldIndex + 1;
        newStart = index + 1;
      }
      block(before.length, next.length);
      return;
    }
    set(path, next);
  };
  return {
    agentReceipt(key: string, digest: string) {
      if (
        view.kindAt(['nativeAgentOperations']) === 'missing' &&
        !patch.some(
          (op) => op.op === 'set' && op.path.length === 1 && op.path[0] === 'nativeAgentOperations'
        )
      )
        set(['nativeAgentOperations'], {});
      visit(['nativeAgentOperations', key], view.valueAt(['nativeAgentOperations', key]), digest);
    },
    sparse(change: import('@lody/shared').AgentHistoryPatch) {
      visit(change.path, change.before, change.next, change.path, change.rangeStart ?? 0);
    },
    replace(position: number, before: unknown, next: unknown) {
      if (historyValuesEqual(before, next)) return;
      if (view.kindAt(['history', position]) === 'value') {
        literal(['history', position], next);
      } else visit(['history', position], before, next);
    },
    fields(position: number, fields: Readonly<Record<string, unknown>>) {
      if (!Object.keys(fields).length) return;
      if (view.kindAt(['history', position]) === 'value') {
        const before = view.valueAt(['history', position]);
        if (!record(before))
          throw new HistoryWriteError([
            { path: ['history', position], code: 'invalid_stored_turn' },
          ]);
        const next = { ...before };
        for (const [key, value] of Object.entries(fields)) {
          if (value === undefined) delete next[key];
          else next[key] = value;
        }
        if (!historyValuesEqual(before, next)) {
          literal(['history', position], next);
        }
      } else
        for (const [key, value] of Object.entries(fields))
          visit(['history', position, key], view.valueAt(['history', position, key]), value);
    },
    control(root: string, before: unknown, next: unknown) {
      visit([root], before, next);
    },
    append(at: number, entries: readonly unknown[]) {
      if (!entries.length) return;
      newRows = true;
      patch.push({
        op: 'arr_splice',
        path: ['history'],
        at,
        del: 0,
        items: entries.map(wire),
      });
    },
    restore(at: number, entries: readonly unknown[], atomic: readonly boolean[]) {
      if (entries.length !== atomic.length)
        throw new Error('Native history restore representation mismatch');
      if (!entries.length) return;
      if (!canSetValue) {
        if (atomic.some(Boolean) && !atomic.every(Boolean))
          throw new HistoryWriteError([
            { path: ['history'], code: 'unsupported_mixed_atomic_restore' },
          ]);
        if (atomic.some(Boolean)) atomicRows = true;
        else newRows = true;
        patch.push({ op: 'arr_splice', path: ['history'], at, del: 0, items: entries.map(wire) });
        return;
      }
      // Scalar placeholders avoid temporary Map/Text subtrees for literal rows.
      patch.push({
        op: 'arr_splice',
        path: ['history'],
        at,
        del: 0,
        items: entries.map((entry, index) => (atomic[index] ? null : wire(entry))),
      });
      entries.forEach((entry, index) => {
        if (atomic[index]) literal(['history', at + index], entry);
      });
    },
    remove(at: number, count: number) {
      if (count) patch.push({ op: 'arr_splice', path: ['history'], at, del: count, items: [] });
    },
    finish() {
      if (!canSetValue && atomicRows && newRows)
        throw new HistoryWriteError([
          { path: ['history'], code: 'unsupported_mixed_atomic_insertion' },
        ]);
      return {
        patch,
        docSchema:
          !canSetValue && atomicRows ? { ...schema, defaultObject: 'value' as const } : schema,
      };
    },
  };
}
