import { describe, expect, it } from 'vitest';
import type { MessageContent, SessionHistoryInput } from '@lody/shared';

import { markAssistantTurnFinished } from './assistant-turn-finalize';

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

const compactionMarker = (
  toolCallId: string,
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
): MessageContent => ({
  type: 'tool_call',
  toolCallId,
  title: status === 'completed' ? 'Context compacted' : 'Compacting context',
  status,
  activityKind: 'context_compaction',
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

  it('settles a compaction the finished turn left open', () => {
    // Nothing but a notification for the same toolCallId can move a synthetic
    // compaction marker off `in_progress`, and the turn is over — so it would
    // spin forever. Unconditional: adapters ship separately from the host, so
    // the paths that happen to know the provider failed are not the only ones
    // that can strand a marker.
    const history = [
      assistantEntry({
        id: 'assistant:u1',
        items: [compactionMarker('compact-1', 'in_progress')],
      }),
    ];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });

    expect(history[0]).toMatchObject({ finished: true, endedAt: TURN_ENDED_AT });
    expect(history[0]?.items).toMatchObject([{ toolCallId: 'compact-1', status: 'failed' }]);
  });

  it('preserves a compaction the provider already settled', () => {
    const history = [
      assistantEntry({
        id: 'assistant:u1',
        items: [compactionMarker('compact-1', 'completed')],
      }),
    ];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });

    expect(history[0]?.items).toMatchObject([{ toolCallId: 'compact-1', status: 'completed' }]);
  });

  it('drops the duplicate markers one compaction episode minted', () => {
    // An adapter that re-opens a compaction already in flight (Claude Code
    // repeats `status: "compacting"`) mints a fresh toolCallId each time.
    // History merges tool calls by id, so every duplicate became its own
    // "Compacting context" row — n stacked spinners for one compaction. Only
    // the marker that carries the episode's outcome survives.
    const history = [
      assistantEntry({
        id: 'assistant:u1',
        items: [
          compactionMarker('compact-1', 'in_progress'),
          compactionMarker('compact-2', 'in_progress'),
          compactionMarker('compact-3', 'completed'),
        ],
      }),
    ];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });

    expect(history[0]?.items).toMatchObject([{ toolCallId: 'compact-3', status: 'completed' }]);
  });

  it('keeps an earlier compaction that reported its own outcome', () => {
    // A long turn legitimately compacts more than once. Those markers each
    // reached a terminal status, so none of them is a duplicate identity.
    const history = [
      assistantEntry({
        id: 'assistant:u1',
        items: [
          compactionMarker('compact-1', 'completed'),
          { type: 'text', text: 'work between compactions' },
          compactionMarker('compact-2', 'in_progress'),
        ],
      }),
    ];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });

    expect(history[0]?.items).toMatchObject([
      { toolCallId: 'compact-1', status: 'completed' },
      { type: 'text' },
      { toolCallId: 'compact-2', status: 'failed' },
    ]);
  });

  it('leaves an entry without compaction markers untouched', () => {
    const items: MessageContent[] = [{ type: 'text', text: 'hello' }];
    const history = [assistantEntry({ id: 'assistant:u1', items })];

    markAssistantTurnFinished(history, { endedAt: TURN_ENDED_AT });

    expect(history[0]?.items).toBe(items);
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
