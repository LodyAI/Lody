import assert from 'node:assert/strict';
import test from 'node:test';
import {
  permissionModeFor,
  withPermissionMode,
} from '../../../../packages/cloud-runtime/src/protocol/capability.ts';

const modes = [
  { id: 'ask', name: 'Ask' },
  { id: 'auto', name: 'Auto Approve' },
];
const selector = (id, category) => ({
  id,
  category,
  type: 'select',
  currentValue: 'ask',
  options: modes,
});
const choice = {
  modelId: 'model',
  effort: 'high',
  modeId: 'plan',
  configOptionValues: { fast: true, interaction_mode: 'plan' },
};

test('explicit permission changes keep interaction mode, model, effort and unrelated options', () => {
  for (const option of [
    selector('permission_mode', 'mode'),
    selector('approval', '_permission'),
  ]) {
    const capability = {
      modes: [{ id: 'plan', name: 'Plan' }],
      configOptions: [selector('interaction_mode', 'mode'), option],
    };
    assert.equal(permissionModeFor(capability, choice).value, 'ask');
    const next = withPermissionMode(capability, choice, 'auto');
    assert.equal(permissionModeFor(capability, next).value, 'auto');
    assert.deepEqual(next, {
      ...choice,
      configOptionValues: { ...choice.configOptionValues, [option.id]: 'auto' },
    });
    assert.equal(withPermissionMode(capability, next, 'unsupported'), next);
    assert.equal(choice.configOptionValues[option.id], undefined);
  }
});

test('legacy modes outrank generic mode configuration; generic fallback excludes interaction mode', () => {
  const capability = {
    modes,
    configOptions: [
      selector('interaction_mode', 'mode'),
      selector('mode', 'mode'),
    ],
  };
  const legacy = withPermissionMode(capability, choice, 'auto');
  assert.equal(legacy.modeId, 'auto');
  assert.equal(legacy.configOptionValues, choice.configOptionValues);
  const generic = { ...capability, modes: [] };
  assert.equal(
    withPermissionMode(generic, choice, 'auto').configOptionValues.mode,
    'auto',
  );
  assert.equal(
    permissionModeFor(
      { modes: [], configOptions: [selector('interaction_mode', 'mode')] },
      choice,
    ),
    undefined,
  );
  assert.equal(withPermissionMode(undefined, choice, 'auto'), choice);
});

test('stale saved permission falls back to the current agent option', () => {
  const capability = {
    modes: [],
    configOptions: [selector('permission_mode', '_permission')],
  };
  assert.equal(
    permissionModeFor(capability, {
      configOptionValues: { permission_mode: 'removed' },
    }).value,
    'ask',
  );
});

test('a config selector projected into the model picker is not a legacy mode', () => {
  const capability = {
    modes,
    legacyModes: [],
    configOptions: [selector('interaction_mode', 'mode')],
  };
  assert.equal(permissionModeFor(capability, choice), undefined);
  capability.configOptions.push(selector('approval', 'mode'));
  const next = withPermissionMode(capability, choice, 'auto');
  assert.equal(next.configOptionValues.approval, 'auto');
  assert.equal(next.modeId, 'plan');
});
