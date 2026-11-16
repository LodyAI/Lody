import { describe, expect, it } from 'vitest';
import type { MessageContent } from '../src/ai';
import { nextCronFireMs } from '../src/cron-next-fire';
import {
  collectPendingScheduledTasksFromHistory,
  resolveFireMs,
  type ScheduledTaskHistoryEntry,
} from '../src/scheduled-tasks-from-history';

function toolCall(args: {
  toolCallId: string;
  title: string;
  status?: 'pending' | 'in_progress' | 'completed' | 'failed';
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  content?: unknown;
  schedulingTimeZone?: string;
  recordedAtMs?: number;
}): MessageContent {
  return {
    type: 'tool_call',
    toolCallId: args.toolCallId,
    title: args.title,
    status: args.status ?? 'completed',
    kind: 'other',
    rawInput: args.rawInput,
    rawOutput: args.rawOutput,
    content: args.content,
    schedulingTimeZone: args.schedulingTimeZone,
    recordedAtMs: args.recordedAtMs,
  } as MessageContent;
}

function entry(endedAt: number, items: MessageContent[]): ScheduledTaskHistoryEntry {
  return { timestamp: new Date(endedAt).toISOString(), endedAt, items };
}

describe('collectPendingScheduledTasksFromHistory', () => {
  it('keeps only the latest ScheduleWakeup', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(1_000, [
        toolCall({
          toolCallId: 'w1',
          title: 'ScheduleWakeup',
          rawInput: { delaySeconds: 60, reason: 'first' },
        }),
      ]),
      entry(2_000, [
        toolCall({
          toolCallId: 'w2',
          title: 'ScheduleWakeup',
          rawInput: { delaySeconds: 30, reason: 'second' },
        }),
      ]),
    ]);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      id: 'wakeup',
      createdAtMs: 2_000,
      scheduledForMs: 2_000 + 30_000,
      summary: 'second',
    });
  });

  it('removes a cron when a later CronDelete references its id', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(1_000, [
        toolCall({
          toolCallId: 'c1',
          title: 'CronCreate',
          rawInput: { cron: '17 8 3 7 *', prompt: 'one-shot' },
          rawOutput: 'Scheduled one-shot task ab9963d6 (17 8 3 7 *).',
        }),
      ]),
      entry(2_000, [
        toolCall({ toolCallId: 'd1', title: 'CronDelete', rawInput: { id: 'ab9963d6' } }),
      ]),
    ]);
    expect(tasks).toEqual([]);
  });

  it('ignores non-completed tool calls and unrelated tools', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(1_000, [
        toolCall({
          toolCallId: 'p1',
          title: 'CronCreate',
          status: 'pending',
          rawInput: { cron: '* * * * *' },
        }),
        toolCall({ toolCallId: 'r1', title: 'Read', rawInput: { path: 'x' } }),
        { type: 'text', text: 'hello' } as MessageContent,
      ]),
    ]);
    expect(tasks).toEqual([]);
  });

  it('coexists a wakeup and cron jobs, wakeup first', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(1_000, [
        toolCall({
          toolCallId: 'c1',
          title: 'CronCreate',
          rawInput: { cron: '0 9 * * *', prompt: 'p' },
        }),
        toolCall({
          toolCallId: 'w1',
          title: 'ScheduleWakeup',
          rawInput: { delaySeconds: 30, reason: 'r' },
        }),
      ]),
    ]);
    expect(tasks.map((t) => t.kind)).toEqual(['wakeup', 'cron']);
  });

  describe('one-shot cron anchoring', () => {
    // Regression for the "fires in 364 days" phantom: cron-fire follow-up turns are
    // runtime-internal steers, so one history entry can aggregate several runtime turns.
    // The entry's endedAt (03:39) then lands PAST the one-shot's 03:33 fire minute, and
    // anchoring the creation there resolves the fire time to the NEXT year — future, so
    // the fired-row filter never hides it. All timestamps pinned to +08:00 so the test is
    // zone-independent.
    const TURN_START = Date.parse('2026-09-03T03:13:39+08:00');
    const CALL_AT = Date.parse('2026-09-03T03:18:43+08:00');
    const FIRE_AT = Date.parse('2026-09-03T03:33:00+08:00');
    const ENTRY_END = Date.parse('2026-09-03T03:39:15+08:00');
    const NEXT_DAY = Date.parse('2026-09-04T03:00:00+08:00');

    const oneShotCall = (extra: {
      recordedAtMs?: number;
      content?: unknown;
      rawOutput?: unknown;
    }): MessageContent =>
      toolCall({
        toolCallId: 'c1',
        title: 'CronCreate',
        rawInput: { cron: '33 3 3 9 *', prompt: 'check progress', recurring: false },
        schedulingTimeZone: 'Asia/Shanghai',
        ...extra,
      });

    const legacyEntry = (items: MessageContent[]): ScheduledTaskHistoryEntry => ({
      timestamp: new Date(TURN_START).toISOString(),
      endedAt: ENTRY_END,
      items,
    });

    it('prefers the runtime-committed nextFireAt from the output, immune to the entry times', () => {
      // Production persistence shape: the output text lives in a content terminal_output
      // block, not rawOutput.
      const output =
        'id: 01M1HRYC69Y0J184PQN1GEZHXJ\n' +
        'cron: 33 3 3 9 *\n' +
        'humanSchedule: at 03:33 on day 3 of September\n' +
        'recurring: false\n' +
        'nextFireAt: 2026-09-03T03:33:00.000+08:00';
      const tasks = collectPendingScheduledTasksFromHistory([
        legacyEntry([
          oneShotCall({ content: [{ type: 'terminal_output', output, truncated: false }] }),
        ]),
      ]);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]?.scheduledForMs).toBe(FIRE_AT);
      // Long after the fire, resolution still returns the committed (past) time — the
      // panel's fired-row filter hides it instead of showing next year.
      expect(resolveFireMs(tasks[0]!, NEXT_DAY)).toBe(FIRE_AT);
      expect(FIRE_AT < NEXT_DAY).toBe(true);
    });

    it('anchors at the call recordedAtMs when the output carried no nextFireAt', () => {
      const tasks = collectPendingScheduledTasksFromHistory([
        legacyEntry([oneShotCall({ recordedAtMs: CALL_AT })]),
      ]);
      expect(tasks[0]?.createdAtMs).toBe(CALL_AT);
      expect(tasks[0]?.scheduledForMs).toBeUndefined();
      expect(resolveFireMs(tasks[0]!, NEXT_DAY)).toBe(FIRE_AT);
    });

    it('legacy fallback anchors at the turn START, not its (merged) end', () => {
      const tasks = collectPendingScheduledTasksFromHistory([legacyEntry([oneShotCall({})])]);
      // Turn-start anchor: the first match after 03:13 is 03:33 the same day — the entry's
      // endedAt (03:39) must not push the resolution to next year.
      expect(tasks[0]?.createdAtMs).toBe(TURN_START);
      expect(resolveFireMs(tasks[0]!, NEXT_DAY)).toBe(FIRE_AT);
    });

    it('ignores a nextFireAt line on recurring jobs (it is only their FIRST fire)', () => {
      const tasks = collectPendingScheduledTasksFromHistory([
        entry(1_000, [
          toolCall({
            toolCallId: 'c1',
            title: 'CronCreate',
            rawInput: { cron: '*/20 * * * *', prompt: 'p', recurring: true },
            rawOutput:
              'id: job1\ncron: */20 * * * *\nrecurring: true\nnextFireAt: 2026-09-03T03:20:00.000+08:00',
          }),
        ]),
      ]);
      expect(tasks[0]?.scheduledForMs).toBeUndefined();
      const fire = resolveFireMs(tasks[0]!, NEXT_DAY);
      expect(typeof fire).toBe('number');
      expect(fire!).toBeGreaterThan(NEXT_DAY);
    });

    it('anchors a wakeup at the call recordedAtMs, not the turn', () => {
      const tasks = collectPendingScheduledTasksFromHistory([
        legacyEntry([
          toolCall({
            toolCallId: 'w1',
            title: 'ScheduleWakeup',
            rawInput: { delaySeconds: 120, reason: 'r' },
            recordedAtMs: CALL_AT,
          }),
        ]),
      ]);
      expect(tasks[0]?.createdAtMs).toBe(CALL_AT);
      expect(tasks[0]?.scheduledForMs).toBe(CALL_AT + 120_000);
    });
  });

  it('resolveFireMs handles wakeup, missing schedule, and same-minute one-shot creation', () => {
    expect(
      resolveFireMs(
        { id: 'wakeup', kind: 'wakeup', createdAtMs: 1_000, scheduledForMs: 31_000 },
        5_000
      )
    ).toBe(31_000);
    expect(resolveFireMs({ id: 'wakeup', kind: 'wakeup', createdAtMs: 1_000 }, 5_000)).toBe(
      undefined
    );
    expect(resolveFireMs({ id: 'cron-1', kind: 'cron', createdAtMs: 1_000 }, 5_000)).toBe(
      undefined
    );
    const createdInTargetMinute = Date.parse('2026-07-03T16:25:15+08:00');
    const sameMinuteFire = Date.parse('2026-07-03T16:25:00+08:00');
    expect(
      resolveFireMs(
        {
          id: 'cron-same-minute',
          kind: 'cron',
          createdAtMs: createdInTargetMinute,
          humanSchedule: '25 16 3 7 *',
          recurring: false,
          timeZone: 'Asia/Shanghai',
        },
        Date.parse('2026-07-03T17:00:00+08:00')
      )
    ).toBe(sameMinuteFire);
  });
});

