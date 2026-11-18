import { z } from 'zod';
import {
  ScheduleRegistryRowSchema,
  ScheduleRuntimeRowSchema,
  ScheduleTombstoneSchema,
} from './schedule-types';
import {
  scheduleManualRequestSchema,
  projectScheduleRegistry,
  type ScheduleRegistryCommand,
} from './schedule-registry-port';
export const SCHEDULE_REGISTRY_COMMAND_MAX_BYTES = 64 * 1024;
export const SCHEDULE_REGISTRY_SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024;
const id = z.string().min(1).max(512);
export const scheduleRegistryIpcErrorCodeSchema = z.enum([
  'invalid_request',
  'access_denied',
  'restart_required',
  'cleanup_unconfirmed',
  'operation_failed',
  'unavailable',
]);
export type ScheduleRegistryIpcErrorCode = z.infer<typeof scheduleRegistryIpcErrorCodeSchema>;
export class ScheduleRegistryIpcError extends Error {
  constructor(readonly code: ScheduleRegistryIpcErrorCode = 'invalid_request') {
    super(`schedule_registry_${code}`);
    this.name = 'ScheduleRegistryIpcError';
  }
}
export const scheduleRegistryIpcErrorCode = (error: unknown): ScheduleRegistryIpcErrorCode => {
  const parsed = scheduleRegistryIpcErrorCodeSchema.safeParse(
    error && typeof error === 'object' && 'code' in error ? error.code : undefined
  );
  return parsed.success ? parsed.data : 'operation_failed';
};
function budget(value: unknown, bytes: number) {
  try {
    const json = JSON.stringify(value);
    if (json && new TextEncoder().encode(json).length <= bytes) return;
  } catch {
    /* Content-free error only. */
  }
  throw new ScheduleRegistryIpcError();
}
const commands = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('publish'),
      row: ScheduleRegistryRowSchema.omit({ ownerId: true }).strict(),
    })
    .strict(),
  z.object({ kind: z.literal('tombstone'), scheduleId: id, now: z.number().finite() }).strict(),
  z
    .object({
      kind: z.literal('request-run'),
      request: scheduleManualRequestSchema.omit({ actorId: true }).strict(),
    })
    .strict(),
]);
export type ScheduleRegistryIpcCommand = z.infer<typeof commands>;
/** The renderer supplies no actor/account/workspace/namespace or raw mutation.
 * A local publication can target only main's currently admitted local machine. */
export function parseScheduleRegistryIpcCommand(
  value: unknown,
  actorId: string,
  machineId: string
): ScheduleRegistryCommand {
  budget(value, SCHEDULE_REGISTRY_COMMAND_MAX_BYTES);
  try {
    const command = commands.parse(value);
    switch (command.kind) {
      case 'publish':
        if (command.row.machineId !== machineId)
          throw new ScheduleRegistryIpcError('access_denied');
        return {
          kind: 'publish',
          row: ScheduleRegistryRowSchema.parse({ ...command.row, ownerId: actorId }),
        };
      case 'tombstone':
        return { ...command, actorId };
      case 'request-run':
        return { kind: 'request-run', request: { ...command.request, actorId } };
    }
  } catch (error) {
    throw error instanceof ScheduleRegistryIpcError ? error : new ScheduleRegistryIpcError();
  }
}
/** Trusted UI port adapter removes actor fields; callers cannot open daemon-only runtime/prune writes. */
export function toScheduleRegistryIpcCommand(
  command: ScheduleRegistryCommand,
  actorId: string
): ScheduleRegistryIpcCommand {
  try {
    switch (command.kind) {
      case 'publish': {
        if (command.row.ownerId !== actorId) throw new ScheduleRegistryIpcError('access_denied');
        const { ownerId: _owner, ...row } = command.row;
        budget({ kind: command.kind, row }, SCHEDULE_REGISTRY_COMMAND_MAX_BYTES);
        return commands.parse({ kind: command.kind, row });
      }
      case 'tombstone':
        if (command.actorId !== actorId) throw new ScheduleRegistryIpcError('access_denied');
        return commands.parse({
          kind: command.kind,
          scheduleId: command.scheduleId,
          now: command.now,
        });
      case 'request-run': {
        if (command.request.actorId !== actorId)
          throw new ScheduleRegistryIpcError('access_denied');
        const { actorId: _actor, ...request } = command.request;
        return commands.parse({ kind: command.kind, request });
      }
      default:
        throw new ScheduleRegistryIpcError('access_denied');
    }
  } catch (error) {
    throw error instanceof ScheduleRegistryIpcError ? error : new ScheduleRegistryIpcError();
  }
}
export const scheduleRegistryIpcRequestSchema = z
  .object({ registrationId: z.string().uuid(), requestId: z.string().uuid() })
  .strict();
