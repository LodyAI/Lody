import {
  isContainer,
  LoroList,
  LoroMap,
  LoroMovableList,
  LoroText,
  LoroTree,
  type Container,
  type ContainerType,
} from 'loro-crdt';
import type { InferContainerOptions, SchemaType } from 'loro-mirror';

/**
 * Writes plain values into Loro containers with exactly the container shape
 * loro-mirror's `Mirror.setState` produces for the same schema, so a turn
 * written here from the same accepted input matches a Mirror write's layout and
 * the old full-Mirror read path (and every other client) sees no difference.
 *
 * The rules are loro-mirror's `initializeContainer` / `diffMap` / `diffList`
 * rules restated over the schema objects `@lody/shared` exports:
 *
 * - A field with a container schema becomes that container when the value has
 *   the matching shape, otherwise a plain value.
 * - A field with an `Any` schema infers: plain object → `LoroMap`, array →
 *   `LoroList`, string → `LoroText` only when that `Any` set
 *   `defaultLoroText`. Schema-less descendants inherit the inference options
 *   of the `Any` they were created under.
 * - A field with a primitive schema (or an unknown key on a map with no
 *   catchall) is set as a plain value after the schema's `encode` transform.
 * - `$cid` and `undefined` values are never written.
 *
 * `packages/shared/tests/history-writer.test.ts` proves the equivalence
 * against a Mirror-written doc, op for op.
 */

export type MaterializeInfer = InferContainerOptions | undefined;

const CID_KEY = '$cid';

type AnySchemaLike = SchemaType & { type: 'any'; options: InferContainerOptions };
type MapSchemaLike = SchemaType & {
  type: 'loro-map';
  definition: Record<string, SchemaType>;
  catchallType?: SchemaType;
};
type ListSchemaLike = SchemaType & {
  type: 'loro-list' | 'loro-movable-list';
  itemSchema?: SchemaType;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Date) &&
  !(value instanceof RegExp) &&
  typeof value !== 'function';

export const isMapSchema = (schema: SchemaType | undefined): schema is MapSchemaLike =>
  schema?.type === 'loro-map';
export const isListSchema = (schema: SchemaType | undefined): schema is ListSchemaLike =>
  schema?.type === 'loro-list' || schema?.type === 'loro-movable-list';
const isAnySchema = (schema: SchemaType | undefined): schema is AnySchemaLike =>
  schema?.type === 'any';
export const isContainerSchema = (schema: SchemaType | undefined): boolean =>
  schema !== undefined &&
  (schema.type === 'loro-map' ||
    schema.type === 'loro-list' ||
    schema.type === 'loro-text' ||
    schema.type === 'loro-movable-list' ||
    schema.type === 'loro-tree');

/** `definition[key]`, else the map's catchall, else nothing. */
export function getMapFieldSchema(
  schema: SchemaType | undefined,
  key: string,
  value?: unknown
): SchemaType | undefined {
  if (!isMapSchema(schema)) return undefined;
  if (Object.prototype.hasOwnProperty.call(schema.definition, key)) {
    const field = schema.definition[key];
    // `schema.ts` marks genuinely streaming fields with an explicit `storageSchema`
    // insertion hint. It is a storage policy, never a validation constraint.
    const storage =
      field?.type === 'any'
        ? (field.options as InferContainerOptions & { storageSchema?: SchemaType }).storageSchema
        : undefined;
    const kind = storage?.getContainerType();
    return storage && kind && (value === undefined || matchesContainerType(kind, value))
      ? storage
      : field;
  }
  return schema.catchallType;
}

export const containerTypeOfSchema = (
  schema: SchemaType | undefined
): ContainerType | undefined => {
  const type = schema?.getContainerType();
  return type === null ? undefined : type;
};

/** An `Any` schema replaces the inherited inference options with its own. */
export function applySchemaToInfer(
  schema: SchemaType | undefined,
  base: MaterializeInfer
): MaterializeInfer {
  if (!isAnySchema(schema)) return base;
  const next: InferContainerOptions = { ...base };
  next.defaultLoroText = schema.options.defaultLoroText ?? false;
  if (schema.options.defaultMovableList !== undefined) {
    next.defaultMovableList = schema.options.defaultMovableList;
  }
  return next;
}

