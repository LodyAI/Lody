import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IndexEntry, IndexPut, RoostNodeStream } from '@loro-dev/roost-node';
import {
  pickDirectoryScalars,
  pickDirectoryInputConfig,
  historyQueryRow,
  type SessionEntry,
} from '@lody/shared/session-data';
import {
  dispatchEntry,
  isDispatchCandidate,
  sameDispatchEntry,
  selectDispatchHistory,
  type SessionDispatchEntry,
} from './session-dispatch-history';

const marker = { table: 'lody_dispatch_checkpoint_v1', key: new Uint8Array() };
const rowsTable = 'lody_dispatch_rows_v1';
const pendingTable = 'lody_dispatch_pending_v1';
const completedTable = 'lody_dispatch_completed_v1';
const positionsTable = 'lody_dispatch_positions_v1';
const toolOwnersTable = 'lody_history_tool_owners_v1';
const permissionOwnersTable = 'lody_history_permission_owners_v1';
const outputOwnersTable = 'lody_history_output_owners_v1';
const systemTurnsTable = 'lody_history_system_turns_v1';
const utf8 = new TextEncoder();
const encode = (value: unknown) => utf8.encode(JSON.stringify(value));
const decode = (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as unknown;
const stale = () =>
  Object.assign(new Error('Roost dispatch projection changed'), { code: 'stale' });
export class RoostDispatchIndexCorrupt extends Error {}
const entrySchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant', 'system']),
    status: z
      .enum([
        'prepared',
        'pending',
        'pending_apply',
        'delivery_unknown',
        'seen',
        'processing',
        'handled',
        'failed',
        'canceled',
      ])
      .optional(),
    read: z.boolean().optional(),
    userTurnId: z.string().optional(),
    endedAt: z.number().optional(),
    inputConfig: z
      .object({ _lodyDeliveryKind: z.literal('steer').optional() })
      .strict()
      .optional(),
  })
  .strict();
const inspectionSchema = z
  .object({
    scalars: entrySchema
      .omit({ inputConfig: true })
      .extend({
        timestamp: z.string(),
        cancellationReason: z.literal('user_stop').optional(),
        finished: z.boolean().optional(),
        sendStatus: z.literal('timeout').optional(),
        acpTurnId: z.string().optional(),
        startedAt: z.number().optional(),
        permissionWaitMs: z.number().optional(),
      })
      .strict(),
    userId: z.string().optional(),
    query: z.record(z.string(), z.unknown()),
    inputConfig: z.unknown().optional(),
    scheduleRun: z.unknown().optional(),
    goals: z.array(z.record(z.string(), z.unknown())),
    itemTypes: z.array(z.string()),
    itemCount: z.number().int().nonnegative().optional(),
    planCount: z.number().int().nonnegative().optional(),
    fileIds: z.array(z.string()),
    tools: z.array(z.object({ id: z.string(), requestId: z.string().optional() }).strict()),
  })
  .strict();
export type RoostHistoryInspection = z.infer<typeof inspectionSchema>;
export const inspectHistoryEntry = (
  entry: SessionEntry,
  transcriptVisibility = false
): RoostHistoryInspection => ({
  scalars: pickDirectoryScalars(entry)!,
  query: historyQueryRow(
    entry,
    {
      field: (value, key) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? Reflect.get(value, key)
          : undefined,
      keys: (value) =>
        value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : [],
      scalar: (value) => (typeof value === 'bigint' ? { integer: value.toString() } : value),
      length: (value) => (Array.isArray(value) ? value.length : 0),
      at: (value, index) => (value as unknown[])[index],
    },
    transcriptVisibility
  ) as Record<string, unknown>,
  ...(typeof entry.userId === 'string' ? { userId: entry.userId } : {}),
  inputConfig: pickDirectoryInputConfig(entry.inputConfig),
  ...(entry.scheduleRun !== undefined ? { scheduleRun: entry.scheduleRun } : {}),
  goals: (entry.items ?? [])
    .filter((item) => item.type === 'goal')
    .map((item) => structuredClone(item) as unknown as Record<string, unknown>),
  itemTypes: (entry.items ?? []).flatMap((item) =>
    typeof item.type === 'string' ? [item.type] : []
  ),
  ...(Array.isArray(entry.items) ? { itemCount: entry.items.length } : {}),
  ...(Array.isArray(entry.plan) ? { planCount: entry.plan.length } : {}),
  fileIds: (entry.items ?? []).flatMap((item) =>
    item.type === 'file' && typeof item.fileId === 'string' ? [item.fileId] : []
  ),
  tools: (entry.items ?? []).flatMap((item) => {
    if (item.type !== 'tool_call' || typeof item.toolCallId !== 'string') return [];
    return [
      {
        id: item.toolCallId,
        ...(typeof item.permissionRequest?.requestId === 'string'
          ? { requestId: item.permissionRequest.requestId }
          : {}),
      },
    ];
  }),
});
const rowSchema = z
  .object({
    position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entry: entrySchema,
    inspection: inspectionSchema.optional(),
    segments: z
      .array(
        z
          .object({
            turnId: z.string().regex(/^[0-9a-f]{32}$/),
            segmentId: z.string(),
            physicalSegmentId: z.string().optional(),
          })
          .strict()
      )
      .min(1),
  })
  .strict();
