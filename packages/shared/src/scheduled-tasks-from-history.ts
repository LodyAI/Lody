import { nextCronFireMs } from './cron-next-fire';
import type { PendingScheduledTask } from './schema';

/**
 * Derive the session's currently-pending scheduled tasks (cron jobs / wakeups) purely from
 * the Cron* / ScheduleWakeup `tool_call` items already in session history. Nothing extra is
 * persisted — not in `SessionMeta`, not as a new history item; the panel above the composer
 * calls this on the history it already renders.
 *
 * The persisted `tool_call` keeps `title` (the tool name), `rawInput`, `rawOutput`, `content`,
 * `status`, `schedulingTimeZone` (the creating machine's zone), and `recordedAtMs` (when the
 * call was first persisted), but not provider metadata. So we reconstruct from
 * `rawInput` + the call's `recordedAtMs` (falling back to the owning turn's timestamps):
 *  - ScheduleWakeup: only the latest matters; scheduledFor ≈ call time + delaySeconds (no TZ).
 *  - CronCreate: schedule/recurring/prompt come from rawInput.cron/recurring/prompt, and the
 *    cron is local-time to `schedulingTimeZone` — carried onto the task so the UI resolves it
 *    in the right zone (cron carries no timezone; the machine may differ from the viewer). For
 *    a one-shot (`recurring: false`), the output's `nextFireAt` line is the runtime-committed
 *    fire time and wins over any re-derivation from the expression.
 *  - CronDelete: removes any cron whose output text contains the deleted id.
 *  - CronList: skipped (its structured jobs aren't persisted).
 * Fire-time resolution and "already fired -> hide" happen in the UI (see `nextCronFireMs`).
 *
 * Why the turn entry's `endedAt` is NOT the anchor: cron-fire follow-up turns are
 * runtime-internal steers, so one history entry can aggregate several runtime turns and its
 * `endedAt` keeps advancing — past a one-shot's fire minute. Anchoring there rolls the
 * resolved fire time to the NEXT matching year (a fired job showing "fires in 364 days"),
 * and the panel's fired-row filter can never catch it because that phantom time is future.
 */

const MAX_SUMMARY_LENGTH = 200;
const WAKEUP_TASK_ID = 'wakeup';

