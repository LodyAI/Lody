import { expect, it, vi } from 'vitest';
import { createScheduleSyncGate } from './schedule-sync-gate';
import type { StreamsRoomBinding } from '../loro/streams-room-binding';

it('requires the initial and each current connection sync, ignoring stale completions and disposal', async () => {
  let status: StreamsRoomBinding['status'] = 'joined';
  let notify!: () => void;
  let initial!: () => void;
  let finish!: () => void;
  let waiting!: () => void;
  let started = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  const ready = vi.fn();
  const binding: StreamsRoomBinding = {
    get status() {
      return status;
    },
    onStatusChange: (callback) => {
      notify = () => callback(status);
      return () => {};
    },
    firstSyncedWithRemote: new Promise<void>((resolve) => {
      initial = resolve;
    }),
    waitUntilSynced: () => {
      waiting();
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
  const gate = createScheduleSyncGate(binding, ready, vi.fn());
  expect(gate.isReady()).toBe(false);
  initial();
  await started;
  finish();
  await Promise.resolve();
  expect(gate.isReady()).toBe(true);
  status = 'disconnected';
  notify();
  expect(gate.isReady()).toBe(false);
  started = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  status = 'joined';
  notify();
  await started;
  expect(gate.isReady()).toBe(false);
  status = 'disconnected';
  notify();
  finish();
  await Promise.resolve();
  expect(gate.isReady()).toBe(false);
  expect(ready).toHaveBeenCalledTimes(1);
  started = new Promise<void>((resolve) => {
    waiting = resolve;
  });
  status = 'joined';
  notify();
  await started;
  gate.dispose();
  finish();
  await Promise.resolve();
  expect(gate.isReady()).toBe(false);
});
