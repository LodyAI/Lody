import {
  LoroList,
  LoroMap,
  LoroMovableList,
  LoroText,
  type Container,
  type LoroDoc,
} from 'loro-crdt';
import { sessionDocSchema, type SessionHistoryInput } from '@lody/shared';

/**
 * Writes history entries straight into the Loro doc with the exact container
 * shapes a full-schema `Mirror.setState` would have produced, so peers that
 * still read through the full `sessionDocSchema` (the CLI, older clients) see
 * byte-for-byte the same structure.
 *
 * The rules are loro-mirror's `initializeContainer` rules, restated:
 * - `undefined` and `$cid` keys are skipped;
 * - a declared container field (`loro-map` / `loro-list` / `loro-text`) becomes
 *   that container when the value has the matching shape, otherwise a plain
 *   value;
 * - an `any` field infers: plain object → Map, array → List (MovableList when
 *   `defaultMovableList`), string → Text only when that `any` sets
 *   `defaultLoroText`; the `any`'s options are inherited by everything nested
 *   under it;
 * - a map without a schema (created by inference) keeps inferring with the
 *   inherited options; a schema'd map's undeclared keys use its catchall, or a
 *   plain value when there is none;
 * - primitives go through the field's `transform.encode` when one exists.
 */

type InferOptions = { defaultLoroText?: boolean; defaultMovableList?: boolean };

type SchemaLike = {
  type: string;
  definition?: Record<string, SchemaLike>;
  catchallType?: SchemaLike;
  itemSchema?: SchemaLike;
  options?: {
    defaultLoroText?: boolean;
    defaultMovableList?: boolean;
    transform?: { encode?: (value: unknown) => unknown };
  };
  getContainerType?: () => string | null;
};

type ContainerKind = 'Map' | 'List' | 'MovableList' | 'Text';

const HISTORY_LIST_SCHEMA = (
  sessionDocSchema as unknown as { definition: Record<string, SchemaLike> }
).definition.history!;
const HISTORY_ENTRY_SCHEMA = HISTORY_LIST_SCHEMA.itemSchema!;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof RegExp);

const inferKind = (value: unknown, infer: InferOptions | undefined): ContainerKind | undefined => {
  if (isPlainObject(value)) return 'Map';
  if (Array.isArray(value)) return infer?.defaultMovableList ? 'MovableList' : 'List';
  if (typeof value === 'string') return infer?.defaultLoroText ? 'Text' : undefined;
  return undefined;
};

const schemaKind = (schema: SchemaLike): ContainerKind | undefined => {
  switch (schema.type) {
    case 'loro-map':
      return 'Map';
    case 'loro-list':
      return 'List';
    case 'loro-movable-list':
      return 'MovableList';
    case 'loro-text':
      return 'Text';
    default:
      return undefined;
  }
};

const matchesKind = (kind: ContainerKind, value: unknown): boolean =>
  kind === 'Map'
    ? isPlainObject(value)
    : kind === 'Text'
      ? typeof value === 'string'
      : Array.isArray(value);

const inferFromAny = (schema: SchemaLike, base: InferOptions | undefined): InferOptions => ({
  ...base,
  defaultLoroText: schema.options?.defaultLoroText ?? false,
  ...(schema.options?.defaultMovableList !== undefined
    ? { defaultMovableList: schema.options.defaultMovableList }
    : {}),
});

const encode = (schema: SchemaLike | undefined, value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  const transform = schema?.options?.transform;
  return transform?.encode ? transform.encode(value) : value;
};

const newContainer = (kind: ContainerKind): Container => {
  switch (kind) {
    case 'Map':
      return new LoroMap();
    case 'List':
      return new LoroList();
    case 'MovableList':
      return new LoroMovableList();
    case 'Text':
      return new LoroText();
  }
};