export function inferContainerType(
  value: unknown,
  infer: MaterializeInfer
): ContainerType | undefined {
  if (isRecord(value)) return 'Map';
  if (Array.isArray(value)) return infer?.defaultMovableList ? 'MovableList' : 'List';
  if (typeof value === 'string') return infer?.defaultLoroText ? 'Text' : undefined;
  return undefined;
}

export function matchesContainerType(type: ContainerType, value: unknown): boolean {
  switch (type) {
    case 'Map':
      return isRecord(value);
    case 'List':
    case 'MovableList':
    case 'Tree':
      return Array.isArray(value);
    case 'Text':
      return typeof value === 'string';
    default:
      return false;
  }
}

const hasTransform = (
  schema: SchemaType | undefined
): schema is SchemaType & { transform: { encode: (value: unknown) => unknown } } => {
  const transform = (schema as { transform?: unknown } | undefined)?.transform;
  return transform != null && typeof transform === 'object';
};

export const applyEncode = (schema: SchemaType | undefined, value: unknown): unknown => {
  if (value === null || value === undefined) return value;
  return hasTransform(schema) ? schema.transform.encode(value) : value;
};

export const schemaHasTransform = (schema: SchemaType | undefined): boolean => hasTransform(schema);

const createDetached = (type: ContainerType): Container => {
  switch (type) {
    case 'Map':
      return new LoroMap();
    case 'List':
      return new LoroList();
    case 'MovableList':
      return new LoroMovableList();
    case 'Text':
      return new LoroText();
    case 'Tree':
      return new LoroTree();
    default:
      throw new Error(`Unsupported container type: ${type}`);
  }
};

const containerTypeForInsert = (
  schema: SchemaType | undefined,
  value: unknown,
  infer: MaterializeInfer
): ContainerType => {
  const type = schema ? containerTypeOfSchema(schema) : inferContainerType(value, infer);
  if (!type) throw new Error('Cannot infer a container type for the value');
  return type;
};

/** Attach a new child container under `key` and fill it. */
export function insertContainerIntoMap(
  map: LoroMap,
  schema: SchemaType | undefined,
  key: string,
  value: unknown,
  infer: MaterializeInfer
): Container {
  const type = containerTypeForInsert(schema, value, infer);
  const attached = map.setContainer(key, createDetached(type) as never) as unknown as Container;
  populateContainer(attached, schema, value, schema ? undefined : infer);
  return attached;
}

/** Attach a new child container at `index` and fill it. */
export function insertContainerIntoList(
  list: LoroList | LoroMovableList,
  schema: SchemaType | undefined,
  index: number,
  value: unknown,
  infer: MaterializeInfer
): Container {
  const type = containerTypeForInsert(schema, value, infer);
  const attached = list.insertContainer(
    index,
    createDetached(type) as never
  ) as unknown as Container;
  populateContainer(attached, schema, value, schema ? undefined : infer);
  return attached;
}

/**
 * Fill a freshly attached container. `infer` is the inference the container
 * inherited when it has no schema; schema-backed containers start from the
 * global (empty) inference, exactly like `Mirror.initializeContainer`.
 */
export function populateContainer(
  container: Container,
  schema: SchemaType | undefined,
  value: unknown,
  infer: MaterializeInfer
): void {
  const kind = container.kind();
  if (kind === 'Map') {
    if (!isRecord(value)) return;
    populateMap(container as LoroMap, isMapSchema(schema) ? schema : undefined, value, infer);
  } else if (kind === 'List' || kind === 'MovableList') {
    if (!Array.isArray(value)) return;
    populateList(
      container as LoroList | LoroMovableList,
      isListSchema(schema) ? schema : undefined,
      value,
      infer
    );
  } else if (kind === 'Text') {
    if (typeof value === 'string') (container as LoroText).update(value);
  } else {
    throw new Error(`Unsupported container kind for history: ${kind}`);
  }
}

function populateMap(
  map: LoroMap,
  schema: MapSchemaLike | undefined,
  value: Record<string, unknown>,
  baseInfer: MaterializeInfer
): void {
  for (const [key, item] of Object.entries(value)) {
    if (key === CID_KEY || item === undefined) continue;
    writeMapEntry(map, schema, key, item, baseInfer);
  }
}

