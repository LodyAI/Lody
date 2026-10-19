import { expect, it } from 'vitest';
import {
  refActionPrediction,
  judgeRefAction,
  judgeConcurrentRefAction,
} from '../src/pure/action-model';
import type { RefState } from '../src/pure/reference-model';
const state: RefState = {
  org: 'o',
  ownerUser: 'u',
  epoch: 3,
  rotationRequired: true,
  revoked: new Set(),
  devices: new Map([
    ['owner', { id: 'owner', user: 'u', role: 'owner', kind: 'personal' }],
    ['owner-r', { id: 'owner-r', user: 'u', role: 'owner', kind: 'recovery' }],
    ['member', { id: 'member', user: 'v', role: 'member', kind: 'personal' }],
    ['guest', { id: 'guest', user: 'w', role: 'guest', kind: 'personal' }],
    ['admin', { id: 'admin', user: 'a', role: 'admin', kind: 'personal' }],
  ]),
};
const predict = (operation: string, actor = 'owner', extra = {}) =>
  refActionPrediction({
    state,
    actor,
    running: true,
    action: { kind: 'call', operation, ...extra },
    targetDevice: 'member',
    targetUser: 'v',
  });
it('independently predicts rotation, atomic removal, ledger commands and current reads', () => {
  expect(predict('rotate-epoch').expected).toBe('allow');
  expect(predict('rotate-epoch', 'admin').expected).toBe('allow');
  expect(predict('rotate-epoch', 'owner-r').expected).toBe('deny');
  expect(predict('remove-member-and-rotate', 'admin').expected).toBe('deny');
  expect(predict('remove-member-and-rotate').expected).toBe('allow');
  expect(predict('set-role', 'member', { role: 'guest' }).expected).toBe('deny');
  expect(predict('revoke').expected).toBe('deny');
  for (const operation of ['keys', 'pull', 'recover', 'refresh', 'resume'])
    expect(predict(operation, 'guest').expected).toBe('allow');
  expect(predict('append').expected).toBe('deny');
  expect(predict('upload-snapshot', 'guest').expected).toBe('deny');
});
it('covers local and harness actions separately instead of treating injected faults as permissions', () => {
  for (const kind of [
    'measure',
    'transport',
    'storage',
    'attack',
    'persist',
    'crash',
    'begin-call',
  ])
    expect(
      refActionPrediction({ state, actor: 'owner', running: true, action: { kind } }).expected
    ).toBe('allow');
  expect(
    refActionPrediction({
      state,
      actor: 'owner',
      running: false,
      action: { kind: 'call', operation: 'pull' },
    }).expected
  ).toBe('deny');
  const denied = predict('append', 'guest');
  expect(judgeRefAction(denied, { ok: true })).toBe('violation');
  expect(
    judgeRefAction(denied, { ok: false, error: { tag: 'ContentError', code: 'unauthorized' } })
  ).toBe('pass');
  expect(
    judgeRefAction(denied, { ok: false, error: { tag: 'LabContentError', code: 'transport' } })
  ).toBe('unavailable');
  expect(
    judgeRefAction(denied, {
      ok: false,
      error: { tag: 'LabProcessError', code: 'invalid-command' },
    })
  ).toBe('harness-error');
  expect(
    judgeRefAction(predict('pull'), {
      ok: false,
      error: { tag: 'LedgerFeedError', code: 'forbidden' },
    })
  ).toBe('unavailable');
});

it('compares semantic transition observations as well as accept/refuse', () => {
  expect(
    judgeRefAction(predict('rotate-epoch'), {
      ok: true,
      value: { outcome: 'Committed', epoch: state.epoch + 2 },
    })
  ).toBe('violation');
  expect(
    judgeRefAction(predict('rotate-epoch'), {
      ok: true,
      value: { outcome: 'Conflict', epoch: state.epoch + 1 },
    })
  ).toBe('pass');
  const receiving = predict('keys', 'owner-r');
  expect(judgeRefAction(receiving, { ok: true, value: { scheduled: 1 } })).toBe('violation');
  expect(judgeRefAction(receiving, { ok: true, value: { scheduled: 0 } })).toBe('pass');
});

it('checks independently witnessed poststate instead of trusting a committed outcome label', () => {
  const role = predict('set-role', 'owner', { role: 'guest' });
  expect(judgeRefAction(role, { ok: true, value: { outcome: 'Committed' } }, state)).toBe(
    'violation'
  );
  const remove = predict('remove-member-and-rotate');
  expect(
    judgeRefAction(
      remove,
      { ok: true, value: { outcome: 'Committed', epoch: state.epoch + 1 } },
      { ...state, epoch: state.epoch + 1, rotationRequired: false }
    )
  ).toBe('violation');
  expect(
    judgeRefAction(predict('pull'), {
      ok: false,
      error: { tag: 'LedgerFeedError', code: 'forbidden' },
    })
  ).toBe('unavailable');
});

it('retains concurrent permission uncertainty without converting a legitimate refusal or earlier acceptance into a violation', () => {
  const active = { ...state, rotationRequired: false };
  const before = refActionPrediction({
    state: active,
    actor: 'member',
    running: true,
    action: { kind: 'call', operation: 'append' },
  });
  const changed = {
    ...active,
    devices: new Map(active.devices).set('member', {
      id: 'member',
      user: 'v',
      role: 'guest',
      kind: 'personal',
    }),
  };
  const after = refActionPrediction({
    state: changed,
    actor: 'member',
    running: true,
    action: { kind: 'call', operation: 'append' },
  });
  const refusal = { ok: false, error: { tag: 'ContentError', code: 'unauthorized' } };
  expect(judgeRefAction(before, refusal, changed)).toBe('violation');
  expect(judgeConcurrentRefAction(before, after, refusal, changed)).toBe('unavailable');
  expect(judgeConcurrentRefAction(before, after, { ok: true }, changed)).toBe('unavailable');
  expect(judgeConcurrentRefAction(after, before, { ok: true }, active)).toBe('unavailable');
  expect(judgeConcurrentRefAction(after, after, { ok: true }, changed)).toBe('violation');
  expect(judgeConcurrentRefAction(before, before, refusal, active)).toBe('violation');
  expect(
    judgeConcurrentRefAction(
      before,
      after,
      { ok: false, error: { tag: 'LabActionError', code: 'invalid-plan' } },
      changed
    )
  ).toBe('harness-error');
});
