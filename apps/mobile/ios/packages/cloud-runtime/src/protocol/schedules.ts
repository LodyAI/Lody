import { z } from 'zod/v4';

// Scheduled tasks, ported from web @lody/shared `schedule-types.ts`,
// `schedule-registry.ts`, `schedule-recurrence.ts` and components
// `schedule-format.ts` (the shared root is not browser-safe). The owning
// machine recomputes the definition fingerprint from the stored document, so
// every schema below must parse and normalise exactly like the shared one:
// a drift here leaves a saved schedule blocked on DEFINITION_NOT_COMMITTED.

const instant = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());
const identifier = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[a-zA-Z0-9_-]+$/);
const timestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);

export const SCHEDULE_PROMPT_MAX_BYTES = 32 * 1024;
/** Machines below this `schedules` protocol cannot run prompt schedules. */
export const SCHEDULES_PROMPT_PROTOCOL_VERSION = 2;

export const ScheduleTriggerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('manual') }).strict(),
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
export type TimedScheduleTrigger = Exclude<ScheduleTrigger, { kind: 'manual' }>;

export const ScheduleDestinationSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('new_session') }).strict(),
  z
    .object({
      kind: z.literal('own_session'),
      epoch: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('existing_session'),
      sessionId: z.string().min(1),
    })
    .strict(),
]);
export type ScheduleDestination = z.infer<typeof ScheduleDestinationSchema>;

const SENSITIVE_OPTION_ID =
  /(?:api[_-]?key|auth|bearer|credential|password|passwd|secret|token)/i;

export const ScheduleAgentSchema = z
  .object({
    memory: z
      .object({
        providerId: z.string().trim().min(1).max(100),
        memoryId: z.string().trim().min(1).max(200),
      })
      .strict()
      .optional(),
    agentConfigId: z.string().min(1),
    modeId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    configOptionValues: z
      .record(
        z
          .string()
          .min(1)
          .max(100)
          .refine((key) => !SENSITIVE_OPTION_ID.test(key)),
        z
          .union([z.string(), z.boolean()])
          .refine((value) => typeof value !== 'string' || value.length <= 1024),
      )
      .refine((value) => Object.keys(value).length <= 50)
      .optional(),
  })
  .strict();
export type ScheduleAgent = z.infer<typeof ScheduleAgentSchema>;

export const ScheduleProjectRefSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('github'),
      repoFullName: z.string(),
      branch: z.string().trim().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('local'),
      localProjectId: z.string(),
      branch: z.string().trim().min(1).optional(),
      githubRepoFullName: z.string().trim().min(1).optional(),
      useWorktree: z.boolean().optional(),
    })
    .strict(),
]);
export type ScheduleProjectRef = z.infer<typeof ScheduleProjectRefSchema>;

export const ScheduleDefinitionSchema = z
  .object({
    scheduleId: identifier,
    messageVersion: z.literal(1).optional(),
    title: z.string().trim().min(1).max(200),
    ownerId: z.string().min(1),
    machineId: z.string().min(1),
    enabled: z.boolean(),
    activationId: identifier,
    activeFrom: timestamp,
    trigger: ScheduleTriggerSchema,
    misfirePolicy: z.object({ kind: z.enum(['skip', 'run_once']) }).strict(),
    overlapPolicy: z.enum(['skip', 'queue_one']),
    agent: ScheduleAgentSchema,
    project: ScheduleProjectRefSchema.optional(),
    destination: ScheduleDestinationSchema.default({ kind: 'new_session' }),
    retryPolicy: z
      .object({
        dispatchMaxAttempts: z.number().int().min(1).max(5),
        dispatchMaxAgeMs: z
          .number()
          .int()
          .min(1)
          .max(24 * 60 * 60 * 1000),
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
    kind: z.enum([
      'created',
      'edited',
      'paused',
      'resumed',
      'deleted',
      'manual_run',
    ]),
    requesterSessionId: identifier.optional(),
    actorId: z.string().min(1),
    createdAt: timestamp,
  })
  .strict();
export type ScheduleActivity = z.infer<typeof ScheduleActivitySchema>;

/** A prompt-only document. Scheduled messages are read-only on mobile. */
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
  destination: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  elevatedPermissions: z.boolean().default(false),
  scheduledMessage: z.literal(true).optional(),
  definitionFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  agentConfigId: z.string().min(1),
  projectKind: z.enum(['local', 'github']).optional(),
  projectKey: z.string().min(1).optional(),
});
export type ScheduleRegistryRow = z.infer<typeof ScheduleRegistryRowSchema>;

