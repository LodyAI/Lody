import { z } from 'zod';

import { ProjectRefSchema } from './message-schemas';
import type { ProjectRef } from './project';
import { classifyPermissionModeFace, type AcpCapabilityCacheEntry } from './ai';
import { isSensitiveAcpConfigOptionId } from './session-preparation';

export const SCHEDULE_PROMPT_MAX_BYTES = 32 * 1024;
export const SCHEDULE_PROTOCOL_VERSION = 1;
export const SCHEDULE_DISPATCH_MAX_ATTEMPTS = 5;
export const SCHEDULE_DISPATCH_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const SCHEDULE_MISFIRE_GRACE_MS = 2 * 60 * 1000;
export const SCHEDULE_RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 1_800_000] as const;

const instant = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const identifier = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9_-]+$/);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);

export const ScheduleTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: instant }).strict(),
  z
    .object({
      kind: z.literal('interval'),
      everyMs: z.number().int().min(60_000),
      anchorAt: instant,
    })
    .strict(),
  z
    .object({
      kind: z.literal('cron'),
      expression: z.string().trim().min(1).max(256),
      timeZone: z.string().min(1).max(100),
    })
    .strict(),
]);
export type ScheduleTrigger = z.infer<typeof ScheduleTriggerSchema>;

export const ScheduleAgentSchema = z
  .object({
    agentConfigId: z.string().min(1),
    modeId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    configOptionValues: z
      .record(
        z
          .string()
          .min(1)
          .max(100)
          .refine(
            (key) => !isSensitiveAcpConfigOptionId(key),
            'Credentials belong in the Agent configuration'
          ),
        z.string().max(1024)
      )
      .refine((value) => Object.keys(value).length <= 50, 'Too many config options')
      .optional(),
  })
  .strict();

export const ScheduleDefinitionSchema = z
  .object({
    scheduleId: identifier,
    title: z.string().trim().min(1).max(200),
    ownerId: z.string().min(1),
    // Pin execution to the machine that the human authorized. Moving an Agent
    // config must not silently migrate schedules to another local ledger.
    machineId: z.string().min(1),
    enabled: z.boolean(),
    activationId: identifier,
    activeFrom: timestamp,
    trigger: ScheduleTriggerSchema,
    misfirePolicy: z.object({ kind: z.enum(['skip', 'run_once']) }).strict(),
    overlapPolicy: z.enum(['skip', 'queue_one']),
    agent: ScheduleAgentSchema,
    project: ProjectRefSchema.transform((value) => value as ProjectRef),
    retryPolicy: z
      .object({
        dispatchMaxAttempts: z.number().int().min(1).max(SCHEDULE_DISPATCH_MAX_ATTEMPTS),
        dispatchMaxAgeMs: z.number().int().min(1).max(SCHEDULE_DISPATCH_MAX_AGE_MS),
      })
      .strict(),
    createdAt: timestamp,
    updatedAt: timestamp,
    createdBy: z.string().min(1),
  })
  .strict();
export type ScheduleDefinition = z.infer<typeof ScheduleDefinitionSchema>;

export const ScheduleActivitySchema = z
  .object({
    id: identifier,
    kind: z.enum(['created', 'edited', 'paused', 'resumed', 'deleted', 'manual_run']),
    requesterSessionId: identifier.optional(),
    actorId: z.string().min(1),
    createdAt: timestamp,
  })
  .strict();
export type ScheduleActivity = z.infer<typeof ScheduleActivitySchema>;

export type ScheduleDocument = {
  definition: ScheduleDefinition;
  prompt: string;
  timeline: ScheduleActivity[];
};

export const ScheduleRegistryRowSchema = ScheduleDefinitionSchema.pick({
  scheduleId: true,
  title: true,
  ownerId: true,
  machineId: true,
  enabled: true,
  activationId: true,
  activeFrom: true,
  trigger: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  elevatedPermissions: z.boolean().default(false),
  definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  agentConfigId: z.string().min(1),
  projectKind: z.enum(['local', 'github']),
  projectKey: z.string().min(1),
});
export type ScheduleRegistryRow = z.infer<typeof ScheduleRegistryRowSchema>;

export const ScheduleRuntimeRowSchema = z.object({
  scheduleId: identifier,
  machineId: z.string().min(1),
  activationId: identifier,
  observedDefinitionFingerprint: z.string(),
  nextScheduledAt: timestamp.optional(),
  queueState: z.enum(['due', 'waiting_for_agent', 'retrying', 'blocked']).optional(),
  blockedCode: z.string().max(100).optional(),
  lastDispatch: z
    .object({ scheduledFor: timestamp, dispatchedAt: timestamp, sessionId: z.string() })
    .optional(),
  updatedAt: timestamp,
});
export type ScheduleRuntimeRow = z.infer<typeof ScheduleRuntimeRowSchema>;

export const ScheduleTombstoneSchema = z.object({
  deletedAt: timestamp,
  actorId: z.string().min(1),
});

export const SCHEDULE_RUN_STATES = [
  'pending',
  'claimed',
  'session_prepared',
  'retry_wait',
  'dispatched',
  'finished',
  'failed',
  'skipped',
] as const;
export type ScheduleRunState = (typeof SCHEDULE_RUN_STATES)[number];

/** Permission is an advertised semantic category, never inferred from an id. */
export function hasExplicitSchedulePermission(
  agent: z.infer<typeof ScheduleAgentSchema>,
  capability: Pick<AcpCapabilityCacheEntry, 'modes' | 'configOptions'> | undefined
): boolean {
  if (!capability) return false;
  const explicit =
    capability.configOptions?.filter((option) => option.category === '_permission') ?? [];
  const accepts = (option: NonNullable<typeof capability.configOptions>[number]): boolean => {
    const value = agent.configOptionValues?.[option.id];
    return (
      value !== undefined &&
      (option.type === 'boolean'
        ? value === 'true' || value === 'false'
        : option.options.some((entry) => entry.value === value))
    );
  };
  if (explicit.length) return explicit.some(accepts);
  return (
    (!!agent.modeId && capability.modes.some((mode) => mode.id === agent.modeId)) ||
    (capability.configOptions ?? []).some(
      (option) => option.category === 'mode' && option.id !== 'interaction_mode' && accepts(option)
    )
  );
}

export function validateSchedulePrompt(prompt: string): void {
  if (!prompt.trim() || new TextEncoder().encode(prompt).length > SCHEDULE_PROMPT_MAX_BYTES) {
    throw new Error('Schedule prompt must contain text and be at most 32 KiB');
  }
}

export function scheduleUsesElevatedPermissions(
  agent: z.infer<typeof ScheduleAgentSchema>
): boolean {
  return [agent.modeId, ...Object.values(agent.configOptionValues ?? {})].some((value) => {
    const face = classifyPermissionModeFace(value);
    return face.kind !== 'hidden' && face.tone === 'warning';
  });
}