const headerSchema = z
  .object({
    version: z.literal(2),
    inspectionVersion: z.literal(1).optional(),
    token: z.string().uuid(),
    cursor: z.string().regex(/^(0|[1-9][0-9]*)$/),
    count: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();
export type RoostDispatchRow = z.infer<typeof rowSchema>;
type Header = z.infer<typeof headerSchema>;
export type RoostDispatchCheckpoint = { header: Header; bytes: Uint8Array };
export type RoostDispatchUpdate = {
  before?: SessionDispatchEntry;
  after: SessionDispatchEntry;
  inspection: RoostHistoryInspection;
  position?: number;
  segments?: RoostDispatchRow['segments'];
};
type Plan = {
  base: RoostDispatchCheckpoint;
  next: RoostDispatchCheckpoint;
  puts: IndexEntry[];
  changed: RoostDispatchRow[];
};
const rowKey = (id: string) => ({ table: rowsTable, key: utf8.encode(id) });
const positionKey = (position: number) => {
  const key = new Uint8Array(8);
  new DataView(key.buffer).setBigUint64(0, BigInt(position));
  return { table: positionsTable, key };
};
const pendingKey = (row: RoostDispatchRow) => {
  const key = new Uint8Array(8 + utf8.encode(row.entry.id).length);
  new DataView(key.buffer).setBigUint64(0, BigInt(row.position));
  key.set(utf8.encode(row.entry.id), 8);
  return { table: pendingTable, key };
};
const completionPrefix = (userTurnId: string) =>
  utf8.encode(`${Buffer.byteLength(userTurnId)}:${userTurnId}:`);
const completionKey = (row: RoostDispatchRow) => ({
  table: completedTable,
  key: Buffer.concat([completionPrefix(row.entry.userTurnId ?? ''), utf8.encode(row.entry.id)]),
});
const hasCompletion = (entry: SessionDispatchEntry) =>
  entry.role === 'assistant' && entry.userTurnId !== undefined && typeof entry.endedAt === 'number';
const matchesPrefix = (bytes: Uint8Array, prefix: Uint8Array) =>
  prefix.every((byte, index) => bytes[index] === byte);
const ownerKey = (id: string, row: RoostDispatchRow) =>
  Buffer.concat([completionPrefix(id), positionKey(row.position).key, utf8.encode(row.entry.id)]);
const inspectionRefs = (row: RoostDispatchRow): { table: string; key: Uint8Array }[] => [
  ...(row.inspection?.tools ?? []).flatMap((tool) => [
    { table: toolOwnersTable, key: ownerKey(tool.id, row) },
    ...(tool.requestId !== undefined && row.entry.role === 'assistant'
      ? [{ table: permissionOwnersTable, key: ownerKey(tool.requestId, row) }]
      : []),
  ]),
  ...(row.entry.role === 'assistant' && row.entry.userTurnId !== undefined
    ? [{ table: outputOwnersTable, key: ownerKey(row.entry.userTurnId, row) }]
    : []),
  ...(row.entry.role === 'system'
    ? [
        {
          table: systemTurnsTable,
          key: Buffer.concat([positionKey(row.position).key, utf8.encode(row.entry.id)]),
        },
      ]
    : []),
];

/** Rebuildable local indexes. An exact event cursor certifies complete membership;
 * rows contain only scalar evidence and physical references, never message bodies. */
export class RoostDispatchIndex {
  private cached: RoostDispatchCheckpoint | undefined;
  private readonly rows = new Map<string, RoostDispatchRow>();
  constructor(readonly host: RoostNodeStream) {}

  forget(): void {
    this.cached = undefined;
    this.rows.clear();
  }
  current(): RoostDispatchCheckpoint | undefined {
    return this.cached;
  }

  async checkpoint(cursor: bigint, count: number): Promise<RoostDispatchCheckpoint | undefined> {
    if (this.cached?.header.cursor === cursor.toString() && this.cached.header.count === count)
      return this.cached;
    const [bytes] = await this.host.readIndex([marker]);
    if (!bytes) {
      this.forget();
      return undefined;
    }
    let value: unknown;
    try {
      value = decode(bytes);
    } catch {
      this.forget();
      return undefined;
    }
    const parsed = headerSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.cursor !== cursor.toString() ||
      parsed.data.count !== count
    ) {
      this.forget();
      return undefined;
    }
    const checkpoint = { header: parsed.data, bytes };
    if (!this.cached || !Buffer.from(this.cached.bytes).equals(Buffer.from(bytes)))
      this.rows.clear();
    this.cached = checkpoint;
    return checkpoint;
  }

  private remember(row: RoostDispatchRow): RoostDispatchRow {
    this.rows.delete(row.entry.id);
    this.rows.set(row.entry.id, row);
    while (this.rows.size > 500) {
      const id = this.rows.keys().next().value;
      if (id === undefined) break;
      this.rows.delete(id);
    }
    return row;
  }

  async row(
    id: string,
    checkpoint: RoostDispatchCheckpoint
  ): Promise<RoostDispatchRow | undefined> {
    const cached = this.cached === checkpoint ? this.rows.get(id) : undefined;
    if (cached) return cached;
    const [bytes] = await this.host.readIndex([rowKey(id)]);
    if (!bytes) return undefined;
    const row = rowSchema.parse(decode(bytes));
    if (row.entry.id !== id || row.position >= checkpoint.header.count)
      throw new RoostDispatchIndexCorrupt('Roost dispatch row does not match its checkpoint');
    return this.remember(row);
  }

  async range(
    checkpoint: RoostDispatchCheckpoint,
    from: number,
    to: number
  ): Promise<RoostDispatchRow[]> {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < 0 ||
      to < from ||
      to > checkpoint.header.count ||
      to - from > 500
    )
      throw new RangeError('Roost indexed range must contain at most 500 logical rows');
    const [markerBytes, ...positions] = await this.host.readIndex([
      marker,
      ...Array.from({ length: to - from }, (_, offset) => positionKey(from + offset)),
    ]);
    if (!markerBytes || !Buffer.from(markerBytes).equals(Buffer.from(checkpoint.bytes)))
      throw stale();
    const ids = positions.map((bytes) => {
      if (!bytes) throw new RoostDispatchIndexCorrupt('Roost position mapping is missing');
      return z.string().parse(decode(bytes));
    });
    const [currentMarker, ...values] = await this.host.readIndex([marker, ...ids.map(rowKey)]);
    if (!currentMarker || !Buffer.from(currentMarker).equals(Buffer.from(checkpoint.bytes)))
      throw stale();
    return values.map((bytes, offset) => {
      if (!bytes) throw new RoostDispatchIndexCorrupt('Roost indexed range row is missing');
      const row = rowSchema.parse(decode(bytes));
      if (row.entry.id !== ids[offset] || row.position !== from + offset)
        throw new RoostDispatchIndexCorrupt('Roost indexed range identity or position changed');
      return this.remember(row);
    });
  }

  private puts(row: RoostDispatchRow, before?: RoostDispatchRow): IndexEntry[] {
    const puts: IndexEntry[] = [];
    if (before && isDispatchCandidate(before.entry))
      puts.push({ ...pendingKey(before), value: null });
    if (before && hasCompletion(before.entry)) puts.push({ ...completionKey(before), value: null });
    puts.push({ ...rowKey(row.entry.id), value: encode(row) });
    if (!before || before.position !== row.position) {
      if (before) puts.push({ ...positionKey(before.position), value: null });
      puts.push({ ...positionKey(row.position), value: encode(row.entry.id) });
    }
    if (isDispatchCandidate(row.entry))
      puts.push({ ...pendingKey(row), value: encode(row.entry.id) });
    if (hasCompletion(row.entry)) puts.push({ ...completionKey(row), value: encode(row) });
    if (before) for (const ref of inspectionRefs(before)) puts.push({ ...ref, value: null });
    for (const ref of inspectionRefs(row)) puts.push({ ...ref, value: encode(row.entry.id) });
    return [
      ...new Map(
        puts.map((put) => [`${put.table}:${Buffer.from(put.key).toString('hex')}`, put])
      ).values(),
    ];
  }

  async plan(
    base: RoostDispatchCheckpoint,
    through: bigint,
    count: number,
    updates: readonly RoostDispatchUpdate[]
  ): Promise<Plan> {
    const changed: RoostDispatchRow[] = [];
    const puts: IndexEntry[] = [];
    for (const update of updates) {
      const before = await this.row(update.after.id, base);
      const row = rowSchema.parse({
        position: update.position ?? before?.position,
        entry: dispatchEntry(update.after),
        inspection: update.inspection,
        segments: update.segments ?? before?.segments,
      });
      if (!before && row.position < base.header.count) throw stale();
      if (row.position >= count) throw stale();
      if (
        before &&
        before.position === row.position &&
        sameDispatchEntry(before.entry, row.entry) &&
        JSON.stringify(before.inspection) === JSON.stringify(row.inspection) &&
        before.segments.length === row.segments.length &&
        before.segments.every(
          (segment, i) =>
            segment.turnId === row.segments[i]?.turnId &&
            segment.segmentId === row.segments[i]?.segmentId
        )
      )
        continue;
      puts.push(...this.puts(row, before));
      changed.push(row);
    }
    const header = { ...base.header, cursor: through.toString(), count };
    const next = { header, bytes: encode(header) };
    puts.push({ ...marker, value: next.bytes });
    // One identity can be touched several times by a command. The last put wins.
    const unique = new Map(
      puts.map((put) => [`${put.table}:${Buffer.from(put.key).toString('hex')}`, put])
    );
    return { base, next, puts: [...unique.values()], changed };
  }

  expected(plan: Plan): IndexEntry {
    return { ...marker, value: plan.base.bytes };
  }
  derivedPuts(plan: Plan): IndexPut[] | undefined {
    if (plan.puts.some((put) => put.value === null)) return undefined;
    return plan.puts.flatMap((put) => (put.value === null ? [] : [{ ...put, value: put.value }]));
  }
  async validate(checkpoint: RoostDispatchCheckpoint): Promise<void> {
    const [after] = await this.host.readIndex([marker]);
    if (!after || !Buffer.from(after).equals(Buffer.from(checkpoint.bytes))) throw stale();
  }
  accept(plan: Plan): void {
    this.cached = plan.next;
    for (const row of plan.changed) this.remember(row);
  }
  async commit(plan: Plan): Promise<void> {
    if (!(await this.host.compareAndWriteIndex([this.expected(plan)], plan.puts))) throw stale();
    this.accept(plan);
  }

  /** Called under the owner's write queue. Publish the marker only after every
   * bounded page and the final authoritative cursor have been verified. */
  async rebuild(
    cursor: bigint,
    count: number,
    pages: AsyncIterable<readonly RoostDispatchRow[]>,
    verify: () => Promise<void>
  ): Promise<void> {
    this.forget();
    const [previous] = await this.host.readIndex([marker]);
    const building = encode({ building: randomUUID() });
    if (
      !(await this.host.compareAndWriteIndex(
        [{ ...marker, value: previous ?? null }],
        [{ ...marker, value: building }]
      ))
    )
      throw stale();
    const guarded = async (puts: IndexEntry[]) => {
      if (!(await this.host.compareAndWriteIndex([{ ...marker, value: building }], puts)))
        throw stale();
    };
    for (const table of [
      rowsTable,
      pendingTable,
      completedTable,
      positionsTable,
      toolOwnersTable,
      permissionOwnersTable,
      outputOwnersTable,
      systemTurnsTable,
    ]) {
      for (;;) {
        const old = await this.host.scanIndex(table, new Uint8Array(), 128n);
        if (!old.length) break;
        await guarded(old.map((row) => ({ table, key: row.key, value: null })));
      }
    }
    let seen = 0;
    let inspected = true;
    for await (const page of pages) {
      inspected &&= page.every((row) => row.inspection !== undefined);
      for (let start = 0; start < page.length; start += 32) {
        const selected = page.slice(start, start + 32).map((row) => rowSchema.parse(row));
        await guarded(selected.flatMap((row) => this.puts(row)));
        seen += selected.length;
      }
    }
    if (seen !== count) throw stale();
    await verify();
    const header: Header = {
      version: 2,
      ...(inspected ? { inspectionVersion: 1 as const } : {}),
      token: randomUUID(),
      cursor: cursor.toString(),
      count,
    };
    const bytes = encode(header);
    await guarded([{ ...marker, value: bytes }]);
    this.cached = { header, bytes };
  }

  inspection(row: RoostDispatchRow): RoostHistoryInspection {
    const inspection = row.inspection;
    if (
      !inspection ||
      inspection.scalars.id !== row.entry.id ||
      inspection.scalars.role !== row.entry.role
    )
      throw new RoostDispatchIndexCorrupt('Roost history inspection is incomplete');
    return inspection;
  }

  async owners(
    checkpoint: RoostDispatchCheckpoint,
    kind: 'tool' | 'permission' | 'output' | 'system',
    id: string,
    from = 0,
    limit = Infinity
  ): Promise<RoostDispatchRow[]> {
    const table = {
      tool: toolOwnersTable,
      permission: permissionOwnersTable,
      output: outputOwnersTable,
      system: systemTurnsTable,
    }[kind];
    const prefix = kind === 'system' ? new Uint8Array() : completionPrefix(id);
    let start = Buffer.concat([prefix, positionKey(from).key]);
    const rows: RoostDispatchRow[] = [];
    for (;;) {
      const page = await this.host.scanIndex(
        table,
        start,
        BigInt(Math.min(128, limit - rows.length))
      );
      for (const ref of page) {
        if (!matchesPrefix(ref.key, prefix)) break;
        const row = await this.row(z.string().parse(decode(ref.value)), checkpoint);
        if (!row || row.position < from)
          throw new RoostDispatchIndexCorrupt('Roost history owner is unavailable');
        const inspection = this.inspection(row);
        const matches =
          kind === 'tool'
            ? inspection.tools.some((tool) => tool.id === id)
            : kind === 'permission'
              ? row.entry.role === 'assistant' &&
                inspection.tools.some((tool) => tool.requestId === id)
              : kind === 'output'
                ? row.entry.role === 'assistant' && row.entry.userTurnId === id
                : row.entry.role === 'system';
        if (!matches)
          throw new RoostDispatchIndexCorrupt('Roost history owner does not match its index');
        rows.push(row);
      }
      if (rows.length >= limit || page.length < 128 || !matchesPrefix(page.at(-1)!.key, prefix))
        break;
      start = Buffer.concat([page.at(-1)!.key, new Uint8Array([0])]);
    }
    await this.validate(checkpoint);
    return rows;
  }

  async read(
    checkpoint: RoostDispatchCheckpoint,
    includeTurnIds: readonly string[]
  ): Promise<SessionDispatchEntry[]> {
    const ids = new Set(includeTurnIds);
    const pendingIds = new Set<string>();
    let start = new Uint8Array();
    for (;;) {
      const page = await this.host.scanIndex(pendingTable, start, 128n);
      for (const row of page) {
        const id = z.string().parse(decode(row.value));
        ids.add(id);
        pendingIds.add(id);
      }
      if (page.length < 128) break;
      start = Buffer.concat([page[page.length - 1]!.key, new Uint8Array([0])]);
    }
    const entries: RoostDispatchRow[] = [];
    for (const id of ids) {
      const row = await this.row(id, checkpoint);
      if (pendingIds.has(id) && (!row || !isDispatchCandidate(row.entry)))
        throw new RoostDispatchIndexCorrupt('Roost pending dispatch row is unavailable');
      if (row) entries.push(row);
      const prefix = completionPrefix(id);
      const [completion] = await this.host.scanIndex(completedTable, prefix, 1n);
      if (completion && matchesPrefix(completion.key, prefix)) {
        const completed = rowSchema.parse(decode(completion.value));
        if (
          completed.entry.userTurnId !== id ||
          !hasCompletion(completed.entry) ||
          completed.position >= checkpoint.header.count
        )
          throw new RoostDispatchIndexCorrupt('Roost dispatch completion row is unavailable');
        entries.push(completed);
      }
    }
    await this.validate(checkpoint);
    const unique = new Map(entries.map((row) => [row.entry.id, row]));
    return selectDispatchHistory(
      [...unique.values()].sort((a, b) => a.position - b.position).map((row) => row.entry),
      includeTurnIds
    ).map(dispatchEntry);
  }
}
