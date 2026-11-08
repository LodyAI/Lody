import { z } from 'zod/v4';

/**
 * A time rule as the editor names it, never cron. `manual` runs only on
 * request; `unsupported` is a stored rule no named kind expresses (shown
 * read-only via `summary`, re-emitted verbatim while untouched).
 */
export const ScheduleRule = z
  .object({
    kind: z.enum([
      'manual',
      'once',
      'minutes',
      'hours',
      'daily',
      'weekdays',
      'weekly',
      'monthly',
      'unsupported',
    ]),
    /** `minutes` / `hours` step. */
    every: z.number().int().optional(),
    hour: z.number().int().optional(),
    minute: z.number().int().optional(),
    /** `weekly`: Sunday = 0 … Saturday = 6. */
    weekdays: z.array(z.number().int()).optional(),
    /** `monthly`: 1–31. */
    days: z.array(z.number().int()).optional(),
    /** `once`: epoch milliseconds. */
    at: z.number().optional(),
    /** IANA zone a wall-clock rule is authored in. */
    timeZone: z.string().optional(),
    /** `unsupported`: the stored cron expression or interval, verbatim. */
    summary: z.string().optional(),
  })
  .meta({ id: 'ScheduleRule' });

export const ScheduleState = z
  .object({
    group: z.enum(['running', 'paused', 'attention', 'ended']),
    kind: z.enum([
      'sent',
      'cancelled',
      'notSent',
      'cancelling',
      'sendsAt',
      'waitingToSend',
      'paused',
      'blocked',
      'retrying',
      'due',
      'waitingForAgent',
      'manual',
      'runsAt',
      'done',
      'notScheduled',
    ]),
    /** Epoch milliseconds the state refers to (next run, last run, …). */
    at: z.number().optional(),
    blockedCode: z.string().optional(),
  })
  .meta({ id: 'ScheduleState' });

export const ScheduleProject = z
  .object({
    kind: z.enum(['local', 'github']),
    localProjectId: z.string().optional(),
    repoFullName: z.string().optional(),
    branch: z.string().optional(),
    useWorktree: z.boolean().optional(),
    /** Display name resolved by the runtime (read only). */
    name: z.string().optional(),
  })
  .meta({ id: 'ScheduleProject' });

export const ScheduleItem = z
  .object({
    scheduleId: z.string().min(1),
    title: z.string(),
    ownerId: z.string(),
    /** The signed-in user owns it: only the owner may change it. */
    isOwner: z.boolean(),
    machineId: z.string(),
    machineName: z.string().optional(),
    /** The machine runs a CLI that can execute edits, resumes and runs. */
    machineSupported: z.boolean(),
    agentConfigId: z.string(),
    agentName: z.string().optional(),
    agentType: z.string().optional(),
    enabled: z.boolean(),
    /** A one-time message into a chat; read only on mobile (delete only). */
    scheduledMessage: z.boolean(),
    rule: ScheduleRule,
    destination: z.enum(['new_session', 'own_session', 'existing_session']),
    destinationSessionId: z.string().optional(),
    projectKind: z.enum(['local', 'github']).optional(),
    projectKey: z.string().optional(),
    projectName: z.string().optional(),
    state: ScheduleState,
    lastRunAt: z.number().optional(),
    lastSessionId: z.string().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
  })
  .meta({ id: 'ScheduleItem' });

export const SchedulesParams = z
  .object({ workspaceId: z.string().min(1) })
  .meta({ id: 'SchedulesParams' });

export const SchedulesResult = z
  .object({
    items: z.array(ScheduleItem),
    /** IANA zone of the device runtime (fallback for older machines). */
    deviceTimeZone: z.string(),
    /** Machines' IANA zones by id, for authoring wall-clock rules. */
    machineTimeZones: z.record(z.string(), z.string()),
    /** Computers the signed-in user owns: the only ones a schedule can target. */
    ownedMachineIds: z.array(z.string()),
  })
  .meta({ id: 'SchedulesResult' });

export const ScheduleDetailParams = z
  .object({
    workspaceId: z.string().min(1),
    scheduleId: z.string().min(1),
  })
  .meta({ id: 'ScheduleDetailParams' });

export const ScheduleDetail = z
  .object({
    item: ScheduleItem,
    prompt: z.string(),
    modelId: z.string().optional(),
    modeId: z.string().optional(),
    project: ScheduleProject.optional(),
  })
  .meta({ id: 'ScheduleDetail' });

export const ScheduleDraft = z
  .object({
    title: z.string(),
    prompt: z.string(),
    machineId: z.string().min(1),
    agentConfigId: z.string().min(1),
    modelId: z.string().optional(),
    modeId: z.string().optional(),
    project: ScheduleProject.optional(),
    /** A picked chat (`existing_session`) stays on web. */
    destination: z.enum(['new_session', 'own_session']),
    rule: ScheduleRule,
  })
  .meta({ id: 'ScheduleDraft' });

export const ScheduleCommandParams = z
  .object({
    workspaceId: z.string().min(1),
    action: z.enum(['create', 'edit', 'pause', 'resume', 'run', 'delete']),
    /** Caller-chosen for `create`; `[A-Za-z0-9_-]{1,50}`. */
    scheduleId: z.string().min(1),
    /**
     * Idempotency key, `[A-Za-z0-9_-]{1,50}`. Reuse it only to retry the same
     * command after an unknown outcome; a new intent needs a new key.
     */
    requestId: z.string().min(1),
    draft: ScheduleDraft.optional(),
  })
  .meta({ id: 'ScheduleCommandParams' });

export const ScheduleCommandResult = z
  .object({ scheduleId: z.string() })
  .meta({ id: 'ScheduleCommandResult' });
