import {
  sessionHistorySchema,
  type PermissionOutcome,
  type SessionHistory,
  type MessageContent,
} from '@lody/shared';
import { validateSchema, type SchemaType } from 'loro-mirror';
import {
  isContainer,
  LoroMap,
  type Container,
  type LoroDoc,
  type LoroList,
  type LoroMovableList,
  type LoroText,
} from 'loro-crdt';
import { normalizeHydratedTurn } from './create-conversation-view-from-doc';
import { isPlainRecord } from './is-plain-record';
import {
  applyEncode,
  applySchemaToInfer,
  containerTypeOfSchema,
  getMapFieldSchema,
  inferContainerType,
  insertContainerIntoMap,
  isContainerSchema,
  isListSchema,
  isMapSchema,
  matchesContainerType,
  populateContainer,
  schemaHasTransform,
  writeDiffListInsert,
  writeReplacedMapEntry,
  type MaterializeInfer,
} from './history-materializer';
import type { ConversationView } from './types';

/**
 * The renderer's only way to write session history once the control-plane
 * Mirror stops materializing it. Every method is one `doc.commit()`, and the
 * containers it creates are byte-for-byte what `Mirror.setState` would have
 * created (see `history-materializer.ts` and `tests/history-writer.test.ts`).
 */
export interface HistoryWriter {
  /** Appends one turn at the tail. Throws when the entry fails the session schema. */
  append(entry: SessionHistory): void;
  /**
   * Replaces the turn with this id in place using a schema-driven minimal diff
   * (scalars are set, texts updated, lists diffed by index like loro-mirror).
   * Returns false when no turn has that id.
   */
  replace(turnId: string, entry: SessionHistory): boolean;
  /**
   * Writes `outcome` onto the tool call carrying `permissionRequest.requestId`.
   * `turnId` addresses the turn directly; without it the history is scanned
   * newest-to-oldest. Returns false when no such request exists.
   */
  respondPermission(
    requestId: string,
    outcome: PermissionOutcome,
    options?: { turnId?: string }
  ): boolean;
  /**
   * Synchronous read of one turn for read-modify-write flows (never for
   * rendering): the hydrated object when the view holds it, else a fresh read.
   */
  read(turnId: string): SessionHistory | undefined;
}

type ToolCallMessage = Extract<MessageContent, { type: 'tool_call' }>;

const CID_KEY = '$cid';

const assertValidEntry = (entry: unknown) => {
  const validation = validateSchema(sessionHistorySchema, entry, {
    ignoreUnknownProperties: true,
  });
  if (!validation.valid) {
    throw new Error(`History entry validation failed: ${validation.errors?.join(', ')}`);
  }
};

// ---- loro-mirror's diff, applied directly ------------------------------------------

function diffContainer(
  container: Container,
  schema: SchemaType | undefined,
  oldValue: unknown,
  newValue: unknown,
  infer: MaterializeInfer
): void {
  const effective = applySchemaToInfer(schema, infer);
  const kind = container.kind();
  if (kind === 'Map') {
    if (!isPlainRecord(oldValue) || !isPlainRecord(newValue)) {
      throw new Error('Failed to diff container(map). Old and new state must be objects');
    }
    diffMap(
      container as LoroMap,
      isMapSchema(schema) ? schema : undefined,
      oldValue,
      newValue,
      effective
    );
    return;
  }
  if (kind === 'List') {
    if (!Array.isArray(oldValue) || !Array.isArray(newValue)) {
      throw new Error('Failed to diff container(list). Old and new state must be arrays');
    }
    diffList(
      container as LoroList,
      isListSchema(schema) ? schema : undefined,
      oldValue,
      newValue,
      effective
    );
    return;
  }
  if (kind === 'Text') {
    if (typeof oldValue !== 'string' || typeof newValue !== 'string') {
      throw new Error('Failed to diff container(text). Old and new state must be strings');
    }
    if (oldValue !== newValue) (container as LoroText).update(newValue);
    return;
  }
  throw new Error(`Unsupported container kind in a history turn: ${kind}`);
}

