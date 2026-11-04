import { Immer } from 'immer';
import {
  isContainer,
  type LoroDoc,
  type LoroList,
  type LoroMap,
  type VersionVector,
} from 'loro-crdt';
import type { SchemaType } from 'loro-mirror';
import type { SessionHistoryInput } from './schema';
import { sessionHistorySchema } from './schema';
import { HistoryWriteError } from './history-write-schema';
import {
  diffHistoryContainer,
  diffHistoryListRange,
  getMapFieldSchema,
} from './history-materializer';

export interface AgentHistoryTargets {
  readonly toolCallIds: readonly string[];
  readonly taskIds: readonly string[];
  readonly rootTail?: boolean;
  readonly rootTailIfTaskMissing?: readonly string[];
  readonly runs: readonly {
    readonly sessionId: string;
    readonly runId: string;
    readonly tail: boolean;
    readonly plan: boolean;
    readonly toolCallIds: readonly string[];
  }[];
}

const immer = new Immer({ autoFreeze: false, useStrictShallowCopy: true });
type Json = Record<string, unknown>;
const record = (value: unknown): value is Json =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const map = (value: unknown) =>
  isContainer(value) && value.kind() === 'Map' ? (value as LoroMap) : undefined;
const list = (value: unknown) =>
  isContainer(value) && value.kind() === 'List' ? (value as LoroList) : undefined;
const field = (value: unknown, key: string): unknown => {
  const stored = map(value);
  return stored ? stored.get(key) : record(value) ? value[key] : undefined;
};
const json = (value: unknown): unknown => (isContainer(value) ? value.toJSON() : value);
const scalar = (value: unknown): unknown =>
  isContainer(value) && value.kind() === 'Text' ? value.toJSON() : value;
const key = (sessionId: string, runId: string) => JSON.stringify([sessionId, runId]);
const fields = (value: LoroMap, excluded: string): Json => {
  const result: Json = {};
  for (const name of value.keys())
    if (name !== excluded && name !== 'fileDiff') result[name] = json(value.get(name));
  return result;
};
const invalid = () => {
  throw new HistoryWriteError([{ path: ['history'], code: 'unsupported_reorder' }]);
};
type Slot = { row: number; item: number };
type ChildIndex = { tools: Map<string, number>; plan?: number };
type Index = {
  version: VersionVector;
  rows: Map<string, number[]>;
  tools: Map<string, Slot>;
  tasks: Map<string, Slot>;
  runs: Map<string, Slot>;
  parents: Map<string, string | undefined>;
  children: Map<string, ChildIndex>;
};