/** One map entry, following the schema-first, then inferred, then plain rule. */
export function writeMapEntry(
  map: LoroMap,
  schema: MapSchemaLike | undefined,
  key: string,
  item: unknown,
  baseInfer: MaterializeInfer
): void {
  if (schema) {
    const fieldSchema = getMapFieldSchema(schema, key, item);
    if (isAnySchema(fieldSchema)) {
      const infer = applySchemaToInfer(fieldSchema, baseInfer);
      if (inferContainerType(item, infer)) insertContainerIntoMap(map, undefined, key, item, infer);
      else map.set(key, item as never);
      return;
    }
    if (fieldSchema && isContainerSchema(fieldSchema)) {
      const type = containerTypeOfSchema(fieldSchema);
      if (type && matchesContainerType(type, item)) {
        insertContainerIntoMap(map, fieldSchema, key, item, undefined);
      } else {
        map.set(key, applyEncode(fieldSchema, item) as never);
      }
      return;
    }
    map.set(key, applyEncode(fieldSchema, item) as never);
    return;
  }
  if (inferContainerType(item, baseInfer)) {
    insertContainerIntoMap(map, undefined, key, item, baseInfer);
  } else {
    map.set(key, item as never);
  }
}

function populateList(
  list: LoroList | LoroMovableList,
  schema: ListSchemaLike | undefined,
  value: readonly unknown[],
  baseInfer: MaterializeInfer
): void {
  for (let i = 0; i < value.length; i += 1) {
    writeListItem(list, schema, i, value[i], baseInfer);
  }
}

/** One list item at `index`, following the same rule as map entries. */
export function writeListItem(
  list: LoroList | LoroMovableList,
  schema: ListSchemaLike | undefined,
  index: number,
  item: unknown,
  baseInfer: MaterializeInfer
): void {
  const itemSchema = schema?.itemSchema;
  if (isAnySchema(itemSchema)) {
    const infer = applySchemaToInfer(itemSchema, baseInfer) ?? baseInfer;
    if (inferContainerType(item, infer))
      insertContainerIntoList(list, undefined, index, item, infer);
    else list.insert(index, item as never);
    return;
  }
  if (itemSchema && isContainerSchema(itemSchema)) {
    const type = containerTypeOfSchema(itemSchema);
    if (type && matchesContainerType(type, item)) {
      insertContainerIntoList(list, itemSchema, index, item, undefined);
    } else {
      list.insert(index, applyEncode(itemSchema, item) as never);
    }
    return;
  }
  if (!itemSchema) {
    if (inferContainerType(item, baseInfer)) {
      insertContainerIntoList(list, undefined, index, item, baseInfer);
    } else {
      list.insert(index, item as never);
    }
    return;
  }
  list.insert(index, applyEncode(itemSchema, item) as never);
}

/**
 * A map entry whose value changed type or is new: loro-mirror's
 * `insertChildToMap` decides container-vs-plain by inference, and the apply
 * step then attaches the field's container schema when it has one.
 */
export function writeReplacedMapEntry(
  map: LoroMap,
  fieldSchema: SchemaType | undefined,
  key: string,
  value: unknown,
  childInfer: MaterializeInfer
): void {
  if (!inferContainerType(value, childInfer)) {
    map.set(key, value as never);
    return;
  }
  const containerSchema = fieldSchema && isContainerSchema(fieldSchema) ? fieldSchema : undefined;
  insertContainerIntoMap(
    map,
    containerSchema,
    key,
    value,
    containerSchema ? undefined : childInfer
  );
}

