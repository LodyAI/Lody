import { describe, expect, it } from 'vitest';
import type { MessageContent } from '../src/ai';
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
  it('derives a wakeup with scheduledFor = call time + delaySeconds', () => {
    const endedAt = 1_000_000;
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(endedAt, [
        toolCall({
          toolCallId: 'w1',
          title: 'ScheduleWakeup',
          rawInput: { delaySeconds: 120, reason: 'wake up and report' },
        }),
      ]),
    ]);
    expect(tasks).toEqual([
      {
        id: 'wakeup',
        kind: 'wakeup',
        createdAtMs: endedAt,
        scheduledForMs: endedAt + 120_000,
        summary: 'wake up and report',
      },
    ]);
  });

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

  it('derives a cron task from CronCreate rawInput', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(5_000, [
        toolCall({
          toolCallId: 'c1',
          title: 'CronCreate',
          rawInput: { cron: '0 9 * * 1-5', prompt: 'daily standup', recurring: true },
          rawOutput: 'Scheduled task ab9963d6 (0 9 * * 1-5).',
        }),
      ]),
    ]);
    expect(tasks).toEqual([
      {
        id: 'c1',
        kind: 'cron',
        createdAtMs: 5_000,
        humanSchedule: '0 9 * * 1-5',
        recurring: true,
        summary: 'daily standup',
      },
    ]);
  });

  it('propagates the persisted machine timezone onto the cron task', () => {
    const tasks = collectPendingScheduledTasksFromHistory([
      entry(5_000, [
        toolCall({
          toolCallId: 'c1',
          title: 'CronCreate',
          rawInput: { cron: '0 9 * * *', prompt: 'p' },
          schedulingTimeZone: 'America/New_York',
        }),
      ]),
    ]);
    expect(tasks[0]?.timeZone).toBe('America/New_York');
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

    it('ignores an absent/unparseable nextFireAt and falls back to the anchor', () => {
      const tasks = collectPendingScheduledTasksFromHistory([
        legacyEntry([oneShotCall({ recordedAtMs: CALL_AT, rawOutput: 'nextFireAt: null' })]),
      ]);
      expect(tasks[0]?.scheduledForMs).toBeUndefined();
      expect(resolveFireMs(tasks[0]!, NEXT_DAY)).toBe(FIRE_AT);
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
});
