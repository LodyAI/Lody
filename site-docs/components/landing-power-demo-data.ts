/**
 * Deterministic mock data for landing power demos.
 * Fixed timestamps / curves so SSR and client match (no Date.now / Math.random).
 */

import type { PowerPrConversationItem, PowerPrData } from './landing-replica/power-pr';
import type {
  StackedAreaBucket,
  UsageCalendar,
  UsageCalendarDay,
  UsageDayDetail,
  UsageRange,
  UsageTimeline,
  UsageTimelineBucket,
} from './landing-replica/power-usage';

/** Localized axis labels the demo data carries into the stacked-area charts. */
export type LandingUsageDataLabels = {
  weekdays: readonly string[];
  today: string;
};

// ---- Stats (Settings → Usage) ----------------------------------------------
//
// Simulated 3-person distributed team with deliberately irregular daily load:
//   - Any day can be quiet or spike; there is no weekday/weekend cadence
//   - Per-person model preferences (Codex vs Claude vs Kimi)
//
// Official list prices (USD / 1M tokens), short-context standard tier:
//   OpenAI  https://developers.openai.com/api/docs/pricing  (as of 2026-07-30)
//     gpt-5.6-sol   input $5.00  cached $0.50  output $30.00
//     gpt-5.6-terra input $2.00  cached $0.20  output $12.00
//     gpt-5.5       input $5.00  cached $0.50  output $30.00
//   Anthropic https://platform.claude.com/docs/en/about-claude/pricing
//     claude-fable-5    input $10.00  cache hit $1.00  output $50.00
//     claude-opus-5     input $5.00   cache hit $0.50  output $25.00
//     claude-opus-4-8   input $5.00   cache hit $0.50  output $25.00
//   Moonshot https://platform.kimi.ai/docs/pricing/chat-k3
//     kimi-k3  cache-miss $3.00  cache-hit $0.30  output $15.00
//
// Blended `usdPerM` for agent coding sessions:
//   75% input / 25% output, and of input 70% cache-hit / 30% cache-miss.

type ModelListPrice = {
  id: string;
  label: string;
  /** USD / 1M uncached (or cache-miss) input tokens */
  input: number;
  /** USD / 1M cached-input / cache-hit tokens */
  cachedInput: number;
  /** USD / 1M output tokens */
  output: number;
};

const AGENT_INPUT_SHARE = 0.75;
const AGENT_OUTPUT_SHARE = 0.25;
const AGENT_CACHE_HIT_SHARE = 0.7; // of input tokens

function blendUsdPerM(price: Pick<ModelListPrice, 'input' | 'cachedInput' | 'output'>): number {
  const inputBlended =
    price.input * (1 - AGENT_CACHE_HIT_SHARE) + price.cachedInput * AGENT_CACHE_HIT_SHARE;
  return inputBlended * AGENT_INPUT_SHARE + price.output * AGENT_OUTPUT_SHARE;
}

/**
 * Official list prices + derived agent-workload blend.
 * Keep ≤5 models so the legend stays readable in the landing card.
 */
const MODEL_LIST_PRICES = [
  {
    id: 'gpt-5.6-sol',
    label: 'gpt-5.6-sol',
    input: 5.0,
    cachedInput: 0.5,
    output: 30.0,
  },
  {
    id: 'claude-opus-5',
    label: 'claude-opus-5',
    input: 5.0,
    cachedInput: 0.5,
    output: 25.0,
  },
  {
    id: 'claude-fable-5',
    label: 'claude-fable-5',
    input: 10.0,
    cachedInput: 1.0,
    output: 50.0,
  },
  {
    id: 'gpt-5.6-terra',
    label: 'gpt-5.6-terra',
    input: 2.0,
    cachedInput: 0.2,
    output: 12.0,
  },
  {
    id: 'kimi-k3',
    label: 'kimi-k3',
    input: 3.0,
    cachedInput: 0.3,
    output: 15.0,
  },
] as const satisfies readonly ModelListPrice[];

/**
 * First-tier coding models (names match product stats style).
 * `usdPerM` = blended effective rate from official list prices + agent mix above.
 */
