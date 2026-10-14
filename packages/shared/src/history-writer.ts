import { Immer } from 'immer';
import { isContainer, LoroMap, type LoroDoc, type LoroList, type VersionVector } from 'loro-crdt';
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
import {
  applySchemaToInfer,
  diffHistoryContainer,
  diffHistoryListRange,
  getMapFieldSchema,
  populateContainer,
} from './history-materializer';
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

/** Capture a backend's stored values using the writer's common provenance registry. */
export function captureStoredHistory(
  history: readonly SessionHistoryInput[]
): StoredHistorySnapshot {
  const stored = structuredClone(history) as SessionHistoryInput[];
  const snapshot = Object.freeze({
    get history() {
      return structuredClone(stored);
    },
  }) as StoredHistorySnapshot;
  storedHistories.set(snapshot, stored);
  return snapshot;
}

/** Preflight the complete copy before either backend changes its target. */
export function prepareStoredHistoryCopy(
  snapshot: StoredHistorySnapshot,
  selection: readonly SessionHistoryInput[],
  previous: readonly SessionHistoryInput[]
): SessionHistoryInput[] {
  const source = storedHistories.get(snapshot);
  if (!source) throw new HistoryWriteError([{ path: ['history'], code: 'invalid_snapshot' }]);
  const ids = new Set(previous.map((entry) => entry.id));
  for (const entry of selection) {
    if (ids.has(entry.id))
      throw new HistoryWriteError([{ path: ['history'], code: 'copy_target_conflict' }]);
    ids.add(entry.id);
  }
  const sourceById = new Map<string, SessionHistoryInput>();
  for (const old of source) if (!sourceById.has(old.id)) sourceById.set(old.id, old);
  return selection.map((entry) => {
    const old = sourceById.get(entry.id);
    return (
      old ? prepareReplacement(old, entry) : cleanNew(HistoryEntryWriteSchema, entry)
    ) as SessionHistoryInput;
  });
}

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
      Object.entries(schema.shape).some(
        ([key, field]) =>
          field instanceof z.ZodLiteral &&
          record(old) &&
          Object.hasOwn(old, key) &&
          old[key] !== parsed[key]
      )
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
export function matchesRollbackReceipt(
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

export function prepareReplacement(previous: unknown, incoming: unknown): Record<string, unknown> {
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
  /**
   * Stage a single-turn replacement without writing. Validates only changed
   * fields/items through the shared prepare rule (unchanged opaque stored
   * content is retained), so a `HistoryWriteError` thrown here is a pre-write
   * rejection. Returns a commit closure, or `undefined` when the turn is absent.
   */
  prepareReplace(turnId: string, entry: SessionHistory): (() => void) | undefined;
  read(turnId: string): SessionHistory | undefined;
  /** Existing typed callback API; only its changed turns/items reach the writer. */
  update(updater: (history: SessionHistoryInput[]) => SessionHistoryInput[]): void;
  /** Mutate an existing turn without producing/planning the entire history. */
  updateEntry(id: string, updater: (entry: SessionHistoryInput) => SessionHistoryInput): boolean;
  /**
   * Target-local agent output that materializes neither the history nor the whole
   * turn. The updater receives one single-item row per requested tool call stored
   * outside the window, then the assistant turn with every field except `fileDiff`
   * and only its trailing items: the last item, extended back across adjacent
   * text/thought so compaction sees the neighbours a whole-turn write would. Returns
   * false without writing when the turn is missing, duplicated or not a stored Map
   * with an item list, or a requested tool call is stored inline; use `update` then.
   */
  updateTail(
    turnId: string,
    toolCallIds: readonly string[],
    updater: (rows: SessionHistoryInput[]) => SessionHistoryInput[]
  ): boolean;
  /**
   * Mutate every stored row carrying `id`, oldest first. Concurrent producers
   * can insert the same turn twice; this keeps those copies in step. Every
   * replacement is prepared before the first CRDT mutation.
   */
  updateCopies(id: string, updater: (copies: SessionHistoryInput[]) => void): boolean;
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
  const rowWithId = (index: number, id: string) => {
    const map = list.get(index);
    if (isContainer(map) && map.kind() === 'Map' && (map as LoroMap).get('id') === id)
      return { map: map as LoroMap, inline: undefined, index };
    if (!isContainer(map) && record(map) && map.id === id)
      return { map: undefined, inline: map as unknown as SessionHistoryInput, index };
    return undefined;
  };
  const locate = (id: string) => {
    for (let index = list.length - 1; index >= 0; index--) {
      const found = rowWithId(index, id);
      if (found) return found;
    }
    return undefined;
  };
  const storedList = (value: unknown) =>
    isContainer(value) && value.kind() === 'List' ? (value as LoroList) : undefined;
  const storedJson = (value: unknown) => (isContainer(value) ? value.toJSON() : value);
  const isTextish = (item: unknown) => {
    const type = storedScalar(storedField(item, 'type'));
    return type === 'text' || type === 'thought';
  };

  // Where each tool call is stored, so target-local writes neither materialize nor
  // scan the history. A full-history write merges into the newest row holding the
  // id, the first such item within it; the index keeps that same owner. It is
  // complete only at `version`: any write it did not account for, local or
  // imported, makes the next use rescan.
  type ToolSlot = { row: number; item: number; inline?: true };
  let toolIndex: { version: VersionVector; slots: Map<string, ToolSlot> } | undefined;
  const indexTool = (slots: Map<string, ToolSlot>, id: unknown, slot: ToolSlot) => {
    if (typeof id !== 'string') return;
    const current = slots.get(id);
    if (!current || current.row < slot.row) slots.set(id, slot);
  };
  const currentToolIndex = () => {
    if (toolIndex && toolIndex.version.compare(doc.version()) === 0) return toolIndex.slots;
    const slots = new Map<string, ToolSlot>();
    for (let row = 0; row < list.length; row++) {
      const stored = list.get(row);
      const items = storedField(stored, 'items');
      const inline = !isContainer(stored) || !storedList(items);
      const values = storedList(items)?.toArray() ?? (Array.isArray(items) ? items : []);
      values.forEach((value, item) => {
        if (storedScalar(storedField(value, 'type')) !== 'tool_call') return;
        indexTool(slots, storedScalar(storedField(value, 'toolCallId')), {
          row,
          item,
          ...(inline ? { inline: true as const } : {}),
        });
      });
    }
    toolIndex = { version: doc.version(), slots };
    return slots;
  };
  const toolAt = (slot: ToolSlot, id: string) => {
    const items = storedList(storedField(list.get(slot.row), 'items'));
    const value = items && slot.item < items.length ? items.get(slot.item) : undefined;
    return storedScalar(storedField(value, 'toolCallId')) === id && items
      ? { items, value: storedJson(value) }
      : undefined;
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
      if (!isContainer(map) && record(map))
        return { index, inline: true, value: prepareValue(previous[index], entry) };
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
        else if ('inline' in op && op.inline) {
          list.delete(i, 1);
          list.insert(i, op.value as Parameters<LoroList['insert']>[1]);
        } else if (op.value !== undefined && isContainer(op.map))
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
      return captureStoredHistory(writer.readStored());
    },
    copyFrom(snapshot, history) {
      const previous = list.toJSON() as SessionHistory[];
      // Incoming ids were proven unique above. Match each to the first stored
      // occurrence once instead of rescanning the entire source for every turn.
      const values = prepareStoredHistoryCopy(snapshot, history, previous);
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
      const commit = writer.prepareReplace(id, entry);
      if (!commit) return false;
      commit();
      return true;
    },
    prepareReplace(id, entry) {
      const target = locate(id);
      if (!target) return undefined;
      const { map, inline, index } = target;
      if (entry.id !== id) throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
      // Validate only changed fields/items and retain unchanged opaque stored
      // content; this runs before any CRDT mutation.
      const previous = map ? (map.toJSON() as SessionHistoryInput) : inline!;
      const value = prepareReplacement(previous, entry);
      return () => {
        if (map) diffHistoryContainer(map, sessionHistorySchema, previous, value, undefined);
        else {
          list.delete(index, 1);
          list.insert(index, value as Parameters<LoroList['insert']>[1]);
        }
        doc.commit();
      };
    },
    read(id) {
      const target = locate(id);
      return (target?.map ? target.map.toJSON() : target?.inline) as SessionHistory | undefined;
    },
    update(updater) {
      const previous = readAll();
      const next = immer.produce(previous as SessionHistoryInput[], (draft) => {
        // Callers may mutate the draft, return a replacement, or both. Immer
        // rejects a recipe that does both, so a distinct return value is written
        // back into the draft and the draft stays the one result (the legacy
        // Mirror updater had the same rule).
        const result = updater(draft);
        if (result && result !== (draft as unknown)) {
          (draft as SessionHistoryInput[]).splice(
            0,
            draft.length,
            ...(result as SessionHistoryInput[])
          );
        }
        return undefined;
      });
      prepare(previous, next)();
    },
    updateEntry(id, updater) {
      const target = locate(id);
      if (!target) return false;
      const { map, inline, index } = target;
      const previous =
        readHistory?.()[index] ?? (map ? (map.toJSON() as SessionHistoryInput) : inline!);
      const next = immer.produce(previous, (draft) => {
        // Same normalization as `update`: a caller may rewrite the draft's
        // fields, return a replacement entry, or both.
        const result = updater(draft);
        if (result && result !== (draft as unknown)) {
          const replacement = draft as unknown as Record<string, unknown>;
          for (const key of Object.keys(replacement)) delete replacement[key];
          Object.assign(replacement, result);
        }
        return undefined;
      });
      if (next.id !== id) throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
      if (historyValuesEqual(previous, next)) return true;
      const prepared = prepareReplacement(previous, next);
      if (map) diffHistoryContainer(map, sessionHistorySchema, previous, prepared, undefined);
      else {
        list.delete(index, 1);
        list.insert(index, prepared as Parameters<LoroList['insert']>[1]);
      }
      doc.commit();
      return true;
    },
    updateTail(id, toolCallIds, updater) {
      // A pending foreign change must count against the index version, not ride in our commit.
      doc.commit();
      let targetRow = -1;
      for (let row = 0; row < list.length; row++) {
        if (storedScalar(storedField(list.get(row), 'id')) !== id) continue;
        if (targetRow >= 0) return false;
        targetRow = row;
      }
      if (targetRow < 0) return false;
      const map = list.get(targetRow);
      if (!isContainer(map) || map.kind() !== 'Map') return false;
      const target = map as LoroMap;
      const items = storedList(target.get('items'));
      if (!items || storedScalar(target.get('role')) !== 'assistant') return false;
      let start = Math.max(0, items.length - 1);
      while (start > 0 && isTextish(items.get(start)) && isTextish(items.get(start - 1))) start--;

      let slots = currentToolIndex();
      const resolve = () =>
        toolCallIds.map((toolCallId) => {
          const slot = slots.get(toolCallId);
          if (!slot) return { toolCallId };
          const stored = slot.inline ? undefined : toolAt(slot, toolCallId);
          return { toolCallId, slot, stored };
        });
      let tools = resolve();
      if (tools.some(({ slot, stored }) => slot && !slot.inline && !stored)) {
        toolIndex = undefined;
        slots = currentToolIndex();
        tools = resolve();
      }
      if (tools.some(({ slot, stored }) => slot && !stored)) return false;
      const segments = tools.flatMap(({ toolCallId, slot, stored }) =>
        slot && stored && (slot.row !== targetRow || slot.item < start)
          ? [{ toolCallId, slot, items: stored.items, value: stored.value }]
          : []
      );

      const fields: Record<string, unknown> = {};
      for (const key of target.keys())
        if (key !== 'items' && key !== 'fileDiff') fields[key] = storedJson(target.get(key));
      const tail = Array.from({ length: items.length - start }, (_, i) =>
        storedJson(items.get(start + i))
      );
      // A duplicate copy in the tail would win the planner's lookup over the indexed owner.
      if (
        segments.some(({ toolCallId }) =>
          tail.some((item) => storedField(item, 'toolCallId') === toolCallId)
        )
      )
        return false;
      const previous = [
        ...segments.map(
          ({ toolCallId, value }) =>
            // Never the target id: the planner selects its active turn by id.
            ({ id: `\u0000tool:${toolCallId}`, role: 'assistant', items: [value] }) as unknown
        ),
        { ...fields, items: tail },
      ] as SessionHistoryInput[];
      const next = immer.produce(previous, (draft) => {
        const result = updater(draft);
        if (result && result !== (draft as unknown)) draft.splice(0, draft.length, ...result);
        return undefined;
      });
      if (next.length !== previous.length)
        throw new HistoryWriteError([{ path: ['history'], code: 'unsupported_reorder' }]);
      // Window rows carry only what this write may change; preflight all of it first.
      const prepared = next.map((row, i) => {
        const old = previous[i]!;
        if (row === old) return undefined;
        if (row.id !== old.id)
          throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
        const { items: _oldItems, ...oldFields } = old;
        const { items: _items, ...rowFields } = row;
        if (
          (i < segments.length || 'fileDiff' in rowFields) &&
          !historyValuesEqual(oldFields, rowFields)
        )
          throw new HistoryWriteError([{ path: ['history', i], code: 'invalid_input' }]);
        return historyValuesEqual(old, row) ? undefined : prepareReplacement(old, row);
      });
      if (prepared.every((value) => value === undefined)) return true;

      const itemsSchema = getMapFieldSchema(sessionHistorySchema, 'items');
      const infer = applySchemaToInfer(sessionHistorySchema, undefined);
      const targetPrepared = prepared[segments.length];
      if (targetPrepared) {
        const { items: _items, ...oldFields } = previous[segments.length]!;
        const { items: nextTail, ...nextFields } = targetPrepared;
        // A partial map diff visits only these fields; the range diff only the tail.
        diffHistoryContainer(target, sessionHistorySchema, oldFields, nextFields, undefined);
        diffHistoryListRange(items, itemsSchema, start, tail, nextTail as unknown[], infer);
      }
      // Segments sit below the tail; write later positions first so earlier ones hold.
      let reindex = false;
      segments
        .map((segment, i) => ({
          ...segment,
          old: previous[i]!.items as unknown[],
          value: prepared[i]?.items as unknown[] | undefined,
        }))
        .sort((a, b) => b.slot.row - a.slot.row || b.slot.item - a.slot.item)
        .forEach(({ slot, items: owner, old, value }) => {
          if (!value) return;
          if (value.length !== 1) reindex = true;
          diffHistoryListRange(owner, itemsSchema, slot.item, old, value, infer);
        });
      doc.commit();

      // Positions below the tail are unchanged unless a segment changed length.
      if (reindex || !toolIndex) {
        toolIndex = undefined;
        return true;
      }
      for (const [toolCallId, slot] of slots)
        if (slot.row === targetRow && slot.item >= start) slots.delete(toolCallId);
      ((targetPrepared?.items as unknown[] | undefined) ?? tail).forEach((value, i) => {
        if (storedScalar(storedField(value, 'type')) === 'tool_call')
          indexTool(slots, storedField(value, 'toolCallId'), { row: targetRow, item: start + i });
      });
      toolIndex.version = doc.version();
      return true;
    },
    updateCopies(id, updater) {
      const targets: NonNullable<ReturnType<typeof rowWithId>>[] = [];
      for (let index = 0; index < list.length; index++) {
        const found = rowWithId(index, id);
        if (found) targets.push(found);
      }
      if (targets.length === 0) return false;
      const projected = readHistory?.();
      const previous = targets.map(({ map, inline, index }) => {
        const read = projected?.[index];
        if (record(read) && read.id === id) return read as SessionHistoryInput;
        return map ? (map.toJSON() as SessionHistoryInput) : inline!;
      });
      const next = immer.produce(previous, (draft) => {
        updater(draft);
      });
      if (next.length !== previous.length)
        throw new HistoryWriteError([{ path: ['history'], code: 'unsupported_reorder' }]);
      const prepared = next.map((entry, i) => {
        if (entry.id !== id) throw new HistoryWriteError([{ path: ['id'], code: 'immutable_id' }]);
        return historyValuesEqual(previous[i], entry)
          ? undefined
          : prepareReplacement(previous[i]!, entry);
      });
      if (prepared.every((value) => value === undefined)) return true;
      targets.forEach(({ map, index }, i) => {
        const value = prepared[i];
        if (value === undefined) return;
        if (map) diffHistoryContainer(map, sessionHistorySchema, previous[i], value, undefined);
        else {
          list.delete(index, 1);
          list.insert(index, value as Parameters<LoroList['insert']>[1]);
        }
      });
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
      if (!map)
        return writer.updateEntry(id, (entry) => {
          const next = { ...entry };
          if (value === undefined) delete next[key];
          else Object.assign(next, { [key]: value });
          return next;
        });
      const stored = map.get(key);
      const previous = isContainer(stored) ? stored.toJSON() : stored;
      if (historyValuesEqual(previous, value)) return true;
      const parsed = cleanNew(field, value, previous);
      doc.commit();
      const indexed = toolIndex?.version.compare(doc.version()) === 0;
      // A partial map diff only visits this key; it neither reads nor authors items.
      diffHistoryContainer(
        map,
        sessionHistorySchema,
        { [key]: previous },
        { [key]: parsed },
        undefined
      );
      doc.commit();
      // A field write cannot add a tool call, so it keeps the index complete.
      if (indexed && toolIndex) toolIndex.version = doc.version();
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
          let applied = false;
          const updated = writer.updateEntry(id, (turn) => {
            applied = applyRespondPermission(
              turn as unknown as Record<string, unknown>,
              requestId,
              outcome
            );
            return turn;
          });
          return updated && applied;
        }
      }
      return false;
    },
  };
  return { ...writer, prepare };
}