export interface ScheduledTaskHistoryEntry {
  timestamp?: string;
  startedAt?: number;
  endedAt?: number;
  // Structural, not `MessageContent[]`: the web's mirror-generated history item type
  // diverges from the hand-written union, so we read items defensively at runtime.
  items?: readonly unknown[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function truncateSummary(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_SUMMARY_LENGTH
    ? `${trimmed.slice(0, MAX_SUMMARY_LENGTH - 1)}…`
    : trimmed;
}

/** Strip undefined fields so the result is minimal and comparisons stay stable. */
function cleanTask(task: PendingScheduledTask): PendingScheduledTask {
  const out: PendingScheduledTask = { id: task.id, kind: task.kind, createdAtMs: task.createdAtMs };
  if (task.scheduledForMs !== undefined) out.scheduledForMs = task.scheduledForMs;
  if (task.humanSchedule !== undefined) out.humanSchedule = task.humanSchedule;
  if (task.recurring !== undefined) out.recurring = task.recurring;
  if (task.durable !== undefined) out.durable = task.durable;
  if (task.summary !== undefined) out.summary = task.summary;
  if (task.timeZone !== undefined) out.timeZone = task.timeZone;
  return out;
}

/**
 * Best-effort anchor for a turn when the tool call carries no `recordedAtMs`: prefer when
 * it STARTED, else its timestamp; `endedAt` is the last resort (see the module doc — a
 * merged entry's `endedAt` can land past a one-shot's fire minute and skip a year ahead).
 */
function resolveAnchorMs(entry: ScheduledTaskHistoryEntry): number {
  if (typeof entry.startedAt === 'number' && Number.isFinite(entry.startedAt))
    return entry.startedAt;
  if (entry.timestamp) {
    const parsed = Date.parse(entry.timestamp);
    if (!Number.isNaN(parsed)) return parsed;
  }
  if (typeof entry.endedAt === 'number' && Number.isFinite(entry.endedAt)) return entry.endedAt;
  return 0;
}

/**
 * The runtime-committed fire time from a CronCreate output's `nextFireAt:` line (local ISO
 * with numeric offset, so `Date.parse` reads it exactly). The output format is a deliberate
 * one-key-per-line contract (`formatOutput` in the runtime's CronCreate tool), and the text
 * survives the history pipeline inside `rawOutput` / `content` (terminal_output). Returns
 * undefined when absent or unparseable — the caller falls back to re-deriving from the cron
 * expression.
 */
function parseCommittedOneShotFireMs(sourceText: string): number | undefined {
  const match =
    /nextFireAt:\s*"?(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2}))/i.exec(
      sourceText
    );
  if (!match || match[1] === undefined) return undefined;
  const parsed = Date.parse(match[1]);
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function collectPendingScheduledTasksFromHistory(
  entries: readonly ScheduledTaskHistoryEntry[]
): PendingScheduledTask[] {
  const cronByCallId = new Map<string, { task: PendingScheduledTask; sourceText: string }>();
  let wakeup: PendingScheduledTask | undefined;

  for (const entry of entries) {
    const anchorMs = resolveAnchorMs(entry);
    for (const rawItem of entry.items ?? []) {
      const item = asRecord(rawItem);
      if (!item || item.type !== 'tool_call' || item.status !== 'completed') continue;
      // `toolName` is the canonical name; older history pinned it into `title`.
      const toolName = asString(item.toolName) ?? asString(item.title);
      if (!toolName) continue;
      const rawInput = asRecord(item.rawInput) ?? {};

      switch (toolName) {
        case 'ScheduleWakeup': {
          const callMs = asFiniteNumber(item.recordedAtMs) ?? anchorMs;
          const delaySeconds = asFiniteNumber(rawInput.delaySeconds);
          wakeup = cleanTask({
            id: WAKEUP_TASK_ID,
            kind: 'wakeup',
            createdAtMs: callMs,
            scheduledForMs: delaySeconds !== undefined ? callMs + delaySeconds * 1000 : undefined,
            summary: truncateSummary(asString(rawInput.reason) ?? asString(rawInput.prompt)),
          });
          break;
        }
        case 'CronCreate': {
          const cron = asString(rawInput.cron);
          const toolCallId = asString(item.toolCallId);
          if (!cron || !toolCallId) break;
          // The created job's id (needed to match a later CronDelete) and the committed
          // one-shot fire time are only in the output text, so keep it for a robust
          // substring match and the `nextFireAt` parse.
          const sourceText = JSON.stringify([item.rawOutput ?? null, item.content ?? null]);
          const recurring = asBoolean(rawInput.recurring);
          cronByCallId.set(toolCallId, {
            task: cleanTask({
              id: toolCallId,
              kind: 'cron',
              // The call's own persist stamp is the true creation moment; the turn anchor
              // is only a fallback (see the module doc for why `endedAt` cannot serve).
              createdAtMs: asFiniteNumber(item.recordedAtMs) ?? anchorMs,
              humanSchedule: cron,
              recurring,
              summary: truncateSummary(asString(rawInput.prompt)),
              // Cron is local-time to the machine that created it (recorded at persist time).
              timeZone: asString(item.schedulingTimeZone),
              // One-shot: pin the runtime-committed fire time when the output carried it.
              // Only explicit `recurring: false` — an absent flag defaults to recurring in
              // the runtime, where nextFireAt is just the FIRST of many fires.
              scheduledForMs:
                recurring === false ? parseCommittedOneShotFireMs(sourceText) : undefined,
            }),
            sourceText,
          });
          break;
        }
        case 'CronDelete': {
          const id = asString(rawInput.id);
          if (!id) break;
          // Deleting the current key during Map iteration is safe per spec.
          for (const [callId, existing] of cronByCallId) {
            if (existing.sourceText.includes(id)) cronByCallId.delete(callId);
          }
          break;
        }
        default:
          break;
      }
    }
  }

  const cronTasks = [...cronByCallId.values()].map((entry) => entry.task);
  return wakeup ? [wakeup, ...cronTasks] : cronTasks;
}

/** Resolve a task's concrete fire time: wakeups and one-shot crons may carry it, cron jobs derive it. */
export function resolveFireMs(task: PendingScheduledTask, nowMs: number): number | undefined {
  if (task.kind === 'wakeup') {
    return typeof task.scheduledForMs === 'number' ? task.scheduledForMs : undefined;
  }
  if (!task.humanSchedule) return undefined;
  // Cron expressions are local-time to the machine that created the job, so resolve them in
  // that machine's timezone (falls back to the viewer's local zone when unknown).
  const timeZone = task.timeZone;
  // Recurring cron: next occurrence relative to now (always upcoming).
  if (task.recurring) return nextCronFireMs(task.humanSchedule, nowMs, timeZone);
  // One-shot cron with the runtime-committed fire time (parsed from CronCreate's output):
  // exact and anchor-independent, and once it has fired the time is in the PAST so the row
  // hides — this is the path that cannot produce a next-year phantom.
  if (typeof task.scheduledForMs === 'number') return task.scheduledForMs;
  // One-shot cron, legacy fallback: resolve its single fire time anchored at creation — so
  // once it has fired the time resolves to the PAST (and the row is hidden) instead of
  // jumping to next year.
  // Anchor just before the START of the creation minute (nextCronFireMs matches strictly
  // after `from`, rounded up to the next whole minute): a cron scheduled to fire in the
  // same minute it was created (e.g. "25 16 3 7 *" while the turn ends at 16:25:1x) must
  // still resolve to that minute — otherwise it skips a year ahead and never hides.
  const creationMinuteStartMs = Math.floor(task.createdAtMs / 60_000) * 60_000;
  return nextCronFireMs(task.humanSchedule, creationMinuteStartMs - 1, timeZone);
}
