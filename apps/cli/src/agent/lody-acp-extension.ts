import { normalizePersistedRateLimit } from '@lody/shared';
import {
  LODY_EXTENSION_METHODS,
  normalizeLodyExtensionMethod,
  type LodyExtensionCapabilities,
  type RateLimitsSnapshot,
  type SessionUsageUpdate,
} from 'acp-extension-core';
import { z } from 'zod';

const VersionOneSchema = z.object({ version: z.literal(1) });
const LodyCapabilitiesSchema = z
  .object({
    usage: VersionOneSchema.optional(),
    rateLimits: VersionOneSchema.extend({ query: z.literal(true).optional() }).optional(),
    forkAtTurn: VersionOneSchema.optional(),
    steering: VersionOneSchema.extend({
      transport: z.enum(['request', 'prompt']),
      upstreamTurn: z.enum(['same', 'handoff']),
      configPolicy: z.enum(['active', 'apply']),
    }).optional(),
    tasks: VersionOneSchema.extend({
      background: z.literal(true).optional(),
      scheduled: z.literal(true).optional(),
    }).optional(),
    subagents: VersionOneSchema.extend({
      lifecycle: z.literal(true),
      list: z.literal(true).optional(),
      cancel: z.literal(true).optional(),
      output: z.literal(true).optional(),
    }).optional(),
    goal: VersionOneSchema.extend({
      actions: z.array(z.enum(['set', 'pause', 'resume', 'clear'])),
    }).optional(),
    compaction: VersionOneSchema.optional(),
    sessionHistory: VersionOneSchema.optional(),
  })
  .partial();

const ModelUsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  cacheReadInputTokens: z.number().nonnegative(),
  cacheCreationInputTokens: z.number().nonnegative().optional(),
  reasoningOutputTokens: z.number().nonnegative().optional(),
  webSearchRequests: z.number().nonnegative().optional(),
  costUSD: z.number().nonnegative().optional(),
  contextWindow: z.number().positive().optional(),
});

const SessionUsageUpdateSchema = z.object({
  sessionId: z.string().min(1),
  usage: ModelUsageSchema,
  modelUsage: z.record(z.string(), ModelUsageSchema).optional(),
});

const RateLimitWindowSchema = z.object({
  usedPercent: z.number().min(0).max(100),
  windowDurationSeconds: z.number().nonnegative().nullable(),
  resetsAtEpochSeconds: z.number().int().positive().nullable(),
});

const RateLimitWalletSchema = z.object({
  balanceCents: z.number(),
  totalCents: z.number(),
  monthlyChargeLimitEnabled: z.boolean(),
  monthlyChargeLimitCents: z.number(),
  monthlyUsedCents: z.number(),
  currency: z.string().min(1),
});

const RateLimitSchema = z.object({
  limitId: z.string().min(1),
  scope: z.object({
    providerId: z.string().min(1),
    accountId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
  }),
  limitName: z.string().nullable().optional(),
  planName: z.string().nullable().optional(),
  windows: z.array(RateLimitWindowSchema),
  wallet: RateLimitWalletSchema.nullable().optional(),
});

const RateLimitsSnapshotSchema = z.object({
  rateLimits: z.array(RateLimitSchema),
  fetchedAtEpochSeconds: z.number().nonnegative().optional(),
});

const LegacyProposedPlanSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string(),
  turnId: z.string(),
  markdown: z.string(),
  status: z.enum(['delta', 'completed', 'cleared']),
  isLatest: z.boolean(),
});

const MessagePhaseSchema = z.enum(['commentary', 'final_answer']);

const LEGACY_METHODS = {
  usageUpdate: '_acp_ext:session_usage_update',
  rateLimitsUpdate: '_acp_ext:session_rate_limits',
  proposedPlan: '_acp_ext:codex_proposed_plan',
  claudeTaskLifecycle: '_claude/taskLifecycle',
  kimiTaskLifecycle: '_kimi/taskLifecycle',
  cursorCreatePlan: '_cursor/create_plan',
} as const;

export type LodyExtensionEvent =
  | { readonly type: 'usage'; readonly update: SessionUsageUpdate }
  | { readonly type: 'rateLimits'; readonly snapshot: RateLimitsSnapshot }
  | {
      readonly type: 'legacyProposedPlan';
      readonly plan: z.infer<typeof LegacyProposedPlanSchema>;
    }
  | {
      readonly type: 'legacyTaskLifecycle';
      readonly provider: 'claude' | 'kimi';
      readonly params: Record<string, unknown>;
    }
  | {
      readonly type: 'cursorPlanApproval';
      readonly sessionId: string;
      readonly toolCallId: string;
      readonly planId: string;
      readonly plan: string;
    }
  | {
      readonly type: 'cursorPlanApprovalInvalid';
      readonly error: string;
    };