export const ScheduleRuntimeRowSchema = z.object({
  scheduleId: identifier,
  machineId: z.string().min(1),
  activationId: identifier,
  observedDefinitionFingerprint: z.string(),
  nextScheduledAt: timestamp.optional(),
  queueState: z
    .enum(['due', 'waiting_for_agent', 'retrying', 'blocked'])
    .optional(),
  blockedCode: z.string().max(100).optional(),
  messageState: z.enum(['pending', 'sent', 'cancelled', 'failed']).optional(),
  lastDispatch: z
    .object({
      scheduledFor: timestamp,
      dispatchedAt: timestamp,
      sessionId: z.string(),
    })
    .optional(),
  updatedAt: timestamp,
});
export type ScheduleRuntimeRow = z.infer<typeof ScheduleRuntimeRowSchema>;

export const ScheduleTombstoneSchema = z.object({
  deletedAt: timestamp,
  actorId: z.string().min(1),
});

export const getScheduleRegistryStreamId = (workspaceId: string) =>
  `${workspaceId}:sr`;
export const getScheduleStreamId = (workspaceId: string, id: string) =>
  `${workspaceId}:schedule:${id}`;
export const scheduleRegistryKeys = {
  schedule: (id: string): string[] => ['schedule', id],
  runtime: (id: string, machineId: string): string[] => [
    'runtime',
    id,
    machineId,
  ],
  tombstone: (id: string): string[] => ['tombstone', id],
  manual: (id: string, requestId: string): string[] => [
    'manual',
    id,
    requestId,
  ],
};
export const isScheduleIdentifier = (value: string) =>
  identifier.safeParse(value).success;

/** Stable across object insertion order, on Node and every UI runtime. */
export function canonicalScheduleJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry !== null && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, normalize(v)]),
      );
    return entry;
  };
  return JSON.stringify(normalize(value));
}

