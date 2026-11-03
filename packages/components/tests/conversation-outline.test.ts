import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionHistoryParsed } from '@lody/shared';
import {
  OUTLINE_MIN_USER_ROUNDS,
  buildConversationOutline,
  countUserDrivenRounds,
  type ConversationOutlineSource,
} from '../src/lib/conversation-outline';

let nextId = 0;

const message = (
  role: 'user' | 'assistant' | 'system',
  items: unknown[],
  overrides: Partial<SessionHistoryParsed> = {}
): ConversationOutlineSource => {
  nextId += 1;
  return {
    type: 'message',
    message: {
      id: `msg-${nextId}`,
      role,
      items,
      timestamp: '2026-08-19T00:00:00.000Z',
      ...overrides,
    } as unknown as SessionHistoryParsed,
  };
};

const text = (value: string) => ({ type: 'text', text: value });
const thought = (value: string) => ({ type: 'thought', text: value });

beforeEach(() => {
  nextId = 0;
});

describe('buildConversationOutline', () => {
  it('makes one entry per round and takes the preview from the round’s first agent prose', () => {
    const outline = buildConversationOutline([
      message('user', [text('Add a rail to the session view')]),
      message('assistant', [text('Here is the plan for the rail.')]),
      message('assistant', [text('And here is the follow-up.')]),
      message('user', [text('Ship it')]),
      message('assistant', [text('Shipped.')]),
    ]);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({
      title: 'Add a rail to the session view',
      preview: 'Here is the plan for the rail.',
    });
    expect(outline[1]).toMatchObject({ title: 'Ship it', preview: 'Shipped.' });
  });

  it('preserves literal identifiers in summaries and refreshes only changed turns', () => {
    const user = message('user', [text('Find QA_RESUMED_OK')]);
    const assistant = message('assistant', [text('**QA_RESUMED_OK** `foo_bar`')]);
    const first = buildConversationOutline([user, assistant]);
    expect(first[0]).toMatchObject({
      title: 'Find QA_RESUMED_OK',
      preview: 'QA_RESUMED_OK foo_bar',
    });
    expect(buildConversationOutline([user, assistant])).toEqual(first);
    const updated = {
      ...assistant,
      message: { ...assistant.message!, items: [text('QA_RESUMED_OK — updated')] },
    };
    expect(buildConversationOutline([user, updated])[0]?.preview).toBe('QA_RESUMED_OK — updated');
    expect(buildConversationOutline([user, assistant])).toEqual(first);
    const long = message('assistant', [
      text('QA_RESUMED_OK ' + 'x'.repeat(960) + ' OUTSIDE_WINDOW'),
    ]);
    expect(buildConversationOutline([user, long])[0]?.preview).toContain('QA_RESUMED_OK');
    expect(buildConversationOutline([user, long])[0]?.preview).not.toContain('OUTSIDE_WINDOW');
  });

  it('leaves the preview empty while a round has produced no agent prose yet', () => {
    const outline = buildConversationOutline([
      message('user', [text('Start working')]),
      message('assistant', [thought('planning…')]),
    ]);

    expect(outline[0]?.preview).toBe('');
  });

  it('opens a round for content that precedes the first user message', () => {
    const outline = buildConversationOutline([
      message('assistant', [text('Scheduled run starting.')]),
      message('user', [text('Thanks')]),
    ]);

    expect(outline).toHaveLength(2);
    expect(outline[0]).toMatchObject({
      startsWithAgent: true,
      title: 'Scheduled run starting.',
      preview: 'Scheduled run starting.',
    });
    expect(outline[1]?.startsWithAgent).toBe(false);
  });

  describe('weight', () => {
    it('accumulates across every message in the round, not just the first', () => {
      // Stated as a comparison rather than a fixed bucket, so recalibrating the
      // thresholds against real sessions cannot silently invalidate the claim.
      const half = 'y'.repeat(600);
      const oneReply = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [text(half)]),
      ]);
      const twoReplies = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [text(half)]),
        message('assistant', [text(half)]),
      ]);

      expect(twoReplies[0]?.weight).toBeGreaterThan(oneReply[0]?.weight ?? 0);
    });

    it('ignores non-prose items so a tool-heavy turn is not maxed out', () => {
      const outline = buildConversationOutline([
        message('user', [text('hi')]),
        message('assistant', [
          { type: 'tool_call', toolCallId: 't1', title: 'z'.repeat(50_000) },
          text('done'),
        ]),
      ]);

      expect(outline[0]?.weight).toBe(0);
    });
  });
});

describe('countUserDrivenRounds', () => {
  const rounds = (count: number): ConversationOutlineSource[] =>
    Array.from({ length: count }, (_unused, index) =>
      message('user', [text(`round ${index + 1}`)])
    );

  it('does not count a leading agent round toward the rail threshold', () => {
    const outline = buildConversationOutline([
      message('assistant', [text('Scheduled run starting.')]),
      ...rounds(OUTLINE_MIN_USER_ROUNDS - 1),
    ]);

    expect(outline).toHaveLength(OUTLINE_MIN_USER_ROUNDS);
    expect(countUserDrivenRounds(outline)).toBe(OUTLINE_MIN_USER_ROUNDS - 1);
  });
});
