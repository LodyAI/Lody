import { z } from 'zod';

const json = z.record(z.string(), z.json());
export const automationEmptyReadParametersSchema = z.object({}).strict();
export const automationEventReadParametersSchema = z
  .object({
    since: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
  })
  .strict();

/** A read capability identifies data, never a predefined wait predicate or an effect. */
export const automationReadRequestSchema = z
  .object({
    resource: z.string().min(1).max(128),
    parameters: json.default({}),
  })
  .strict();
export type AutomationReadRequest = z.infer<typeof automationReadRequestSchema>;
export const automationReadResponseSchema = z
  .object({
    value: z.json(),
    observedAt: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 128 * 1024,
    'Automation observation exceeds 128 KiB'
  );
export type AutomationReadResponse = z.infer<typeof automationReadResponseSchema>;

/** Host-captured source evidence; guest return values cannot create admission authority. */
export const automationEvidenceSchema = z
  .object({
    sourceId: z.string().min(1),
    revision: z.string().min(1),
    sessionId: z.string().min(1),
    prUrl: z.string().min(1),
    repository: z.string().min(1),
    headSha: z.string().regex(/^[a-f0-9]{40,64}$/i),
  })
  .strict();
export type AutomationEvidence = z.infer<typeof automationEvidenceSchema>;
