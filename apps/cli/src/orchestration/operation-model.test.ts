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
      delivery: 'consumed',
      completionTurnWrites: 1,
    });
  });

  it('keeps archived delivery pending until restore', () => {
    const archived = trace('accept', 'materialize_success', 'archive', 'finish', 'schedule');
    expect(archived).toMatchObject({ delivery: 'pending', completionTurnWrites: 0 });
    const restored = stepOrchestrationModel(
      stepOrchestrationModel(archived, 'restore'),
      'schedule'
    );
    expect(restored.delivery).toBe('consumed');
  });

  it('writes the result once without starting an assistant when configuration is gone', () => {
    expect(
      trace('accept', 'materialize_success', 'delete_configuration', 'finish', 'schedule')
    ).toMatchObject({
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
  });
});

it('retains UI observation after a deadline Delivery without scheduling another continuation', () => {
  const delivered = trace(
    'accept',
    'materialize_success',
    'deadline',
    'schedule',
    'complete_turn',
    'flush_progress'
  );
  expect(delivered).toMatchObject({
    delivery: 'consumed',
    progress: 'pending',
    targetTerminal: false,
    completionTurnWrites: 1,
  });
  const settled = stepOrchestrationModel(
    stepOrchestrationModel(delivered, 'observe_target_terminal'),
    'flush_progress'
  );
  expect(settled).toMatchObject({
    delivery: 'consumed',
    progress: 'settled',
    targetTerminal: true,
    activeTurn: 'none',
    completionTurnWrites: 1,
  });
});