export const scheduleRegistryIpcStatefulRequestSchema = scheduleRegistryIpcRequestSchema
  .extend({ expectedGeneration: id })
  .strict();
export const scheduleRegistryIpcExecuteRequestSchema = scheduleRegistryIpcStatefulRequestSchema
  .extend({ command: z.unknown() })
  .strict();
export const scheduleRegistryIpcUnsubscribeSchema = scheduleRegistryIpcRequestSchema
  .extend({ leaseId: z.string().uuid() })
  .strict();
export const scheduleRegistryIpcObserveResultSchema = z
  .object({ leaseId: z.string().uuid() })
  .strict();
export const scheduleRegistryIpcCancelResultSchema = z
  .object({ canceled: z.literal(true) })
  .strict();
export const scheduleRegistryIpcCommandResultSchema = z
  .object({ generation: id, changed: z.boolean() })
  .strict();
export const scheduleRegistryIpcFlushResultSchema = z.object({ generation: id }).strict();
const state = z
  .object({
    schedules: z.array(ScheduleRegistryRowSchema.strip()).max(10000),
    runtimes: z.array(ScheduleRuntimeRowSchema.strip()).max(10000),
    manuals: z.array(scheduleManualRequestSchema.strip()).max(10000),
    tombstones: z.array(ScheduleTombstoneSchema.extend({ scheduleId: id }).strip()).max(10000),
    discoveryIds: z.array(id).max(10000),
    synced: z.boolean(),
  })
  .strict();
const snapshot = z.object({ generation: id, workspaceId: id, state }).strict();
export type ScheduleRegistryIpcSnapshot = z.infer<typeof snapshot>;
export function parseScheduleRegistryIpcSnapshot(value: unknown): ScheduleRegistryIpcSnapshot {
  budget(value, SCHEDULE_REGISTRY_SNAPSHOT_MAX_BYTES);
  try {
    return snapshot.parse(value);
  } catch {
    throw new ScheduleRegistryIpcError('operation_failed');
  }
}
const event = z.discriminatedUnion('type', [
  scheduleRegistryIpcUnsubscribeSchema.extend({ type: z.literal('snapshot'), snapshot }).strict(),
  scheduleRegistryIpcUnsubscribeSchema
    .extend({ type: z.literal('error'), code: scheduleRegistryIpcErrorCodeSchema })
    .strict(),
]);
export type ScheduleRegistryIpcEvent = z.infer<typeof event>;
export function parseScheduleRegistryIpcEvent(value: unknown): ScheduleRegistryIpcEvent {
  budget(value, SCHEDULE_REGISTRY_SNAPSHOT_MAX_BYTES + 4096);
  try {
    return event.parse(value);
  } catch {
    throw new ScheduleRegistryIpcError('operation_failed');
  }
}

/** Main-only admission hook: evaluated against the exact rows used by the
 * backend CAS planner, so a concurrent ownership change cannot bypass policy. */
export function assertScheduleRegistryIpcWriteAuthority(
  command: ScheduleRegistryCommand,
  rows: Parameters<typeof projectScheduleRegistry>[0],
  actorId: string,
  machineId: string
): void {
  const entries = [...rows];
  const snapshot = projectScheduleRegistry(entries);
  const id =
    command.kind === 'publish'
      ? command.row.scheduleId
      : command.kind === 'request-run'
        ? command.request.scheduleId
        : command.kind === 'tombstone'
          ? command.scheduleId
          : undefined;
  if (!id) throw new ScheduleRegistryIpcError('access_denied');
  const stored = entries.find(
    (row) => row.key.length === 2 && row.key[0] === 'schedule' && row.key[1] === id
  );
  if (stored) {
    const raw = stored.value;
    if (
      !raw ||
      typeof raw !== 'object' ||
      Array.isArray(raw) ||
      raw instanceof Uint8Array ||
      !('ownerId' in raw) ||
      raw.ownerId !== actorId ||
      !('machineId' in raw) ||
      raw.machineId !== machineId
    )
      throw new ScheduleRegistryIpcError('access_denied');
  }
  const existing = snapshot.schedules.find((row) => row.scheduleId === id);
  if (existing && (existing.ownerId !== actorId || existing.machineId !== machineId))
    throw new ScheduleRegistryIpcError('access_denied');
  if (
    command.kind !== 'publish' &&
    !existing &&
    !(
      command.kind === 'tombstone' &&
      snapshot.tombstones.some((row) => row.scheduleId === id && row.actorId === actorId)
    )
  )
    throw new ScheduleRegistryIpcError('access_denied');
}
