import { describe, expect, it } from 'vitest';
import type { MachineId, SessionHistoryInput, SessionMeta } from '@lody/shared';
import {
  findNextDispatchableUserTurn,
  resolveSessionCancelAction,
  resolveSessionDispatchAction,
  type SessionDispatchSnapshot,
} from '../src/session/session-dispatch-logic';

const MACHINE = 'machine-1' as MachineId;

const baseMeta: SessionMeta = {
  id: 'session-1',
  machineId: MACHINE,
  userId: 'user-1',
  createdAt: new Date().toISOString(),
  cliType: 'builtin',
  agentType: 'codex',
  status: { type: 'idle' },
} as SessionMeta;

const pendingTurn = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  items: [{ type: 'text', text: 'hello' }],
  timestamp: new Date().toISOString(),
  status: 'pending',
  read: false,
  userId: 'user-1',
});

const handledTurn = (id: string): SessionHistoryInput => ({
  id,
  role: 'user',
  items: [{ type: 'text', text: 'hello' }],
  timestamp: new Date().toISOString(),
  status: 'handled',
  read: true,
  userId: 'user-1',
});

const snap = (overrides: Partial<SessionDispatchSnapshot> = {}): SessionDispatchSnapshot => ({
  meta: baseMeta,
  history: [],
  hasActiveTurn: false,
  hasBlockingPendingCreate: false,
  hasReusableSession: false,
  ...overrides,
});

// ── resolveSessionDispatchAction ────────────────────────────────────────────

describe('resolveSessionDispatchAction', () => {
  it('returns noop when meta.machineId does not match', () => {
    const action = resolveSessionDispatchAction(
      snap({ meta: { ...baseMeta, machineId: 'other' as MachineId } }),
      MACHINE
    );
    expect(action).toEqual({ type: 'noop', reason: 'not-owned' });
  });

  it('returns noop when session is archived', () => {
    const action = resolveSessionDispatchAction(
      snap({ meta: { ...baseMeta, isArchived: true } as SessionMeta }),
      MACHINE
    );
    expect(action).toEqual({ type: 'noop', reason: 'archived' });
  });

  it('returns noop when there is a pending session create owned by the active turn', () => {
    const action = resolveSessionDispatchAction(
      snap({ hasActiveTurn: true, hasBlockingPendingCreate: true }),
      MACHINE
    );
    expect(action).toEqual({ type: 'noop', reason: 'pending-create' });
  });

  it('returns noop when status is running with an active turn owner', () => {
    const action = resolveSessionDispatchAction(
      snap({
        meta: { ...baseMeta, status: { type: 'running' } },
        hasActiveTurn: true,
        hasReusableSession: true,
      }),
      MACHINE
    );
    expect(action).toEqual({ type: 'noop', reason: 'active-session' });
  });

  it('returns reset-stale-status when status is running with no in-memory session', () => {
    const action = resolveSessionDispatchAction(
      snap({ meta: { ...baseMeta, status: { type: 'running' } } }),
      MACHINE
    );
    expect(action).toEqual({ type: 'reset-stale-status', statusType: 'running' });
  });

  it('returns reset-stale-status for initializing status with no in-memory session', () => {
    const action = resolveSessionDispatchAction(
      snap({ meta: { ...baseMeta, status: { type: 'initializing' } } }),
      MACHINE
    );
    expect(action).toEqual({ type: 'reset-stale-status', statusType: 'initializing' });
  });

  it('returns reset-stale-status for requestPermission status with no in-memory session', () => {
    const action = resolveSessionDispatchAction(
      snap({ meta: { ...baseMeta, status: { type: 'requestPermission' } } }),
      MACHINE
    );
    expect(action).toEqual({ type: 'reset-stale-status', statusType: 'requestPermission' });
  });

  it('returns no-dispatchable-turn when history is empty', () => {
    const action = resolveSessionDispatchAction(snap(), MACHINE);
    expect(action).toEqual({ type: 'no-dispatchable-turn' });
  });

  it('returns no-dispatchable-turn when all turns are handled', () => {
    const action = resolveSessionDispatchAction(
      snap({ history: [handledTurn('t-1'), handledTurn('t-2')] }),
      MACHINE
    );
    expect(action).toEqual({ type: 'no-dispatchable-turn' });
  });

  it('returns dispatch/create for pending turn with no in-memory session and no acpSessionId', () => {
    const turn = pendingTurn('t-1');
    const action = resolveSessionDispatchAction(snap({ history: [turn] }), MACHINE);
    expect(action).toEqual({ type: 'dispatch', mode: 'create', turn });
  });

  it('returns dispatch/continue for pending turn with existing acpSessionId', () => {
    const turn = pendingTurn('t-1');
    const action = resolveSessionDispatchAction(
      snap({ meta: { ...baseMeta, acpSessionId: 'acp-1' } as SessionMeta, history: [turn] }),
      MACHINE
    );
    expect(action).toEqual({ type: 'dispatch', mode: 'continue', turn });
  });

  it('returns dispatch/continue for pending turn with reusable in-memory session', () => {
    const turn = pendingTurn('t-1');
    const action = resolveSessionDispatchAction(
      snap({ history: [turn], hasReusableSession: true }),
      MACHINE
    );
    expect(action).toEqual({ type: 'dispatch', mode: 'continue', turn });
  });

  it('dispatches the first pending turn, skipping handled ones', () => {
    const t2 = pendingTurn('t-2');
    const action = resolveSessionDispatchAction(
      snap({ history: [handledTurn('t-1'), t2] }),
      MACHINE
    );
    expect(action).toEqual({ type: 'dispatch', mode: 'create', turn: t2 });
  });
});

