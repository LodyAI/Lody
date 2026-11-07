import assert from 'node:assert/strict';
import test from 'node:test';
import {
  fastModeFor,
  withFastMode,
} from '../../../../packages/cloud-runtime/src/protocol/capability.ts';

test('Fast respects agent capability, current default and an explicit off choice', () => {
  for (const id of ['fast-mode', 'fast']) {
    const capability = {
      configOptions: [{ id, type: 'boolean', currentValue: true }],
    };
    const choice = {
      modelId: 'a',
      effort: 'medium',
      configOptionValues: { permission: 'ask' },
    };
    assert.equal(fastModeFor(capability, choice).enabled, true);
    const next = withFastMode(capability, choice, false);
    assert.deepEqual(next, {
      ...choice,
      configOptionValues: { permission: 'ask', [id]: false },
    });
    assert.equal(fastModeFor(capability, next).enabled, false);
    assert.deepEqual(choice.configOptionValues, { permission: 'ask' });
  }
  const choice = { modelId: 'a' };
  assert.equal(fastModeFor(undefined, choice), undefined);
  assert.equal(withFastMode(undefined, choice, true), choice);
  assert.equal(
    fastModeFor({ configOptions: [{ id: 'fast', type: 'select' }] }, choice),
    undefined,
  );
});
