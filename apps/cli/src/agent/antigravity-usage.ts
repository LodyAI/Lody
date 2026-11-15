import { z } from 'zod';
import type { SessionUsageUpdate } from 'acp-extension-core';

const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const promptUsage = z.object({
  usage: z
    .object({
      inputTokens: tokenCount,
      outputTokens: tokenCount,
      cachedReadTokens: tokenCount.nullish().transform((value) => value ?? 0),
      cachedWriteTokens: tokenCount.nullish(),
      thoughtTokens: tokenCount.nullish(),
    })
    .refine((u) => (u.thoughtTokens ?? 0) <= u.outputTokens),
});

/** Each agy response reports this request's usage, including cache and thought subsets. */
export function readAntigravityPromptUsage(
  response: unknown,
  sessionId: string,
  modelId: string | undefined,
  contextWindow?: number
): SessionUsageUpdate | undefined {
  if (!modelId) return undefined;
  const parsed = promptUsage.safeParse(response);
  if (!parsed.success) return undefined;
  const u = parsed.data.usage;
  const usage = {
    inputTokens: u.inputTokens,
    outputTokens: u.outputTokens - (u.thoughtTokens ?? 0),
    cacheReadInputTokens: u.cachedReadTokens,
    ...(u.cachedWriteTokens != null ? { cacheCreationInputTokens: u.cachedWriteTokens } : {}),
    ...(u.thoughtTokens != null ? { reasoningOutputTokens: u.thoughtTokens } : {}),
  };
  const aggregateUsage = {
    ...usage,
    ...(contextWindow !== undefined && Number.isFinite(contextWindow) && contextWindow > 0
      ? { contextWindow }
      : {}),
  };
  return {
    sessionId,
    usage: aggregateUsage,
    modelUsage: { [modelId]: usage },
    delta: { usage: aggregateUsage, modelUsage: { [modelId]: usage } },
  };
}
