import { describe, expect, it } from 'vitest';

import {
  assertOrchestrationModelSafety,
  enumerateOrchestrationModel,
  initialOrchestrationModelState,
  stepOrchestrationModel,
} from './operation-model';

const trace = (...actions: Parameters<typeof stepOrchestrationModel>[1][]) =>
  actions.reduce(stepOrchestrationModel, initialOrchestrationModelState());

describe('Operation delivery executable model', () => {
  it('exhaustively preserves safety over bounded race traces', () => {
    expect(enumerateOrchestrationModel(9).length).toBeGreaterThan(50);
  });

  it('prioritizes queued user input and later dispatches the Delivery separately', () => {
    const afterUser = trace('accept', 'materialize_success', 'finish', 'enqueue_user', 'schedule');
    expect(afterUser).toMatchObject({ activeTurn: 'user', delivery: 'pending' });
    const afterDelivery = stepOrchestrationModel(
      stepOrchestrationModel(afterUser, 'complete_turn'),
      'schedule'
    );
    expect(afterDelivery).toMatchObject({
      activeTurn: 'delivery',
      delivery: 'claimed',
      completionTurnWrites: 0,
    });
    const prepared = stepOrchestrationModel(afterDelivery, 'prepare_turn');
    const started = stepOrchestrationModel(prepared, 'start_turn');
    expect(started).toMatchObject({ delivery: 'started', completionTurnWrites: 1 });
    expect(stepOrchestrationModel(started, 'complete_turn').delivery).toBe('consumed');
  });

  it('keeps archived delivery pending until restore', () => {
    const archived = trace('accept', 'materialize_success', 'archive', 'finish', 'schedule');
    expect(archived).toMatchObject({ delivery: 'pending', completionTurnWrites: 0 });
    const restored = trace('accept', 'materialize_success', 'archive', 'finish', 'restore');
    const claimed = stepOrchestrationModel(restored, 'schedule');
    expect(claimed.delivery).toBe('claimed');
    const prepared = stepOrchestrationModel(claimed, 'prepare_turn');
    const started = stepOrchestrationModel(prepared, 'start_turn');
    expect(started.delivery).toBe('started');
  });

  it('writes the result once without starting an assistant when configuration is gone', () => {
    const finalizing = trace(
      'accept',
      'materialize_success',
      'delete_configuration',
      'finish',
      'schedule'
    );
    expect(finalizing).toMatchObject({
      delivery: 'finalizing',
      deliveryClaimOwner: 'current',
      activeTurn: 'none',
      completionTurnWrites: 0,
    });
    expect(stepOrchestrationModel(finalizing, 'complete_finalization')).toMatchObject({
      delivery: 'consumed',
      activeTurn: 'none',
      completionTurnWrites: 1,
    });
  });

  it('uses deadline as a terminal backstop', () => {
    expect(trace('accept', 'deadline')).toMatchObject({
      operation: 'finished',
      delivery: 'pending',
    });
  });

  it('permits one confirmed pre-provider recovery and consumes without a third attempt', () => {
    const firstAttempt = trace(
      'accept',
      'materialize_success',
      'finish',
      'schedule',
      'prepare_turn'
    );
    const secondAttempt = stepOrchestrationModel(
      stepOrchestrationModel(stepOrchestrationModel(firstAttempt, 'interrupt_turn'), 'schedule'),
      'prepare_turn'
    );
    expect(secondAttempt).toMatchObject({ delivery: 'prepared', deliveryAttempts: 2 });
    const exhausted = stepOrchestrationModel(
      stepOrchestrationModel(secondAttempt, 'interrupt_turn'),
      'schedule'
    );
    expect(exhausted).toMatchObject({
      delivery: 'finalizing',
      deliveryClaimOwner: 'current',
      deliveryAttempts: 2,
      activeTurn: 'none',
    });
    expect(stepOrchestrationModel(exhausted, 'complete_finalization').delivery).toBe('consumed');
  });

  it('consumes a user cancellation without reopening the Delivery', () => {
    const started = trace(
      'accept',
      'materialize_success',
      'finish',
      'schedule',
      'prepare_turn',
      'start_turn'
    );
    const cancelled = stepOrchestrationModel(started, 'cancel_turn');
    expect(cancelled).toMatchObject({
      delivery: 'consumed',
      deliveryClaimOwner: 'none',
      activeTurn: 'none',
      deliveryAttempts: 1,
    });
    expect(stepOrchestrationModel(cancelled, 'schedule')).toEqual(cancelled);
  });

  it('keeps a crashed attempt fenced until a replacement Worker recovers the old boot', () => {
    const firstAttempt = trace(
      'accept',
      'materialize_success',
      'finish',
      'schedule',
      'prepare_turn',
      'start_turn'
    );
    const afterExit = stepOrchestrationModel(firstAttempt, 'restart');
    expect(afterExit).toMatchObject({
      delivery: 'started',
      deliveryClaimOwner: 'previous',
      activeTurn: 'none',
      deliveryAttempts: 1,
    });
    expect(stepOrchestrationModel(afterExit, 'schedule')).toEqual(afterExit);

    const recovered = stepOrchestrationModel(afterExit, 'recover_orphans');
    expect(recovered).toMatchObject({
      delivery: 'uncertain',
      deliveryClaimOwner: 'none',
      activeTurn: 'none',
      deliveryAttempts: 1,
    });
    const finalizing = stepOrchestrationModel(recovered, 'schedule');
    expect(finalizing).toMatchObject({
      delivery: 'uncertain_finalizing',
      deliveryClaimOwner: 'current',
      activeTurn: 'none',
    });
    expect(stepOrchestrationModel(finalizing, 'complete_finalization').delivery).toBe('consumed');
  });

  it('releases pre-start claims without spending the execution budget', () => {
    const firstClaim = trace('accept', 'materialize_success', 'finish', 'schedule');
    expect(firstClaim).toMatchObject({
      delivery: 'claimed',
      deliveryAttempts: 0,
      completionTurnWrites: 0,
    });
    const firstFailure = stepOrchestrationModel(firstClaim, 'history_write_fail');
    const secondClaim = stepOrchestrationModel(firstFailure, 'schedule');
    const secondFailure = stepOrchestrationModel(secondClaim, 'history_write_fail');
    expect(secondFailure).toMatchObject({
      delivery: 'pending',
      deliveryAttempts: 0,
      deliveryClaimOwner: 'none',
    });
    const recovered = stepOrchestrationModel(
      stepOrchestrationModel(stepOrchestrationModel(secondFailure, 'schedule'), 'prepare_turn'),
      'start_turn'
    );
    expect(recovered).toMatchObject({ delivery: 'started', deliveryAttempts: 1 });
  });

  it('keeps terminal history finalization fenced across Worker replacement', () => {
    const finalizing = trace(
      'accept',
      'materialize_success',
      'delete_configuration',
      'finish',
      'schedule'
    );
    const afterExit = stepOrchestrationModel(finalizing, 'restart');
    expect(afterExit).toMatchObject({
      delivery: 'finalizing',
      deliveryClaimOwner: 'previous',
      completionTurnWrites: 0,
    });
    expect(stepOrchestrationModel(afterExit, 'schedule')).toEqual(afterExit);

    const recovered = stepOrchestrationModel(afterExit, 'recover_orphans');
    const reclaimed = stepOrchestrationModel(recovered, 'schedule');
    expect(reclaimed).toMatchObject({
      delivery: 'finalizing',
      deliveryClaimOwner: 'current',
      completionTurnWrites: 0,
    });
    expect(stepOrchestrationModel(reclaimed, 'complete_finalization')).toMatchObject({
      delivery: 'consumed',
      deliveryClaimOwner: 'none',
      completionTurnWrites: 1,
    });
  });

  it('keeps a failed materialization pending until its owned retry fires', () => {
    const failed = trace('accept', 'materialize_fail', 'finish');
    expect(failed).toMatchObject({
      operation: 'active',
      targetInput: 'retry_scheduled',
      delivery: 'absent',
    });
    expect(
      stepOrchestrationModel(
        stepOrchestrationModel(failed, 'materialization_retry'),
        'materialize_success'
      )
    ).toMatchObject({ operation: 'active', targetInput: 'durable' });
  });

  it('clears a scheduled materialization retry at the deadline', () => {
    expect(stepOrchestrationModel(trace('accept', 'materialize_fail'), 'deadline')).toMatchObject({
      operation: 'finished',
      targetInput: 'missing',
      delivery: 'pending',
    });
  });

  it('rejects a new machine Command at the fixed chain-depth cap', () => {
    const capped = { ...initialOrchestrationModelState(), chainDepth: 5 };
    expect(stepOrchestrationModel(capped, 'accept').operation).toBe('absent');
  });

  it('can falsify duplicate completion writes and excess chain depth', () => {
    expect(() =>
      assertOrchestrationModelSafety({
        ...initialOrchestrationModelState(),
        completionTurnWrites: 2,
      })
    ).toThrow(/more than one visible completion/);
    expect(() =>
      assertOrchestrationModelSafety({
        ...initialOrchestrationModelState(),
        chainDepth: 6,
      })
    ).toThrow(/exceeded the fixed depth cap/);
    expect(() =>
      assertOrchestrationModelSafety({
        ...initialOrchestrationModelState(),
        deliveryAttempts: 3,
      })
    ).toThrow(/bounded attempt count/);
    expect(() =>
      assertOrchestrationModelSafety({
        ...initialOrchestrationModelState(),
        deliveryClaimOwner: 'current',
      })
    ).toThrow(/claim state/);
  });
});
