import { z } from 'zod';
import {
  SessionHistoryInputConfigSchema,
  MessageContentSchema,
  PlanEntrySchema,
  normalizeLegacyAcpSessionConfig,
} from './message-schemas';

/** New writes only. Never parse/rewrite the stored history through this schema. */
export const HistoryEntryWriteSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  timestamp: z.string(),
  userTurnId: z.string().optional(),
  acpTurnId: z.string().optional(),
  items: z.array(MessageContentSchema).optional(),
  plan: z.array(PlanEntrySchema).optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  permissionWaitMs: z.number().optional(),
  status: z
    .enum(['pending', 'pending_apply', 'seen', 'processing', 'handled', 'failed', 'canceled'])
    .optional(),
  inputConfig: z
    .preprocess(normalizeLegacyAcpSessionConfig, SessionHistoryInputConfigSchema)
    .optional(),
  read: z.boolean().optional(),
  userId: z.string().optional(),
  modelInfo: z
    .object({
      modelId: z.string(),
      name: z.string(),
      description: z.string().nullable().optional(),
      _meta: z.record(z.string(), z.unknown()).nullable().optional(),
    })
    .optional(),
  fileDiff: z
    .array(
      z.object({
        filePath: z.string(),
        add: z.number(),
        del: z.number(),
        cc: z
          .object({
            v: z.literal(1),
            fileId: z.string(),
            opId: z
              .string()
              .regex(/^\d+:\d+$/)
              .optional(),
            baseOpId: z
              .string()
              .regex(/^\d+:\d+$/)
              .optional(),
            base: z.literal('missing').optional(),
            deleted: z.literal(true).optional(),
          })
          .optional(),
      })
    )
    .optional(),
  finished: z.boolean().optional(),
  sendStatus: z.literal('timeout').optional(),
});

export type HistoryEntryWrite = z.output<typeof HistoryEntryWriteSchema>;

/** Paths and codes only: never put conversation contents in validation errors. */
export class HistoryWriteError extends Error {
  constructor(readonly issues: readonly { path: readonly PropertyKey[]; code: string }[]) {
    super(
      `Invalid history write: ${issues.map((issue) => `${issue.path.join('.')}: ${issue.code}`).join(', ')}`
    );
    this.name = 'HistoryWriteError';
  }
}

export function parseHistoryWrite<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = z.safeParse(historyInputSchema(schema), withoutTransportIds(value));
  if (!result.success)
    throw new HistoryWriteError(result.error.issues.map(({ path, code }) => ({ path, code })));
  assertHistoryJson(result.data);
  return result.data as T;
}

const discriminatedOptions = new WeakMap<z.ZodUnion, Map<unknown, readonly z.core.$ZodType[]>>();

/** Schema-derived discriminator lookup; never duplicate the message variant list. */
export function historyUnionCandidates(
  schema: z.ZodUnion,
  value: unknown
): readonly z.core.$ZodType[] {
  if (schema instanceof z.ZodDiscriminatedUnion) {
    const key = schema.def.discriminator;
    let index = discriminatedOptions.get(schema);
    if (!index) {
      index = new Map();
      for (const option of schema.options) {
        if (!(option instanceof z.ZodObject) || !(option.shape[key] instanceof z.ZodLiteral)) {
          // Only optimize literal discriminators; other Zod schemas retain their own semantics.
          return schema.options;
        }
        for (const literal of option.shape[key].values) index.set(literal, [option]);
      }
      discriminatedOptions.set(schema, index);
    }
    return value !== null && typeof value === 'object'
      ? (index.get((value as Record<string, unknown>)[key]) ?? [])
      : [];
  }
  const mayMatch = (option: z.core.$ZodType): boolean => {
    if (option instanceof z.ZodUnion) return historyUnionCandidates(option, value).length > 0;
    if (!(option instanceof z.ZodObject) || value === null || typeof value !== 'object')
      return true;
    for (const [key, field] of Object.entries(option.shape)) {
      if (
        field instanceof z.ZodLiteral &&
        !(field.values as ReadonlySet<unknown>).has((value as Record<string, unknown>)[key])
      )
        return false;
    }
    return true;
  };
  return schema.options.filter(mayMatch);
}

