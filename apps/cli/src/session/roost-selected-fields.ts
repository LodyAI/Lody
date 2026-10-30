import type { FieldSelector, Path, RoostNodeStream, ContentOp } from '@loro-dev/roost-node';
import {
  applicationJsonText,
  toApplicationJson,
  type NodeLodyHistory,
} from '@loro-dev/roost/lody-history';
import { decodeJson } from '@loro-dev/roost';
import {
  projectRoostSegments,
  type SessionEntry,
  type RoostHistorySegment,
} from '@lody/shared/session-data';
import { SESSION_DIRECTORY_INPUT_CONFIG_KEYS } from '@lody/shared/session-data';
import { stageRoostContent } from './roost-content-patches';

/** A tuple projects every array element, preserving positions and empty items. */
const textPresence = Symbol('text-presence');
type Shape = true | typeof textPresence | { readonly [key: string]: Shape } | readonly [Shape];
type Source = { path: Path; jsonPath?: Path };
type Member = {
  businessId: string;
  segmentId: string;
  turnId: Uint8Array;
  physicalSegmentId?: string;
};
const key = (value: string) => ({ key: value });
const stale = () => Object.assign(new Error('Roost selected fields changed'), { code: 'stale' });
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const child = (source: Source, part: Path[number]): Source =>
  source.jsonPath
    ? { ...source, jsonPath: [...source.jsonPath, part] }
    : { path: [...source.path, part] };
const define = (value: Record<string, unknown>, name: string, item: unknown) =>
  Object.defineProperty(value, name, {
    value: item,
    enumerable: true,
    configurable: true,
    writable: true,
  });

/** Breadth-first selection keeps requests bounded and never exports an ancestor
 * value to discover its children. Native selects inside serialized state values. */
async function selectedValue(
  host: RoostNodeStream,
  id: Uint8Array,
  source: Source,
  shape: Shape
): Promise<unknown> {
  type Task = { source: Source; shape: Shape; assign(value: unknown): void };
  let result: unknown, seq: bigint | undefined;
  let tasks: Task[] = [
    {
      source,
      shape,
      assign: (value) => {
        result = value;
      },
    },
  ];
  while (tasks.length) {
    const next: Task[] = [];
    for (let offset = 0; offset < tasks.length; offset += 1024) {
      const batch = tasks.slice(offset, offset + 1024);
      const read = await host.readFields(
        id,
        batch.map((task): FieldSelector => ({
          ...task.source,
          ...(task.shape === true ? {} : { info: true }),
        }))
      );
      if (seq !== undefined && seq !== read.nextSeq) throw stale();
      seq = read.nextSeq;
      for (const [index, field] of read.fields.entries()) {
        if (field.state === 'missing') continue;
        const task = batch[index]!;
        const value = toApplicationJson(decodeJson(new TextEncoder().encode(field.contentJson)));
        if (task.shape === true) {
          task.assign(value);
          continue;
        }
        if (!plain(value)) throw new Error('Invalid Roost field description');
        if (task.shape === textPresence && value.kind === 'string') {
          if (typeof value.nonBlank !== 'boolean') throw new Error('Missing Roost text presence');
          task.assign(value.nonBlank ? 'x' : '');
          continue;
        }
        if (Array.isArray(task.shape) && value.kind === 'array') {
          if (!Number.isSafeInteger(value.length) || (value.length as number) < 0)
            throw new Error('Invalid Roost selected array length');
          const array = new Array<unknown>(value.length as number);
          task.assign(array);
          for (let position = 0; position < array.length; position++)
            next.push({
              source: child(task.source, { index: BigInt(position) }),
              shape: task.shape[0]!,
              assign: (item) => {
                array[position] = item;
              },
            });
        } else if (
          task.shape !== textPresence &&
          !Array.isArray(task.shape) &&
          value.kind === 'object'
        ) {
          const object: Record<string, unknown> = {};
          task.assign(object);
          for (const [name, selection] of Object.entries(task.shape))
            next.push({
              source: child(task.source, key(name)),
              shape: selection,
              assign: (item) => {
                define(object, name, item);
              },
            });
        } else {
          // Preserve null and malformed primitive values; callers retain their
          // existing validation and matching rules instead of inventing a row.
          next.push({ ...task, shape: true });
        }
      }
    }
    tasks = next;
  }
  return result;
}

