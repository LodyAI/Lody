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
  it('exhaustively preserves nonempty at-most-once batches over bounded interleavings', () => {
    expect(enumerateOrchestrationModel(9).length).toBeGreaterThan(100);
  });
  it('automation never clears Stop and an accepted human wins before automatic submission', () => {
    expect(trace('stop', 'automation', 'schedule')).toMatchObject({
      active: 'none',
      paused: true,
      automation: false,
    });
    expect(trace('automation', 'human', 'schedule', 'submit')).toMatchObject({
      active: 'human',
      submitted: true,
      automation: true,
    });
    expect(trace('automation', 'schedule', 'human', 'submit')).toMatchObject({
      active: 'automation',
      submitted: false,
      human: true,
    });
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
  it('restart retires interrupted work without replay and admits fresh human input', () => {
    expect(
      trace(
        'human',
        'schedule',
        'submit',
        'result',
        'restart',
        'schedule',
        'human',
        'schedule',
        'submit'
      )
    ).toMatchObject({ active: 'human', batch: [1], receipts: [[1]], pending: [] });
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
