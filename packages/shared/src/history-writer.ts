import { Immer } from 'immer';
import { isContainer, LoroMap, type LoroDoc, type LoroList } from 'loro-crdt';
import { z } from 'zod';
import type { SessionHistory, SessionHistoryInput } from './schema';
import { sessionHistorySchema } from './schema';
import type { PermissionOutcome } from './message';
import {
  MessageContentSchema,
  PermissionOutcomeSchema,
  ToolCallMessageSchema,
  ToolCallContentSchema,
  SessionHistoryInputConfigSchema,
  TaskProposalMetaSchema,
} from './message-schemas';
import {
  HistoryEntryWriteSchema,
  HistoryWriteError,
  parseHistoryWrite,
  historyUnionCandidates,
} from './history-write-schema';
import { diffHistoryContainer, populateContainer } from './history-materializer';
import { applyRespondPermission } from './session-data/planner';

const immer = new Immer({ autoFreeze: false, useStrictShallowCopy: true });
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Inspect stored metadata without materializing sibling payloads; accept legacy JSON too. */
const storedField = (value: unknown, key: string): unknown =>
  isContainer(value)
    ? value.kind() === 'Map'
      ? (value as LoroMap).get(key)
      : undefined
    : record(value)
      ? value[key]
      : undefined;
const storedScalar = (value: unknown): unknown =>
  isContainer(value) && value.kind() === 'Text' ? value.toJSON() : value;

declare const storedHistoryBrand: unique symbol;
/** Provenance, not a way to bless caller-supplied JSON. history is a detached copy. */
export interface StoredHistorySnapshot {
  readonly [storedHistoryBrand]: true;
  readonly history: SessionHistoryInput[];
}
const storedHistories = new WeakMap<StoredHistorySnapshot, SessionHistoryInput[]>();

/** Ignore Mirror's transport identity, never the contents of a historical item. */
export function historyValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((v, i) => historyValuesEqual(v, b[i]));
  if (!record(a) || !record(b)) return false;
  const ak = Object.keys(a).filter((k) => k !== '$cid' && a[k] !== undefined);
  const bk = Object.keys(b).filter((k) => k !== '$cid' && b[k] !== undefined);
  return (
    ak.length === bk.length &&
    ak.every((k) => Object.hasOwn(b, k) && historyValuesEqual(a[k], b[k]))
  );
}

/** New unknown keys are filtered; unknown keys already stored are never scrubbed. */
function preserveUnknown(
  schema: z.core.$ZodType,
  old: unknown,
  input: unknown,
  parsed: unknown
): unknown {
  if (schema instanceof z.ZodOptional || schema instanceof z.ZodNullable)
    return preserveUnknown(schema.unwrap(), old, input, parsed);
  if (schema instanceof z.ZodUnion) {
    const candidates = historyUnionCandidates(schema, parsed);
    const option =
      candidates.length === 1
        ? candidates[0]
        : candidates.find((candidate) => z.safeParse(candidate, parsed).success);
    return option ? preserveUnknown(option, old, input, parsed) : parsed;
  }
  if (schema instanceof z.ZodObject && record(parsed)) {
    // A different union variant is a new value, not a carrier for the old one's extensions.
    if (
      record(old) &&
      typeof old.type === 'string' &&
      typeof parsed.type === 'string' &&
      old.type !== parsed.type
    )
      old = undefined;
    const result: Record<string, unknown> = Object.create(null);
    // Explicit protocol extension dictionaries (e.g. ACP content metadata) are
    // open in the shared parser. Respect that contract, not an invented whitelist.
    for (const key of Object.keys(parsed)) {
      if (key !== '$cid' && !Object.hasOwn(schema.shape, key)) result[key] = parsed[key];
    }
    const open = schema.def.catchall && !(schema.def.catchall instanceof z.ZodNever);
    if (record(old))
      for (const key of Object.keys(old)) {
        if (
          key !== '$cid' &&
          !Object.hasOwn(schema.shape, key) &&
          (!open || !Object.hasOwn(parsed, key))
        )
          result[key] = old[key];
      }
    for (const [key, field] of Object.entries(schema.shape)) {
      if (!Object.hasOwn(parsed, key)) continue;
      result[key] = preserveUnknown(
        field as z.ZodType,
        record(old) ? old[key] : undefined,
        record(input) ? input[key] : undefined,
        parsed[key]
      );
    }
    return result;
  }
  if (schema instanceof z.ZodArray && Array.isArray(parsed))
    return parsed.map((value, i) =>
      preserveUnknown(
        schema.element,
        Array.isArray(old) ? old[i] : undefined,
        Array.isArray(input) ? input[i] : undefined,
        value
      )
    );
  return parsed;
}