// Reuse the business schemas' field definitions, but do not make their stricter
// external-RPC unknown-key policy a history rewrite policy. Closed objects select
// known input fields; explicit ACP extension dictionaries remain open.
const inputSchemas = new WeakMap<z.core.$ZodType, z.core.$ZodType>();
function historyInputSchema(schema: z.core.$ZodType): z.core.$ZodType {
  const cached = inputSchemas.get(schema);
  if (cached) return cached;
  let result = schema;
  // Clone definitions, including checks/refinements, once. Zod then selects,
  // filters and validates in a single parse; never project/parse every value twice.
  if (schema instanceof z.ZodOptional) {
    result = schema.clone({ ...schema.def, innerType: historyInputSchema(schema.unwrap()) });
  } else if (schema instanceof z.ZodNullable) {
    result = schema.clone({ ...schema.def, innerType: historyInputSchema(schema.unwrap()) });
  } else if (schema instanceof z.ZodPipe) {
    // Preserve preprocessing/transforms, while selecting known fields on both
    // sides of the pipe (notably the legacy inputConfig normalizer's output).
    result = schema.clone({
      ...schema.def,
      in: historyInputSchema(schema.def.in),
      out: historyInputSchema(schema.def.out),
    });
  } else if (schema instanceof z.ZodUnion) {
    result = schema.clone({ ...schema.def, options: schema.options.map(historyInputSchema) });
  } else if (schema instanceof z.ZodArray) {
    result = schema.clone({ ...schema.def, element: historyInputSchema(schema.element) });
  } else if (schema instanceof z.ZodObject) {
    const catchall = schema.def.catchall;
    const open = catchall && !(catchall instanceof z.ZodNever);
    result = schema.clone({
      ...schema.def,
      shape: Object.fromEntries(
        Object.entries(schema.shape).map(([key, field]) => [
          key,
          historyInputSchema(field as z.core.$ZodType),
        ])
      ),
      catchall: open ? historyInputSchema(catchall) : undefined,
    });
  }
  inputSchemas.set(schema, result);
  return result;
}

// Mirror adds $cid to nested maps, including strict ACP objects. It is read-side
// container identity, not an input field; the materializer never persists it.
function withoutTransportIds(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) throw new HistoryWriteError([{ path: [], code: 'non_json_value' }]);
  if (
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  )
    return value;
  ancestors.add(value);
  // Most new provider data has no transport ids. Walk for cycles, but only
  // allocate a copy where stripping an id actually changes the value.
  let result: unknown = value;
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    value.forEach((child, i) => {
      const next = withoutTransportIds(child, ancestors);
      if (next !== child) {
        copy ??= value.slice();
        copy[i] = next;
      }
    });
    result = copy ?? value;
  } else {
    const object = value as Record<string, unknown>;
    let copy: Record<string, unknown> | undefined;
    for (const key of Object.keys(object)) {
      if (key === '$cid') {
        copy ??= { ...object };
        delete copy[key];
      } else {
        const next = withoutTransportIds(object[key], ancestors);
        if (next !== object[key]) {
          copy ??= { ...object };
          Object.defineProperty(copy, key, {
            value: next,
            enumerable: true,
            configurable: true,
            writable: true,
          });
        }
      }
    }
    result = copy ?? value;
  }
  ancestors.delete(value);
  return result;
}

// Provider-owned rawInput/rawOutput/_meta may have arbitrary JSON keys, not JS
// functions, class instances, cycles or non-finite values that fail halfway into Loro.
function assertHistoryJson(
  value: unknown,
  path: PropertyKey[] = [],
  ancestors = new Set<object>()
): void {
  if (
    value === undefined ||
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  )
    return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (
    typeof value !== 'object' ||
    ancestors.has(value) ||
    (!Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new HistoryWriteError([{ path, code: 'non_json_value' }]);
  }
  ancestors.add(value);
  for (const [key, child] of Object.entries(value))
    assertHistoryJson(child, [...path, key], ancestors);
  ancestors.delete(value);
}