export function parseLodyExtensionCapabilities(
  meta: Record<string, unknown> | null | undefined
): LodyExtensionCapabilities {
  const lody = meta?.lody;
  const parsed = LodyCapabilitiesSchema.safeParse(lody);
  const capabilities = parsed.success ? parsed.data : {};
  const legacyKimi = meta?.['lody.ai/kimi'];
  const legacyKimiParsed = z
    .object({
      protocolVersion: z.literal(1),
      features: z.object({
        subagentLifecycle: z.literal(true).optional(),
        subagentManagement: z.literal(true).optional(),
      }),
    })
    .safeParse(legacyKimi);
  if (!legacyKimiParsed.success || capabilities.subagents) return capabilities;
  const features = legacyKimiParsed.data.features;
  if (!features.subagentLifecycle && !features.subagentManagement) return capabilities;
  return {
    ...capabilities,
    subagents: {
      version: 1,
      lifecycle: true,
      ...(features.subagentManagement ? { list: true, cancel: true, output: true } : {}),
    },
  };
}

export function parseRateLimitsSnapshot(value: unknown): RateLimitsSnapshot {
  return RateLimitsSnapshotSchema.parse(value);
}

export function parseLodyMessagePhase(
  meta: Record<string, unknown> | null | undefined
): z.infer<typeof MessagePhaseSchema> | undefined {
  const canonical = z.object({ messagePhase: MessagePhaseSchema }).safeParse(meta?.lody);
  if (canonical.success) return canonical.data.messagePhase;

  // One-release compatibility for Codex runtimes predating Core v0.1.
  const legacy = z.object({ phase: MessagePhaseSchema }).safeParse(meta?.codex);
  return legacy.success ? legacy.data.phase : undefined;
}

export function parseLodyExtensionMessage(args: {
  method: string;
  params: Record<string, unknown>;
  sessionId: string;
  provider: string;
}): LodyExtensionEvent | null {
  const method = normalizeLodyExtensionMethod(args.method);
  if (method === LODY_EXTENSION_METHODS.sessionUsageUpdate) {
    return { type: 'usage', update: SessionUsageUpdateSchema.parse(args.params) };
  }
  if (method === LODY_EXTENSION_METHODS.rateLimitsUpdate) {
    return { type: 'rateLimits', snapshot: parseRateLimitsSnapshot(args.params) };
  }

  // One-release compatibility for pre-Core-v0.1 managed runtimes.
  if (method === LEGACY_METHODS.usageUpdate) {
    return {
      type: 'usage',
      update: SessionUsageUpdateSchema.parse({ ...args.params, sessionId: args.sessionId }),
    };
  }
  if (method === LEGACY_METHODS.rateLimitsUpdate) {
    const rateLimit = normalizePersistedRateLimit(args.provider, null, args.params);
    return rateLimit ? { type: 'rateLimits', snapshot: { rateLimits: [rateLimit] } } : null;
  }
  if (method === LEGACY_METHODS.proposedPlan) {
    return { type: 'legacyProposedPlan', plan: LegacyProposedPlanSchema.parse(args.params) };
  }
  if (method === LEGACY_METHODS.claudeTaskLifecycle) {
    return { type: 'legacyTaskLifecycle', provider: 'claude', params: args.params };
  }
  if (method === LEGACY_METHODS.kimiTaskLifecycle) {
    return { type: 'legacyTaskLifecycle', provider: 'kimi', params: args.params };
  }

  // Handle cursor-agent's plan delivery via _cursor/create_plan extension.
  // cursor-agent sends this as a blocking extension that must be wired to an
  // approval decision — the client renders the plan, asks the user to approve
  // or reject, and returns the outcome so cursor-agent can continue.
  // See issue #258.
  if (method === LEGACY_METHODS.cursorCreatePlan) {
    const CursorPlanSchema = z.object({
      plan: z.string(),
      sessionId: z.string().optional(),
      toolCallId: z.string().optional(),
    });
    const parsed = CursorPlanSchema.safeParse(args.params);
    if (parsed.success) {
      const sessionId = parsed.data.sessionId ?? args.sessionId;
      return {
        type: 'cursorPlanApproval',
        sessionId,
        toolCallId: parsed.data.toolCallId ?? `cursor-plan:${sessionId}`,
        // The displayed plan keys on a stable per-session id so a revised plan
        // (fresh toolCallId after "No, keep planning") replaces the previous one
        // instead of accumulating next to it; the approval tool-call keeps the
        // unique cursor-supplied id.
        planId: `cursor-plan:${sessionId}`,
        plan: parsed.data.plan,
      };
    }
    // The method is recognized but the payload is malformed: surface an explicit
    // invalid event so the blocking caller can answer cursor-agent with a
    // cancelled outcome instead of an empty response.
    return { type: 'cursorPlanApprovalInvalid', error: parsed.error.message };
  }

  return null;
}
