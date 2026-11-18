import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import { RepoRpcError, type RepoClient } from '@loro-dev/loro-repo-client';
import type { ScheduleRetentionRequest } from '../schedule-registry-port';
import type { NativeScheduleDefinitionRegistry } from './native-schedule-definition';
const inputSchema = z
  .object({
    actorId: z.string().min(1),
    machineId: z.string().min(1),
    activationId: z.string().min(1),
    runtimeUpdatedAt: z.number().finite(),
    now: z.number().finite(),
    retentionMs: z.number().finite().nonnegative(),
  })
  .strict();
const recordSchema = z
  .object({
    scheduleId: z.string().min(1).max(512),
    input: inputSchema,
    stage: z.enum(['preparing', 'reserved', 'deleting', 'deleted', 'complete']),
  })
  .strict();
export type NativeScheduleRetentionRecord = z.infer<typeof recordSchema>;
function hasTable(db: DatabaseSync) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='native_schedule_retention'")
    .get();
}
/** Passive route inspection never creates a database/table or native room. */
export function readNativeScheduleRetentions(
  journalPath: string,
  binding: string
): NativeScheduleRetentionRecord[] {
  if (!existsSync(journalPath)) return [];
  const db = new DatabaseSync(journalPath, { readOnly: true, timeout: 0 });
  try {
    if (!hasTable(db)) return [];
    return (
      db.prepare('SELECT intent FROM native_schedule_retention WHERE binding=?').all(binding) as {
        intent: string;
      }[]
    ).map((row) => recordSchema.parse(JSON.parse(row.intent)));
  } finally {
    db.close();
  }
}
/** Exact-room retirement boundary. The SR execution tombstone is durable before
 * deletion; original rows and this intent remain retry handles until completion.
 * A lost delete ACK is reconciled by absence only and is never replayed. */
export async function purgeNativeScheduleDefinition(options: {
  journalPath: string;
  binding: string;
  scheduleId: string;
  input: ScheduleRetentionRequest;
  registry: NativeScheduleDefinitionRegistry;
  getClient(): Promise<RepoClient>;
  assertCurrent(): void;
  drain(): Promise<void>;
  namespace: string;
}): Promise<void> {
  const input = inputSchema.parse(options.input);
  if (!options.registry.prepareRetention || !options.registry.completeRetention)
    throw new Error('Native retention registry authority unavailable');
  options.assertCurrent();
  const db = new DatabaseSync(options.journalPath);
  db.exec('PRAGMA synchronous=FULL');
  db.exec(
    'CREATE TABLE IF NOT EXISTS native_schedule_retention(binding TEXT NOT NULL,room_id TEXT NOT NULL,intent TEXT NOT NULL,PRIMARY KEY(binding,room_id)) WITHOUT ROWID'
  );
  const roomId = `schedule-${options.scheduleId}`;
  const read = () => {
    const row = db
      .prepare('SELECT intent FROM native_schedule_retention WHERE binding=? AND room_id=?')
      .get(options.binding, roomId) as { intent: string } | undefined;
    const value = row ? recordSchema.parse(JSON.parse(row.intent)) : undefined;
    if (
      value &&
      (value.scheduleId !== options.scheduleId || !isDeepStrictEqual(value.input, input))
    )
      throw new Error('Native retention intent changed');
    return value;
  };
  const write = (
    stage: NativeScheduleRetentionRecord['stage'],
    previous: NativeScheduleRetentionRecord
  ) => {
    options.assertCurrent();
    const value = recordSchema.parse({ scheduleId: options.scheduleId, input, stage });
    const result = db
      .prepare(
        'UPDATE native_schedule_retention SET intent=? WHERE binding=? AND room_id=? AND intent=?'
      )
      .run(JSON.stringify(value), options.binding, roomId, JSON.stringify(previous));
    if (Number(result.changes) !== 1) throw new Error('Native retention stage changed');
    return value;
  };
  try {
    db.prepare(
      'INSERT OR IGNORE INTO native_schedule_retention(binding,room_id,intent) VALUES(?,?,?)'
    ).run(
      options.binding,
      roomId,
      JSON.stringify(
        recordSchema.parse({ scheduleId: options.scheduleId, input, stage: 'preparing' })
      )
    );
    let value = read()!;
    if (value.stage === 'complete') return;
    if (value.stage === 'preparing') {
      const confirmed = await options.registry.prepareRetention(options.scheduleId, input);
      options.assertCurrent();
      if (!confirmed) {
        db.prepare(
          'DELETE FROM native_schedule_retention WHERE binding=? AND room_id=? AND intent=?'
        ).run(options.binding, roomId, JSON.stringify(value));
        throw new Error('Schedule is no longer eligible for retention');
      }
      value = write('reserved', value);
    }
    await options.drain();
    options.assertCurrent();
    const client = await options.getClient();
    options.assertCurrent();
    const absent = async () => {
      try {
        await client.inspectDocCausal(options.namespace, { kind: 'loro_doc', id: roomId });
        options.assertCurrent();
        return false;
      } catch (error) {
        options.assertCurrent();
        if (error instanceof RepoRpcError && error.code === 'room_not_found') return true;
        throw error;
      }
    };
    if (value.stage === 'deleting') {
      if (!(await absent())) throw new Error('Native retention deletion outcome remains unknown');
      value = write('deleted', value);
    }
    if (value.stage === 'reserved') {
      if (await absent())
        throw new Error('Native definition disappeared before retention deletion');
      value = write('deleting', value);
      await client.deleteRoom(options.namespace, { kind: 'loro_doc', id: roomId });
      options.assertCurrent();
      if (!(await absent())) throw new Error('Native retention deletion unconfirmed');
      value = write('deleted', value);
    }
    if (value.stage === 'deleted') {
      await options.registry.completeRetention(options.scheduleId, input);
      options.assertCurrent();
      write('complete', value);
    }
  } finally {
    db.close();
  }
}
