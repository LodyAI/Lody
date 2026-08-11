import { describe, expect, it } from 'vitest';
import {
  SessionStatusFactory,
  type MachineId,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import {
  findNextDispatchableUserTurn,
  resolveSessionDispatchAction,
} from './session-dispatch-logic';
import { SessionExecutionService } from './session-execution-service';

describe('resolveSessionDispatchAction rewrite barrier', () => {
  it('blocks stale-status repair and pending dispatch while history is being replaced', () => {
    const machineId = 'machine-1' as MachineId;
    const meta = {
      id: 'session-1',
      machineId,
      createdAt: '2026-08-03T00:00:00.000Z',
      userId: 'user-1',
      cliType: 'builtin',
      agentType: 'codex',
      status: SessionStatusFactory.running(),
      latestUserMsgId: 'replacement-user',
    } as SessionMeta;

    expect(
      resolveSessionDispatchAction(
        {
          meta,
          history: [
            {
              id: 'replacement-user',
              timestamp: '2026-08-03T00:00:01.000Z',
              role: 'user',
              items: [{ type: 'text', text: 'replacement' }],
              fileDiff: [],
              status: 'pending',
            },
          ],
          hasActiveTurn: false,
          hasBlockingPendingCreate: false,
          hasReusableSession: true,
          hasRewriteBarrier: true,
        },
        machineId
      )
    ).toEqual({ type: 'noop', reason: 'rewrite-barrier' });
  });
});

describe('findNextDispatchableUserTurn steer intent', () => {
  const machineId = 'machine-1' as MachineId;
  const guide = {
    id: 'guide-user',
    timestamp: '2026-08-03T00:00:01.000Z',
    role: 'user' as const,
    items: [{ type: 'text' as const, text: 'do it differently' }],
    fileDiff: [],
    status: 'pending_apply' as const,
  };
  const baseMeta = {
    id: 'session-1',
    machineId,
    createdAt: '2026-08-03T00:00:00.000Z',
    userId: 'user-1',
    cliType: 'builtin',
    agentType: 'codex',
    status: SessionStatusFactory.idle(),
    lastHandledUserMsgId: 'earlier-user',
  } as SessionMeta;

  it('leaves an ordinary guide alone: it belongs to the steer path, not dispatch', () => {
    expect(findNextDispatchableUserTurn([guide], baseMeta)).toBeNull();
  });

  it('dispatches a guide the dispatch pointer was re-aimed at after the agent refused it', () => {
    expect(
      findNextDispatchableUserTurn([guide], { ...baseMeta, latestUserMsgId: 'guide-user' })
    ).toEqual(guide);
  });

  it('does not re-dispatch a re-aimed guide that already ran', () => {
    expect(
      findNextDispatchableUserTurn([guide], {
        ...baseMeta,
        latestUserMsgId: 'guide-user',
        lastHandledUserMsgId: 'guide-user',
      })
    ).toBeNull();
  });
});

describe('SessionExecutionService history mutation ownership', () => {
  it('makes queue promotion and edit-and-resend mutually exclusive', () => {
    const service = new SessionExecutionService({
      logger: { debug: () => undefined } as never,
      sessionManager: {
        getPendingSession: () => undefined,
        getSession: () => undefined,
      },
    } as never);
    const sessionId = 'session-1' as SessionId;

    const releaseQueue = service.tryAcquireSessionRewriteConflictLease(sessionId);
    expect(releaseQueue).toBeTypeOf('function');
    expect(service.tryAcquireSessionRewriteBarrier(sessionId)).toBeNull();

    releaseQueue?.();
    const releaseRewrite = service.tryAcquireSessionRewriteBarrier(sessionId);
    expect(releaseRewrite).toBeTypeOf('function');
    expect(service.tryAcquireSessionRewriteConflictLease(sessionId)).toBeNull();

    releaseRewrite?.();
    const releaseNextQueue = service.tryAcquireSessionRewriteConflictLease(sessionId);
    expect(releaseNextQueue).toBeTypeOf('function');
    releaseNextQueue?.();
  });
});
