import { z } from 'zod';

import { canShowSubscriptionRateLimits } from './session-usage';
import type { AgentConfigCliType, AgentConfigMeta } from '@lody/shared';

/**
 * Client half of the Codex reset forecast surface.
 *
 * `codex-resets.com` is a third-party site that watches public posts and
 * publishes AI-classified forecasts and scheduled reset announcements. Forecasts
 * are not commitments; schedules remain pending until execution is reported.
 * The UI keeps third-party attribution visible. The endpoint is a public, unauthenticated, read-only GET.
 *
 * Everything the UI reads is normalized here at the parse boundary, so no
 * component touches the wire's snake_case shape or an unvalidated URL.
 */

export const CODEX_RESETS_STATUS_URL = 'https://codex-resets.com/api/v1/status';

export type CodexResetWatchLevel = 'elevated' | 'strong';

export type CodexResetSource = {
  author: string;
  /** Already checked to be http(s); safe to put in an `href`. */
  url: string;
};

export type CodexResetWatch = {
  /** `null` when the API reports a level this build does not know. */
  level: CodexResetWatchLevel | null;
  /** `null` when the forecast carries no numeric probability. */
  chancePercent: number | null;
  /** Free-text forecast window with whitespace/trailing punctuation normalized. */
  windowText: string;
  observedAtIso: string;
  observedAtMs: number;
  expiresAtIso: string;
  expiresAtMs: number;
  text: string;
  source: CodexResetSource | null;
};

export type CodexResetAnnouncement = {
  announcedAtIso: string;
  announcedAtMs: number;
  text: string;
  source: CodexResetSource | null;
};

export type CodexScheduledReset = CodexResetAnnouncement & {
  scheduledForIso: string | null;
  scheduledForMs: number | null;
};

export type CodexResetStatus = {
  scheduledReset: CodexScheduledReset | null;
  watch: CodexResetWatch | null;
  latestReset: CodexResetAnnouncement | null;
};

// Only the fields the UI renders are described. Unknown keys are stripped, and
// `stats` is ignored on purpose, so an additive server change cannot break the
// dialog.
const sourceSchema = z.object({
  // Source attribution is ancillary. The endpoint occasionally omits the
  // author, which must not make the forecast status itself unusable.
  author: z.string().optional(),
  url: z.string().optional(),
});

const watchSchema = z.object({
  level: z.string(),
  reset_chance_percent: z.number().nullish(),
  forecast_window: z.string(),
  observed_at: z.string(),
  expires_at: z.string(),
  text: z.string(),
  source: sourceSchema.nullish(),
});

const resetSchema = z.object({
  announced_at: z.string(),
  text: z.string(),
  source: sourceSchema.nullish(),
});

const scheduledResetSchema = resetSchema.extend({
  status: z.literal('scheduled'),
  scheduled_for: z.string().nullable(),
});

const statusResponseSchema = z.object({
  data: z.object({
    latest_reset: resetSchema.nullish(),
    scheduled_reset: scheduledResetSchema.nullish(),
    active_watch: watchSchema.nullish(),
  }),
});

/** Only http(s) reaches an `href`; anything else (javascript:, data:) is dropped. */
export function sanitizeExternalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    return url.toString();
  } catch {
    return null;
  }
}

function parseSource(
  raw: z.infer<typeof sourceSchema> | null | undefined
): CodexResetSource | null {
  const url = sanitizeExternalUrl(raw?.url);
  if (!raw?.author || !url) return null;
  return { author: raw.author, url };
}

function parseTimestamp(raw: string): number | null {
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseLevel(raw: string): CodexResetWatchLevel | null {
  return raw === 'elevated' || raw === 'strong' ? raw : null;
}

function parseChancePercent(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * `forecast_window` is free text and is NOT a timestamp — it can be "the next 6
 * hours", "6-12h", or "later today". So this only tidies whitespace and a
 * trailing sentence period; the phrase itself is passed through verbatim and is
 * always presented as a labelled window, never spliced into a sentence that
 * would claim a reset happens at a particular time.
 */
export function normalizeForecastWindowText(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。]+$/, '')
    .trim();
}

/**
 * Formats the API's UTC expiry instant as a semantic local time (for example,
 * "Tomorrow 2:00 PM" / "明天 14:00"). An explicit `timeZone` is accepted for
 * deterministic tests; production callers omit it so Intl uses the browser/OS
 * time zone.
 */
export function formatCodexResetExpiry(
  epochMs: number,
  nowMs: number,
  locale?: string,
  timeZone?: string
): string {
  // i18next uses `zh_CN` in some compositions, while Intl requires `zh-CN`.
  const intlLocale = locale?.replace(/_/g, '-') || undefined;

  const calendarDay = (value: number): number => {
    const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      ...(timeZone ? { timeZone } : {}),
    }).formatToParts(new Date(value));
    const part = (type: 'year' | 'month' | 'day') =>
      Number(parts.find((item) => item.type === type)?.value);
    return Date.UTC(part('year'), part('month') - 1, part('day'));
  };

  const dayDelta = Math.round((calendarDay(epochMs) - calendarDay(nowMs)) / 86_400_000);
  const time = new Intl.DateTimeFormat(intlLocale, {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(epochMs));

  if (dayDelta >= -1 && dayDelta <= 1) {
    const day = new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' }).format(
      dayDelta,
      'day'
    );
    return `${day.charAt(0).toLocaleUpperCase(intlLocale)}${day.slice(1)} ${time}`;
  }

  return new Intl.DateTimeFormat(intlLocale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(epochMs));
}