/** The one writer's version-checked directory. Index metadata, never historical payloads. */
export function createAgentHistoryWindow(
  doc: LoroDoc,
  prepare: (previous: SessionHistoryInput, next: SessionHistoryInput) => Json,
  equal: (a: unknown, b: unknown) => boolean
) {
  const history = doc.getList('history');
  let index: Index | undefined;
  const indexItem = (directory: Index, value: unknown, slot: Slot) => {
    const type = scalar(field(value, 'type'));
    if (type !== 'tool_call' && type !== 'subagent_task') return;
    const id = scalar(field(value, type === 'tool_call' ? 'toolCallId' : 'taskId'));
    if (typeof id !== 'string') return;
    if (type === 'tool_call' || type === 'subagent_task') {
      const owners = type === 'tool_call' ? directory.tools : directory.tasks;
      const old = owners.get(id);
      // Legacy task/tool ownership: newest row, first matching item in that row.
      if (!old || old.row < slot.row || (old.row === slot.row && old.item >= slot.item))
        owners.set(id, slot);
    }
    if (type !== 'subagent_task') return;
    const run = field(value, 'run');
    const sessionId = scalar(field(run, 'sessionId'));
    if (typeof sessionId !== 'string') return;
    const runKey = key(sessionId, id);
    const old = directory.runs.get(runKey);
    // Normalized runs instead retain the first exact (root, run) match.
    if (!old || old.row > slot.row || (old.row === slot.row && old.item >= slot.item)) {
      directory.runs.set(runKey, slot);
      const parent = scalar(field(field(run, 'snapshot'), 'parentRunId'));
      directory.parents.set(
        runKey,
        typeof parent === 'string' ? key(sessionId, parent) : undefined
      );
    }
  };
  const current = () => {
    doc.commit();
    if (index?.version.compare(doc.version()) === 0) return index;
    const next: Index = {
      version: doc.version(),
      rows: new Map(),
      tools: new Map(),
      tasks: new Map(),
      runs: new Map(),
      parents: new Map(),
      children: new Map(),
    };
    for (let row = 0; row < history.length; row++) {
      const value = history.get(row);
      const id = scalar(field(value, 'id'));
      if (typeof id === 'string') next.rows.set(id, [...(next.rows.get(id) ?? []), row]);
      const items = field(value, 'items');
      const values = list(items)?.toArray() ?? (Array.isArray(items) ? items : []);
      values.forEach((item, position) => indexItem(next, item, { row, item: position }));
    }
    index = next;
    return next;
  };
  const childIndex = (directory: Index, items: LoroList) => {
    let found = directory.children.get(items.id);
    if (found) return found;
    found = { tools: new Map() };
    items.toArray().forEach((value, position) => {
      const type = scalar(field(value, 'type'));
      if (type === 'plan') found!.plan ??= position;
      const id = scalar(field(value, 'toolCallId'));
      if (type === 'tool_call' && typeof id === 'string' && !found!.tools.has(id))
        found!.tools.set(id, position);
    });
    directory.children.set(items.id, found);
    return found;
  };

  return {
    /** Field writes cannot change row/item identities; retain a complete directory. */
    preserveIndex(write: () => void) {
      doc.commit();
      const complete = index?.version.compare(doc.version()) === 0;
      write();
      if (complete && index) index.version = doc.version();
    },
    update(
      id: string,
      targets: AgentHistoryTargets,
      updater: (rows: SessionHistoryInput[]) => SessionHistoryInput[]
    ): boolean {
      const directory = current();
      const targetRows = directory.rows.get(id);
      if (targetRows?.length !== 1) return false;
      const targetRow = targetRows[0]!;
      const readRootTail =
        targets.rootTail !== false ||
        (targets.rootTailIfTaskMissing ?? []).some((task) => !directory.tasks.has(task));
      if (scalar(field(history.get(targetRow), 'role')) !== 'assistant') return false;
      const selected = new Map<number, Set<number>>([[targetRow, new Set()]]);
      const select = (slot: Slot | undefined) => {
        if (!slot) return;
        let positions = selected.get(slot.row);
        if (!positions) selected.set(slot.row, (positions = new Set()));
        positions.add(slot.item);
      };
      targets.toolCallIds.forEach((tool) => select(directory.tools.get(tool)));
      targets.taskIds.forEach((task) => select(directory.tasks.get(task)));
      const runTargets = new Map(targets.runs.map((run) => [key(run.sessionId, run.runId), run]));
      // Follow only established ancestry. The reducer remains responsible for rejecting cycles.
      const pending = [...runTargets.keys()];
      const visited = new Set<string>();
      while (pending.length) {
        const runKey = pending.pop()!;
        if (visited.has(runKey)) continue;
        visited.add(runKey);
        select(directory.runs.get(runKey));
        const parent = directory.parents.get(runKey);
        if (parent) pending.push(parent);
      }
      for (const row of selected.keys()) {
        const value = map(history.get(row));
        if (!value || !list(value.get('items'))) return false;
      }

      type Projection = { value: unknown; plan: (next: unknown) => () => void };
      // A sparse prefix contains exact lookups; the contiguous tail permits appends/compaction.
      // No unrelated item or child transcript is materialized, parsed or diffed.
      const window = (
        items: LoroList,
        positions: Set<number>,
        tailStart: number,
        schema: SchemaType | undefined,
        project: (value: unknown, position: number) => Projection
      ) => {
        const prefix = [...positions]
          .filter((position) => position < tailStart)
          .sort((a, b) => a - b);
        const offsets = [
          ...prefix,
          ...Array.from({ length: items.length - tailStart }, (_, i) => tailStart + i),
        ];
        const projections = offsets.map((position) => project(items.get(position), position));
        const before = projections.map((projection) => projection.value);
        return {
          before,
          plan(after: unknown[]) {
            if (after.length < prefix.length) invalid();
            // Selected identities and the non-text tail anchor must survive in place.
            for (let i = 0; i < before.length; i++) {
              const old = before[i];
              const type = field(old, 'type');
              if (i >= prefix.length && (type === 'text' || type === 'thought')) continue;
              if (
                field(after[i], 'type') !== type ||
                field(after[i], 'toolCallId') !== field(old, 'toolCallId') ||
                field(after[i], 'taskId') !== field(old, 'taskId')
              )
                invalid();
            }
            const writes = prefix.map((_, i) => projections[i]!.plan(after[i]));
            // The tail is either contiguous text/thought, or one non-text anchor plus appends.
            const anchor = before[prefix.length];
            const customTail = anchor !== undefined && field(anchor, 'type') === 'subagent_task';
            if (customTail) writes.push(projections[prefix.length]!.plan(after[prefix.length]));
            const skip = prefix.length + (customTail ? 1 : 0);
            return () => {
              writes.forEach((write) => write());
              diffHistoryListRange(
                items,
                schema,
                tailStart + (customTail ? 1 : 0),
                before.slice(skip),
                after.slice(skip),
                undefined
              );
            };
          },
          refresh(after: unknown[], accept: (value: unknown, position: number) => void) {
            after.forEach((value, i) =>
              accept(value, i < prefix.length ? prefix[i]! : tailStart + i - prefix.length)
            );
          },
        };
      };
      const simple = (
        items: LoroList,
        schema: SchemaType | undefined,
        value: unknown,
        position: number
      ): Projection => {
        const before = json(value);
        return {
          value: before,
          plan: (after) => () =>
            diffHistoryListRange(items, schema, position, [before], [after], undefined),
        };
      };
      const itemsSchema = getMapFieldSchema(sessionHistorySchema, 'items');
      const itemSchema =
        itemsSchema && 'itemSchema' in itemsSchema
          ? (itemsSchema.itemSchema as SchemaType)
          : undefined;
      const runSchema = getMapFieldSchema(itemSchema, 'run');
      const childSchema = getMapFieldSchema(runSchema, 'items');
      const childRefreshes: Array<() => void> = [];
      const project = (items: LoroList, value: unknown, position: number): Projection => {
        const task = map(value);
        const run = task && map(task.get('run'));
        const children = run && list(run.get('items'));
        if (!task || !run || !children || scalar(task.get('type')) !== 'subagent_task')
          return simple(items, itemsSchema, value, position);
        const request = runTargets.get(
          key(String(scalar(run.get('sessionId'))), String(scalar(task.get('taskId'))))
        );
        const slots =
          request && (request.plan || request.toolCallIds.length > 0)
            ? childIndex(directory, children)
            : undefined;
        const wanted = new Set<number>();
        for (const tool of request?.toolCallIds ?? []) {
          const slot = slots?.tools.get(tool);
          if (slot !== undefined) wanted.add(slot);
        }
        if (request?.plan && slots?.plan !== undefined) wanted.add(slots.plan);
        const nested = window(
          children,
          wanted,
          request?.tail ? Math.max(0, children.length - 1) : children.length,
          childSchema,
          (child, offset) => simple(children, childSchema, child, offset)
        );
        const before: Json & { run: Json & { items: unknown[] } } = {
          ...fields(task, 'run'),
          run: { ...fields(run, 'items'), items: nested.before },
        };
        return {
          value: before,
          plan(after) {
            if (
              !record(after) ||
              !record(after.run) ||
              !Array.isArray(after.run.items) ||
              after.run.sessionId !== before.run.sessionId
            )
              invalid();
            const next = after as Json & { run: Json & { items: unknown[] } };
            const { items: _oldItems, ...oldRun } = before.run;
            const { items: nextItems, ...nextRun } = next.run;
            const writeChildren = nested.plan(nextItems);
            childRefreshes.push(() => {
              if (!slots) return;
              nested.refresh(nextItems, (child, offset) => {
                if (field(child, 'type') === 'plan') slots.plan ??= offset;
                const tool = field(child, 'toolCallId');
                if (field(child, 'type') === 'tool_call' && typeof tool === 'string')
                  slots.tools.set(tool, Math.min(slots.tools.get(tool) ?? offset, offset));
              });
            });
            return () => {
              diffHistoryContainer(
                task,
                itemSchema,
                { ...before, run: oldRun },
                { ...next, run: nextRun },
                undefined
              );
              writeChildren();
            };
          },
        };
      };
      const rows = [...selected]
        .sort(([a], [b]) => a - b)
        .map(([row, positions]) => {
          const stored = map(history.get(row))!;
          const items = list(stored.get('items'))!;
          let start =
            row === targetRow && readRootTail ? Math.max(0, items.length - 1) : items.length;
          const textish = (offset: number) =>
            ['text', 'thought'].includes(String(scalar(field(items.get(offset), 'type'))));
          while (start > 0 && start < items.length && textish(start) && textish(start - 1)) start--;
          const view = window(items, positions, start, itemsSchema, (value, offset) =>
            project(items, value, offset)
          );
          return {
            row,
            stored,
            view,
            before: {
              ...fields(stored, 'items'),
              items: view.before,
            } as unknown as SessionHistoryInput,
          };
        });
      const before = rows.map((row) => row.before);
      const after = immer.produce(before, (draft) => {
        const result = updater(draft);
        if (result && result !== draft) draft.splice(0, draft.length, ...result);
      });
      if (after.length !== before.length) invalid();
      // Prepare every changed row, including nested payload validation, before any CRDT mutation.
      const prepared = after.map((row, i) => {
        const previous = before[i]!;
        if (
          row.id !== previous.id ||
          ('fileDiff' in row && !equal(row.fileDiff, previous.fileDiff))
        )
          invalid();
        return equal(row, previous) ? undefined : prepare(previous, row);
      });
      const writes = rows.map(({ stored, view, before: previous }, i) => {
        const next = prepared[i];
        if (!next) return () => {};
        if (!Array.isArray(next.items)) invalid();
        const writeItems = view.plan(next.items as unknown[]);
        const { items: _oldItems, ...oldFields } = previous;
        const { items: _newItems, ...nextFields } = next;
        return () => {
          diffHistoryContainer(stored, sessionHistorySchema, oldFields, nextFields, undefined);
          writeItems();
        };
      });
      writes.forEach((write) => write());
      doc.commit();
      rows.forEach(({ row, view }, i) =>
        view.refresh((prepared[i]?.items ?? before[i]!.items) as unknown[], (value, item) =>
          indexItem(directory, value, { row, item })
        )
      );
      childRefreshes.forEach((refresh) => refresh());
      directory.version = doc.version();
      return true;
    },
  };
}