function diffMap(
  map: LoroMap,
  schema: Parameters<typeof getMapFieldSchema>[0],
  oldValue: Record<string, unknown>,
  newValue: Record<string, unknown>,
  infer: MaterializeInfer
): void {
  for (const key of Object.keys(oldValue)) {
    if (key === CID_KEY) continue;
    if (getMapFieldSchema(schema, key)?.type === 'ignore') continue;
    if (!(key in newValue)) map.delete(key);
  }
  for (const key of Object.keys(newValue)) {
    if (key === CID_KEY) continue;
    const oldItem = oldValue[key];
    const newItem = newValue[key];
    const fieldSchema = getMapFieldSchema(schema, key);
    if (fieldSchema?.type === 'ignore') continue;
    if (newItem === undefined) {
      if (key in oldValue && oldItem !== undefined) map.delete(key);
      continue;
    }
    const childInfer = applySchemaToInfer(fieldSchema, infer);
    const schemaType = containerTypeOfSchema(fieldSchema);
    let containerType = schemaHasTransform(fieldSchema)
      ? undefined
      : (schemaType ?? inferContainerType(newItem, childInfer));
    if (schemaType && containerType && !matchesContainerType(containerType, newItem)) {
      containerType = inferContainerType(newItem, childInfer);
    }
    if (!(key in oldValue)) {
      if (containerType && matchesContainerType(containerType, newItem)) {
        const containerSchema =
          fieldSchema && isContainerSchema(fieldSchema) ? fieldSchema : undefined;
        insertContainerIntoMap(
          map,
          containerSchema,
          key,
          newItem,
          containerSchema ? undefined : childInfer
        );
      } else {
        map.set(key, applyEncode(fieldSchema, newItem) as never);
      }
      continue;
    }
    if (oldItem === newItem) continue;
    if (
      containerType &&
      matchesContainerType(containerType, newItem) &&
      matchesContainerType(containerType, oldItem)
    ) {
      const child = map.get(key);
      if (!isContainer(child)) {
        writeReplacedMapEntry(map, fieldSchema, key, newItem, childInfer);
      } else {
        diffContainer(child, fieldSchema, oldItem, newItem, infer);
      }
      continue;
    }
    writeReplacedMapEntry(map, fieldSchema, key, applyEncode(fieldSchema, newItem), childInfer);
  }
}

