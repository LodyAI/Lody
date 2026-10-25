import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { IndexEntry, IndexPut, RoostNodeStream } from '@loro-dev/roost-node';
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
const rowSchema = z
  .object({
    position: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    entry: entrySchema,
    segments: z
      .array(
        z.object({ turnId: z.string().regex(/^[0-9a-f]{32}$/), segmentId: z.string() }).strict()
      )
      .min(1),
  })
  .strict();
const headerSchema = z
  .object({
    version: z.literal(2),
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
    return puts;
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
      if (update.before && sameDispatchEntry(update.before, update.after) && !update.segments) {
        const known = this.cached === base ? this.rows.get(update.after.id) : undefined;
        if (update.position === undefined || known?.position === update.position) continue;
      }
      const before = await this.row(update.after.id, base);
      const row = rowSchema.parse({
        position: update.position ?? before?.position,
        entry: dispatchEntry(update.after),
        segments: update.segments ?? before?.segments,
      });
      if (!before && row.position < base.header.count) throw stale();
      if (row.position >= count) throw stale();
      if (
        before &&
        before.position === row.position &&
        sameDispatchEntry(before.entry, row.entry) &&
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
    for (const table of [rowsTable, pendingTable, completedTable, positionsTable]) {
      for (;;) {
        const old = await this.host.scanIndex(table, new Uint8Array(), 128n);
        if (!old.length) break;
        await guarded(old.map((row) => ({ table, key: row.key, value: null })));
      }
    }
    let seen = 0;
    for await (const page of pages) {
      for (let start = 0; start < page.length; start += 32) {
        const selected = page.slice(start, start + 32).map((row) => rowSchema.parse(row));
        await guarded(selected.flatMap((row) => this.puts(row)));
        seen += selected.length;
      }
    }
    if (seen !== count) throw stale();
    await verify();
    const header: Header = { version: 2, token: randomUUID(), cursor: cursor.toString(), count };
    const bytes = encode(header);
    await guarded([{ ...marker, value: bytes }]);
    this.cached = { header, bytes };
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
