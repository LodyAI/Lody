import { z } from 'zod';
import type { NativeSessionCommand, NativeSessionRead } from './native-session-domain';
import type { SessionId } from './ids';

const id = z.string().min(1).max(512);
const index = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const nativeSessionIpcErrorCodeSchema = z.enum([
  'invalid_request',
  'invalid_command',
  'access_denied',
  'restart_required',
  'cleanup_unconfirmed',
  'operation_failed',
  'unavailable',
]);
export type NativeSessionIpcErrorCode = z.infer<typeof nativeSessionIpcErrorCodeSchema>;
export class NativeSessionIpcError extends Error {
  constructor(readonly code: NativeSessionIpcErrorCode = 'operation_failed') {
    super(`native_session_${code}`);
    this.name = 'NativeSessionIpcError';
  }
}
export function nativeSessionIpcErrorCode(error: unknown): NativeSessionIpcErrorCode {
  const code = nativeSessionIpcErrorCodeSchema.safeParse(
    error && typeof error === 'object' && 'code' in error ? error.code : undefined
  );
  if (code.success) return code.data;
  if (error instanceof z.ZodError) return 'invalid_request';
  if (error instanceof Error && error.name === 'HistoryWriteError') return 'invalid_command';
  return 'operation_failed';
}
const read = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('count') }).strict(),
  ...(['all', 'control', 'frontiers', 'directorySnapshot', 'flush'] as const).map((kind) =>
    z.object({ kind: z.literal(kind) }).strict()
  ),
  z.object({ kind: z.literal('at'), position: index }).strict(),
  ...(['turn', 'display', 'output'] as const).map((kind) =>
    z.object({ kind: z.literal(kind), turnId: id }).strict()
  ),
  z.object({ kind: z.literal('run'), turnId: id, sessionId: id, runId: id }).strict(),
  ...(['range', 'directory'] as const).map((kind) =>
    z.object({ kind: z.literal(kind), from: index, to: index }).strict()
  ),
]);
// This boundary validates the finite operation and its envelope. The shared
// HistoryWriter/control parsers validate authored content at the actual write,
// preserving unchanged opaque stored content rather than parsing it as new input.
const command = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('append'), turn: z.unknown() }).strict(),
  z.object({ kind: z.literal('dispatchUserTurn'), turn: z.unknown() }).strict(),
  z.object({ kind: z.literal('replace'), turnId: id, turn: z.unknown() }).strict(),
  z.object({ kind: z.literal('action'), action: z.unknown() }).strict(),
  z
    .object({
      kind: z.literal('permission'),
      requestId: id,
      outcome: z.unknown(),
      options: z.object({ turnId: id.optional() }).strict().optional(),
    })
    .strict(),
  z.object({ kind: z.literal('editableTail'), input: z.unknown() }).strict(),
  ...(['rollbackTail', 'releaseRollback', 'releaseSnapshot'] as const).map((kind) =>
    z.object({ kind: z.literal(kind), token: id }).strict()
  ),
  z.object({ kind: z.literal('import'), input: z.unknown() }).strict(),
  z.object({ kind: z.literal('capture') }).strict(),
  z.object({ kind: z.literal('copy'), token: id, selection: z.array(z.unknown()) }).strict(),
  z.object({ kind: z.literal('humanReceipt'), inputId: id }).strict(),
  z.object({ kind: z.literal('queuePush'), item: z.unknown() }).strict(),
  z.object({ kind: z.literal('queueUpdate'), cid: id, patch: z.unknown() }).strict(),
  z.object({ kind: z.literal('queueRemove'), cid: id }).strict(),
  z.object({ kind: z.literal('queueReorder'), cids: z.array(id) }).strict(),
  z.object({ kind: z.literal('cancel'), id, turnId: id }).strict(),
  z.object({ kind: z.literal('preview'), value: z.unknown() }).strict(),
  z.object({ kind: z.literal('externalCursor'), value: z.unknown() }).strict(),
]);
export const nativeSessionIpcScopeSchema = z
  .object({
    registrationId: id,
    sessionId: id.transform((value) => value as SessionId),
    requestId: id,
  })
  .strict();
export const nativeSessionIpcReadSchema = nativeSessionIpcScopeSchema
  .extend({ query: read, expectedGeneration: id.optional() })
  .strict();
export const nativeSessionIpcExecuteSchema = nativeSessionIpcScopeSchema
  .extend({ command, expectedGeneration: id })
  .strict();
export const nativeSessionIpcUnobserveSchema = nativeSessionIpcScopeSchema
  .extend({ leaseId: id })
  .strict();
export function parseNativeSessionRead(value: unknown): NativeSessionRead {
  return read.parse(value);
}
export function parseNativeSessionCommand(value: unknown): NativeSessionCommand {
  return command.parse(value) as NativeSessionCommand;
}
