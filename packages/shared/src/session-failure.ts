import { z } from 'zod';

/**
 * A normalized, coordinator-facing failure reason. Provider-specific causes
 * stay available through the raw chat notice; this vocabulary answers what a
 * caller can do next (wait for quota, start a fresh Session, retry, or ask a
 * human). The Operation schema is strict, so a reader that validates it must
 * know these optional fields; the human-readable message stays independent.
 */
export const LodyFailureReasonSchema = z.enum([
  'usage_limit',
  'context_overflow',
  'model_error',
  'permission_denied',
  'cancelled',
  'agent_crash',
  'unknown',
]);

export type LodyFailureReason = z.infer<typeof LodyFailureReasonSchema>;

/** Bounds provider text copied into durable Operation results and history pages. */
export const MAX_FAILURE_DETAIL_CHARS = 500;

const CONTEXT_OVERFLOW_PATTERNS = [
  /\bcontext(?:[ _-](?:window|length|limit))\b[\s\S]{0,120}\b(?:exceed\w*|over\w*|too (?:long|large)|maximum|max\w*|limit)\b/i,
  /\b(?:exceed\w*|over\w*|too (?:long|large)|maximum|max\w*)\b[\s\S]{0,80}\bcontext(?:[ _-](?:window|length|limit))\b/i,
  /\bcontext[_-]length[_-]exceeded\b/i,
  /\b(?:maximum|max) context\b/i,
  /\bprompt is too long\b/i,
  /\b(?:input|conversation|request) (?:is )?too long\b/i,
  /\btoo many (?:input )?tokens\b/i,
  /\btoken (?:limit|budget) exceeded\b/i,
] as const;

const USAGE_LIMIT_PATTERNS = [
  /\byou(?:'ve| have) hit your\b[\s\S]{0,80}\blimit\b/i,
  /\b(?:usage|rate|quota|session|weekly|daily|hourly|5[ _-]?hour|five[ _-]?hour)[ _-]?limit\b[\s\S]{0,120}\b(?:reached|exceeded|exhausted|hit|resets?|try again)\b/i,
  /\b(?:exceeded|reached|exhausted)\b[\s\S]{0,80}\b(?:usage|rate|quota)\b[\s\S]{0,40}\blimit\b/i,
  /\b(?:quota|usage) (?:exceeded|exhausted|reached)\b/i,
  /\btoo many requests\b/i,
  /\b(?:billing|credit) (?:limit|balance)\b[\s\S]{0,80}\b(?:reached|exceeded|too low|insufficient)\b/i,
] as const;

const PERMISSION_PATTERNS = [
  /\bpermission denied\b/i,
  /\baccess denied\b/i,
  /\bnot (?:authorized|allowed|permitted)\b/i,
  /\bforbidden\b/i,
  /\bsign[ -]?in (?:again|required)\b/i,
] as const;

const CONTEXT_OVERFLOW_REASON_CODES = new Set(['context_overflow']);
const USAGE_LIMIT_REASON_CODES = new Set([
  'usage_limit',
  'rate_limit',
  'rate_limited',
  'quota_exceeded',
  'quota_exhausted',
]);
const CANCELLED_REASON_CODES = new Set(['cancelled', 'canceled', 'acp_request_cancelled']);
const PERMISSION_REASON_CODES = new Set([
  'permission_denied',
  'machine_access_denied',
  'session_archived',
  'agent_type_mismatch',
  'acp_auth_required',
]);
const MODEL_ERROR_REASON_CODES = new Set([
  'model_error',
  'acp_internal_error',
  'acp_upstream_api_error',
  'acp_provider_overloaded',
  'acp_session_storage_incompatible',
  'acp_resource_not_found',
  'acp_method_not_found',
  'acp_invalid_params',
  'acp_invalid_request',
  'acp_parse_error',
  'acp_unknown_error',
]);
const AGENT_CRASH_REASON_CODES = new Set([
  'agent_crash',
  'agent_disconnected',
  'agent_no_output',
  'session_init_failed',
  'session_restore_failed',
  'session_not_found',
  'acp_not_ready',
  'memory_pressure',
  'turn_pre_prompt_failed',
  'message_delivery_failed',
]);

/**
 * Remove credential-shaped text before provider copy is persisted or returned
 * to another Session. Bare environment values cannot be recognized reliably;
 * assignments and well-known token formats are redacted so neither an
 * `API_KEY=…` dump nor a bearer token crosses the Operation boundary.
 */
export function redactFailureDetail(value: string, maxChars = MAX_FAILURE_DETAIL_CHARS): string {
  let text = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [redacted]')
    .replace(/\b(?:sk|rk|pk)-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{8,}\b/g, '[redacted]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g, '[redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    .replace(
      /\b([A-Za-z][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]'
    )
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|secret|password)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '$1=[redacted]'
    )
    .replace(/\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/gi, 'https://[redacted]@');
  const characters = Array.from(text);
  if (characters.length > maxChars) text = characters.slice(0, maxChars).join('');
  return text.trim();
}

export function classifyFailureReason(notice: {
  reason?: string;
  message?: string;
}): LodyFailureReason {
  const message = notice.message ?? '';
  if (CONTEXT_OVERFLOW_PATTERNS.some((pattern) => pattern.test(message))) return 'context_overflow';
  if (USAGE_LIMIT_PATTERNS.some((pattern) => pattern.test(message))) return 'usage_limit';
  if (PERMISSION_PATTERNS.some((pattern) => pattern.test(message))) return 'permission_denied';
  const reason = notice.reason;
  if (!reason) return 'unknown';
  if (CONTEXT_OVERFLOW_REASON_CODES.has(reason)) return 'context_overflow';
  if (USAGE_LIMIT_REASON_CODES.has(reason)) return 'usage_limit';
  if (CANCELLED_REASON_CODES.has(reason)) return 'cancelled';
  if (PERMISSION_REASON_CODES.has(reason)) return 'permission_denied';
  if (MODEL_ERROR_REASON_CODES.has(reason)) return 'model_error';
  if (AGENT_CRASH_REASON_CODES.has(reason)) return 'agent_crash';
  return 'unknown';
}

export const retryableFailureReason = (reason: LodyFailureReason): boolean => {
  switch (reason) {
    case 'usage_limit':
    case 'model_error':
    case 'cancelled':
    case 'agent_crash':
      return true;
    case 'context_overflow':
    case 'permission_denied':
    case 'unknown':
      return false;
  }
};

const parseIsoResetAt = (message: string): string | undefined => {
  const match = message.match(
    /\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))\b/
  );
  if (!match?.[1]) return undefined;
  const timestamp = Date.parse(match[1]);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
};