describe('nextCronFireMs — timezone', () => {
  const utc = (y: number, mo: number, d: number, h: number, mi: number) =>
    Date.UTC(y, mo - 1, d, h, mi);
  const localMs = (year: number, month1: number, day: number, hour: number, minute: number) =>
    new Date(year, month1 - 1, day, hour, minute, 0, 0).getTime();

  it('resolves the cron in the given zone, not the runner local zone', () => {
    const from = utc(2026, 7, 1, 0, 0);
    expect(nextCronFireMs('0 9 * * *', from, 'America/New_York')).toBe(utc(2026, 7, 1, 13, 0));
    expect(nextCronFireMs('0 9 * * *', from, 'Asia/Shanghai')).toBe(utc(2026, 7, 1, 1, 0));
  });

  it('crosses a spring-forward DST boundary correctly', () => {
    expect(nextCronFireMs('0 9 * * *', utc(2026, 3, 7, 15, 0), 'America/New_York')).toBe(
      utc(2026, 3, 8, 13, 0)
    );
  });

  it('falls back to the local zone for an unusable timezone', () => {
    const from = localMs(2026, 7, 1, 8, 0);
    expect(nextCronFireMs('0 9 * * *', from, 'Not/AZone')).toBe(nextCronFireMs('0 9 * * *', from));
  });
});
