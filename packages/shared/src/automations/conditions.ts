import { z } from 'zod';
import type { AutomationEvidence } from './reads';

const id = z.string().min(1).max(512);
export const automationProgramSchema = z
  .string()
  .min(1)
  .max(64 * 1024);
export const automationResultSchema = z.union([
  z.literal(false),
  z
    .object({
      resumeText: z
        .string()
        .trim()
        .min(1)
        .max(32 * 1024),
      payload: z.json().optional(),
    })
    .strict()
    .refine(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 64 * 1024,
      'Automation result exceeds 64 KiB'
    ),
]);
export type AutomationResult = z.infer<typeof automationResultSchema>;

export const automationRegistrationSchema = z
  .object({
    program: automationProgramSchema.describe(
      'A JavaScript function expression `async ({ ctx }) => ...` observing state through ctx.read/ctx.fetch/ctx.exec. Return false to keep waiting, or { resumeText, payload? } to complete once. Time-triggered wake-ups do not belong here: use lody_schedule for periodic or delayed work.'
    ),
    key: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        'Slot name. Registering into a slot supersedes its unfinished wait; omit it for the shared default slot. Pass distinct keys only for genuinely independent parallel observations.'
      ),
    reason: z
      .string()
      .max(2000)
      .optional()
      .describe('Short human-facing summary of what is being waited for.'),
    intervalMs: z
      .number()
      .int()
      .min(1000)
      .max(24 * 60 * 60_000)
      .default(30_000)
      .describe('Minimum delay between condition checks; default 30 seconds.'),
    expiresAt: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Absolute epoch milliseconds after which the wait expires.'),
  })
  .strict();
export type AutomationRegistration = z.infer<typeof automationRegistrationSchema>;

const environmentName = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);
/** A long command the Host runs on the Agent's behalf; its exit resumes the Session. */
export const automationRunSchema = z
  .object({
    command: z.string().min(1).max(4096),
    args: z.array(z.string().max(8192)).max(256).default([]),
    cwd: z.string().min(1).max(4096).optional(),
    env: z
      .record(environmentName, z.string().max(8192))
      .refine((value) => Object.keys(value).length <= 64, 'At most 64 environment variables')
      .optional(),
    reason: z.string().max(2000).optional(),
  })
  .strict();
export type AutomationRun = z.infer<typeof automationRunSchema>;

/** Exit facts the Host observed for a managed run. */
export type AutomationRunExit = {
  endedAt: number;
  /** `exited` ran to completion; `spawn_failed` never started; `interrupted` lost its owner. */
  outcome: 'exited' | 'spawn_failed' | 'interrupted';
  exitCode: number | null;
  signal: string | null;
  error?: string;
  tail: string;
  logTruncated: boolean;
};
export type AutomationManagedRun = Omit<AutomationRun, 'reason'> & {
  logPath: string;
  /** Persisted before spawn. A start without a live owner is never retried. */
  startedAt?: number;
  pid?: number;
  exit?: AutomationRunExit;
};

export type AutomationWait = Omit<AutomationRegistration, 'program'> & {
  /** Condition program; absent for a managed run. */
  program?: string;
  run?: AutomationManagedRun;
  /** Frozen causal origin: the machine-caused input that produced this registration. */
  causal?: AutomationCausalOrigin;
  id: string;
  sessionId: string;
  workspaceId: string;
  ownerUserId: string;
  ownerMachineId: string;
  createdAt: number;
  updatedAt: number;
  nextCheckAt: number;
  checks: number;
  consecutiveErrors: number;
  state: 'waiting' | 'checking' | 'matched' | 'cancelled' | 'expired' | 'failed' | 'superseded';
  lastError?: string;
  result?: Exclude<AutomationResult, false>;
  invocationId?: string;
  reads?: string[];
  evidence?: AutomationEvidence[];
};

export const automationProgramContextSchema = z
  .object({
    sessionId: id,
    workspaceId: id,
    now: z.number().int().nonnegative(),
  })
  .strict();
export type AutomationProgramContext = z.infer<typeof automationProgramContextSchema>;

export type AutomationCausalOrigin = {
  depth: number;
  sessionId?: string;
  turnId?: string;
};

export const autoDeliverMergeMethodSchema = z.enum(['auto', 'squash', 'merge', 'rebase']);
export type AutoDeliverMergeMethod = z.infer<typeof autoDeliverMergeMethodSchema>;

/** Which Auto delivery steps the Host may request; merge is on by default. */
export const autoDeliverOptionsSchema = z
  .object({
    fixCi: z.boolean().default(true),
    resolveConflicts: z.boolean().default(true),
    merge: z.boolean().default(true),
    mergeMethod: autoDeliverMergeMethodSchema.optional(),
    prUrls: z.array(z.string().url()).max(32).optional(),
  })
  .strict();
export type AutoDeliverOptions = z.infer<typeof autoDeliverOptionsSchema>;

/** Ordinary Session feature settings; event/action mapping remains internal. */
export const automationSettingsSchema = z
  .object({
    recoverCapacity: z.boolean().optional(),
    archiveAfterMerge: z.boolean().optional(),
    compactWhenIdle: z
      .union([
        z.literal(false),
        z
          .object({
            contextTokens: z.number().int().positive().default(300_000),
            cacheTtlMs: z
              .number()
              .int()
              .min(60_000)
              .max(24 * 60 * 60_000),
            leadTimeMs: z.number().int().min(1000).default(60_000),
          })
          .strict()
          .refine(
            (value) => value.leadTimeMs < value.cacheTtlMs,
            'Lead time must be shorter than estimated cache lifetime'
          ),
      ])
      .optional(),
    /**
     * Auto delivery for this Session's current pull request. Off unless enabled;
     * it ends when that pull request is merged. The Host owns the steps and limits.
     */
    autoDeliver: z.union([z.literal(false), autoDeliverOptionsSchema]).optional(),
  })
  .strict();
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;