const nextUtcTime = (referenceMs: number, hours: number, minutes: number): string | undefined => {
  if (!Number.isFinite(referenceMs) || hours > 23 || minutes > 59) return undefined;
  const reference = new Date(referenceMs);
  let timestamp = Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate(),
    hours,
    minutes
  );
  // Provider copy names the next occurrence of that wall-clock time, not a
  // timestamp that may already be in the past.
  if (timestamp <= referenceMs) timestamp += 24 * 60 * 60 * 1000;
  return new Date(timestamp).toISOString();
};

/**
 * Parse provider quota copy into a reset instant. Explicit ISO timestamps win;
 * wall-clock copy (`resets 6am (UTC)`, `try again at 7:20 AM`) is interpreted
 * as UTC and moved to its next occurrence. Unknown copy stays unset rather
 * than inventing a reset at which a scheduler would retry too early.
 */
export function parseFailureResetAt(
  message: string | undefined,
  referenceMs: number
): string | undefined {
  if (!message) return undefined;
  const iso = parseIsoResetAt(message);
  if (iso) return iso;
  const hasExplicitUtcZone = (rest: string): boolean =>
    /^\s*(?:\((?:UTC|GMT)\)|(?:UTC|GMT)\b)/i.test(rest);
  const meridiem =
    /\b(?:resets?|reset|try again)(?:\s+at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i.exec(message);
  if (meridiem?.[1]) {
    const rest = message.slice((meridiem.index ?? 0) + meridiem[0].length);
    // A wall-clock reset without a named UTC/GMT zone is the provider's local
    // time. Treating it as UTC would schedule a retry hours too early or late.
    if (!hasExplicitUtcZone(rest)) return undefined;
    const rawHours = Number.parseInt(meridiem[1], 10);
    const minutes = meridiem[2] ? Number.parseInt(meridiem[2], 10) : 0;
    const isPm = meridiem[3]?.toLowerCase() === 'pm';
    const hours = (rawHours % 12) + (isPm ? 12 : 0);
    return nextUtcTime(referenceMs, hours, minutes);
  }
  const clock = /\b(?:resets?|reset)(?:\s+at)?\s+(\d{1,2}):(\d{2})\b/i.exec(message);
  if (clock?.[1] && clock[2]) {
    const rest = message.slice((clock.index ?? 0) + clock[0].length);
    if (!hasExplicitUtcZone(rest)) return undefined;
    return nextUtcTime(referenceMs, Number.parseInt(clock[1], 10), Number.parseInt(clock[2], 10));
  }
  return undefined;
}

export type ChatFailureDescription = {
  reason: LodyFailureReason;
  retryable: boolean;
  detail?: string;
  resetAt?: string;
  at?: string;
};

/** Normalize one durable `chat_failed` notice for callers outside the banner. */
export function describeChatFailure(
  notice: { reason?: string; message?: string; at?: string; resetAt?: string } | undefined,
  referenceMs = Date.now()
): ChatFailureDescription {
  if (!notice) return { reason: 'unknown', retryable: false };
  const reason = classifyFailureReason(notice);
  const detail = notice.message ? redactFailureDetail(notice.message) : undefined;
  const explicitReset = notice.resetAt ? Date.parse(notice.resetAt) : Number.NaN;
  const resetAt =
    reason === 'usage_limit'
      ? Number.isFinite(explicitReset)
        ? new Date(explicitReset).toISOString()
        : parseFailureResetAt(detail, referenceMs)
      : undefined;
  return {
    reason,
    retryable: retryableFailureReason(reason),
    ...(detail ? { detail } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(notice.at ? { at: notice.at } : {}),
  };
}

export const LodyTurnFailureSchema = z
  .object({
    reason: LodyFailureReasonSchema,
    detail: z.string().optional(),
    at: z.string(),
    resetAt: z.string().optional(),
    turnId: z.string().optional(),
    assistantTurnId: z.string().optional(),
  })
  .strict();

export type LodyTurnFailure = z.infer<typeof LodyTurnFailureSchema>;