export const LANDING_USAGE_MODELS = MODEL_LIST_PRICES.map((m) => ({
  id: m.id,
  label: m.label,
  usdPerM: blendUsdPerM(m),
  list: { input: m.input, cachedInput: m.cachedInput, output: m.output },
})) as readonly {
  id: (typeof MODEL_LIST_PRICES)[number]['id'];
  label: string;
  usdPerM: number;
  list: { input: number; cachedInput: number; output: number };
}[];

export type LandingUsageModelId = (typeof LANDING_USAGE_MODELS)[number]['id'];

export const LANDING_USAGE_MEMBERS = [
  { id: 'u1', name: 'Lee', initials: 'L' },
  { id: 'u2', name: 'Zixuan', initials: 'Z' },
  { id: 'u3', name: 'Wibus', initials: 'W' },
] as const;

export type LandingUsageMemberId = (typeof LANDING_USAGE_MEMBERS)[number]['id'];

const MODEL_BY_ID = new Map(LANDING_USAGE_MODELS.map((m) => [m.id, m]));

/**
 * Share of each member’s daily tokens by model (must sum ≈ 1).
 * Preferences:
 *   Lee    — Codex / GPT-5.6 Sol workhorse, Terra for bulk, light Opus
 *   Zixuan — Claude Opus 5 primary, Fable for hard reviews, some Sol
 *   Wibus  — Kimi K3 + Terra value path, occasional frontier
 */
const MEMBER_MODEL_MIX: Record<
  LandingUsageMemberId,
  Readonly<Partial<Record<LandingUsageModelId, number>>>
> = {
  u1: {
    'gpt-5.6-sol': 0.62,
    'gpt-5.6-terra': 0.24,
    'claude-opus-5': 0.1,
    'kimi-k3': 0.04,
  },
  u2: {
    'claude-opus-5': 0.48,
    'claude-fable-5': 0.18,
    'gpt-5.6-sol': 0.22,
    'kimi-k3': 0.07,
    'gpt-5.6-terra': 0.05,
  },
  u3: {
    'kimi-k3': 0.42,
    'gpt-5.6-terra': 0.34,
    'gpt-5.6-sol': 0.14,
    'claude-opus-5': 0.1,
  },
};

/**
 * Personal token totals (raw tokens). Index 0 = Mon … 6 = Sun. Values are
 * intentionally uncorrelated with the weekday so the demo does not paint bands.
 */
const WEEK_MEMBER_TOKENS: Record<LandingUsageMemberId, readonly number[]> = {
  // Mon      Tue       Wed       Thu       Fri       Sat         Sun
  u1: [168_000_000, 42_000_000, 310_000_000, 91_000_000, 275_000_000, 328_000_000, 72_000_000],
  u2: [242_000_000, 188_000_000, 35_000_000, 296_000_000, 69_000_000, 114_000_000, 351_000_000],
  u3: [38_000_000, 272_000_000, 145_000_000, 18_000_000, 256_000_000, 171_000_000, 239_000_000],
};

/**
 * Deterministic 0..1 noise from (member, day, salt) — SSR-stable, no Math.random.
 * Produces uneven day curves without looking like a sine wave.
 */
function dayNoise(memberOrdinal: number, dayIndex: number, salt: number): number {
  const x = Math.sin(memberOrdinal * 12.9898 + dayIndex * 78.233 + salt * 43.758) * 43758.5453;
  return x - Math.floor(x);
}

/** Mid-week Fable spikes for Zixuan; plus per-day mix jitter for everyone. */
const FABLE_DAY_BOOST: ReadonlyArray<number> = [0.02, 0.0, 0.14, 0.05, 0.01, 0.03, 0.0];

const WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

const MEMBER_ORDINAL: Record<LandingUsageMemberId, number> = { u1: 1, u2: 2, u3: 3 };

