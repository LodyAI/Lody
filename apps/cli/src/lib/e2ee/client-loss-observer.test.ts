import { SessionDispatchWatcher } from '@/session/session-dispatch-watcher';
import { MessageProcessor } from '../message-processor';
import type { Logger } from '@/utils/logger';
import type { LocalSessionControlRequestValidated } from '@lody/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDaemonLossRegistry,
  createDaemonLossTasks,
  type DaemonLossPending,
} from './client-loss-observer';

vi.hoisted(() => {
  Object.assign(globalThis, { __LODY_E2E_DAEMON_LOSS__: true });
  process.env.LODY_E2E = '1';
});

const empty = (): DaemonLossPending => ({
  processorActive: 0,
  processorQueued: 0,
  watcherChecks: 0,
  executionTurns: 0,
  executionBookkeeping: 0,
});
const scope = { machineId: 'machine', workspaceId: 'workspace', accountId: 'account' };
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('daemon client-loss causal barrier', () => {
  afterEach(() => vi.useRealTimers());
  it('does not invent evidence for an absent or disabled owner', () => {
    const registry = createDaemonLossRegistry(false);
    expect(
      registry.register(scope, () => ({ intakeClosed: true, pending: empty() }))
    ).toBeUndefined();
    expect(registry.inspect(scope.workspaceId)).toBeNull();
    expect(createDaemonLossRegistry(true).inspect(scope.workspaceId)).toBeNull();
  });
  it('empty queues alone cannot confirm loss or retirement', () => {
    const registry = createDaemonLossRegistry(true, 42);
    const row = registry.register(scope, () => ({ intakeClosed: true, pending: empty() }))!;
    const baseline = registry.inspect(scope.workspaceId)!;
    expect(baseline).toMatchObject({
      version: 1,
      pid: 42,
      status: 'active',
      lossSequence: 0,
      code: null,
      drained: false,
    });
    row.retired();
    expect(registry.inspect(scope.workspaceId)?.drained).toBe(false);
    row.loss('e2ee_member_removed');
    expect(registry.inspect(scope.workspaceId)).toMatchObject({
      status: 'drained',
      code: 'e2ee_member_removed',
      retired: true,
      drained: true,
    });
  });
  it.each(Object.keys(empty()) as (keyof DaemonLossPending)[])(
    'retains a still-owned %s after cleanup returns',
    async (key) => {
      const registry = createDaemonLossRegistry(true);
      const pending = empty();
      pending[key] = 1;
      const row = registry.register(scope, () => ({ intakeClosed: true, pending }))!;
      row.loss('e2ee_device_revoked');
      row.retired();
      let finished = false;
      const result = registry.wait(scope.workspaceId, 0).then((value) => {
        finished = true;
        return value;
      });
      await Promise.resolve();
      expect(finished).toBe(false);
      pending[key] = 0;
      registry.changed();
      expect(await result).toMatchObject({ status: 'drained', code: 'e2ee_device_revoked' });
    }
  );
  it('retains old watcher work even if product maps were cleared on stop', async () => {
    const registry = createDaemonLossRegistry(true);
    const tasks = createDaemonLossTasks(true, registry.changed);
    const oldCheck = deferred();
    void tasks.track(oldCheck.promise);
    let closed = false;
    const row = registry.register(scope, () => ({
      intakeClosed: closed,
      pending: { ...empty(), watcherChecks: tasks.size },
    }))!;
    row.loss('e2ee_member_removed');
    row.retired();
    closed = true;
    expect(registry.inspect(scope.workspaceId)?.pending.watcherChecks).toBe(1);
    const wait = registry.wait(scope.workspaceId, 0);
    oldCheck.resolve();
    expect(await wait).toMatchObject({ drained: true, pending: empty() });
  });
  it('requires every intake owner to be fenced and never treats a failed cleanup as drained', () => {
    const registry = createDaemonLossRegistry(true);
    let closed = false;
    const row = registry.register(scope, () => ({ intakeClosed: closed, pending: empty() }))!;
    row.loss('e2ee_device_revoked');
    row.retired();
    expect(registry.inspect(scope.workspaceId)?.drained).toBe(false);
    closed = true;
    row.failed();
    expect(registry.inspect(scope.workspaceId)).toMatchObject({ status: 'failed', drained: false });
  });
  it('does not hide rejected watcher work by dropping its pending reference early', async () => {
    const tasks = createDaemonLossTasks(true, () => {});
    let reject!: (reason: Error) => void;
    const work = new Promise<void>((_, fail) => {
      reject = fail;
    });
    expect(tasks.track(work)).toBe(work);
    expect(tasks.size).toBe(1);
    reject(new Error('synthetic'));
    await expect(work).rejects.toThrow('synthetic');
    expect(tasks.size).toBe(0);
  });
  it('expires a missing causal signal with a fixed error rather than returning zero counts', async () => {
    vi.useFakeTimers();
    const registry = createDaemonLossRegistry(true);
    registry.register(scope, () => ({ intakeClosed: true, pending: empty() }));
    const result = expect(registry.wait(scope.workspaceId, 0)).rejects.toThrow(
      'daemon_loss_deadline'
    );
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
  });
  it('waits for a later loss sequence, and cancels the read without mutating an owner', async () => {
    const registry = createDaemonLossRegistry(true);
    const row = registry.register(scope, () => ({ intakeClosed: true, pending: empty() }))!;
    row.loss('e2ee_member_removed');
    row.retired();
    const before = registry.inspect(scope.workspaceId)!;
    const abort = new AbortController();
    const wait = registry.wait(scope.workspaceId, before.lossSequence, abort.signal);
    abort.abort();
    await expect(wait).rejects.toThrow('daemon_loss_aborted');
    expect(registry.inspect(scope.workspaceId)).toEqual(before);
  });
  it('binds replacement owners to a new random identity', () => {
    const registry = createDaemonLossRegistry(true);
    registry.register(scope, () => ({ intakeClosed: false, pending: empty() }));
    const old = registry.inspect(scope.workspaceId)!;
    registry.register(scope, () => ({ intakeClosed: false, pending: empty() }));
    const next = registry.inspect(scope.workspaceId)!;
    expect(next.processInstance).toBe(old.processInstance);
    expect(next.ownerInstance).not.toBe(old.ownerInstance);
  });
  it('counts same-session queue links not yet admitted into concurrency slots', async () => {
    const logger = { debug() {}, warn() {}, error() {} } as unknown as Logger;
    const processor = new MessageProcessor(logger, 1);
    const first = deferred();
    const entered = deferred();
    const message = {
      type: 'session/chat',
      sessionId: 'session',
    } as LocalSessionControlRequestValidated;
    let handled = 0;
    processor.enqueue(message, async () => {
      handled++;
      entered.resolve();
      await first.promise;
    });
    processor.enqueue(message, async () => {
      handled++;
    });
    await entered.promise;
    processor.stop();
    expect(processor.inspectClientLoss()).toEqual({ stopped: true, active: 1, queued: 1 });
    processor.enqueue(message, async () => {
      handled += 100;
    });
    first.resolve();
    await processor.drain();
    expect(processor.inspectClientLoss()).toEqual({ stopped: true, active: 0, queued: 0 });
    expect(handled).toBe(2);
  });

  it('fences only the baseline requester removed by a newer verified ledger; the machine remains running', async () => {
    const registry = createDaemonLossRegistry(true);
    let length = 10;
    let generation = 0;
    let devicePresent = true;
    let memberPresent = true;
    const tasks = createDaemonLossTasks(true, registry.changed);
    const pendingBeforeLedger = deferred();
    void tasks.track(pendingBeforeLedger.promise);
    registry.register(
      scope,
      () => ({ intakeClosed: false, pending: { ...empty(), watcherChecks: tasks.size } }),
      (key) => ({
        membershipId: 'member',
        ownerMembershipId: 'member',
        devicePresent: key === 'client' ? devicePresent : key === 'other',
        memberPresent,
        length,
        generation,
      })
    );
    const baseline = registry.inspect(scope.workspaceId, 'client')!;
    expect(registry.inspect(scope.workspaceId, 'unknown')).toBeNull();
    expect(baseline).toMatchObject({ code: null, fence: null, drained: false });
    devicePresent = false;
    length++;
    generation++;
    registry.changed();
    expect(registry.inspect(scope.workspaceId, 'client')).toMatchObject({
      code: 'e2ee_device_revoked',
      fence: 'verified-ledger',
      retired: false,
      drained: false,
    });
    const wait = registry.wait(scope.workspaceId, 0, undefined, 30_000, 'client');
    pendingBeforeLedger.resolve();
    expect(await wait).toMatchObject({
      drained: true,
      retired: false,
      requesterInstance: baseline.requesterInstance,
      authorityLength: 11,
      authorityGeneration: 1,
    });
    expect(registry.inspect(scope.workspaceId, 'other')).toMatchObject({
      drained: false,
      code: null,
    });
    memberPresent = false;
    length++;
    generation++;
    expect(registry.inspect(scope.workspaceId, 'client')).toMatchObject({
      code: 'e2ee_member_removed',
    });
  });
  it('rejects an unchanged or unverified authority position even with empty queues', () => {
    const registry = createDaemonLossRegistry(true);
    let present = true;
    let length = 10;
    let generation = 0;
    registry.register(
      scope,
      () => ({ intakeClosed: false, pending: empty() }),
      () => ({
        membershipId: 'member',
        ownerMembershipId: 'member',
        devicePresent: present,
        memberPresent: true,
        length,
        generation,
      })
    );
    registry.inspect(scope.workspaceId, 'client');
    present = false;
    expect(registry.inspect(scope.workspaceId, 'client')?.drained).toBe(false);
    generation++;
    expect(registry.inspect(scope.workspaceId, 'client')?.drained).toBe(false);
    length++;
    expect(registry.inspect(scope.workspaceId, 'client')?.drained).toBe(true);
  });
  it('rejects owner replacement and does not let read failures escape into product callbacks', async () => {
    const registry = createDaemonLossRegistry(true);
    let throwRead = false;
    registry.register(scope, () => {
      if (throwRead) throw new Error('secret');
      return { intakeClosed: false, pending: empty() };
    });
    const readFailure = expect(registry.wait(scope.workspaceId, 0)).rejects.toThrow(
      'daemon_loss_unavailable'
    );
    throwRead = true;
    expect(() => registry.changed()).not.toThrow();
    await readFailure;
    throwRead = false;
    const replacement = expect(registry.wait(scope.workspaceId, 0)).rejects.toThrow(
      'daemon_loss_owner_changed'
    );
    registry.register(scope, () => ({ intakeClosed: true, pending: empty() }));
    await replacement;
  });
  it('keeps an already-started watcher check visible after stop clears the normal chain maps', async () => {
    const held = deferred();
    const entered = deferred();
    const watcher = new SessionDispatchWatcher({ userResolver: { clear() {} } } as never);
    const internal = watcher as unknown as {
      maybeHandleSession: () => Promise<void>;
      lifecycleGeneration: number;
      started: boolean;
    };
    internal.lifecycleGeneration = 1;
    internal.started = true;
    internal.maybeHandleSession = async () => {
      entered.resolve();
      await held.promise;
    };
    const work = watcher.enqueueSessionCheck('session' as never);
    await entered.promise;
    watcher.stop();
    expect(watcher.inspectClientLoss()).toEqual({ stopped: true, pending: 1 });
    held.resolve();
    await work;
    expect(watcher.inspectClientLoss()).toEqual({ stopped: true, pending: 0 });
  });
});
