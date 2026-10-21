import { describe, it, expect } from 'vitest';
import {
  initialOrchestrationModelState,
  stepOrchestrationModel,
  enumerateOrchestrationModel,
  type InboxEvent,
} from './operation-model';
const trace = (...events: InboxEvent[]) =>
  events.reduce(stepOrchestrationModel, initialOrchestrationModelState());
describe('current Inbox scheduling contract', () => {
  it.each(['apply_target_steer', 'uncertain_target_steer'] as const)(
    'never replays a submitted target after %s and restart',
    (outcome) => {
      expect(trace('prepare_target_steer', 'materialize_target')).toMatchObject({
        targetSteer: 'prepared',
      });
      expect(
        trace(
          'prepare_target_steer',
          'submit_target_steer',
          outcome,
          'restart',
          'prepare_target_steer',
          'submit_target_steer',
          'materialize_target'
        )
      ).toMatchObject({
        targetSteer: outcome === 'apply_target_steer' ? 'applied' : 'unknown',
        targetSteerSubmissions: 1,
      });
    }
  );
  it('allows ordinary recovery only after proven non-application', () => {
    expect(
      trace(
        'prepare_target_steer',
        'submit_target_steer',
        'refuse_target_steer',
        'materialize_target'
      )
    ).toMatchObject({
      targetSteer: 'ordinary',
      targetSteerSubmissions: 1,
    });
  });
  it('exhaustively preserves nonempty at-most-once batches over bounded interleavings', () => {
    expect(enumerateOrchestrationModel(9).length).toBeGreaterThan(100);
  });
  it('wakeable results coalesce before an idle conversation is scheduled', () => {
    expect(trace('result', 'result', 'schedule')).toMatchObject({
      active: 'automatic',
      batch: [1, 2],
      queue: [1, 2],
      receipts: [],
    });
  });
  it('claim includes late results without duplicate release creating another wake', () => {
    expect(
      trace(
        'human',
        'schedule',
        'submit',
        'result',
        'result',
        'normal',
        'result',
        'duplicate_release',
        'restart',
        'schedule',
        'submit'
      )
    ).toMatchObject({
      active: 'automatic',
      batch: [1, 2, 3],
      receipts: [[1, 2, 3]],
      queue: [1, 2, 3],
    });
  });
  it('Stop blocks automatic work until fresh human input, which carries saved results', () => {
    expect(
      trace(
        'human',
        'schedule',
        'submit',
        'result',
        'stop',
        'restart',
        'schedule',
        'human',
        'schedule',
        'submit'
      )
    ).toMatchObject({ active: 'human', batch: [1], receipts: [[1]], paused: false });
  });
  it('consuming a batch cannot create an empty successor', () => {
    expect(
      trace(
        'human',
        'schedule',
        'submit',
        'result',
        'normal',
        'schedule',
        'submit',
        'normal',
        'schedule'
      )
    ).toMatchObject({ active: 'none', queue: [], pending: [], receipts: [[1]] });
  });
  it('a pending human wins over automatic preparation', () => {
    expect(
      trace('human', 'schedule', 'submit', 'result', 'normal', 'human', 'schedule', 'submit')
    ).toMatchObject({ active: 'human', receipts: [[1]], pending: [] });
  });
  it('unreleased work blocks even a fresh human until resource recovery', () => {
    expect(trace('human', 'schedule', 'submit', 'unreleased', 'human', 'schedule')).toMatchObject({
      blocked: true,
      active: 'human',
      human: true,
    });
  });
  it('withdrawing an unverified human execution reschedules the same results once', () => {
    expect(
      trace('result', 'human', 'schedule', 'withdraw', 'schedule', 'submit', 'withdraw', 'normal')
    ).toMatchObject({ active: 'none', receipts: [[1]], consumed: [1], human: false });
  });
  it('failure retains results without automatic intent', () => {
    expect(trace('human', 'schedule', 'submit', 'result', 'failed', 'schedule')).toMatchObject({
      active: 'none',
      queue: [1],
      pending: [],
    });
  });
});