function mixForMemberDay(
  memberId: LandingUsageMemberId,
  dayIndex: number
): Partial<Record<LandingUsageModelId, number>> {
  const base: Partial<Record<LandingUsageModelId, number>> = { ...MEMBER_MODEL_MIX[memberId] };
  const ord = MEMBER_ORDINAL[memberId];

  // Day-to-day preference wobble: push mass between primary and secondary models.
  if (memberId === 'u1') {
    const wobble = (dayNoise(ord, dayIndex, 1) - 0.5) * 0.28; // ±14pp Sol ↔ Terra
    base['gpt-5.6-sol'] = Math.max(0.32, (base['gpt-5.6-sol'] ?? 0) + wobble);
    base['gpt-5.6-terra'] = Math.max(0.08, (base['gpt-5.6-terra'] ?? 0) - wobble);
    if (dayNoise(ord, dayIndex, 2) > 0.72) {
      // Occasional Opus day
      base['claude-opus-5'] = (base['claude-opus-5'] ?? 0) + 0.12;
      base['gpt-5.6-sol'] = Math.max(0.28, (base['gpt-5.6-sol'] ?? 0) - 0.12);
    }
  } else if (memberId === 'u2') {
    const boost = FABLE_DAY_BOOST[dayIndex] ?? 0;
    if (boost > 0) {
      base['claude-fable-5'] = (base['claude-fable-5'] ?? 0) + boost;
      base['claude-opus-5'] = Math.max(0.12, (base['claude-opus-5'] ?? 0) - boost * 0.55);
      base['gpt-5.6-sol'] = Math.max(0.06, (base['gpt-5.6-sol'] ?? 0) - boost * 0.45);
    }
    const wobble = (dayNoise(ord, dayIndex, 3) - 0.5) * 0.22;
    base['claude-opus-5'] = Math.max(0.15, (base['claude-opus-5'] ?? 0) + wobble);
    base['gpt-5.6-sol'] = Math.max(0.08, (base['gpt-5.6-sol'] ?? 0) - wobble * 0.5);
  } else {
    const wobble = (dayNoise(ord, dayIndex, 4) - 0.5) * 0.3;
    base['kimi-k3'] = Math.max(0.15, (base['kimi-k3'] ?? 0) + wobble);
    base['gpt-5.6-terra'] = Math.max(0.1, (base['gpt-5.6-terra'] ?? 0) - wobble * 0.6);
    if (dayNoise(ord, dayIndex, 5) > 0.78) {
      // Rare Sol sprint day
      base['gpt-5.6-sol'] = (base['gpt-5.6-sol'] ?? 0) + 0.18;
      base['kimi-k3'] = Math.max(0.12, (base['kimi-k3'] ?? 0) - 0.1);
      base['gpt-5.6-terra'] = Math.max(0.08, (base['gpt-5.6-terra'] ?? 0) - 0.08);
    }
  }

  // Renormalize shares to 1.
  let sum = 0;
  for (const m of LANDING_USAGE_MODELS) sum += base[m.id] ?? 0;
  if (sum > 0) {
    for (const m of LANDING_USAGE_MODELS) {
      if (base[m.id] != null) base[m.id] = (base[m.id] as number) / sum;
    }
  }
  return base;
}

function splitTokensByModel(
  totalTokens: number,
  mix: Partial<Record<LandingUsageModelId, number>>
): Record<LandingUsageModelId, number> {
  const out = {} as Record<LandingUsageModelId, number>;
  for (const m of LANDING_USAGE_MODELS) {
    out[m.id] = 0;
  }
  if (totalTokens <= 0) return out;

  let assigned = 0;
  const entries = LANDING_USAGE_MODELS.map((m) => {
    const share = mix[m.id] ?? 0;
    const tokens = Math.round(totalTokens * share);
    return { id: m.id, tokens };
  });
  for (const e of entries) {
    out[e.id] = e.tokens;
    assigned += e.tokens;
  }
  // Fix rounding onto the member’s primary model.
  const primary = entries.reduce((a, b) => (b.tokens > a.tokens ? b : a));
  out[primary.id] += totalTokens - assigned;
  return out;
}

type DaySlice = {
  label: string;
  /** memberId → modelId → tokens */
  byMemberModel: Record<LandingUsageMemberId, Record<LandingUsageModelId, number>>;
};