/** loro-mirror's `tryUpdateToContainer` for a list insert during a diff. */
export function writeDiffListInsert(
  list: LoroList | LoroMovableList,
  schema: ListSchemaLike | undefined,
  index: number,
  value: unknown,
  infer: MaterializeInfer
): void {
  const itemSchema = schema?.itemSchema;
  const effective = applySchemaToInfer(itemSchema, infer);
  const containerType = itemSchema
    ? (containerTypeOfSchema(itemSchema) ?? inferContainerType(value, effective))
    : inferContainerType(value, effective);
  if (!containerType || (itemSchema && hasTransform(itemSchema))) {
    list.insert(index, applyEncode(itemSchema, value) as never);
    return;
  }
  const containerSchema = itemSchema && isContainerSchema(itemSchema) ? itemSchema : undefined;
  insertContainerIntoList(
    list,
    containerSchema,
    index,
    value,
    containerSchema ? undefined : effective
  );
}

export { isContainer };

// Minimal field diff extracted from PR #376 (cc49d259).
export function diffHistoryContainer(
  container: Container,
  schema: SchemaType | undefined,
  oldValue: unknown,
  newValue: unknown,
  infer: MaterializeInfer
): void {
  const effective = applySchemaToInfer(schema, infer);
  const kind = container.kind();
  if (kind === 'Map') {
    if (!isRecord(oldValue) || !isRecord(newValue)) {
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
  if (kind === 'List' || kind === 'MovableList') {
    if (!Array.isArray(oldValue) || !Array.isArray(newValue)) {
      throw new Error('Failed to diff container(list). Old and new state must be arrays');
    }
    diffList(
      container as LoroList | LoroMovableList,
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
    const fieldSchema = getMapFieldSchema(schema, key, newItem);
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
    // Schema choices govern new fields; string edits preserve the existing
    // representation so legacy Text identities and primitive values survive.
    if (
      (!fieldSchema || fieldSchema.type === 'any' || fieldSchema.type === 'loro-text') &&
      !schemaHasTransform(fieldSchema) &&
      typeof oldItem === 'string' &&
      typeof newItem === 'string'
    ) {
      const stored = map.get(key);
      if (isContainer(stored) && stored.kind() === 'Text') {
        (stored as LoroText).update(newItem);
        continue;
      }
      if (typeof stored === 'string') {
        map.set(key, newItem);
        continue;
      }
    }
    if (
      containerType &&
      matchesContainerType(containerType, newItem) &&
      matchesContainerType(containerType, oldItem)
    ) {
      const child = map.get(key);
      if (
        !isContainer(child) ||
        !['Map', 'List', 'MovableList', 'Text'].includes(child.kind()) ||
        !matchesContainerType(child.kind(), newItem)
      ) {
        writeReplacedMapEntry(map, fieldSchema, key, newItem, childInfer);
      } else {
        diffHistoryContainer(child, fieldSchema, oldItem, newItem, infer);
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
  // Retained object references anchor existing containers even when an earlier
  // item was deleted. In particular, never rewrite an untouched opaque item.
  const positions = new Map<unknown, number>();
  oldValue.forEach((item, index) => {
    if (item !== null && typeof item === 'object') positions.set(item, index);
  });
  let oldStart = 0;
  let newStart = 0;
  const writeBlock = (oldEnd: number, newEnd: number) => {
    const oldLength = oldEnd - oldStart;
    const newLength = newEnd - newStart;
    const overlap = Math.min(oldLength, newLength);
    for (let j = 0; j < overlap; j++) {
      const before = oldValue[oldStart + j];
      const after = newValue[newStart + j];
      if (before === after) continue;
      const container = list.get(newStart + j);
      if (
        isContainer(container) &&
        matchesContainerType(container.kind(), before) &&
        matchesContainerType(container.kind(), after)
      ) {
        diffHistoryContainer(container, schema?.itemSchema, before, after, infer);
      } else {
        list.delete(newStart + j, 1);
        writeDiffListInsert(list, schema, newStart + j, after, infer);
      }
    }
    if (oldLength > overlap) list.delete(newStart + overlap, oldLength - overlap);
    for (let j = overlap; j < newLength; j++) {
      writeDiffListInsert(list, schema, newStart + j, newValue[newStart + j], infer);
    }
  };
  for (let index = 0; index < newValue.length; index++) {
    const oldIndex = positions.get(newValue[index]);
    if (oldIndex === undefined || oldIndex < oldStart) continue;
    writeBlock(oldIndex, index);
    oldStart = oldIndex + 1;
    newStart = index + 1;
  }
  writeBlock(oldValue.length, newValue.length);
}