// ── resolveSessionCancelAction ──────────────────────────────────────────────

describe('resolveSessionCancelAction', () => {
  it('returns noop when meta is undefined', () => {
    const action = resolveSessionCancelAction(undefined, undefined, MACHINE);
    expect(action).toEqual({ type: 'noop', reason: 'not-owned' });
  });

  it('returns noop when not owned', () => {
    const action = resolveSessionCancelAction(
      { ...baseMeta, machineId: 'other' as MachineId },
      undefined,
      MACHINE
    );
    expect(action).toEqual({ type: 'noop', reason: 'not-owned' });
  });

  it('returns noop when archived', () => {
    const action = resolveSessionCancelAction(
      { ...baseMeta, isArchived: true } as SessionMeta,
      undefined,
      MACHINE
    );
    expect(action).toEqual({ type: 'noop', reason: 'archived' });
  });

  it('returns noop when no lastCanceledTurn', () => {
    const action = resolveSessionCancelAction(baseMeta, undefined, MACHINE);
    expect(action).toEqual({ type: 'noop', reason: 'no-cancel-turn' });
  });

  it('returns noop when lastCanceledTurn equals lastSeenCancelTurn', () => {
    const action = resolveSessionCancelAction(
      { ...baseMeta, lastCanceledTurn: 'turn-x' } as SessionMeta,
      'turn-x',
      MACHINE
    );
    expect(action).toEqual({ type: 'noop', reason: 'already-seen' });
  });

  it('returns cancel with the turnId', () => {
    const action = resolveSessionCancelAction(
      { ...baseMeta, lastCanceledTurn: 'turn-x' } as SessionMeta,
      undefined,
      MACHINE
    );
    expect(action).toEqual({ type: 'cancel', turnId: 'turn-x' });
  });

  it('returns cancel when lastCanceledTurn differs from lastSeenCancelTurn', () => {
    const action = resolveSessionCancelAction(
      { ...baseMeta, lastCanceledTurn: 'turn-y' } as SessionMeta,
      'turn-x',
      MACHINE
    );
    expect(action).toEqual({ type: 'cancel', turnId: 'turn-y' });
  });
});

// ── findNextDispatchableUserTurn ─────────────────────────────────────────────