const cleanNew = (schema: z.ZodType, input: unknown, old?: unknown): unknown => {
  const parsed = parseHistoryWrite(schema, input);
  // There is no stored extension to merge for a newly authored value.
  return old === undefined ? parsed : preserveUnknown(schema, old, input, parsed);
};

// One independently editable group, derived from the message definition rather
// than a second set of validators. Tool identity stays outside this group.
const ToolStateWriteSchema = ToolCallMessageSchema.omit({
  type: true,
  toolCallId: true,
});

function prepareObjectFields(
  schema: z.ZodObject,
  old: Record<string, unknown>,
  input: Record<string, unknown>
) {
  const result = { ...old };
  for (const [key, field] of Object.entries(schema.shape)) {
    if (historyValuesEqual(old[key], input[key])) continue;
    const value = cleanNew(field as z.ZodType, input[key], old[key]);
    if (value === undefined) delete result[key];
    else result[key] = value;
  }
  return result;
}

/** Permission producers also enrich descriptions; they do not author old content. */
function prepareToolState(old: unknown, input: unknown): Record<string, unknown> | undefined {
  if (!record(old) || !record(input) || old.type !== 'tool_call' || input.type !== 'tool_call')
    return undefined;
  const payload = (value: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(value).filter(([key]) => !Object.hasOwn(ToolStateWriteSchema.shape, key))
    );
  if (!historyValuesEqual(payload(old), payload(input))) return undefined;
  const result = { ...old };
  for (const [key, schema] of Object.entries(ToolStateWriteSchema.shape)) {
    if (historyValuesEqual(old[key], input[key])) continue;
    if (key === 'content' && Array.isArray(input.content)) {
      const previous = Array.isArray(old.content) ? old.content : [];
      const used = new Set<number>();
      result.content = input.content.map((block, i) => {
        const retained = previous.findIndex(
          (value, index) => !used.has(index) && historyValuesEqual(value, block)
        );
        if (retained >= 0) {
          used.add(retained);
          return previous[retained];
        }
        return cleanNew(ToolCallContentSchema, block, previous[i]);
      });
      continue;
    }
    const oldRequest = old.permissionRequest;
    const permissionRequest = input.permissionRequest;
    // Answering an existing request does not author its options or tool content.
    if (key === 'permissionRequest' && record(oldRequest) && record(permissionRequest)) {
      const { outcome: _oldOutcome, ...oldInfo } = oldRequest;
      const { outcome, ...info } = permissionRequest;
      if (historyValuesEqual(oldInfo, info)) {
        const parsed = cleanNew(PermissionOutcomeSchema.optional(), outcome, oldRequest.outcome);
        result.permissionRequest = { ...oldRequest, outcome: parsed };
        continue;
      }
    }
    const parsed = cleanNew(schema, input[key], old[key]);
    if (parsed === undefined) delete result[key];
    else result[key] = parsed;
  }
  return result;
}

/** Only a read acknowledgement on a newly inserted pending user row is benign. */
function matchesRollbackReceipt(
  before: readonly unknown[],
  after: readonly unknown[],
  current: readonly unknown[]
): boolean {
  const previousIds = new Set(before.filter(record).map((entry) => entry.id));
  return (
    after.length === current.length &&
    after.every((expected, i) => {
      const actual = current[i];
      if (historyValuesEqual(expected, actual)) return true;
      if (
        !record(expected) ||
        !record(actual) ||
        previousIds.has(expected.id) ||
        expected.role !== 'user' ||
        expected.status !== 'pending' ||
        (expected.read !== undefined && expected.read !== false) ||
        actual.status !== 'seen' ||
        actual.read !== true
      )
        return false;
      return historyValuesEqual(expected, {
        ...actual,
        status: expected.status,
        read: expected.read,
      });
    })
  );
}

