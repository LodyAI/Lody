import { decodeBatch } from '@loro-dev/roost';
import { toApplicationJson, type HistoryProjectedMessage } from '@loro-dev/roost/lody-history';
import type { RoostNodeStream } from '@loro-dev/roost-node';
import type { SessionHistoryChanges } from '@lody/shared';
import { SessionHistoryContentPatchSchema } from '@lody/shared/session-data';
import { roostCheckpointCursor } from './roost-history-changes';

type ReadyChanges = Extract<SessionHistoryChanges, { state: 'ready' }>;
const MAX_UPDATES = 256n;
const MAX_BYTES = 4 * 1024 * 1024;
const hex = (value: Uint8Array) => Buffer.from(value).toString('hex');

/** Reuse admitted native edits; unsupported intervals retain the complete-body read. */
export async function readRoostHistoryPatches(
  host: RoostNodeStream,
  messages: readonly HistoryProjectedMessage[],
  changes: ReadyChanges,
  checkpoint: string,
  through: bigint
): Promise<ReadyChanges['patches']> {
  if (changes.from !== undefined || !changes.ids.length) return undefined;
  const after = roostCheckpointCursor(checkpoint);
  const length = through - after;
  if (length <= 0n || length > MAX_UPDATES) return undefined;
  const primaries = messages.filter((row) => row.segmentId === 'primary' && !row.sealed);
  if (
    changes.ids.some(
      (id) =>
        !primaries.some((row) => row.businessId === id) ||
        messages.filter((row) => row.businessId === id).length !== 1
    )
  )
    return undefined;
  // Permission outcomes may be overlaid from independently stored response records.
  for (const row of primaries) {
    if (!changes.ids.includes(row.businessId) || !(row.content instanceof Map)) continue;
    const items = row.content.get('items');
    if (
      Array.isArray(items) &&
      items.some((item) => item instanceof Map && item.has('permissionRequest'))
    )
      return undefined;
  }
  const byPhysicalId = new Map(primaries.map((row) => [hex(row.turnId), row]));
  const events = await host.eventsAfter(after, length);
  if (BigInt(events.length) !== length) return undefined;
  const groups = new Map<string, { row: HistoryProjectedMessage; sequences: bigint[] }>();
  for (const [index, record] of events.entries()) {
    if (record.cursor !== after + BigInt(index) + 1n || record.event.kind !== 'changed')
      return undefined;
    const ref = record.event.update;
    const row = byPhysicalId.get(hex(ref.turnId));
    if (!row || !changes.ids.includes(row.businessId) || ref.seq === 0n) return undefined;
    let group = groups.get(row.businessId);
    if (!group) {
      group = { row, sequences: [] };
      groups.set(row.businessId, group);
    }
    group.sequences.push(ref.seq);
  }
  if (groups.size !== changes.ids.length) return undefined;
  const turns: NonNullable<ReadyChanges['patches']>['turns'][number][] = [];
  let bytes = 0;
  for (const { row, sequences } of groups.values()) {
    const first = sequences[0]!;
    if (sequences.some((seq, index) => seq !== first + BigInt(index))) return undefined;
    const header = await host.readTurnHeader(row.turnId);
    if (
      header.kind !== 'found' ||
      header.turn.sealed !== null ||
      header.turn.nextSeq !== first + BigInt(sequences.length)
    )
      return undefined;
    const batch = await host.exportUpdates(row.turnId, first, BigInt(sequences.length));
    bytes += batch.length;
    if (bytes > MAX_BYTES) return undefined;
    const updates = decodeBatch(batch);
    if (updates.length !== sequences.length) return undefined;
    const operations = [];
    for (const [index, update] of updates.entries()) {
      if (
        hex(update.turnId) !== hex(row.turnId) ||
        update.seq !== sequences[index] ||
        update.operation.kind !== 'edit'
      )
        return undefined;
      const op = update.operation.op;
      const root = op.path[0];
      if (op.path.length < 2 || !root || !('key' in root) || root.key !== 'content')
        return undefined;
      // The logical projection supplies fileDiff=[] for an absent raw field.
      // Those removals require projection rather than replaying raw JSON edits.
      const field = op.path[1];
      if (op.path.length === 2 && field && 'key' in field && field.key === 'fileDiff') {
        if (op.kind === 'remove' || (op.kind === 'set' && !Array.isArray(op.value)))
          return undefined;
      }
      const path = op.path
        .slice(1)
        .map((part) => ('key' in part ? part : { index: Number(part.index) }));
      const parsed = SessionHistoryContentPatchSchema.safeParse({
        ...op,
        path,
        ...('value' in op ? { value: toApplicationJson(op.value) } : {}),
        ...('values' in op ? { values: op.values.map(toApplicationJson) } : {}),
        ...('index' in op ? { index: Number(op.index), delete: Number(op.delete) } : {}),
      });
      if (!parsed.success) return undefined;
      operations.push(parsed.data);
    }
    turns.push({ turnId: row.businessId, operations });
  }
  return { baseCheckpoint: checkpoint, turns };
}