/** Canonical Mon–Sun week used as the source of truth for all ranges. */
function buildCanonicalWeek(): DaySlice[] {
  return WEEKDAY_LABELS.map((label, dayIndex) => {
    const byMemberModel = {} as DaySlice['byMemberModel'];
    for (const member of LANDING_USAGE_MEMBERS) {
      const total = WEEK_MEMBER_TOKENS[member.id][dayIndex] ?? 0;
      byMemberModel[member.id] = splitTokensByModel(total, mixForMemberDay(member.id, dayIndex));
    }
    return { label, byMemberModel };
  });
}

const CANONICAL_WEEK = buildCanonicalWeek();

const WEEK_ACTIVITY_SCALES = [0.18, 1.85, 0.42, 2.35, 0.08, 1.1, 0.63] as const;

function scaleDaySlice(source: DaySlice, factor: number): DaySlice {
  const byMemberModel = {} as DaySlice['byMemberModel'];
  for (const member of LANDING_USAGE_MEMBERS) {
    const scaled = {} as Record<LandingUsageModelId, number>;
    for (const model of LANDING_USAGE_MODELS) {
      scaled[model.id] = Math.round((source.byMemberModel[member.id][model.id] ?? 0) * factor);
    }
    byMemberModel[member.id] = scaled;
  }
  return { label: source.label, byMemberModel };
}

const LANDING_WEEK = CANONICAL_WEEK.map((slice, index) =>
  scaleDaySlice(slice, WEEK_ACTIVITY_SCALES[index] ?? 1)
);

function dayTotals(slice: DaySlice): {
  byModel: Record<LandingUsageModelId, number>;
  byMember: Record<LandingUsageMemberId, number>;
  tokens: number;
  costUSD: number;
} {
  const byModel = {} as Record<LandingUsageModelId, number>;
  const byMember = {} as Record<LandingUsageMemberId, number>;
  for (const m of LANDING_USAGE_MODELS) byModel[m.id] = 0;
  for (const u of LANDING_USAGE_MEMBERS) byMember[u.id] = 0;

  let tokens = 0;
  let costUSD = 0;
  for (const member of LANDING_USAGE_MEMBERS) {
    let memberTokens = 0;
    for (const model of LANDING_USAGE_MODELS) {
      const t = slice.byMemberModel[member.id][model.id] ?? 0;
      byModel[model.id] += t;
      memberTokens += t;
      tokens += t;
      costUSD += (t / 1_000_000) * model.usdPerM;
    }
    byMember[member.id] = memberTokens;
  }
  return { byModel, byMember, tokens, costUSD };
}

