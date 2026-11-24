import { z } from 'zod';
import {
  descriptorIdSchema as descriptorId,
  pluginIdSchema,
  pluginManifestSchema,
} from './manifest-schema';
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
    permissions: pluginManifestSchema.shape.permissions.unwrap(),
  }),
  obj({
    type: literal('start'),
    contextId: id,

    upgrade: obj({ fromVersion: id, toVersion: id }).optional(),
  }),
  obj({
    type: literal('invoke'),
    callId: id,
    kind,
    descriptorId,
    scope,
    target: json,
    projectConfig: z.record(id, z.union([z.string(), z.number(), z.boolean()])).optional(),
    actorUserId: id,
    input: json,
  }),
  obj({
    type: literal('event'),
    contextId: id,
    eventId: id,
    eventType: id,
    payload: json,
    actorUserId: id.optional(),
    rootUserTurnId: id.optional(),
  }),
  obj({ type: literal('service'), contextId: id }),
  obj({ type: literal('cancel'), callId: id }),
  obj({
    type: literal('shutdown'),
    uninstallContextId: id.optional(),
    graceMs: z.number().int().nonnegative(),
  }),
  obj({ type: literal('host_result'), hostCallId: id, ...success }),
  obj({ type: literal('host_result'), hostCallId: id, ...failure }),
]);
export const childToHostSchema = z.union([
  obj({
    type: literal('ready'),
    handlers: obj({ kind, descriptorId, scope, tool: obj({ description: z.string(), inputSchema: z.record(id, json) }).optional() }).array(),
    subscribedEvents: id.array(),
    resumeEvents: id.array(),
    hasService: z.boolean(),
  }),
  obj({ type: literal('result'), callId: id, ...success }),
  obj({ type: literal('result'), callId: id, ...failure }),
  obj({ type: literal('invalidate'), descriptorId, scope, target: json.optional() }),
  obj({
    type: literal('host_call'),
    hostCallId: id,
    contextId: id,
    op: z.enum([
      'storage.get',
      'storage.set',
      'storage.delete',
      'storage.update',
      'lody.read',
      'lody.unstable.readSnapshot',
      'lody.execute',
    ]),
    payload: obj({ target: json, descriptorId: descriptorId.optional(), input: json.optional() }),
  }),
]);
export type HostToChildFrame = z.infer<typeof hostToChildSchema>;
export type ChildToHostFrame = z.infer<typeof childToHostSchema>;
