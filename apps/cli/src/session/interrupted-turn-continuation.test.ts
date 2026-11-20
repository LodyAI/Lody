import type { SessionMeta } from '@lody/shared';
import { describe, expect, it } from 'vitest';
import {
  interruptedTurnContinuationId,
  isTurnInterruptedByProcessEnd,
  planInterruptedTurnContinuation,
} from './interrupted-turn-continuation';

const meta = {
  id: 'session-1',
  userId: 'owner',
  cliType: 'custom',
  agentType: 'scripted',
  acpSessionId: 'acp-1',
  latestUserMsgId: 'user-1',
  lastHandledUserMsgId: 'user-1',
} as unknown as SessionMeta;
const interruptedTurn = {
  role: 'user',
  userId: 'member',
  inputConfig: {
    prompt: 'Refactor the parser and run the whole suite.',
    inputBlocks: [{ type: 'text', text: 'Refactor the parser and run the whole suite.' }],
    cliType: 'builtin',
    agentType: 'codex',
    modelId: 'model-a',
    modeId: 'auto',
    configOptionValues: { reasoning_effort: 'high' },
    mcpServerIds: ['mcp-1'],
  },
};
const plan = (overrides: Partial<Parameters<typeof planInterruptedTurnContinuation>[0]> = {}) =>
  planInterruptedTurnContinuation({
    interruptedTurnId: 'user-1',
    interruptedTurn,
    meta,
    queuedInputCount: 0,
    continuationExists: false,
    timestamp: '2026-11-19T00:00:00.000Z',
    ...overrides,
  });

describe('continuing a Turn interrupted by a process end', () => {
  it('detects the interruption from the dispatch claim a process end leaves on this Machine only', () => {
    const claimed = { machineId: 'machine-1', processingUserMsgId: 'user-1' } as SessionMeta;
    expect(isTurnInterruptedByProcessEnd(claimed, 'machine-1', 'user-1')).toBe(true);
    // Another Machine owns the Session: it continues its own interrupted Turns.
    expect(isTurnInterruptedByProcessEnd(claimed, 'machine-2', 'user-1')).toBe(false);
    // An ended or stopped Turn cleared its claim; another claim names a different input.
    expect(
      isTurnInterruptedByProcessEnd(
        { machineId: 'machine-1' } as SessionMeta,
        'machine-1',
        'user-1'
      )
    ).toBe(false);
    expect(isTurnInterruptedByProcessEnd(claimed, 'machine-1', 'user-0')).toBe(false);
    expect(isTurnInterruptedByProcessEnd(undefined, 'machine-1', 'user-1')).toBe(false);
  });

  it('sends only `continue` from Lody, on the interrupted Agent configuration, resuming the same agent session', () => {
    const result = plan();
    expect(result.kind).toBe('continue');
    if (result.kind !== 'continue') return;
    expect(result.entry).toMatchObject({
      id: interruptedTurnContinuationId('user-1'),
      role: 'user',
      userId: 'member',
      author: { v: 1, kind: 'system' },
      status: 'pending',
      items: [{ type: 'text', text: 'continue' }],
      inputConfig: {
        prompt: 'continue',
        cliType: 'builtin',
        agentType: 'codex',
        modelId: 'model-a',
        modeId: 'auto',
        configOptionValues: { reasoning_effort: 'high' },
        mcpServerIds: ['mcp-1'],
        resume: 'acp-1',
      },
    });
    expect(result.entry.inputConfig?.inputBlocks).toBeUndefined();
    expect(JSON.stringify(result.entry)).not.toContain('Refactor the parser');
  });

  it('never continues an interrupted continuation, so a crash loop cannot keep restarting work', () => {
    expect(plan({ interruptedTurnId: interruptedTurnContinuationId('user-1') })).toEqual({
      kind: 'skip',
      reason: 'continuation-interrupted',
    });
    expect(plan({ continuationExists: true })).toEqual({
      kind: 'skip',
      reason: 'already-continued',
    });
  });

  it('lets the user win: archived Sessions, newer input and queued input are not continued', () => {
    expect(plan({ meta: { ...meta, isArchived: true } })).toMatchObject({ kind: 'skip' });
    expect(plan({ meta: undefined })).toMatchObject({ kind: 'skip' });
    expect(plan({ meta: { ...meta, latestUserMsgId: 'user-2' } })).toEqual({
      kind: 'skip',
      reason: 'newer-input',
    });
    expect(plan({ queuedInputCount: 1 })).toEqual({ kind: 'skip', reason: 'queued-input' });
  });
});
