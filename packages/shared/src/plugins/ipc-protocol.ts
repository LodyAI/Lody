import { z } from 'zod';
import { descriptorIdSchema as descriptorId, pluginIdSchema } from './manifest-schema';
const obj = z.strictObject,
  literal = z.literal;
const id = z.string().min(1),
  json = z.json(),
  scope = z.enum(['machine', 'session', 'project']),
  kind = z.enum(['query', 'mutation', 'tool', 'attachment-search', 'attachment-resolve']);
export const pluginIpcErrorSchema = obj({
  code: z.enum([
    'untrusted_plugin',
    'plugin_disabled',
    'plugin_faulted',
    'machine_offline',
    'forbidden',
    'not_found',
    'idempotency_conflict',
    'business_key_conflict',
    'outcome_unknown',
    'validation_failed',
    'handler_error',
  ]),
  message: z.string(),
});
const success = { ok: literal(true), data: json },
  failure = { ok: literal(false), error: pluginIpcErrorSchema };
export const hostToChildSchema = z.union([
  obj({
    type: literal('init'),
    pluginId: pluginIdSchema,
    instanceId: z.number().int().positive(),
    dataDir: id,
    config: z.record(id, json),
  }),
  obj({ type: literal('start') }),
  obj({
    type: literal('invoke'),
    callId: id,
    kind,
    descriptorId,
    scope,
    target: json,
    actorUserId: id,
    input: json,
  }),
  obj({
    type: literal('event'),
    eventId: id,
    eventType: id,
    payload: json,
    actorUserId: id.optional(),
    rootUserTurnId: id.optional(),
  }),
  obj({ type: literal('cancel'), callId: id }),
  obj({ type: literal('shutdown'), graceMs: z.number().int().nonnegative() }),
  obj({ type: literal('host_result'), hostCallId: id, ...success }),
  obj({ type: literal('host_result'), hostCallId: id, ...failure }),
]);
export const childToHostSchema = z.union([
  obj({
    type: literal('ready'),
    handlers: obj({ kind, descriptorId, scope }).array(),
    subscribedEvents: id.array(),
  }),
  obj({ type: literal('result'), callId: id, ...success }),
  obj({ type: literal('result'), callId: id, ...failure }),
  obj({ type: literal('invalidate'), descriptorId, scope, target: json.optional() }),
  obj({
    type: literal('host_call'),
    hostCallId: id,
    contextId: id,
    op: z.enum([
      'lody.read',
      'lody.readSnapshot',
      'lody.execute',
      'sessions.create',
      'sessions.send',
      'sessions.respondInteraction',
      'sessions.requestStop',
      'sessions.requestArchive',
    ]),
    payload: obj({ target: json, descriptorId: descriptorId.optional(), input: json.optional() }),
  }),
]);
export type HostToChildFrame = z.infer<typeof hostToChildSchema>;
export type ChildToHostFrame = z.infer<typeof childToHostSchema>;