const scalarNames = [
  'id',
  'role',
  'timestamp',
  'status',
  'read',
  'cancellationReason',
  'finished',
  'endedAt',
  'sendStatus',
  'userTurnId',
  'acpTurnId',
  'startedAt',
  'permissionWaitMs',
  'userId',
] as const;
export const roostInspectionShape: Shape = {
  ...Object.fromEntries(scalarNames.map((name) => [name, true as const])),
  inputConfig: Object.fromEntries(
    SESSION_DIRECTORY_INPUT_CONFIG_KEYS.map((name) => [name, true as const])
  ),
  scheduleRun: { scheduleId: true },
  plan: [{}],
  items: [
    {
      type: true,
      name: true,
      taskId: true,
      run: { sessionId: true, snapshot: { parentRunId: true } },
      toolCallId: true,
      permissionRequest: { requestId: true },
      threadId: true,
      objective: true,
      status: true,
      fileId: true,
      transport: true,
    },
  ],
  __lody_roost_clear_fields_v1: true,
};

export const roostTranscriptShape: Shape = {
  ...(roostInspectionShape as Record<string, Shape>),
  items: [{ text: textPresence, images: [{}], type: true }],
};
function fullTextShape(shape: Shape): Shape {
  if (shape === textPresence) return true;
  if (shape === true) return true;
  if (Array.isArray(shape)) return [fullTextShape(shape[0]!)];
  return Object.fromEntries(
    Object.entries(shape).map(([name, part]) => [name, fullTextShape(part)])
  );
}
function textPresenceOnly(value: unknown, shape: Shape): unknown {
  if (shape === textPresence) return typeof value === 'string' ? (value.trim() ? 'x' : '') : value;
  if (shape === true) return value;
  if (Array.isArray(shape))
    return Array.isArray(value) ? value.map((item) => textPresenceOnly(item, shape[0]!)) : value;
  if (!plain(value)) return value;
  const result: Record<string, unknown> = { ...value };
  for (const [name, part] of Object.entries(shape))
    if (name in result) result[name] = textPresenceOnly(result[name], part);
  return result;
}

function shapeAt(shape: Shape, path: Path): Shape | undefined {
  let current: Shape | undefined = shape;
  for (const part of path) {
    if (current === true) return true;
    if (current === textPresence) return undefined;
    if (!current) return undefined;
    current = Array.isArray(current)
      ? 'index' in part
        ? current[0]
        : undefined
      : 'key' in part
        ? (current as Record<string, Shape>)[part.key]
        : undefined;
  }
  return current;
}