async function digest(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(canonicalScheduleJson(value)),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function validateSchedulePrompt(prompt: string): void {
  if (
    !prompt.trim() ||
    new TextEncoder().encode(prompt).length > SCHEDULE_PROMPT_MAX_BYTES
  )
    throw new Error('schedule_prompt_invalid');
}

const CRON_DAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/** Accepts only the portable five-field syntax the machine accepts. */
export function validateScheduleTrigger(value: unknown): ScheduleTrigger {
  const trigger = ScheduleTriggerSchema.parse(value);
  if (trigger.kind !== 'cron') return trigger;
  const fields = trigger.expression.trim().split(/\s+/);
  const names = new RegExp(
    `(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|${CRON_DAY_NAMES.join('|')})`,
    'gi',
  );
  if (
    fields.length !== 5 ||
    fields.some((field) => !/^[\d*,/\-A-Za-z]+$/.test(field)) ||
    /[LW?#@+]/i.test(trigger.expression.replace(names, ''))
  )
    throw new Error('schedule_trigger_invalid');
  new Intl.DateTimeFormat('en', { timeZone: trigger.timeZone }).format(0);
  return trigger;
}

/** Same execution digest as `scheduleDefinitionFingerprint` in shared. */
export async function scheduleDefinitionFingerprint(
  document: Pick<ScheduleDocument, 'definition' | 'prompt'>,
): Promise<string> {
  const definition = ScheduleDefinitionSchema.parse(document.definition);
  validateScheduleTrigger(definition.trigger);
  if (definition.messageVersion === 1)
    throw new Error('schedule_message_read_only');
  validateSchedulePrompt(document.prompt);
  const {
    title: _title,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    createdBy: _createdBy,
    ...execution
  } = definition;
  return digest({ definition: execution, prompt: document.prompt });
}

const WARNING_MODES = new Set([
  'agent-full-access',
  'danger-full-access',
  'dontAsk',
  'bypassPermissions',
  'yolo',
  'always-approve',
]);

export function scheduleUsesElevatedPermissions(agent: ScheduleAgent) {
  return [agent.modeId, ...Object.values(agent.configOptionValues ?? {})].some(
    (value) => typeof value === 'string' && WARNING_MODES.has(value),
  );
}

export async function buildScheduleRegistryRow(
  document: ScheduleDocument,
): Promise<ScheduleRegistryRow> {
  const d = document.definition;
  return ScheduleRegistryRowSchema.parse({
    scheduleId: d.scheduleId,
    title: d.title,
    ownerId: d.ownerId,
    machineId: d.machineId,
    enabled: d.enabled,
    activationId: d.activationId,
    activeFrom: d.activeFrom,
    trigger: d.trigger,
    destination: d.destination,
    agentConfigId: d.agent.agentConfigId,
    projectKind: d.project?.kind,
    projectKey: d.project
      ? d.project.kind === 'local'
        ? d.project.localProjectId
        : d.project.repoFullName
      : undefined,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
    elevatedPermissions: scheduleUsesElevatedPermissions(d.agent),
    definitionFingerprint: await scheduleDefinitionFingerprint(document),
  });
}

export type ScheduleScanRow = { key: readonly unknown[]; value?: unknown };

export function readScheduleRegistry(scanned: Iterable<ScheduleScanRow>) {
  const rows = new Map<string, ScheduleRegistryRow>();
  const runtimes: ScheduleRuntimeRow[] = [];
  const deleted = new Set<string>();
  for (const entry of scanned) {
    if (entry.key[0] === 'runtime' && entry.key.length === 3) {
      const parsed = ScheduleRuntimeRowSchema.safeParse(entry.value);
      if (
        parsed.success &&
        entry.key[1] === parsed.data.scheduleId &&
        entry.key[2] === parsed.data.machineId
      )
        runtimes.push(parsed.data);
      continue;
    }
    if (entry.key.length !== 2 || typeof entry.key[1] !== 'string') continue;
    if (
      entry.key[0] === 'tombstone' &&
      ScheduleTombstoneSchema.safeParse(entry.value).success
    )
      deleted.add(entry.key[1]);
    if (entry.key[0] !== 'schedule') continue;
    const result = ScheduleRegistryRowSchema.safeParse(entry.value);
    if (result.success && result.data.scheduleId === entry.key[1])
      rows.set(entry.key[1], result.data);
  }
  return {
    rows: [...rows.values()].filter((row) => !deleted.has(row.scheduleId)),
    runtimes,
  };
}

// --- Recurrence: the named rules a person picks, never cron. ---

export type ScheduleRecurrence =
  | { kind: 'minutes'; every: number; timeZone: string }
  | { kind: 'hours'; every: number; timeZone: string }
  | { kind: 'daily'; hour: number; minute: number; timeZone: string }
  | { kind: 'weekdays'; hour: number; minute: number; timeZone: string }
  | {
      kind: 'weekly';
      weekdays: number[];
      hour: number;
      minute: number;
      timeZone: string;
    }
  | {
      kind: 'monthly';
      days: number[];
      hour: number;
      minute: number;
      timeZone: string;
    }
  | { kind: 'once'; at: string }
  | { kind: 'unsupported'; trigger: TimedScheduleTrigger };

const WORKWEEK = [1, 2, 3, 4, 5];

export function deviceTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function parseFixedNumber(field: string, min: number, max: number) {
  if (!/^\d{1,2}$/.test(field)) return null;
  const value = Number(field);
  return value >= min && value <= max ? value : null;
}
function parseStep(field: string) {
  const match = /^\*\/(\d{1,2})$/.exec(field);
  const value = match ? Number(match[1]) : NaN;
  return Number.isInteger(value) && value >= 1 ? value : null;
}
function parseWeekdayToken(token: string) {
  const named = CRON_DAY_NAMES.indexOf(token.toUpperCase());
  if (named >= 0) return named;
  if (!/^\d$/.test(token)) return null;
  const value = Number(token);
  return value <= 7 ? value : null;
}
/** Sunday is 0 or 7; fold only after a range has been expanded. */
function parseWeekdayField(field: string) {
  const found = new Set<number>();
  for (const part of field.split(',')) {
    if (part.includes('/') || part === '') return null;
    const bounds = part.split('-');
    if (bounds.length > 2) return null;
    const from = parseWeekdayToken(bounds[0]!);
    const to = bounds.length === 2 ? parseWeekdayToken(bounds[1]!) : from;
    if (from === null || to === null || from > to) return null;
    for (let day = from; day <= to; day++) found.add(day % 7);
  }
  return found.size ? [...found].sort((a, b) => a - b) : null;
}
function parseDayOfMonthField(field: string) {
  const found = new Set<number>();
  for (const part of field.split(',')) {
    if (part.includes('/') || part === '') return null;
    const bounds = part.split('-');
    if (bounds.length > 2) return null;
    const from = parseFixedNumber(bounds[0]!, 1, 31);
    const to = bounds.length === 2 ? parseFixedNumber(bounds[1]!, 1, 31) : from;
    if (from === null || to === null || from > to) return null;
    for (let day = from; day <= to; day++) found.add(day);
  }
  return found.size ? [...found].sort((a, b) => a - b) : null;
}
const sortedSet = (values: readonly number[]) =>
  [...new Set(values)].sort((a, b) => a - b);
const sameSet = (a: readonly number[], b: readonly number[]) =>
  sortedSet(a).join(',') === sortedSet(b).join(',');

export function triggerToRecurrence(
  trigger: TimedScheduleTrigger,
): ScheduleRecurrence {
  if (trigger.kind === 'once') return { kind: 'once', at: trigger.at };
  const unsupported: ScheduleRecurrence = { kind: 'unsupported', trigger };
  if (trigger.kind === 'interval') {
    if (trigger.everyMs % 3_600_000 === 0)
      return {
        kind: 'hours',
        every: trigger.everyMs / 3_600_000,
        timeZone: deviceTimeZone(),
      };
    if (trigger.everyMs % 60_000 === 0)
      return {
        kind: 'minutes',
        every: trigger.everyMs / 60_000,
        timeZone: deviceTimeZone(),
      };
    return unsupported;
  }
  const fields = trigger.expression.trim().split(/\s+/);
  if (fields.length !== 5) return unsupported;
  const [minuteField, hourField, dayField, monthField, weekdayField] =
    fields as [string, string, string, string, string];
  if (monthField !== '*') return unsupported;
  const unrestrictedDays = dayField === '*' && weekdayField === '*';
  const minuteStep = parseStep(minuteField);
  if (minuteStep !== null)
    return hourField === '*' && unrestrictedDays
      ? { kind: 'minutes', every: minuteStep, timeZone: trigger.timeZone }
      : unsupported;
  const hourStep = parseStep(hourField);
  if (hourStep !== null)
    return minuteField === '0' && unrestrictedDays
      ? { kind: 'hours', every: hourStep, timeZone: trigger.timeZone }
      : unsupported;
  const minute = parseFixedNumber(minuteField, 0, 59);
  const hour = parseFixedNumber(hourField, 0, 23);
  if (minute === null || hour === null) return unsupported;
  const time = { hour, minute, timeZone: trigger.timeZone };
  if (dayField === '*') {
    if (weekdayField === '*') return { kind: 'daily', ...time };
    const weekdays = parseWeekdayField(weekdayField);
    if (!weekdays) return unsupported;
    if (sameSet(weekdays, WORKWEEK)) return { kind: 'weekdays', ...time };
    if (weekdays.length === 7) return { kind: 'daily', ...time };
    return { kind: 'weekly', weekdays, ...time };
  }
  if (weekdayField !== '*') return unsupported;
  const days = parseDayOfMonthField(dayField);
  return days ? { kind: 'monthly', days, ...time } : unsupported;
}

const wholeIn = (value: number, min: number, max: number) =>
  Number.isInteger(value) && value >= min && value <= max;

export function recurrenceToTrigger(
  recurrence: ScheduleRecurrence,
  now: number,
): ScheduleTrigger {
  switch (recurrence.kind) {
    case 'once':
      return validateScheduleTrigger({ kind: 'once', at: recurrence.at });
    case 'unsupported':
      return validateScheduleTrigger(recurrence.trigger);
    case 'minutes':
      if (!wholeIn(recurrence.every, 1, 1440))
        throw new Error('schedule_trigger_invalid');
      return 60 % recurrence.every === 0
        ? validateScheduleTrigger({
            kind: 'cron',
            expression: `*/${recurrence.every} * * * *`,
            timeZone: recurrence.timeZone,
          })
        : validateScheduleTrigger({
            kind: 'interval',
            everyMs: recurrence.every * 60_000,
            anchorAt: new Date(now).toISOString(),
          });
    case 'hours':
      if (!wholeIn(recurrence.every, 1, 168))
        throw new Error('schedule_trigger_invalid');
      return 24 % recurrence.every === 0
        ? validateScheduleTrigger({
            kind: 'cron',
            expression: `0 */${recurrence.every} * * *`,
            timeZone: recurrence.timeZone,
          })
        : validateScheduleTrigger({
            kind: 'interval',
            everyMs: recurrence.every * 3_600_000,
            anchorAt: new Date(now).toISOString(),
          });
    default: {
      if (
        !wholeIn(recurrence.hour, 0, 23) ||
        !wholeIn(recurrence.minute, 0, 59)
      )
        throw new Error('schedule_trigger_invalid');
      let weekdayField = '*';
      if (recurrence.kind === 'weekdays') weekdayField = '1-5';
      if (recurrence.kind === 'weekly') {
        if (recurrence.weekdays.some((day) => !wholeIn(day, 0, 6)))
          throw new Error('schedule_trigger_invalid');
        weekdayField = sortedSet(recurrence.weekdays).join(',');
      }
      if (!weekdayField) throw new Error('schedule_trigger_invalid');
      let dayField = '*';
      if (recurrence.kind === 'monthly') {
        if (recurrence.days.some((day) => !wholeIn(day, 1, 31)))
          throw new Error('schedule_trigger_invalid');
        dayField = sortedSet(recurrence.days).join(',');
      }
      if (!dayField) throw new Error('schedule_trigger_invalid');
      return validateScheduleTrigger({
        kind: 'cron',
        expression: `${recurrence.minute} ${recurrence.hour} ${dayField} * ${weekdayField}`,
        timeZone: recurrence.timeZone,
      });
    }
  }
}

function sameRecurrence(a: ScheduleRecurrence, b: ScheduleRecurrence) {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case 'once':
      return Date.parse(a.at) === Date.parse((b as typeof a).at);
    case 'minutes':
    case 'hours':
      return (
        a.every === (b as typeof a).every &&
        a.timeZone === (b as typeof a).timeZone
      );
    case 'unsupported':
      return (
        canonicalScheduleJson(a.trigger) ===
        canonicalScheduleJson((b as typeof a).trigger)
      );
    default: {
      const other = b as typeof a;
      if (
        a.hour !== other.hour ||
        a.minute !== other.minute ||
        a.timeZone !== other.timeZone
      )
        return false;
      if (a.kind === 'weekly')
        return sameSet(a.weekdays, (other as typeof a).weekdays);
      if (a.kind === 'monthly')
        return sameSet(a.days, (other as typeof a).days);
      return true;
    }
  }
}

/**
 * An untouched rule re-emits the stored trigger verbatim, so opening a
 * `MON-FRI` schedule and saving does not rewrite it and change its fingerprint.
 */
export function applyScheduleRecurrence(
  recurrence: ScheduleRecurrence | null,
  now: number,
  previous?: ScheduleTrigger,
): ScheduleTrigger {
  if (!recurrence) return { kind: 'manual' };
  if (
    previous &&
    previous.kind !== 'manual' &&
    sameRecurrence(triggerToRecurrence(previous), recurrence)
  )
    return previous;
  return recurrenceToTrigger(recurrence, now);
}

// --- Status in words, as `describeScheduleState` (natives localise `kind`). ---

export type ScheduleStateKind =
  | 'sent'
  | 'cancelled'
  | 'notSent'
  | 'cancelling'
  | 'sendsAt'
  | 'waitingToSend'
  | 'paused'
  | 'blocked'
  | 'retrying'
  | 'due'
  | 'waitingForAgent'
  | 'manual'
  | 'runsAt'
  | 'done'
  | 'notScheduled';
export type ScheduleState = {
  group: 'running' | 'paused' | 'attention' | 'ended';
  kind: ScheduleStateKind;
  at?: number;
  blockedCode?: string;
};

export function describeScheduleState(
  row: Pick<ScheduleRegistryRow, 'enabled' | 'trigger' | 'scheduledMessage'>,
  runtime: ScheduleRuntimeRow | undefined,
): ScheduleState {
  const blockedCode = runtime?.blockedCode || undefined;
  const last = runtime?.lastDispatch;
  if (row.scheduledMessage) {
    const planned =
      row.trigger.kind === 'once' ? Date.parse(row.trigger.at) : undefined;
    switch (runtime?.messageState ?? 'pending') {
      case 'sent':
        return { group: 'ended', kind: 'sent', at: last?.dispatchedAt };
      case 'cancelled':
        return { group: 'ended', kind: 'cancelled', at: planned };
      case 'failed':
        return { group: 'ended', kind: 'notSent', blockedCode };
      default:
        if (!row.enabled) return { group: 'paused', kind: 'cancelling' };
        if (runtime?.queueState === 'blocked')
          return { group: 'attention', kind: 'blocked', blockedCode };
        return planned === undefined
          ? { group: 'running', kind: 'waitingToSend' }
          : { group: 'running', kind: 'sendsAt', at: planned };
    }
  }
  if (!row.enabled) return { group: 'paused', kind: 'paused' };
  if (runtime?.queueState === 'blocked')
    return { group: 'attention', kind: 'blocked', blockedCode };
  if (runtime?.queueState === 'retrying')
    return { group: 'attention', kind: 'retrying' };
  const next = runtime?.nextScheduledAt;
  if (runtime?.queueState === 'due')
    return { group: 'running', kind: 'due', at: next };
  if (runtime?.queueState === 'waiting_for_agent')
    return { group: 'running', kind: 'waitingForAgent', at: next };
  if (row.trigger.kind === 'manual')
    return { group: 'running', kind: 'manual', at: last?.dispatchedAt };
  if (next != null) return { group: 'running', kind: 'runsAt', at: next };
  if (row.trigger.kind === 'once' && last)
    return { group: 'ended', kind: 'done', at: last.dispatchedAt };
  return { group: 'running', kind: 'notScheduled' };
}