/** Decide how one value is stored under `schema` (or inferred under `infer`). */
const resolveWrite = (
  schema: SchemaLike | undefined,
  value: unknown,
  infer: InferOptions | undefined
):
  | { mode: 'plain'; value: unknown }
  | {
      mode: 'container';
      kind: ContainerKind;
      schema: SchemaLike | undefined;
      infer: InferOptions | undefined;
    } => {
  if (schema?.type === 'any') {
    const childInfer = inferFromAny(schema, infer);
    const kind = inferKind(value, childInfer);
    return kind
      ? { mode: 'container', kind, schema: undefined, infer: childInfer }
      : { mode: 'plain', value };
  }
  if (schema) {
    const kind = schemaKind(schema);
    if (kind && matchesKind(kind, value)) {
      return { mode: 'container', kind, schema, infer: undefined };
    }
    return { mode: 'plain', value: encode(schema, value) };
  }
  const kind = inferKind(value, infer);
  return kind ? { mode: 'container', kind, schema: undefined, infer } : { mode: 'plain', value };
};

const fillContainer = (
  container: Container,
  schema: SchemaLike | undefined,
  value: unknown,
  infer: InferOptions | undefined
): void => {
  switch (container.kind()) {
    case 'Map':
      writeMapEntries(container as LoroMap, value, schema, infer);
      return;
    case 'List':
    case 'MovableList':
      writeListItems(container as LoroList | LoroMovableList, value, schema, infer);
      return;
    case 'Text':
      if (typeof value === 'string' && value.length > 0) {
        (container as LoroText).insert(0, value);
      }
      return;
    default:
      return;
  }
};

const setMapField = (
  map: LoroMap,
  key: string,
  value: unknown,
  fieldSchema: SchemaLike | undefined,
  infer: InferOptions | undefined
): void => {
  const decision = resolveWrite(fieldSchema, value, infer);
  if (decision.mode === 'plain') {
    map.set(key, decision.value as never);
    return;
  }
  const child = map.setContainer(key, newContainer(decision.kind) as never) as Container;
  fillContainer(child, decision.schema, value, decision.infer);
};

const writeMapEntries = (
  map: LoroMap,
  value: unknown,
  mapSchema: SchemaLike | undefined,
  infer: InferOptions | undefined
): void => {
  if (!isPlainObject(value)) return;
  const schema = mapSchema?.type === 'loro-map' ? mapSchema : undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (key === '$cid' || entry === undefined) continue;
    if (schema) {
      const fieldSchema = schema.definition?.[key] ?? schema.catchallType;
      // A schema'd map with neither a declared field nor a catchall stores the
      // value as-is, without inference (loro-mirror `initializeContainer`).
      if (!fieldSchema) {
        map.set(key, entry as never);
        continue;
      }
      setMapField(map, key, entry, fieldSchema, undefined);
      continue;
    }
    setMapField(map, key, entry, undefined, infer);
  }
};

const writeListItems = (
  list: LoroList | LoroMovableList,
  value: unknown,
  listSchema: SchemaLike | undefined,
  infer: InferOptions | undefined
): void => {
  if (!Array.isArray(value)) return;
  const itemSchema =
    listSchema && (listSchema.type === 'loro-list' || listSchema.type === 'loro-movable-list')
      ? listSchema.itemSchema
      : undefined;
  for (const item of value) {
    const decision = resolveWrite(itemSchema, item, infer);
    if (decision.mode === 'plain') {
      list.push(decision.value as never);
      continue;
    }
    const child = list.pushContainer(newContainer(decision.kind) as never) as Container;
    fillContainer(child, decision.schema, item, decision.infer);
  }
};

const historyList = (doc: LoroDoc): LoroList => doc.getList('history');

/** A map field's value, resolving a nested container (e.g. an inferred `LoroText`) to its JSON. */
const fieldValue = (map: LoroMap, key: string): unknown => {
  const value = map.get(key);
  return value && typeof value === 'object' && 'kind' in (value as object)
    ? (value as Container).toJSON()
    : value;
};

const turnMapAt = (doc: LoroDoc, index: number): LoroMap | null => {
  const cid = (historyList(doc).getShallowValue() as unknown[])[index];
  if (typeof cid !== 'string' || !cid.startsWith('cid:')) return null;
  const container = doc.getContainerById(cid as never);
  return container && container.kind() === 'Map' ? (container as LoroMap) : null;
};

/** Position of the entry whose `id` is `entryId`, scanning shallow values. */
export function findHistoryIndex(doc: LoroDoc, entryId: string): number {
  const cids = historyList(doc).getShallowValue() as unknown[];
  for (let i = 0; i < cids.length; i += 1) {
    const cid = cids[i];
    if (typeof cid !== 'string' || !cid.startsWith('cid:')) continue;
    const map = doc.getContainerById(cid as never);
    if (!map || map.kind() !== 'Map') continue;
    if (fieldValue(map as LoroMap, 'id') === entryId) return i;
  }
  return -1;
}

