import test from 'node:test';
import assert from 'node:assert/strict';
import {
  availableCreationOptions,
  onlineMachines,
  presenceURL,
} from '../../../../packages/cloud-runtime/src/runtime/machine-presence.ts';
import { machineState } from '@lody/cloud-runtime/models/machines';

test('only fresh machine heartbeats establish liveness; multiple instances do not double-count a computer', () => {
  const now = 100_000;
  const beat = (machineId, updatedAt, kind = 'machine') => ({
    machineId,
    instanceId: 'instance',
    updatedAt,
    kind,
  });
  assert.deepEqual(
    onlineMachines(
      {
        a: beat('a', now),
        duplicate: beat('a', now - 30_000),
        stale: beat('b', now - 90_000),
        session: beat('c', now, 'session'),
        invalid: beat('d', NaN),
        deleted: null,
      },
      now,
    ),
    ['a'],
  );
  assert.deepEqual(onlineMachines({ a: beat('a', now) }, now + 90_000), []);
  assert.equal(
    machineState({ state: 'unknown', onlineMachineIds: ['a'] }, 'a'),
    'unknown',
  );
  assert.equal(
    machineState({ state: 'live', onlineMachineIds: ['a'] }, 'b'),
    'offline',
  );
});

test('an online workspace device cannot make a different local project available', () => {
  const options = {
    sessionId: 'draft',
    project: { id: 'a:local:p', machineId: 'a' },
    agents: [{ id: 'agent-a', machineId: 'a' }],
    capabilities: [],
  };
  const elsewhere = { state: 'live', onlineMachineIds: ['b'] };
  assert.equal(
    availableCreationOptions(options, elsewhere).availability,
    'offline',
  );
  assert.deepEqual(availableCreationOptions(options, elsewhere).agents, []);
  const recovered = availableCreationOptions(options, {
    state: 'live',
    onlineMachineIds: ['a', 'b'],
  });
  assert.equal(recovered.availability, 'online');
  assert.equal(recovered.agents[0].id, 'agent-a');
  assert.equal(recovered.sessionId, 'draft');
  assert.deepEqual(
    availableCreationOptions(options, {
      state: 'unknown',
      onlineMachineIds: ['a'],
    }).agents,
    [],
  );
});

test('chat and GitHub projects can choose any online computer, independently of registration count', () => {
  const options = {
    sessionId: 'draft',
    agents: [{ machineId: 'a' }, { machineId: 'b' }],
    capabilities: [],
  };
  const presence = { state: 'live', onlineMachineIds: ['b'] };
  for (const project of [
    undefined,
    { id: 'github:owner/repo', machineId: 'a' },
  ]) {
    const result = availableCreationOptions({ ...options, project }, presence);
    assert.equal(result.availability, 'online');
    assert.deepEqual(result.agents, [{ machineId: 'b' }]);
  }
});

test('presence uses the workspace meta channel and a grant-provided dedicated origin without leaking the token', () => {
  assert.equal(
    presenceURL(
      { gatewayBaseUrl: 'https://gateway.example', token: 'secret' },
      'w',
    ),
    'https://gateway.example/ds/lody/w%3Ameta?ephemeral=presence',
  );
  assert.equal(
    presenceURL(
      {
        gatewayBaseUrl: 'https://gateway.example:444',
        token: 'secret',
        shardHostSuffix: 'streams.example',
      },
      'w',
    ),
    'https://presence.streams.example/ds/lody/w%3Ameta?ephemeral=presence',
  );
});

test('creation exposes confirmed machine presence independently of installed assistants', () => {
  const options = { agents: [], capabilities: [] };
  assert.deepEqual(
    availableCreationOptions(options, {
      state: 'live',
      onlineMachineIds: ['empty-machine'],
    }).onlineMachineIds,
    ['empty-machine'],
  );
  assert.deepEqual(
    availableCreationOptions(options, { state: 'live', onlineMachineIds: [] })
      .onlineMachineIds,
    [],
  );
  assert.equal(
    availableCreationOptions(options, {
      state: 'unknown',
      onlineMachineIds: [],
    }).onlineMachineIds,
    undefined,
  );
});