/**
 * Returns `null` for any response shape this build does not understand, so a
 * caller can present "unavailable" instead of rendering half a forecast.
 */
export function parseCodexResetStatusResponse(value: unknown): CodexResetStatus | null {
  const parsed = statusResponseSchema.safeParse(value);
  if (!parsed.success) return null;

  const rawWatch = parsed.data.data.active_watch;
  let watch: CodexResetWatch | null = null;
  if (rawWatch) {
    const observedAtMs = parseTimestamp(rawWatch.observed_at);
    const expiresAtMs = parseTimestamp(rawWatch.expires_at);
    const windowText = normalizeForecastWindowText(rawWatch.forecast_window);
    // A watch without a usable window or expiry cannot be shown honestly:
    // both drive the copy and the "is this still valid" check.
    if (observedAtMs !== null && expiresAtMs !== null && windowText.length > 0) {
      watch = {
        level: parseLevel(rawWatch.level),
        chancePercent: parseChancePercent(rawWatch.reset_chance_percent),
        windowText,
        observedAtIso: new Date(observedAtMs).toISOString(),
        observedAtMs,
        expiresAtIso: new Date(expiresAtMs).toISOString(),
        expiresAtMs,
        text: rawWatch.text,
        source: parseSource(rawWatch.source),
      };
    }
  }

  const rawReset = parsed.data.data.latest_reset;
  let latestReset: CodexResetAnnouncement | null = null;
  if (rawReset) {
    const announcedAtMs = parseTimestamp(rawReset.announced_at);
    if (announcedAtMs !== null) {
      latestReset = {
        announcedAtIso: new Date(announcedAtMs).toISOString(),
        announcedAtMs,
        text: rawReset.text,
        source: parseSource(rawReset.source),
      };
    }
  }

  const rawScheduled = parsed.data.data.scheduled_reset;
  let scheduledReset: CodexScheduledReset | null = null;
  if (rawScheduled) {
    const announcedAtMs = parseTimestamp(rawScheduled.announced_at);
    const scheduledForMs =
      rawScheduled.scheduled_for === null ? null : parseTimestamp(rawScheduled.scheduled_for);
    if (announcedAtMs !== null) {
      scheduledReset = {
        announcedAtIso: new Date(announcedAtMs).toISOString(),
        announcedAtMs,
        scheduledForIso: scheduledForMs === null ? null : new Date(scheduledForMs).toISOString(),
        scheduledForMs,
        text: rawScheduled.text,
        source: parseSource(rawScheduled.source),
      };
    }
  }

  return { watch, latestReset, scheduledReset };
}

/** The watch, but only while it is still in force at `nowMs`. */
export function selectActiveCodexResetWatch(
  status: CodexResetStatus | null | undefined,
  nowMs: number
): CodexResetWatch | null {
  const watch = status?.watch;
  if (!watch) return null;
  return watch.expiresAtMs > nowMs ? watch : null;
}

export function isCodexResetWatchExpired(
  status: CodexResetStatus | null | undefined,
  nowMs: number
): boolean {
  const watch = status?.watch;
  return !!watch && watch.expiresAtMs <= nowMs;
}

/**
 * The forecast tracks OpenAI's own Codex subscription limits, so it is shown on
 * exactly the providers whose subscription usage Lody already reports: a
 * built-in Codex provider with no custom key or third-party brand behind it.
 */
export function canShowCodexResetForecast({
  cliType,
  agentType,
  config,
}: {
  cliType: AgentConfigCliType;
  agentType: string;
  config?: Pick<AgentConfigMeta, 'brandId' | 'env'> | null;
}): boolean {
  return agentType === 'codex' && canShowSubscriptionRateLimits({ cliType, agentType, config });
}

export type CodexResetStatusFetchResult = {
  /** `null` on a 304: the caller's cached status is still current. */
  status: CodexResetStatus | null;
  /** Echo back on the next request as `If-None-Match`. */
  etag: string | null;
  /** `max-age` from the response, or `null` when the server did not say. */
  maxAgeMs: number | null;
};

export type CodexResetStatusFetcher = (options: {
  etag: string | null;
  signal?: AbortSignal;
}) => Promise<CodexResetStatusFetchResult>;

/** `max-age` only — `s-maxage` addresses shared caches, which we are not. */
export function parseCacheControlMaxAgeMs(header: string | null | undefined): number | null {
  if (!header) return null;
  const match = /(?:^|[\s,])max-age\s*=\s*"?(\d+)"?/i.exec(header);
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds * 1000 : null;
}

export const fetchCodexResetStatus: CodexResetStatusFetcher = async ({ etag, signal }) => {
  const response = await fetch(CODEX_RESETS_STATUS_URL, {
    method: 'GET',
    // Third-party public endpoint: never attach Lody credentials to it.
    credentials: 'omit',
    headers: {
      accept: 'application/json',
      // Revalidate cheaply instead of re-downloading an unchanged forecast.
      ...(etag ? { 'if-none-match': etag } : {}),
    },
    signal,
  });

  const nextEtag = response.headers.get('etag') ?? etag;
  const maxAgeMs = parseCacheControlMaxAgeMs(response.headers.get('cache-control'));

  if (response.status === 304) {
    return { status: null, etag: nextEtag, maxAgeMs };
  }
  if (!response.ok) {
    throw new Error(`Codex reset status request failed with HTTP ${response.status}`);
  }
  const parsed = parseCodexResetStatusResponse(await response.json());
  if (!parsed) {
    throw new Error('Codex reset status response did not match the expected shape');
  }
  return { status: parsed, etag: nextEtag, maxAgeMs };
};
