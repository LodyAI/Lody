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
    program: automationProgramSchema,
    reason: z.string().max(2000).optional(),
    intervalMs: z
      .number()
      .int()
      .min(1000)
      .max(24 * 60 * 60_000)
      .default(30_000),
    expiresAt: z.number().int().positive().optional(),
  })
  .strict();
export type AutomationRegistration = z.infer<typeof automationRegistrationSchema>;

export type AutomationWait = AutomationRegistration & {
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
  state: 'waiting' | 'checking' | 'matched' | 'cancelled' | 'expired' | 'failed';
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
  })
  .strict();
export type AutomationSettings = z.infer<typeof automationSettingsSchema>;