function diffList(
  list: LoroList | LoroMovableList,
  schema: Parameters<typeof writeDiffListInsert>[1],
  oldValue: readonly unknown[],
  newValue: readonly unknown[],
  infer: MaterializeInfer
): void {
  if (oldValue === newValue) return;
  const itemSchema = schema?.itemSchema;
  const oldLen = oldValue.length;
  const newLen = newValue.length;
  let start = 0;
  while (start < oldLen && start < newLen && oldValue[start] === newValue[start]) start += 1;
  let suffix = 0;
  while (
    suffix < oldLen - start &&
    suffix < newLen - start &&
    oldValue[oldLen - 1 - suffix] === newValue[newLen - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldBlock = oldLen - start - suffix;
  const newBlock = newLen - start - suffix;
  const overlap = Math.min(oldBlock, newBlock);
  for (let j = 0; j < overlap; j += 1) {
    const i = start + j;
    if (oldValue[i] === newValue[i]) continue;
    const onLoro = list.get(i);
    if (isContainer(onLoro)) {
      diffContainer(onLoro, itemSchema, oldValue[i], newValue[i], infer);
    } else {
      list.delete(i, 1);
      writeDiffListInsert(list, schema, i, newValue[i], infer);
    }
  }
  for (let k = 0; k < oldBlock - overlap; k += 1) list.delete(start + overlap, 1);
  for (let k = 0; k < newBlock - overlap; k += 1) {
    const index = start + overlap + k;
    writeDiffListInsert(list, schema, index, newValue[index], infer);
  }
}

// ---- writers ----------------------------------------------------------------------------

export function createHistoryWriter(doc: LoroDoc, view: ConversationView): HistoryWriter {
  const list = doc.getList('history');

  const locate = (turnId: string): { index: number; map: LoroMap } | undefined => {
    const index = view.indexOf(turnId);
    if (index < 0) return undefined;
    const value = list.get(index);
    if (!isContainer(value) || value.kind() !== 'Map') return undefined;
    return { index, map: value as LoroMap };
  };

  const readAt = (index: number, map: LoroMap): SessionHistory | undefined =>
    view.turn(index) ?? normalizeHydratedTurn(map.toJSON());

  const writer: HistoryWriter = {
    append: (entry) => {
      assertValidEntry(entry);
      const map = list.insertContainer(list.length, new LoroMap());
      populateContainer(map, sessionHistorySchema, entry, undefined);
      doc.commit();
    },
    replace: (turnId, entry) => {
      const hit = locate(turnId);
      if (!hit) return false;
      assertValidEntry(entry);
      const previous = readAt(hit.index, hit.map);
      if (!previous) return false;
      diffContainer(hit.map, sessionHistorySchema, previous, entry, undefined);
      doc.commit();
      return true;
    },
    respondPermission: (requestId, outcome, options) => {
      // With a turn id this is one lookup. Without one — a caller that does not
      // know which turn a request came from — it is a newest-to-oldest scan.
      const hinted = options?.turnId === undefined ? -1 : view.indexOf(options.turnId);
      const from = hinted >= 0 ? hinted : view.turnCount - 1;
      const to = hinted >= 0 ? hinted : 0;
      for (let index = from; index >= to; index -= 1) {
        const row = view.index(index);
        // An unresolved count is not evidence of an empty turn; only skip a
        // turn known to have no items.
        if (!row || row.role !== 'assistant' || row.itemCount === 0) continue;
        const value = list.get(index);
        if (!isContainer(value) || value.kind() !== 'Map') continue;
        const turn = readAt(index, value as LoroMap);
        if (!turn || !Array.isArray(turn.items)) continue;
        const itemIndex = turn.items.findIndex(
          (item) =>
            isPlainRecord(item) &&
            item.type === 'tool_call' &&
            (item as ToolCallMessage).permissionRequest?.requestId === requestId
        );
        if (itemIndex < 0) continue;
        const item = turn.items[itemIndex] as unknown as ToolCallMessage;
        const items = turn.items.slice();
        items[itemIndex] = {
          ...item,
          permissionRequest: { ...item.permissionRequest!, outcome },
        } as unknown as (typeof items)[number];
        return writer.replace(turn.id, { ...turn, items } as SessionHistory);
      }
      return false;
    },
    read: (turnId) => {
      const hit = locate(turnId);
      return hit ? readAt(hit.index, hit.map) : undefined;
    },
  };
  return writer;
}

/** Minimal Mirror surface the rollback writer needs. */
export type HistoryMirrorLike = {
  getState(): { history?: unknown };
  setState(updater: (draft: { history: SessionHistory[] }) => void): void;
};

/**
 * Rollback-mode writer over the fully materializing Mirror: the exact
 * `setState` mutations the renderer performed before `HistoryWriter` existed.
 */
export function createMirrorHistoryWriter(mirror: HistoryMirrorLike): HistoryWriter {
  const historyOf = (): SessionHistory[] => {
    const history = mirror.getState().history;
    return Array.isArray(history) ? (history as SessionHistory[]) : [];
  };
  const writer: HistoryWriter = {
    append: (entry) => {
      mirror.setState((draft) => {
        draft.history.push(entry);
      });
    },
    replace: (turnId, entry) => {
      let replaced = false;
      mirror.setState((draft) => {
        const index = draft.history.findIndex((item) => item.id === turnId);
        if (index < 0) return;
        draft.history[index] = entry;
        replaced = true;
      });
      return replaced;
    },
    respondPermission: (requestId, outcome, options) => {
      let responded = false;
      mirror.setState((draft) => {
        const ordered = options?.turnId
          ? draft.history.filter((entry) => entry.id === options.turnId)
          : draft.history;
        for (const entry of ordered) {
          const items = entry.items;
          if (!Array.isArray(items)) continue;
          for (const item of items) {
            const request = (
              item as { permissionRequest?: { requestId?: string; outcome?: unknown } }
            ).permissionRequest;
            if (request && request.requestId === requestId) {
              request.outcome = outcome;
              responded = true;
              return;
            }
          }
        }
      });
      return responded;
    },
    read: (turnId) => historyOf().find((entry) => entry.id === turnId),
  };
  return writer;
}