export function appendHistoryEntry(doc: LoroDoc, entry: SessionHistoryInput): void {
  const map = historyList(doc).pushContainer(new LoroMap()) as LoroMap;
  writeMapEntries(map, entry, HISTORY_ENTRY_SCHEMA, undefined);
  doc.commit();
}

/**
 * Replace the entry with `entryId` in place: fields the new entry carries are
 * rewritten (a nested container is dropped and recreated), fields it omits are
 * deleted. The turn map keeps its container id, so readers keyed by turn keep
 * their identity.
 */
export function replaceHistoryEntry(
  doc: LoroDoc,
  entryId: string,
  entry: SessionHistoryInput,
  indexHint?: number
): boolean {
  const map = resolveTurnMap(doc, entryId, indexHint);
  if (!map) return false;
  const next = entry as unknown as Record<string, unknown>;
  for (const key of map.keys()) {
    if (next[key] === undefined) map.delete(key);
  }
  writeEntryFields(map, next);
  doc.commit();
  return true;
}

/**
 * Set only the fields in `patch` on the entry with `entryId`; an explicit
 * `undefined` deletes that field, and untouched fields keep their containers.
 * The scalar-field counterpart of `replaceHistoryEntry`, for status flips
 * that must not rewrite a turn's items.
 */
export function patchHistoryEntry(
  doc: LoroDoc,
  entryId: string,
  patch: Partial<SessionHistoryInput>,
  indexHint?: number
): boolean {
  const map = resolveTurnMap(doc, entryId, indexHint);
  if (!map) return false;
  const next = patch as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(next)) {
    if (key !== '$cid' && value === undefined) map.delete(key);
  }
  writeEntryFields(map, next);
  doc.commit();
  return true;
}

/** The entry's map: the hinted position when it still holds `entryId`, else a scan. */
const resolveTurnMap = (doc: LoroDoc, entryId: string, indexHint?: number): LoroMap | null => {
  if (indexHint !== undefined && indexHint >= 0) {
    const hinted = turnMapAt(doc, indexHint);
    if (hinted !== null && fieldValue(hinted, 'id') === entryId) return hinted;
  }
  const index = findHistoryIndex(doc, entryId);
  return index < 0 ? null : turnMapAt(doc, index);
};

const writeEntryFields = (map: LoroMap, fields: Record<string, unknown>): void => {
  for (const [key, value] of Object.entries(fields)) {
    if (key === '$cid' || value === undefined) continue;
    const fieldSchema = HISTORY_ENTRY_SCHEMA.definition?.[key] ?? HISTORY_ENTRY_SCHEMA.catchallType;
    if (!fieldSchema) {
      map.set(key, value as never);
      continue;
    }
    setMapField(map, key, value, fieldSchema, undefined);
  }
};

/**
 * Record a permission outcome on the item carrying `requestId`. Mirrors the
 * previous `setState` path, which set `permissionRequest.outcome` on the item.
 */
export function respondHistoryPermission(
  doc: LoroDoc,
  requestId: string,
  outcome: unknown,
  indexHint?: number
): boolean {
  const cids = historyList(doc).getShallowValue() as unknown[];
  const order =
    indexHint !== undefined && indexHint >= 0 && indexHint < cids.length
      ? [indexHint, ...cids.map((_, i) => i).filter((i) => i !== indexHint)]
      : cids.map((_, i) => i);
  for (const turnIndex of order) {
    const map = turnMapAt(doc, turnIndex);
    if (!map) continue;
    const items = map.get('items');
    if (!(items instanceof LoroList)) continue;
    for (let i = 0; i < items.length; i += 1) {
      const item = items.get(i);
      if (!(item instanceof LoroMap)) continue;
      const request = item.get('permissionRequest');
      if (!(request instanceof LoroMap) || fieldValue(request, 'requestId') !== requestId) continue;
      // The item map is inferred under the catchall `any` with defaultLoroText,
      // so its nested writes keep inferring with that option.
      setMapField(request, 'outcome', outcome, undefined, { defaultLoroText: true });
      doc.commit();
      return true;
    }
  }
  return false;
}