function prepareReplacement(previous: unknown, incoming: unknown): Record<string, unknown> {
  if (!record(previous) || !record(incoming))
    throw new HistoryWriteError([{ path: [], code: 'invalid_turn' }]);
  const result = { ...previous };
  for (const [key, schema] of Object.entries(HistoryEntryWriteSchema.shape)) {
    if (historyValuesEqual(previous[key], incoming[key])) continue;
    if (key === 'items' && Array.isArray(incoming.items)) {
      const oldItems = Array.isArray(previous.items) ? previous.items : [];
      // Retained items anchor each edited block, including an opaque item shifted
      // by deletion. Align replacements within the block, never across an anchor.
      let lastOld = -1;
      const anchors = incoming.items.map((item) => {
        let index = -1;
        for (let i = lastOld + 1; i < oldItems.length; i++) {
          if (historyValuesEqual(oldItems[i], item)) {
            index = i;
            break;
          }
        }
        if (index >= 0) lastOld = index;
        return index;
      });
      let following = oldItems.length;
      const followingAnchors = new Array<number>(anchors.length);
      for (let i = anchors.length - 1; i >= 0; i--) {
        followingAnchors[i] = following;
        if (anchors[i]! >= 0) following = anchors[i]!;
      }
      let oldStart = 0;
      let newStart = 0;
      result.items = incoming.items.map((item, i) => {
        const unchanged = anchors[i]!;
        if (unchanged >= 0) {
          oldStart = unchanged + 1;
          newStart = i + 1;
          return oldItems[unchanged];
        }
        const nextAnchor = followingAnchors[i]!;
        const oldIndex = oldStart + i - newStart;
        const old = oldIndex < nextAnchor ? oldItems[oldIndex] : undefined;
        const toolState = prepareToolState(old, item);
        if (toolState !== undefined) return toolState;
        if (
          record(old) &&
          record(item) &&
          old.type === 'system_notice' &&
          item.type === old.type &&
          old.name === 'task_proposal' &&
          item.name === old.name &&
          record(old.meta) &&
          record(item.meta) &&
          old.meta.proposalId === item.meta.proposalId &&
          historyValuesEqual({ ...old, meta: undefined }, { ...item, meta: undefined })
        ) {
          return { ...old, meta: prepareObjectFields(TaskProposalMetaSchema, old.meta, item.meta) };
        }
        return cleanNew(
          MessageContentSchema,
          item,
          record(old) && record(item) && old.type === item.type ? old : undefined
        );
      });
    } else if (
      key === 'inputConfig' &&
      record(previous.inputConfig) &&
      record(incoming.inputConfig)
    ) {
      result.inputConfig = prepareObjectFields(
        SessionHistoryInputConfigSchema,
        previous.inputConfig,
        incoming.inputConfig
      );
    } else {
      const value = cleanNew(schema, incoming[key], previous[key]);
      if (value === undefined) delete result[key];
      else result[key] = value;
    }
  }
  return result;
}

export interface HistoryWriter {
  /** Detached stored JSON for inspection/hashing; not copy/rollback provenance. */
  readStored(): SessionHistoryInput[];
  capture(): StoredHistorySnapshot;
  /** Prepend copied history, retaining target initialization rows; ids must not collide. */
  copyFrom(snapshot: StoredHistorySnapshot, history: SessionHistoryInput[]): void;
  /** Restore the changed range only; retain edits to untouched rows. */
  updateWithRollback(
    updater: (history: SessionHistoryInput[]) => SessionHistoryInput[]
  ): () => void;
  append(entry: SessionHistory): void;
  replace(turnId: string, entry: SessionHistory): boolean;
  read(turnId: string): SessionHistory | undefined;
  /** Existing typed callback API; only its changed turns/items reach the writer. */
  update(updater: (history: SessionHistoryInput[]) => SessionHistoryInput[]): void;
  /** Mutate an existing turn without producing/planning the entire history. */
  updateEntry(id: string, updater: (entry: SessionHistoryInput) => SessionHistoryInput): boolean;
  setField<K extends Exclude<keyof SessionHistoryInput, '$cid' | 'items' | 'id'>>(
    turnId: string,
    key: K,
    value: SessionHistoryInput[K] | undefined
  ): boolean;
  respondPermission(
    requestId: string,
    outcome: PermissionOutcome,
    options?: { turnId?: string }
  ): boolean;
}

