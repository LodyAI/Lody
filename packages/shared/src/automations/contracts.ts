import type { AutomationEvidence } from './reads';
import { z } from 'zod';

const id = z.string().min(1).max(512);
const timestamp = z.number().int().nonnegative();
const jsonObject = z
  .record(z.string(), z.json())
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024,
    'Automation data exceeds 64 KiB'
  );

export const automationScopeSchema = z
  .object({
    workspaceId: id,
    sessionId: id.optional(),
    projectId: id.optional(),
  })
  .strict();

export const automationEventSchema = z
  .object({
    id,
    source: id,
    type: id,
    version: z.number().int().positive(),
    subject: id,
    occurredAt: timestamp.optional(),
    observedAt: timestamp,
    scope: automationScopeSchema,
    data: jsonObject,
    provenance: z.enum(['callback', 'poll', 'timer', 'command']),
    completeness: z.enum(['observed', 'gap', 'backfill']),
    correlationId: id.optional(),
    causationId: id.optional(),
    depth: z.number().int().nonnegative().default(0),
  })
  .strict();
export type AutomationEvent = z.infer<typeof automationEventSchema>;

/** Parameters belong to the named Host adapter, not an expression language. */
export const automationConditionSchema = z
  .object({
    kind: id,
    parameters: jsonObject,
  })
  .strict();
export type AutomationCondition = z.infer<typeof automationConditionSchema>;
export type ConditionObservation = {
  value: 'yes' | 'no' | 'unknown';
  reason: string;
  retryAt?: number;
};

export const automationTargetSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('existing'),
      sessionId: id,
      onUnavailable: z.enum(['blocked', 'fail']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('new'),
      agentRoleId: id,
      machineId: id,
      projectId: id.optional(),
      parentSessionId: id.optional(),
    })
    .strict(),
]);

export const automationInvocationSchema = z
  .object({
    target: automationTargetSchema,
    input: z
      .object({
        kind: z.enum(['external_event', 'pending_work']),
        ref: id,
        values: jsonObject.optional(),
      })
      .strict(),
    ifBusy: z.enum(['enqueue', 'reject']).default('enqueue'),
    requiredCapacity: z.object({ bindingId: id, modelId: id.optional() }).strict().optional(),
  })
  .strict();
export type AutomationInvocation = z.infer<typeof automationInvocationSchema>;

export const automationActionSchema = z.object({ kind: id, parameters: jsonObject }).strict();
export type AutomationAction = z.infer<typeof automationActionSchema>;
export const automationContinuationSchema = z
  .object({
    key: id,
    condition: automationConditionSchema.optional(),
    guard: automationConditionSchema.optional(),
    action: automationActionSchema,
    notBefore: timestamp.optional(),
  })
  .strict();
export type AutomationContinuation = z.infer<typeof automationContinuationSchema>;

/** Internal grants derive from authenticated registration and fixed product policy. */
export const automationGrantSchema = z
  .object({
    actions: z.array(id).max(64),
    sessionIds: z.array(id).max(256),
    agentRoleIds: z.array(id).max(64),
    bindingIds: z.array(id).max(64),
    allowLinkedSession: z.boolean(),
    allowCapacityAttempt: z.boolean(),
  })
  .strict();
export type AutomationGrant = z.infer<typeof automationGrantSchema>;

export const automationRuleDraftSchema = z
  .object({
    id,
    name: z.string().min(1).max(200),
    scope: automationScopeSchema,
    selector: z
      .object({
        types: z.array(id).min(1).max(64),
        sources: z.array(id).max(64).optional(),
        subject: id.optional(),
      })
      .strict(),
    handler: z.discriminatedUnion('kind', [
      z
        .object({
          kind: z.literal('policy'),
          policy: z.enum(['archive-after-merge', 'compact-idle', 'recover-capacity']),
          options: jsonObject,
        })
        .strict(),
      z
        .object({
          kind: z.literal('agent'),
          invocation: automationInvocationSchema,
          guard: automationConditionSchema.optional(),
        })
        .strict(),
    ]),
    grants: automationGrantSchema,
    enabled: z.boolean(),
    budget: z
      .object({
        maxActionsPerEvent: z.number().int().min(1).max(256),
        maxInvocationsPerCorrelation: z.number().int().min(1).max(1000),
        maxPendingActions: z.number().int().min(1).max(10000).optional(),
        maxDepth: z.number().int().min(1).max(64),
      })
      .strict(),
  })
  .strict();
export type AutomationRuleDraft = z.infer<typeof automationRuleDraftSchema>;
export const automationRuleSchema = automationRuleDraftSchema.extend({
  revision: z.number().int().positive(),
  ownerUserId: id,
  ownerMachineId: id,
  activationSequence: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
});
export type AutomationRule = z.infer<typeof automationRuleSchema>;

export const automationOriginSchema = z
  .object({
    invocationId: id,
    ruleId: id,
    ruleRevision: z.number().int().positive(),
    eventRef: id,
    authorizationUserId: id,
    expectedHeads: z
      .array(z.object({ repository: id, headSha: z.string().regex(/^[a-f0-9]{40,64}$/i) }).strict())
      .optional(),
    workIntentId: id.optional(),
    nativeSessionId: id.optional(),
    maintenance: z
      .object({ kind: z.literal('compact'), idleTurnId: id, expiresAt: timestamp })
      .strict()
      .optional(),
  })
  .strict();
export type AutomationOrigin = z.infer<typeof automationOriginSchema>;

export type AutomationState =
  | 'accepted'
  | 'waiting'
  | 'resolved'
  | 'submitting'
  | 'queued'
  | 'running'
  | 'blocked'
  | 'settled'
  | 'failed'
  | 'unknown'
  | 'cancelling'
  | 'cancelled'
  | 'superseded';
export type AutomationReceipt = {
  id: string;
  deliveryId: string;
  evidence?: AutomationEvidence[];
  rule: AutomationRule;
  event: AutomationEvent;
  intent: AutomationContinuation;
  state: AutomationState;
  reason?: string;
  retryAt?: number;
  attempts: number;
  sessionId: string;
  turnId: string;
  prepared?: z.infer<typeof jsonObject>;
  createdAt: number;
  updatedAt: number;
};

export type CapacityObservation = {
  bindingId: string;
  fingerprint: string;
  modelId?: string;
  observedAt: number;
  validUntil: number;
  source: 'query' | 'push' | 'exhaustion';
  authentication: 'valid' | 'invalid' | 'unknown';
  billing: 'valid' | 'invalid' | 'unknown';
  windows: Array<{
    id: string;
    usedPercent: number;
    resetsAt?: number;
    observedAt?: number;
    validUntil?: number;
  }>;
};

export type PendingWork = {
  id: string;
  ownerUserId: string;
  updatedAt: number;
  sessionId: string;
  turnId: string;
  nativeSessionId: string;
  bindingId: string;
  fingerprint: string;
  modelId?: string;
  inputRef: string;
  confirmedBoundary: string;
  unresolvedEffects: boolean;
  release: 'released' | 'native_waiting' | 'unknown';
  state:
    | 'blocked_on_capacity'
    | 'queued'
    | 'running'
    | 'settled'
    | 'cancelled'
    | 'failed'
    | 'unknown';
  invocationId?: string;
  notBefore?: number;
  attempts: number;
  origin?: AutomationOrigin;
};
