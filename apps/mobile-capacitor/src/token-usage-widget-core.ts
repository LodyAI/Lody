export type TokenWidgetValue = { tokens: number; label: string };
export type TokenWidgetSummary = {
  userId: string;
  workspaceId: string;
  workspaceName: string;
  locale: string;
  period: 'utcDay' | 'window';
  startMs: number;
  endMs: number;
  total: TokenWidgetValue;
  models: { name: string; value: TokenWidgetValue }[];
  breakdown: {
    input: TokenWidgetValue;
    output: TokenWidgetValue;
    cacheRead: TokenWidgetValue;
  } | null;
  buckets: { startMs: number; tokens: number }[];
};
export type TokenWidgetPublication = {
  summary: TokenWidgetSummary;
  runtime: object;
  authSessionId: string;
};

type Scope = Pick<TokenWidgetSummary, 'userId' | 'workspaceId' | 'workspaceName'>;
type UsageTimeline = {
  workspaceId: string;
  range: string;
  startMs: number;
  endMs: number;
  bucketSizeMs: number;
  totals: {
    tokens: number;
    breakdown?: { inputTokens: number; outputTokens: number; cacheReadInputTokens: number };
  };
  buckets: readonly {
    bucketStartMs: number;
    tokens: number;
    byModel?: readonly { modelId: string; tokens: number }[];
  }[];
};
const HOUR_MS = 3_600_000;
const validTokens = (value: number) =>
  Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;

export function resolveTokenWidgetPublication(
  scope: Scope | null,
  runtime: object | null,
  authSessionId: string | null,
  publication: TokenWidgetPublication | null
): TokenWidgetSummary | null {
  if (
    scope === null ||
    publication === null ||
    runtime === null ||
    authSessionId === null ||
    publication.runtime !== runtime ||
    publication.authSessionId !== authSessionId ||
    publication.summary.userId !== scope.userId ||
    publication.summary.workspaceId !== scope.workspaceId
  )
    return null;
  return publication.summary;
}

/** Project Usage's returned UTC window; never infer a rolling 24h window from 'day'. */
export function buildTokenWidgetSummary({
  scope,
  timeline,
  locale,
  format,
  labelModel = (id) => id,
}: {
  scope: Scope;
  timeline: UsageTimeline;
  locale: string;
  format: (value: number, locale: string) => string;
  labelModel?: (id: string) => string;
}): TokenWidgetSummary | null {
  if (
    timeline.workspaceId !== scope.workspaceId ||
    timeline.range !== 'day' ||
    timeline.bucketSizeMs !== HOUR_MS ||
    !Number.isSafeInteger(timeline.startMs) ||
    timeline.startMs < 0 ||
    !Number.isSafeInteger(timeline.endMs) ||
    timeline.endMs < timeline.startMs ||
    timeline.endMs - timeline.startMs > 25 * HOUR_MS ||
    !validTokens(timeline.totals.tokens) ||
    timeline.buckets.length > 25
  )
    return null;
  const dayStart = Math.floor(timeline.endMs / (24 * HOUR_MS)) * 24 * HOUR_MS;
  const isUtcDay = timeline.startMs === dayStart;
  const lastBucket = isUtcDay ? dayStart + 23 * HOUR_MS : timeline.endMs;
  let previousStart = -Infinity;
  const models = new Map<string, number>();
  for (const bucket of timeline.buckets) {
    if (
      !Number.isSafeInteger(bucket.bucketStartMs) ||
      bucket.bucketStartMs < Math.floor(timeline.startMs / HOUR_MS) * HOUR_MS ||
      bucket.bucketStartMs > lastBucket ||
      bucket.bucketStartMs <= previousStart ||
      !validTokens(bucket.tokens) ||
      (bucket.bucketStartMs > timeline.endMs && bucket.tokens !== 0)
    )
      return null;
    previousStart = bucket.bucketStartMs;
    for (const model of bucket.byModel ?? []) {
      if (!validTokens(model.tokens)) return null;
      models.set(model.modelId, (models.get(model.modelId) ?? 0) + model.tokens);
    }
  }
  if (![...models.values()].every(validTokens)) return null;
  const parts = timeline.totals.breakdown;
  if (
    parts &&
    ![parts.inputTokens, parts.outputTokens, parts.cacheReadInputTokens].every(validTokens)
  )
    return null;
  const value = (tokens: number): TokenWidgetValue => ({ tokens, label: format(tokens, locale) });
  return {
    userId: scope.userId,
    workspaceId: scope.workspaceId,
    workspaceName: scope.workspaceName,
    locale,
    period: isUtcDay ? 'utcDay' : 'window',
    startMs: timeline.startMs,
    endMs: timeline.endMs,
    total: value(timeline.totals.tokens),
    models: [...models.entries()]
      .filter(([, tokens]) => tokens > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 2)
      .map(([id, tokens]) => ({ name: labelModel(id).trim().slice(0, 64), value: value(tokens) })),
    breakdown: parts
      ? {
          input: value(parts.inputTokens),
          output: value(parts.outputTokens),
          cacheRead: value(parts.cacheReadInputTokens),
        }
      : null,
    buckets: timeline.buckets.map((bucket) => ({
      startMs: bucket.bucketStartMs,
      tokens: bucket.tokens,
    })),
  };
}