async function selectedState(
  host: RoostNodeStream,
  id: Uint8Array,
  primaryId: string,
  baseline: unknown,
  shape: Shape
): Promise<unknown> {
  const stored = await selectedValue(
    host,
    id,
    { path: [key('content')] },
    {
      id: true,
      format: true,
      version: true,
      primaryTurnId: true,
      patches: [{ kind: true, path: true, index: true, delete: true }],
    }
  );
  if (!plain(stored)) throw new Error('Invalid Roost state');
  if (typeof stored.id === 'string')
    return selectedValue(host, id, { path: [key('content')] }, shape);
  if (
    stored.format !== 'lody-message-state' ||
    stored.version !== 1 ||
    stored.primaryTurnId !== primaryId ||
    !Array.isArray(stored.patches)
  )
    throw new Error('Invalid Roost state identity');
  let value = baseline;
  for (const [index, raw] of stored.patches.entries()) {
    if (!plain(raw) || typeof raw.kind !== 'string' || !Array.isArray(raw.path))
      throw new Error('Invalid Roost state patch');
    const path: Path = raw.path.map((part: unknown) => {
      if (plain(part) && typeof part.key === 'string' && Object.keys(part).length === 1)
        return { key: part.key };
      if (
        plain(part) &&
        typeof part.index === 'number' &&
        Number.isSafeInteger(part.index) &&
        part.index >= 0 &&
        Object.keys(part).length === 1
      )
        return { index: BigInt(part.index) };
      throw new Error('Invalid Roost state patch path');
    });
    const selection = shapeAt(shape, path);
    if (!selection) continue;
    const prefix = [key('content'), key('patches'), { index: BigInt(index) }];
    let op: ContentOp;
    if (raw.kind === 'set' || raw.kind === 'spliceArray') {
      const projected = await selectedValue(
        host,
        id,
        {
          path: [...prefix, key(raw.kind === 'set' ? 'contentJson' : 'valuesJson')],
          jsonPath: [],
        },
        raw.kind === 'set' ? selection : Array.isArray(selection) ? selection : [selection]
      );
      if (projected === undefined) throw new Error('Missing Roost state patch value');
      op =
        raw.kind === 'set'
          ? {
              kind: 'set',
              path: [key('content'), ...path],
              contentJson: applicationJsonText(projected),
            }
          : {
              kind: 'spliceArray',
              path: [key('content'), ...path],
              index: BigInt(raw.index as number),
              delete: BigInt(raw.delete as number),
              valuesJson: applicationJsonText(projected),
            };
    } else if (raw.kind === 'remove') op = { kind: 'remove', path: [key('content'), ...path] };
    else if (raw.kind === 'appendText' || raw.kind === 'spliceText') {
      const text = await selectedValue(host, id, { path: [...prefix, key('text')] }, true);
      if (typeof text !== 'string') throw new Error('Invalid Roost state text');
      op =
        raw.kind === 'appendText'
          ? { kind: 'appendText', path: [key('content'), ...path], text }
          : {
              kind: 'spliceText',
              path: [key('content'), ...path],
              index: BigInt(raw.index as number),
              delete: BigInt(raw.delete as number),
              text,
            };
    } else throw new Error('Invalid Roost state patch operation');
    const staged = stageRoostContent(value, [op]);
    if (staged === undefined) throw new Error('Invalid Roost projected state operation');
    value = staged;
  }
  return value;
}

async function validateIdentity(
  host: RoostNodeStream,
  id: Uint8Array,
  businessId: string,
  segmentId: string
): Promise<void> {
  const identity = await selectedValue(
    host,
    id,
    { path: [key('lodyHistory')] },
    { version: true, kind: true, businessId: true, segmentId: true }
  );
  if (
    !plain(identity) ||
    identity.version !== '1' ||
    identity.kind !== 'message' ||
    identity.businessId !== businessId ||
    identity.segmentId !== segmentId
  )
    throw new Error('Roost selected history identity is incomplete');
}

/** Logical fields use the same segment order and primary-state precedence as
 * complete reads. The owner fences all calls with generation and event cursor. */
export async function readRoostSelectedEntries(
  host: RoostNodeStream,
  history: NodeLodyHistory,
  members: readonly Member[],
  shape: Shape = roostInspectionShape
): Promise<SessionEntry[]> {
  const segments: RoostHistorySegment[] = [];
  const primaries = new Map<string, { member: Member; content: unknown }>();
  for (const member of members) {
    await validateIdentity(
      host,
      member.turnId,
      member.businessId,
      member.physicalSegmentId ?? member.segmentId
    );
    const content = await selectedValue(host, member.turnId, { path: [key('content')] }, shape);
    segments.push({ ...member, content, sealed: false });
    if (member.segmentId === 'primary') primaries.set(member.businessId, { member, content });
  }
  const entries = projectRoostSegments(segments) as SessionEntry[];
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!,
      primary = primaries.get(entry.id);
    if (!primary) continue;
    const primaryId = Buffer.from(primary.member.turnId).toString('hex');
    const state = await history.lookupMember({
      kind: 'message',
      businessId: entry.id,
      segmentId: `state:${primaryId}`,
    });
    if (!state) continue;
    await validateIdentity(host, state.turnId, entry.id, `state:${primaryId}`);
    const stateShape = shape === roostTranscriptShape ? fullTextShape(shape) : shape;
    const baseline =
      shape === roostTranscriptShape
        ? await selectedValue(host, primary.member.turnId, { path: [key('content')] }, stateShape)
        : primary.content;
    const projected = textPresenceOnly(
      await selectedState(host, state.turnId, primaryId, baseline, stateShape),
      shape
    );
    if (!plain(projected) || projected.id !== entry.id)
      throw new Error('Roost projected state identity mismatch');
    entries[index] = projected as SessionEntry;
  }
  return entries;
}
