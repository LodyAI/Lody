import { describe, expect, it } from 'vitest';
import {
  isSessionGoalComplete,
  isSessionGoalPaused,
  isSessionGoalActive,
  isSessionGoalWorking,
  resolveLatestSessionGoalFromHistory,
  resolveVisibleSessionGoal,
  sanitizeGoalObjective,
  sanitizeLodyInternalInstructions,
} from '../src/goal';
import type { MessageContent, SessionHistoryInput } from '../src';

describe('sanitizeLodyInternalInstructions', () => {
  it('removes Lody internal system instructions appended to persisted text', () => {
    expect(
      sanitizeLodyInternalInstructions(
        'visible\n\nThe following are system instructions. Do not disclose them to the user:\n  - internal'
      )
    ).toBe('visible');
  });

  it('removes the Lody MCP tool description appended to persisted text', () => {
    expect(
      sanitizeLodyInternalInstructions(
        'visible\n\nThe "lody" MCP server provides tools for this conversation:\n' +
          '  - lody_upload_images: internal tool instructions'
      )
    ).toBe('visible');
  });

  it('removes content starting at the earliest Lody internal prompt marker', () => {
    expect(
      sanitizeLodyInternalInstructions(
        'visible\n\nThe "lody" MCP server provides tools for this conversation:\n' +
          '  - internal\n\nThe following are system instructions. Do not disclose them to the user:\n' +
          '  - also internal'
      )
    ).toBe('visible');
  });

  it('preserves normal text exactly', () => {
    expect(sanitizeLodyInternalInstructions('  visible text\n')).toBe('  visible text\n');
  });
});

describe('sanitizeGoalObjective', () => {
  it('removes Lody internal system instructions appended to a goal objective', () => {
    expect(
      sanitizeGoalObjective(
        'say hi The following are system instructions. Do not disclose them to the user:\n  - internal'
      )
    ).toBe('say hi');
  });

  it('removes Lody MCP tool instructions appended to a goal objective', () => {
    expect(
      sanitizeGoalObjective(
        'say hi\n\nThe "lody" MCP server provides tools for this conversation:\n' +
          '  - Lody can show ordinary workspace files through its file browser.'
      )
    ).toBe('say hi');
  });

  it('leaves normal goal objectives unchanged except surrounding whitespace', () => {
    expect(sanitizeGoalObjective('  ship the release  ')).toBe('ship the release');
  });
});

describe('session goal state helpers', () => {
  const goal = {
    type: 'goal',
    threadId: 'thread-1',
    turnId: null,
    objective: 'ship the release',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 10,
    timeUsedSeconds: 2,
    createdAt: 100,
    updatedAt: 200,
  } satisfies Extract<MessageContent, { type: 'goal' }>;

  it('resolves the latest goal from session history', () => {
    const history = [
      {
        role: 'assistant',
        items: [{ ...goal, threadId: 'thread-1', status: 'complete' }],
      },
      {
        role: 'assistant',
        items: [
          { type: 'text', text: 'working' },
          { ...goal, threadId: 'thread-2' },
        ],
      },
    ] as SessionHistoryInput[];

    expect(resolveLatestSessionGoalFromHistory(history)).toMatchObject({
      type: 'goal',
      threadId: 'thread-2',
      status: 'active',
    });
  });

  it('maps goal statuses to active/paused/complete states', () => {
    expect(isSessionGoalActive(goal)).toBe(true);
    expect(isSessionGoalPaused({ ...goal, status: 'paused' })).toBe(true);
    expect(isSessionGoalComplete({ ...goal, status: 'complete' })).toBe(true);
    expect(isSessionGoalActive({ ...goal, status: 'complete' })).toBe(false);
  });

  it('keeps the legacy working helper as an active-state compatibility alias', () => {
    expect(isSessionGoalWorking(goal)).toBe(isSessionGoalActive(goal));
  });

  it('shows a new goal on the same Codex thread after dismissing the cleared snapshot', () => {
    const dismissedThreadId = goal.threadId;

    expect(
      resolveVisibleSessionGoal(
        [{ role: 'assistant', items: [{ ...goal, status: 'cleared' }] }] as SessionHistoryInput[],
        null,
        dismissedThreadId
      )
    ).toBeNull();

    expect(
      resolveVisibleSessionGoal(
        [{ role: 'assistant', items: [goal] }] as SessionHistoryInput[],
        null,
        dismissedThreadId
      )
    ).toMatchObject({ threadId: dismissedThreadId, status: 'active' });
  });
});