/** Cost from official blended rates (no artificial scale). */
function costForTokens(modelId: LandingUsageModelId, tokens: number): number {
  const model = MODEL_BY_ID.get(modelId);
  if (!model || tokens <= 0) return 0;
  return (tokens / 1_000_000) * model.usdPerM;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const LANDING_CALENDAR_START_MS = Date.UTC(2025, 7, 24);
const LANDING_CALENDAR_TODAY_MS = Date.UTC(2026, 7, 27);
const LANDING_CALENDAR_DAY_COUNT = 53 * 7;
const TODAY_LABEL = 'Today';
const LANDING_WEEK_START_MS = Date.UTC(2026, 7, 17);
const DAY_RANGE_SALT = 31;
const WEEK_RANGE_SALT = 41;

/** Swap the canonical English day labels for the page locale's. */
function localizeLabel(label: string, labels: LandingUsageDataLabels): string {
  if (label === TODAY_LABEL) return labels.today;
  const weekday = (WEEKDAY_LABELS as readonly string[]).indexOf(label);
  return weekday >= 0 ? (labels.weekdays[weekday] ?? label) : label;
}

function hourlySlices(source: DaySlice, salt: number): DaySlice[] {
  const weights = Array.from({ length: 24 }, (_, hour) => {
    if (hour >= 2 && hour <= 6) return 0;
    const activity = dayNoise(23, hour, salt);
    if (activity < 0.18) return 0;
    const burst = dayNoise(29, hour, salt + 5) > 0.86 ? 2.35 : 1;
    return (0.012 + activity ** 2 * 0.2) * burst;
  });
  const totalWeight = weights.reduce((sum, value) => sum + value, 0);

  return weights.map((weight, hour) => {
    const share = totalWeight > 0 ? weight / totalWeight : 0;
    const byMemberModel = {} as DaySlice['byMemberModel'];
    for (const member of LANDING_USAGE_MEMBERS) {
      const memberJitter = 0.88 + dayNoise(MEMBER_ORDINAL[member.id], hour, salt) * 0.24;
      const scaled = {} as Record<LandingUsageModelId, number>;
      for (const model of LANDING_USAGE_MODELS) {
        scaled[model.id] = Math.round(
          (source.byMemberModel[member.id][model.id] ?? 0) * share * memberJitter
        );
      }
      byMemberModel[member.id] = scaled;
    }
    return { label: `${String(hour).padStart(2, '0')}:00`, byMemberModel };
  });
}

function slicesForRange(range: UsageRange): DaySlice[] {
  if (range === 'week') {
    return LANDING_WEEK;
  }
  if (range === 'day') {
    return hourlySlices(CANONICAL_WEEK[3]!, DAY_RANGE_SALT);
  }

  // Month uses its real 30-day window. All-time is compressed into 16 chart
  // points and scaled to the same aggregate as the 53-week calendar below.
  const days = range === 'month' ? 30 : 16;
  const out: DaySlice[] = [];
  for (let i = 0; i < days; i += 1) {
    const sourceIndex = Math.min(6, Math.floor(dayNoise(19, i, 21) * 7));
    const source = CANONICAL_WEEK[sourceIndex]!;
    const activity = dayNoise(7, i, 9);
    const quietDay = dayNoise(8, i, 15) < 0.13;
    const inactive = quietDay || activity < 0.2;
    const intensity = inactive ? 0 : (0.48 + activity * 1.02) * (activity > 0.88 ? 1.42 : 1);
    const daysAgo = days - 1 - i;
    const label = daysAgo === 0 ? TODAY_LABEL : `-${daysAgo}d`;
    const byMemberModel = {} as DaySlice['byMemberModel'];
    for (const member of LANDING_USAGE_MEMBERS) {
      const memberScale = intensity * (0.88 + dayNoise(MEMBER_ORDINAL[member.id], i, 11) * 0.28);
      const scaled = {} as Record<LandingUsageModelId, number>;
      for (const model of LANDING_USAGE_MODELS) {
        scaled[model.id] = Math.round(
          (source.byMemberModel[member.id][model.id] ?? 0) * memberScale
        );
      }
      byMemberModel[member.id] = scaled;
    }
    out.push({ label, byMemberModel });
  }
  return out;
}

function timelineBucket(
  slice: DaySlice,
  bucketStartMs: number,
  labels: LandingUsageDataLabels
): UsageTimelineBucket {
  const totals = dayTotals(slice);
  return {
    bucketStartMs,
    bucketLabel: localizeLabel(slice.label, labels),
    tokens: totals.tokens,
    costUSD: Math.round(totals.costUSD * 100) / 100,
    byModel: LANDING_USAGE_MODELS.map((model) => ({
      modelId: model.id,
      tokens: totals.byModel[model.id] ?? 0,
    })),
    byUser: LANDING_USAGE_MEMBERS.map((member) => ({
      userId: member.id,
      tokens: totals.byMember[member.id] ?? 0,
    })),
  };
}

function scaleTimelineBucket(
  bucket: UsageTimelineBucket,
  tokenScale: number,
  costScale: number
): UsageTimelineBucket {
  return {
    ...bucket,
    tokens: bucket.tokens * tokenScale,
    costUSD: bucket.costUSD * costScale,
    byModel: bucket.byModel.map((model) => ({ ...model, tokens: model.tokens * tokenScale })),
    byUser: bucket.byUser.map((user) => ({ ...user, tokens: user.tokens * tokenScale })),
  };
}

function buildLandingUsageTimeline(
  range: UsageRange,
  labels: LandingUsageDataLabels
): UsageTimeline {
  let startMs: number;
  let endMs: number;
  let buckets: UsageTimelineBucket[];

  if (range === 'day') {
    startMs = LANDING_CALENDAR_TODAY_MS;
    endMs = startMs + DAY_MS;
    buckets = hourlySlices(CANONICAL_WEEK[3]!, DAY_RANGE_SALT).map((slice, hour) =>
      timelineBucket(slice, startMs + hour * HOUR_MS, labels)
    );
  } else if (range === 'week') {
    startMs = LANDING_WEEK_START_MS;
    endMs = startMs + 7 * DAY_MS;
    buckets = LANDING_WEEK.flatMap((source, day) =>
      hourlySlices(source, WEEK_RANGE_SALT + day).map((slice, hour) =>
        timelineBucket(slice, startMs + day * DAY_MS + hour * HOUR_MS, labels)
      )
    );
  } else {
    const slices = slicesForRange(range);
    startMs =
      range === 'month' ? LANDING_CALENDAR_TODAY_MS - 29 * DAY_MS : LANDING_CALENDAR_START_MS;
    endMs = LANDING_CALENDAR_TODAY_MS + DAY_MS;
    const bucketSizeMs = Math.floor((endMs - startMs) / slices.length);
    buckets = slices.map((slice, index) =>
      timelineBucket(slice, startMs + index * bucketSizeMs, labels)
    );
  }

  let tokens = buckets.reduce((sum, bucket) => sum + bucket.tokens, 0);
  let costUSD = buckets.reduce((sum, bucket) => sum + bucket.costUSD, 0);
  if (range === 'total') {
    const target = landingCalendarTotals();
    const tokenScale = tokens > 0 ? target.tokens / tokens : 1;
    const costScale = costUSD > 0 ? target.costUSD / costUSD : 1;
    buckets = buckets.map((bucket) => scaleTimelineBucket(bucket, tokenScale, costScale));
    tokens = target.tokens;
    costUSD = target.costUSD;
  }
  const inputTokens = Math.round(tokens * 0.22);
  const outputTokens = Math.round(tokens * 0.18);
  const cacheReadInputTokens = Math.round(tokens * 0.45);
  const cacheCreationInputTokens = Math.round(tokens * 0.05);

  return {
    range,
    startMs,
    endMs,
    totals: {
      tokens,
      costUSD: Math.round(costUSD * 100) / 100,
      breakdown: {
        inputTokens,
        outputTokens,
        cacheReadInputTokens,
        cacheCreationInputTokens,
        reasoningOutputTokens:
          tokens - inputTokens - outputTokens - cacheReadInputTokens - cacheCreationInputTokens,
      },
    },
    users: Object.fromEntries(
      LANDING_USAGE_MEMBERS.map((member) => [member.id, { name: member.name }])
    ),
    buckets,
  };
}

function sumSlices(slices: DaySlice[], label: string): DaySlice {
  const byMemberModel = {} as DaySlice['byMemberModel'];
  for (const member of LANDING_USAGE_MEMBERS) {
    const summed = {} as Record<LandingUsageModelId, number>;
    for (const model of LANDING_USAGE_MODELS) {
      summed[model.id] = slices.reduce(
        (sum, slice) => sum + (slice.byMemberModel[member.id][model.id] ?? 0),
        0
      );
    }
    byMemberModel[member.id] = summed;
  }
  return { label, byMemberModel };
}

/**
 * Days the 24h / 7d timelines cover, as the sum of their hourly buckets. The
 * calendar and the day breakdown use these, so a clicked hour's day reports the
 * same total in the matrix readout, the day panel and the year heatmap.
 */
const HOURLY_DAY_SLICES: ReadonlyMap<number, DaySlice> = new Map([
  ...LANDING_WEEK.map((source, day): [number, DaySlice] => [
    LANDING_WEEK_START_MS + day * DAY_MS,
    sumSlices(hourlySlices(source, WEEK_RANGE_SALT + day), source.label),
  ]),
  [
    LANDING_CALENDAR_TODAY_MS,
    sumSlices(hourlySlices(CANONICAL_WEEK[3]!, DAY_RANGE_SALT), TODAY_LABEL),
  ],
]);

const LANDING_USAGE_CALENDAR: UsageCalendar = {
  startMs: LANDING_CALENDAR_START_MS,
  days: Array.from({ length: LANDING_CALENDAR_DAY_COUNT }, (_, index): UsageCalendarDay => {
    const dayStartMs = LANDING_CALENDAR_START_MS + index * DAY_MS;
    const isFuture = dayStartMs > LANDING_CALENDAR_TODAY_MS;
    const hourlyDay = HOURLY_DAY_SLICES.get(dayStartMs);
    if (hourlyDay) {
      const totals = dayTotals(hourlyDay);
      return {
        dayStartMs,
        tokens: totals.tokens,
        costUSD: Math.round(totals.costUSD * 100) / 100,
        isFuture,
      };
    }
    const sourceIndex = Math.min(6, Math.floor(dayNoise(17, index, 83) * 7));
    const source = CANONICAL_WEEK[sourceIndex]!;
    const sourceTotals = dayTotals(source);
    const activity = dayNoise(9, index, 53);
    const plannedPause = index % 43 === 7 || index % 67 === 19;
    const active = !isFuture && !plannedPause && activity > 0.2;
    const season = 0.86 + Math.sin(index / 23) * 0.14;
    const baseIntensity = 0.22 + dayNoise(11, index, 59) * 1.36;
    const spike = dayNoise(15, index, 71) > 0.88 ? 1.82 : 1;
    const intensity = active ? season * baseIntensity * spike : 0;
    return {
      dayStartMs,
      tokens: Math.round(sourceTotals.tokens * intensity),
      costUSD: Math.round(sourceTotals.costUSD * intensity * 100) / 100,
      isFuture,
    };
  }),
};

function landingCalendarTotals() {
  return LANDING_USAGE_CALENDAR.days.reduce(
    (totals, day) => {
      if (!day.isFuture) {
        totals.tokens += day.tokens;
        totals.costUSD += day.costUSD;
      }
      return totals;
    },
    { tokens: 0, costUSD: 0 }
  );
}

/**
 * Breakdown for one calendar day: the day's calendar total split by its source
 * model/member mix (the hourly buckets for days the 24h / 7d timelines cover).
 * Deterministic — no clock, no randomness.
 */
export function buildLandingUsageDay(dayStartMs: number): UsageDayDetail | undefined {
  const calendarDay = LANDING_USAGE_CALENDAR.days.find((day) => day.dayStartMs === dayStartMs);
  if (!calendarDay || calendarDay.isFuture) return undefined;

  const dayIndex = Math.round((dayStartMs - LANDING_CALENDAR_START_MS) / DAY_MS);
  const sourceIndex = Math.min(6, Math.floor(dayNoise(17, dayIndex, 83) * 7));
  // Timeline-covered days split exactly like their hourly buckets.
  const source = HOURLY_DAY_SLICES.get(dayStartMs) ?? CANONICAL_WEEK[sourceIndex]!;
  const sourceTotals = dayTotals(source);
  const scale = sourceTotals.tokens > 0 ? calendarDay.tokens / sourceTotals.tokens : 0;
  const inputTokens = Math.round(calendarDay.tokens * 0.22);
  const outputTokens = Math.round(calendarDay.tokens * 0.18);
  const cacheReadInputTokens = Math.round(calendarDay.tokens * 0.45);
  const cacheCreationInputTokens = Math.round(calendarDay.tokens * 0.05);

  return {
    dayStartMs,
    totals: {
      tokens: calendarDay.tokens,
      costUSD: calendarDay.costUSD,
      inputTokens,
      outputTokens,
      cacheReadInputTokens,
      cacheCreationInputTokens,
      reasoningOutputTokens:
        calendarDay.tokens -
        inputTokens -
        outputTokens -
        cacheReadInputTokens -
        cacheCreationInputTokens,
      webSearchRequests: 12 + Math.round(dayNoise(13, dayIndex, 67) * 52),
    },
    byModel: LANDING_USAGE_MODELS.map((model) => ({
      modelId: model.id,
      tokens: Math.round((sourceTotals.byModel[model.id] ?? 0) * scale),
    })).sort((a, b) => b.tokens - a.tokens),
    byUser: LANDING_USAGE_MEMBERS.map((member) => ({
      userId: member.id,
      tokens: Math.round((sourceTotals.byMember[member.id] ?? 0) * scale),
    })).sort((a, b) => b.tokens - a.tokens),
    users: Object.fromEntries(
      LANDING_USAGE_MEMBERS.map((member) => [member.id, { name: member.name }])
    ),
  };
}

export function buildLandingUsageDemo(range: UsageRange, labels: LandingUsageDataLabels) {
  const slices = slicesForRange(range);
  const byModelBuckets: StackedAreaBucket[] = [];
  const byMemberBuckets: StackedAreaBucket[] = [];
  let totalTokens = 0;
  let totalCost = 0;

  for (const slice of slices) {
    const totals = dayTotals(slice);
    const label = localizeLabel(slice.label, labels);
    totalTokens += totals.tokens;
    for (const model of LANDING_USAGE_MODELS) {
      totalCost += costForTokens(model.id, totals.byModel[model.id] ?? 0);
    }

    byModelBuckets.push({
      label,
      values: LANDING_USAGE_MODELS.map((m) => ({
        id: m.id,
        label: m.label,
        value: totals.byModel[m.id] ?? 0,
      })),
    });

    byMemberBuckets.push({
      label,
      values: LANDING_USAGE_MEMBERS.map((u) => ({
        id: u.id,
        label: u.name,
        value: totals.byMember[u.id] ?? 0,
      })),
    });
  }

  if (range === 'total') {
    const calendarTotals = landingCalendarTotals();
    const tokenScale = totalTokens > 0 ? calendarTotals.tokens / totalTokens : 1;
    for (const bucket of [...byModelBuckets, ...byMemberBuckets]) {
      for (const value of bucket.values) value.value *= tokenScale;
    }
    totalTokens = calendarTotals.tokens;
    totalCost = calendarTotals.costUSD;
  }

  return {
    byModelBuckets,
    byMemberBuckets,
    calendar: LANDING_USAGE_CALENDAR,
    timeline: buildLandingUsageTimeline(range, labels),
    totals: {
      tokens: totalTokens,
      costUSD: Math.round(totalCost * 100) / 100,
    },
  };
}

// ---- PR tab ----------------------------------------------------------------
//
// Compact thread so the landing PR card matches the usage card height:
//   Zixuan finds an issue → Lee: Fixed. → Wibus LGTM (one approve).
// The description is pre-structured Markdown (headings, bullets, inline code).

const LANDING_PR_CONVERSATION: readonly PowerPrConversationItem[] = [
  {
    kind: 'comment',
    id: 'issue-501',
    author: 'Zixuan',
    createdAt: '2026-07-30T14:20:00.000Z',
    body: 'List path still opens task docs on cold cache — fail closed if the index is missing.',
  },
  {
    kind: 'comment',
    id: 'issue-502',
    author: 'Lee',
    createdAt: '2026-07-30T15:10:00.000Z',
    body: 'Fixed.',
  },
  {
    kind: 'review',
    id: 'review-601',
    author: 'Wibus',
    submittedAt: '2026-07-31T16:00:00.000Z',
    body: 'LGTM!',
  },
];

export const LANDING_PR_DEMO_DATA: PowerPrData = {
  repoFullName: 'loro-dev/lody',
  number: 3175,
  title: 'feat(tasks): add task list/create MCP tools and property writes',
  author: 'Lee',
  createdAt: '2026-07-30T10:00:00.000Z',
  commits: 3,
  additions: 1314,
  deletions: 69,
  changedFiles: 9,
  body: [
    { kind: 'heading', text: 'Summary' },
    {
      kind: 'paragraph',
      runs: [
        'Add MCP tools so agents can list/create tasks and write properties without pasting a task id into the prompt.',
      ],
    },
    { kind: 'heading', text: 'Changes' },
    {
      kind: 'list',
      items: [
        [
          { code: 'list_tasks' },
          ' / ',
          { code: 'create_task' },
          ' tools on the workspace MCP surface',
        ],
        ['Property writes on the task document (status, assignee, custom fields)'],
        ['Fail closed when the task index is cold or missing — no silent empty lists'],
      ],
    },
  ],
  checksTotal: 3,
  conversation: LANDING_PR_CONVERSATION,
};
