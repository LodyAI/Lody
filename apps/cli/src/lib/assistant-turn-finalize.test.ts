import { describe, expect, it } from 'vitest';
import type { SessionHistoryInput } from '@lody/shared';

import {
  markAssistantTurnFinished,
  settleContextCompactionItemAsFailed,
} from './assistant-turn-finalize';

const OPENED_AT = Date.parse('2026-01-01T00:00:00.000Z');
const TURN_ENDED_AT = OPENED_AT + 12_000;
const APP_CLOSED_AT = OPENED_AT + 3_600_000;

const assistantEntry = (
  overrides: Partial<SessionHistoryInput> & { id: string }
): SessionHistoryInput => ({
  role: 'assistant',
  timestamp: new Date(OPENED_AT).toISOString(),
  items: [],
  fileDiff: [],
  ...overrides,
});

describe('markAssistantTurnFinished', () => {
  it('stamps the open assistant entry when no turn id is given', () => {
    const history = [assistantEntry({ id: 'assistant:u1' })];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });

    expect(history[0]).toMatchObject({ finished: true, endedAt: TURN_ENDED_AT });
  });

  it('leaves an already finished turn alone when a later teardown finalizes', () => {
    // Regression for #260: closing the app runs the no-turnId finalize for every
    // live session, which used to re-stamp `endedAt = now` on a turn that ended
    // an hour earlier and inflate its rendered "Worked for …".
    const history = [assistantEntry({ id: 'assistant:u1' })];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });
    markAssistantTurnFinished(history, { endedAt: APP_CLOSED_AT });

    expect(history[0]).toMatchObject({ finished: true, endedAt: TURN_ENDED_AT });
  });

  it('records no duration for a finished entry that never carried one', () => {
    // Image-group and file entries publish `finished: true` with no `endedAt`.
    const history = [assistantEntry({ id: 'assistant-image-1', finished: true })];

    markAssistantTurnFinished(history, { endedAt: APP_CLOSED_AT });

    expect(history[0]?.endedAt).toBeUndefined();
  });

  it('stamps the addressed turn even when a later assistant entry follows it', () => {
    const history = [
      assistantEntry({ id: 'assistant:u1' }),
      assistantEntry({ id: 'assistant-image-1', finished: true }),
    ];

    markAssistantTurnFinished(history, { turnId: 'assistant:u1', endedAt: TURN_ENDED_AT });

    expect(history[0]).toMatchObject({ finished: true, endedAt: TURN_ENDED_AT });
    expect(history[1]?.endedAt).toBeUndefined();
  });

  it('records the permission wait when the finalizing turn measured one', () => {
    const history = [assistantEntry({ id: 'assistant:u1' })];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT, permissionWaitMs: 4_000 });

    expect(history[0]?.permissionWaitMs).toBe(4_000);
  });

  it('settles an incomplete compaction only with provider failure evidence', () => {
    const history = [
      assistantEntry({
        id: 'assistant:u1',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-1',
            title: 'Context compacting',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      }),
    ];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });
    expect(history[0]?.items?.[0]).toMatchObject({ status: 'in_progress' });

    markAssistantTurnFinished(history, {
      endedAt: APP_CLOSED_AT,
      settleContextCompactionAsFailed: true,
    });
    expect(history[0]).toMatchObject({ finished: true, endedAt: TURN_ENDED_AT });
    expect(history[0]?.items?.[0]).toMatchObject({ status: 'failed' });
  });

  it('preserves a provider terminal compaction during failure finalization', () => {
    const history = [
      assistantEntry({
        id: 'assistant:u1',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-1',
            title: 'Context compacting',
            status: 'completed',
            activityKind: 'context_compaction',
          },
        ],
      }),
    ];

    markAssistantTurnFinished(history, {
      endedAt: TURN_ENDED_AT,
      settleContextCompactionAsFailed: true,
    });

    expect(history[0]?.items?.[0]).toMatchObject({ status: 'completed' });
  });

  it('never stamps a user or system entry standing after the turn', () => {
    const history: SessionHistoryInput[] = [
      assistantEntry({ id: 'assistant:u1' }),
      {
        id: 'system:1',
        role: 'system',
        timestamp: new Date(OPENED_AT).toISOString(),
        items: [],
        fileDiff: [],
      },
    ];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });

    expect(history[0]).toMatchObject({ finished: true, endedAt: TURN_ENDED_AT });
    expect(history[1]?.finished).toBeUndefined();
  });
});

describe('settleContextCompactionItemAsFailed', () => {
  it('settles only the exact unresolved activity owned by the requested turn', () => {
    const history = [
      assistantEntry({
        id: 'assistant:u1',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-old',
            title: 'Context compacting',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      }),
      assistantEntry({
        id: 'assistant:u2',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-current',
            title: 'Context compacting',
            status: 'in_progress',
            activityKind: 'context_compaction',
          },
        ],
      }),
    ];

    expect(
      settleContextCompactionItemAsFailed(history, {
        turnId: 'assistant:u1',
        toolCallId: 'compact-old',
      })
    ).toBe(true);
    expect(history[0]?.items?.[0]).toMatchObject({ status: 'failed' });
    expect(history[1]?.items?.[0]).toMatchObject({ status: 'in_progress' });
  });

  it('preserves terminal and mismatched activities', () => {
    const history = [
      assistantEntry({
        id: 'assistant:u1',
        items: [
          {
            type: 'tool_call',
            toolCallId: 'compact-1',
            title: 'Context compacting',
            status: 'completed',
            activityKind: 'context_compaction',
          },
        ],
      }),
    ];

    expect(
      settleContextCompactionItemAsFailed(history, {
        turnId: 'assistant:u1',
        toolCallId: 'compact-other',
      })
    ).toBe(false);
    expect(
      settleContextCompactionItemAsFailed(history, {
        turnId: 'assistant:u1',
        toolCallId: 'compact-1',
      })
    ).toBe(false);
    expect(history[0]?.items?.[0]).toMatchObject({ status: 'completed' });
  });
});