/** Shared extraction of #376's writer. No ConversationView or feature-flag dependency. */
export function createHistoryWriter(doc: LoroDoc, readHistory?: () => readonly SessionHistory[]) {
  const list = doc.getList('history');
  const readAll = () => readHistory?.() ?? (list.toJSON() as SessionHistory[]);
  const locate = (id: string) => {
    for (let index = list.length - 1; index >= 0; index--) {
      const map = list.get(index);
      if (isContainer(map) && map.kind() === 'Map' && (map as LoroMap).get('id') === id)
        return { map: map as LoroMap, index };
    }
    return undefined;
  };

  // Preparation is separate so a malformed update cannot leave half-written CRDT ops.
  const planWrite = (
    previous: readonly SessionHistory[],
    next: readonly SessionHistory[],
    prepareValue: (old: SessionHistory | undefined, value: SessionHistory) => unknown = (
      old,
      value
    ) =>
      old === undefined ? cleanNew(HistoryEntryWriteSchema, value) : prepareReplacement(old, value)
  ) => {
    const used = new Set<number>();
    const byId = new Map<unknown, number[]>();
    const byRef = new Map<unknown, number>();
    previous.forEach((entry, i) => {
      byRef.set(entry, i);
      const id = record(entry) ? entry.id : undefined;
      const matches = byId.get(id) ?? [];
      matches.push(i);
      byId.set(id, matches);
    });
    let last = -1;
    const plan = next.map((entry) => {
      const ref = byRef.get(entry);
      const candidates = byId.get(record(entry) ? entry.id : undefined) ?? [];
      const index =
        ref !== undefined && !used.has(ref) ? ref : candidates.find((i) => !used.has(i));
      if (index === undefined) return { value: prepareValue(undefined, entry), index: -1 };
      if (index < last)
        throw new HistoryWriteError([{ path: ['history'], code: 'unsupported_reorder' }]);
      last = index;
      used.add(index);
      if (historyValuesEqual(previous[index], entry)) return { index };
      const map = list.get(index);
      if (!isContainer(map) || map.kind() !== 'Map')
        throw new HistoryWriteError([{ path: ['history', index], code: 'invalid_stored_turn' }]);
      return { index, map, value: prepareValue(previous[index], entry) };
    });
    return () => {
      for (let i = previous.length - 1; i >= 0; i--) if (!used.has(i)) list.delete(i, 1);
      plan.forEach((op, i) => {
        if (op.index < 0)
          populateContainer(
            list.insertContainer(i, new LoroMap()),
            sessionHistorySchema,
            op.value,
            undefined
          );
        else if (op.value !== undefined && isContainer(op.map))
          diffHistoryContainer(
            op.map,
            sessionHistorySchema,
            previous[op.index],
            op.value,
            undefined
          );
      });
      doc.commit();
    };
  };
  const prepare = (previous: readonly SessionHistory[], next: readonly SessionHistory[]) =>
    planWrite(previous, next);

  const writer: HistoryWriter = {
    readStored() {
      return list.toJSON() as SessionHistoryInput[];
    },
    capture() {
      // Read the actual document, not a normalized projection or caller-owned array.
      const history = writer.readStored();
      const snapshot = Object.freeze({
        get history() {
          return structuredClone(history);
        },
      }) as StoredHistorySnapshot;
      storedHistories.set(snapshot, history);
      return snapshot;
    },
    copyFrom(snapshot, history) {
      const source = storedHistories.get(snapshot);
      if (!source) throw new HistoryWriteError([{ path: ['history'], code: 'invalid_snapshot' }]);
      const previous = list.toJSON() as SessionHistory[];
      const ids = new Set(previous.filter(record).map((entry) => entry.id));
      for (const entry of history) {
        if (ids.has(entry.id))
          throw new HistoryWriteError([{ path: ['history'], code: 'copy_target_conflict' }]);
        ids.add(entry.id);
      }
      // Incoming ids were proven unique above. Match each to the first stored
      // occurrence once instead of rescanning the entire source for every turn.
      const sourceById = new Map<string, SessionHistoryInput>();
      for (const old of source) if (!sourceById.has(old.id)) sourceById.set(old.id, old);
      const values = history.map((entry) => {
        const old = sourceById.get(entry.id);
        if (!old) return cleanNew(HistoryEntryWriteSchema, entry);
        return prepareReplacement(old, entry);
      });
      // Values are either unchanged stored data or preflighted authored changes.
      planWrite(previous, [...values, ...previous] as SessionHistory[], (_old, value) => value)();
    },
    updateWithRollback(updater) {
      const before = readAll();
      const next = immer.produce(before, updater);
      // Unchanged rows are not owned by this operation. Capture only the range
      // it changed, retaining the current values outside it during compensation.
      let start = 0;
      while (
        start < before.length &&
        start < next.length &&
        historyValuesEqual(before[start], next[start])
      )
        start++;
      let suffix = 0;
      while (
        suffix < before.length - start &&
        suffix < next.length - start &&
        historyValuesEqual(before[before.length - 1 - suffix], next[next.length - 1 - suffix])
      )
        suffix++;
      // Capture only the owned range from storage, including fields the reader hides.
      const removed = before.slice(start, before.length - suffix).map((_, offset) => {
        const value = list.get(start + offset);
        return isContainer(value) ? value.toJSON() : value;
      });
      planWrite(before, next)();
      const after = readAll();
      let consumed = false;
      return () => {
        const current = readAll();
        // Structural changes remain conservative: an index is safe only while
        // every row still has the same identity and order as the receipt.
        const sameRows =
          current.length >= after.length &&
          after.every((row, i) => record(row) && record(current[i]) && row.id === current[i].id);
        if (
          consumed ||
          !sameRows ||
          !matchesRollbackReceipt(
            before,
            after.slice(start, after.length - suffix),
            current.slice(start, after.length - suffix)
          )
        )
          throw new HistoryWriteError([{ path: ['history'], code: 'stale_rollback' }]);
        // Only this closure can restore its captured values. Never reparse old data
        // as new input, and never overwrite intervening local/remote history edits
        // other than the discarded replacement's automatic read acknowledgement.
        const restored = [
          ...current.slice(0, start),
          ...removed,
          ...current.slice(after.length - suffix),
        ];
        planWrite(current as SessionHistory[], restored, (_old, value) => value)();
        consumed = true;
      };
    },
    append(entry) {
      const value = cleanNew(HistoryEntryWriteSchema, entry);
      populateContainer(
        list.insertContainer(list.length, new LoroMap()),
        sessionHistorySchema,
        value,
        undefined
      );
      doc.commit();
    },
    replace(id, entry) {
      const target = locate(id);
      if (!target) return false;
      const { map } = target;
      if (entry.id !== id) throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
      const previous = map.toJSON();
      const value = prepareReplacement(previous, entry);
      diffHistoryContainer(map, sessionHistorySchema, previous, value, undefined);
      doc.commit();
      return true;
    },
    read(id) {
      return locate(id)?.map.toJSON() as SessionHistory | undefined;
    },
    update(updater) {
      const previous = readAll();
      const next = immer.produce(previous as SessionHistoryInput[], (draft) => updater(draft));
      prepare(previous, next)();
    },
    updateEntry(id, updater) {
      const target = locate(id);
      if (!target) return false;
      const { map, index } = target;
      const previous = readHistory?.()[index] ?? (map.toJSON() as SessionHistoryInput);
      const next = immer.produce(previous, (draft) => updater(draft));
      if (next.id !== id) throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
      if (historyValuesEqual(previous, next)) return true;
      const prepared = prepareReplacement(previous, next);
      diffHistoryContainer(map, sessionHistorySchema, previous, prepared, undefined);
      doc.commit();
      return true;
    },
    setField(id, key, value) {
      const target = locate(id);
      if (!target) return false;
      const { map } = target;
      const field = HistoryEntryWriteSchema.shape[key];
      if (
        !Object.hasOwn(HistoryEntryWriteSchema.shape, key) ||
        key === ('id' as string) ||
        key === ('items' as string)
      )
        throw new HistoryWriteError([{ path: [key], code: 'invalid_field' }]);
      const stored = map.get(key);
      const previous = isContainer(stored) ? stored.toJSON() : stored;
      if (historyValuesEqual(previous, value)) return true;
      const parsed = cleanNew(field, value, previous);
      // A partial map diff only visits this key; it neither reads nor authors items.
      diffHistoryContainer(
        map,
        sessionHistorySchema,
        { [key]: previous },
        { [key]: parsed },
        undefined
      );
      doc.commit();
      return true;
    },
    respondPermission(requestId, outcome, options) {
      parseHistoryWrite(PermissionOutcomeSchema, outcome);
      const target = options?.turnId ? locate(options.turnId) : undefined;
      if (options?.turnId && !target) return false;
      for (let i = target?.index ?? list.length - 1; i >= (target?.index ?? 0); i--) {
        const row = list.get(i);
        const id = storedScalar(storedField(row, 'id'));
        if (typeof id !== 'string') continue;
        const storedItems = storedField(row, 'items');
        const items =
          isContainer(storedItems) && storedItems.kind() === 'List'
            ? (storedItems as LoroList)
            : Array.isArray(storedItems)
              ? storedItems
              : undefined;
        if (!items) continue;
        for (let at = 0; at < items.length; at++) {
          const item = Array.isArray(items) ? items[at] : items.get(at);
          if (storedScalar(storedField(item, 'type')) !== 'tool_call') continue;
          const request = storedField(item, 'permissionRequest');
          if (storedScalar(storedField(request, 'requestId')) !== requestId) continue;
          // Only the matching turn enters the validated local-update path. The
          // "write the outcome" rule itself is the shared planner, so the Loro
          // and in-memory backends cannot drift.
          return writer.updateEntry(id, (turn) => {
            applyRespondPermission(turn as unknown as Record<string, unknown>, requestId, outcome);
            return turn;
          });
        }
      }
      return false;
    },
  };
  return { ...writer, prepare };
}
