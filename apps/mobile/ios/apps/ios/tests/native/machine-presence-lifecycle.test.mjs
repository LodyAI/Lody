import test from 'node:test';
import assert from 'node:assert/strict';

test('presence reconnects a stalled join, expires heartbeats and fences replaced transports and teardown', async (t) => {
  t.mock.timers.enable({
    apis: ['setTimeout', 'setInterval', 'Date'],
    now: 100_000,
  });
  const rooms = [];
  class Store {
    states = {};
    getAllStates() {
      return this.states;
    }
    subscribe(listener) {
      this.listener = listener;
      return () => {
        this.listener = undefined;
      };
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class Room {
    constructor({ adaptor }) {
      this.store = adaptor;
      rooms.push(this);
    }
    async join({ onStatusChange }) {
      this.status = onStatusChange;
      return { ok: true };
    }
    async close() {
      this.closed = true;
    }
  }
  t.mock.module('loro-crdt/base64', {
    namedExports: { EphemeralStore: Store },
  });
  t.mock.module('@loro-dev/streams-crdt/loro', {
    namedExports: {
      EphemeralStreamCrdt: Room,
      EphemeralStoreAdaptor: (store) => store,
    },
  });
  const { watchMachinePresence } =
    await import('../../../../packages/cloud-runtime/src/runtime/machine-presence.ts');
  const events = [];
  const stop = watchMachinePresence(
    'w',
    async () => ({
      token: 'fixture',
      gatewayBaseUrl: 'https://example.invalid',
    }),
    (value) => events.push(value),
  );
  t.after(stop);
  const flush = async () => {
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  await flush();
  assert.equal(events.at(-1).state, 'unknown');
  assert.equal(rooms.length, 1);
  t.mock.timers.tick(25_000);
  assert.equal(
    rooms[0].closed,
    true,
    'a permanently connecting room must be replaced',
  );
  t.mock.timers.tick(3_000);
  await flush();
  assert.equal(rooms.length, 2);
  rooms[0].status('joined');
  assert.equal(
    events.at(-1).state,
    'unknown',
    'late old callbacks cannot make the workspace live',
  );
  const room = rooms[1];
  room.store.states = {
    a: {
      kind: 'machine',
      machineId: 'a',
      instanceId: 'one',
      updatedAt: Date.now(),
    },
  };
  room.status('joined');
  assert.deepEqual(events.at(-1), { state: 'live', onlineMachineIds: ['a'] });
  t.mock.timers.tick(90_000);
  assert.deepEqual(
    events.at(-1),
    { state: 'live', onlineMachineIds: [] },
    'registration and old heartbeats cannot keep a machine online',
  );
  room.status('reconnecting');
  assert.equal(
    events.at(-1).state,
    'unknown',
    'network uncertainty is not a machine-offline observation',
  );
  t.mock.timers.tick(25_000);
  assert.equal(
    room.closed,
    true,
    'reconnecting after an earlier successful join also has a deadline',
  );
  stop();
  t.mock.timers.tick(60_000);
  await flush();
  assert.equal(rooms.length, 2, 'suspension/logout cancels pending reconnects');
  room.status('joined');
  assert.equal(events.at(-1).state, 'unknown');
});