describe('findNextDispatchableUserTurn', () => {
  it('returns null for empty history', () => {
    expect(findNextDispatchableUserTurn([], baseMeta)).toBeNull();
  });

  it('skips non-user roles', () => {
    const entry = { ...pendingTurn('t-1'), role: 'assistant' } as SessionHistoryInput;
    expect(findNextDispatchableUserTurn([entry], baseMeta)).toBeNull();
  });

  it('does not dispatch operation progress system entries', () => {
    const entry: SessionHistoryInput = {
      id: 'operation-progress:session-1:op-1',
      role: 'system',
      timestamp: new Date().toISOString(),
      userId: 'user-1',
      items: [
        {
          type: 'operation_progress',
          operationId: 'op-1',
          operationKind: 'session_create',
          items: [
            {
              target: { sessionId: 'created-session', userTurnId: 'created-turn' },
              status: 'created',
            },
          ],
        },
      ],
      fileDiff: [],
      finished: true,
    };
    expect(findNextDispatchableUserTurn([entry], baseMeta)).toBeNull();
  });

  it('returns turn with status=pending', () => {
    const turn = pendingTurn('t-1');
    expect(findNextDispatchableUserTurn([turn], baseMeta)).toEqual(turn);
  });

  it('returns turn with status=seen', () => {
    const turn = { ...pendingTurn('t-1'), status: 'seen' } as SessionHistoryInput;
    expect(findNextDispatchableUserTurn([turn], baseMeta)).toEqual(turn);
  });

  it('returns turn with status=processing', () => {
    const turn = { ...pendingTurn('t-1'), status: 'processing' } as SessionHistoryInput;
    expect(findNextDispatchableUserTurn([turn], baseMeta)).toEqual(turn);
  });

  it('skips turn with status=pending_apply', () => {
    const turn = { ...pendingTurn('t-1'), status: 'pending_apply' } as SessionHistoryInput;
    expect(findNextDispatchableUserTurn([turn], baseMeta)).toBeNull();
  });

  it('skips turn with status=handled', () => {
    expect(findNextDispatchableUserTurn([handledTurn('t-1')], baseMeta)).toBeNull();
  });

  it('returns turn with read=false (legacy)', () => {
    const turn = {
      id: 't-1',
      role: 'user',
      items: [{ type: 'text', text: 'hello' }],
      timestamp: new Date().toISOString(),
      read: false,
      userId: 'user-1',
    } as SessionHistoryInput;
    expect(findNextDispatchableUserTurn([turn], baseMeta)).toEqual(turn);
  });

  it('skips turn with read=true and no status (legacy handled)', () => {
    const turn = {
      id: 't-1',
      role: 'user',
      items: [{ type: 'text', text: 'hello' }],
      timestamp: new Date().toISOString(),
      read: true,
      userId: 'user-1',
    } as SessionHistoryInput;
    expect(findNextDispatchableUserTurn([turn], baseMeta)).toBeNull();
  });

  it('returns turn matching processingUserMsgId (crash recovery)', () => {
    const turn = {
      id: 't-1',
      role: 'user',
      items: [{ type: 'text', text: 'hello' }],
      timestamp: new Date().toISOString(),
      read: true,
      userId: 'user-1',
    } as SessionHistoryInput;
    const meta = { ...baseMeta, processingUserMsgId: 't-1' } as SessionMeta;
    expect(findNextDispatchableUserTurn([turn], meta)).toEqual(turn);
  });

  it('returns turn matching latestUserMsgId but not lastHandledUserMsgId', () => {
    const turn = {
      id: 't-1',
      role: 'user',
      items: [{ type: 'text', text: 'hello' }],
      timestamp: new Date().toISOString(),
      read: true,
      userId: 'user-1',
    } as SessionHistoryInput;
    const meta = { ...baseMeta, latestUserMsgId: 't-1' } as SessionMeta;
    expect(findNextDispatchableUserTurn([turn], meta)).toEqual(turn);
  });

  it('skips turn when latestUserMsgId equals lastHandledUserMsgId', () => {
    const turn = {
      id: 't-1',
      role: 'user',
      items: [{ type: 'text', text: 'hello' }],
      timestamp: new Date().toISOString(),
      read: true,
      userId: 'user-1',
    } as SessionHistoryInput;
    const meta = {
      ...baseMeta,
      latestUserMsgId: 't-1',
      lastHandledUserMsgId: 't-1',
    } as SessionMeta;
    expect(findNextDispatchableUserTurn([turn], meta)).toBeNull();
  });

  it('returns the first dispatchable turn in chronological order', () => {
    const t1 = handledTurn('t-1');
    const t2 = pendingTurn('t-2');
    const t3 = pendingTurn('t-3');
    expect(findNextDispatchableUserTurn([t1, t2, t3], baseMeta)).toEqual(t2);
  });
});
