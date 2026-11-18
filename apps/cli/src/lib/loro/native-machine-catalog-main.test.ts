import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeMachineCatalogMainLegacy } from '../../../../electron/src/main/services/native-machine-catalog';
import { NativeRepoHostLegacy } from './native-repo-host';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import { getMachineFlockDocId, machineFlockKeys, type MachineCatalogBinding } from '@lody/shared';
import {
  MachineCatalogIpcError,
  type MachineCatalogIpcEvent,
} from '@lody/shared/machine-catalog-ipc';

const sdk = createRequire(path.resolve(import.meta.dirname, '../../../../electron/package.json'));
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const binding = {
  accountId: 'local:synthetic',
  workspaceId: 'lw_synthetic',
  machineId: 'machine-synthetic',
} as MachineCatalogBinding;
const room = {
  kind: 'flock' as const,
  id: getMachineFlockDocId(binding.workspaceId, binding.machineId),
};
const namespace = binding.workspaceId;
const saved = {
  id: 'agent-synthetic',
  machineId: binding.machineId,
  name: 'Synthetic agent',
  cliType: 'builtin',
  agentType: 'claude',
  env: { API_KEY: 'SYNTHETIC_SAVED_SECRET' },
};
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  const results = await Promise.allSettled(
    cleanups
      .splice(0)
      .reverse()
      .map((close) => close())
  );
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) throw new AggregateError(failed.map((result) => result.reason));
});
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'native-mf-main-'));
  let teardown: () => Promise<unknown> = () => rm(root, { recursive: true, force: true });
  cleanups.push(() => teardown());
  const entry = path.join(root, 'host.mjs'),
    dataDir = path.join(root, 'engine');
  await build({
    entryPoints: [path.join(import.meta.dirname, 'native-repo-host-entry.ts')],
    outfile: entry,
    bundle: true,
    platform: 'node',
    format: 'esm',
    plugins: [
      {
        name: 'native-package',
        setup(builder) {
          builder.onResolve({ filter: /^@loro-dev\/loro-repo-engine$/ }, () => ({
            path: sdk.resolve('@loro-dev/loro-repo-engine'),
            external: true,
          }));
        },
      },
    ],
  });
  const host = new NativeRepoHostLegacy({ dataDir, entry });
  teardown = async () => {
    await host.close();
    await rm(root, { recursive: true, force: true });
  };
  const client = await host.client(),
    rival = await connectEngine(dataDir, { autoReconnect: false });
  teardown = async () => {
    const results = await Promise.allSettled([client.close(), rival.close()]);
    await host.close();
    await rm(root, { recursive: true, force: true });
    const failures = results.filter((result) => result.status === 'rejected');
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason));
  };
  await client.createRoom(namespace, room, 'plaintext');
  await client.flockBatch(namespace, room, [
    { op: 'put', key: machineFlockKeys.agentConfig(saved.id as never), value: saved },
  ]);
  const registrations = new Set<string>();
  const authorityListeners = new Set<() => void>();
  let verify: () => Promise<boolean> = async () => true;
  let upload: () => Promise<void> = async () => {};
  const events: MachineCatalogIpcEvent[] = [];
  let listener = (_event: MachineCatalogIpcEvent) => {};
  let acquireBarrier: Promise<void> | undefined;
  const acquireEntered = deferred<void>();
  const service = new NativeMachineCatalogMainLegacy({
    async acquire(windowId, registrationId, machineId) {
      acquireEntered.resolve();
      if (acquireBarrier) await acquireBarrier;
      const assertCurrent = () => {
        if (
          !registrations.has(JSON.stringify([windowId, registrationId])) ||
          machineId !== binding.machineId
        )
          throw new MachineCatalogIpcError('access_denied');
      };
      assertCurrent();
      return {
        generation: registrationId,
        assertCurrent,
        options: {
          client,
          namespace,
          writer: 'main-synthetic',
          binding,
          authorize: () => {
            assertCurrent();
            return true;
          },
          authority: {
            current: () => ({ epoch: registrationId, synced: true }),
            subscribe: (listener) => {
              authorityListeners.add(listener);
              return () => {
                authorityListeners.delete(listener);
              };
            },
          },
          verifyAgentChange: () => verify(),
          upload: () => upload(),
        },
      };
    },
    send(_windowId, event) {
      events.push(event);
      listener(event);
    },
  });
  // Release only these synthetic resources, in ownership order. Cleanup errors
  // stay observable; never report an IPC test pass while a host survives.
  teardown = async () => {
    const failures: unknown[] = [];
    const attempt = async (close: () => Promise<unknown>) => {
      try {
        await close();
      } catch (cause) {
        failures.push(cause);
      }
    };
    await attempt(() => service.close());
    await Promise.all([attempt(() => client.close()), attempt(() => rival.close())]);
    await attempt(() => service.close());
    let stopped = false;
    await attempt(async () => {
      await host.close();
      stopped = true;
    });
    if (stopped) await attempt(() => rm(root, { recursive: true, force: true }));
    if (failures.length) throw new AggregateError(failures, 'Synthetic main MF cleanup failed');
  };
  const register = (windowId: number) => {
    const registrationId = randomUUID();
    registrations.add(JSON.stringify([windowId, registrationId]));
    return registrationId;
  };
  return {
    service,
    client,
    rival,
    register,
    events,
    revoke: (windowId: number, registrationId: string) => {
      registrations.delete(JSON.stringify([windowId, registrationId]));
    },
    setVerification: (callback: typeof verify) => {
      verify = callback;
    },
    setUpload: (callback: typeof upload) => {
      upload = callback;
    },
    notifyAuthority: () => {
      for (const listener of [...authorityListeners]) listener();
    },
    listen: (callback: typeof listener) => {
      listener = callback;
    },
    holdAcquisition: (barrier: Promise<void>) => {
      acquireBarrier = barrier;
      return acquireEntered.promise;
    },
  };
}

describe('main MF domain bridge over a real independent native host', () => {
  it('keeps saved credentials private and scopes edit tokens to the registered window', async () => {
    const f = await fixture(),
      a = f.register(1),
      b = f.register(2);
    const summary = await f.service.read(1, a, binding.machineId);
    expect(summary.projection.agents).toEqual([
      expect.objectContaining({ id: saved.id, name: saved.name }),
    ]);
    expect(JSON.stringify(summary)).not.toContain('SYNTHETIC_SAVED_SECRET');
    const reply = await f.service.beginAgentConfigEdit(1, a, binding.machineId, saved.id, a);
    expect(reply.generation).toBe(a);
    const editor = reply.editor;
    expect(editor.credentials.envPresent).toBe(true);
    expect(JSON.stringify(editor)).not.toContain('SYNTHETIC_SAVED_SECRET');
    await expect(
      f.service.execute(
        2,
        b,
        binding.machineId,
        {
          kind: 'edit-agent',
          id: saved.id,
          editToken: editor.editToken,
          changes: { name: 'Wrong window' },
        },
        b
      )
    ).rejects.toMatchObject({ code: 'edit_expired' });
    await f.service.execute(
      1,
      a,
      binding.machineId,
      {
        kind: 'edit-agent',
        id: saved.id,
        editToken: editor.editToken,
        changes: { name: 'Edited via main' },
      },
      a
    );
    const row = await f.client.flockGet(
      namespace,
      room,
      machineFlockKeys.agentConfig(saved.id as never)
    );
    expect(row.value).toMatchObject({ name: 'Edited via main', env: saved.env });
  });
  it('rejects malformed/raw commands before any persistent mutation', async () => {
    const f = await fixture(),
      registration = f.register(1);
    const before = await f.client.flockGet(
      namespace,
      room,
      machineFlockKeys.agentConfig(saved.id as never)
    );
    await expect(
      f.service.execute(
        1,
        registration,
        binding.machineId,
        {
          kind: 'create-agent',
          config: saved,
          namespace: 'outside',
          patch: [],
        },
        registration
      )
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(f.service.read(1, registration, 'another-machine')).rejects.toMatchObject({
      code: 'access_denied',
    });
    const after = await f.client.flockGet(
      namespace,
      room,
      machineFlockKeys.agentConfig(saved.id as never)
    );
    expect(after.roomTxId).toBe(before.roomTxId);
    expect(after.value).toEqual(before.value);
  });
  it('does not publish or recreate a catalog when a grant arrives after registration retirement', async () => {
    const f = await fixture(),
      registration = f.register(1),
      gate = deferred<void>();
    const entered = f.holdAcquisition(gate.promise);
    const read = f.service.read(1, registration, binding.machineId);
    await entered;
    const rejected = expect(read).rejects.toMatchObject({ code: 'access_denied' });
    f.revoke(1, registration);
    const retired = f.service.retire(1, registration);
    gate.resolve();
    await rejected;
    await retired;
    await expect(f.service.read(1, registration, binding.machineId)).rejects.toMatchObject({
      code: 'access_denied',
    });
    expect(f.events).toEqual([]);
  });
  it('joins a late grant on close while rejecting its admission even if the foreign grant remains valid', async () => {
    const f = await fixture(),
      registration = f.register(1),
      gate = deferred<void>();
    const entered = f.holdAcquisition(gate.promise);
    const read = f.service.read(1, registration, binding.machineId);
    await entered;
    const rejected = expect(read).rejects.toMatchObject({ code: 'restart_required' });
    const closed = f.service.close();
    gate.resolve();
    await rejected;
    await closed;
    await expect(f.service.read(1, registration, binding.machineId)).rejects.toMatchObject({
      code: 'restart_required',
    });
    expect(f.events).toEqual([]);
  });
  it('sends safe initial and live snapshots and releases only the exact observer lease', async () => {
    const f = await fixture(),
      registration = f.register(1),
      requestId = randomUUID();
    const initial = deferred<MachineCatalogIpcEvent>();
    f.listen((event) => initial.resolve(event));
    const lease = await f.service.observe(1, registration, binding.machineId, requestId);
    const first = await initial.promise;
    expect(first).toMatchObject({
      registrationId: registration,
      requestId,
      leaseId: lease.leaseId,
      type: 'snapshot',
    });
    expect(JSON.stringify(first)).not.toContain('SYNTHETIC_SAVED_SECRET');
    await f.service.unsubscribe(1, registration, binding.machineId, requestId, randomUUID());
    const changed = deferred<MachineCatalogIpcEvent>();
    f.listen((event) => {
      if (event.type === 'snapshot' && event.snapshot.projection.agents[0]?.name === 'Live update')
        changed.resolve(event);
    });
    await f.rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.agentConfig(saved.id as never),
        value: { ...saved, name: 'Live update' },
      },
    ]);
    expect(await changed.promise).toMatchObject({ leaseId: lease.leaseId, type: 'snapshot' });
    await f.service.unsubscribe(1, registration, binding.machineId, requestId, lease.leaseId);
    await f.service.retire(1, registration);
  });
  it('retains unknown unsubscribe outcomes until the actual borrowed transport has closed', async () => {
    const f = await fixture(),
      registration = f.register(1),
      requestId = randomUUID();
    const subscribe = f.client.flockSubscribe.bind(f.client);
    f.client.flockSubscribe = async (...args) => {
      const handle = await subscribe(...args);
      const unsubscribe = handle.unsubscribe.bind(handle);
      handle.unsubscribe = async () => {
        await unsubscribe();
        // Deliver no successful release receipt to the catalog owner, even
        // though this real native engine has accepted the unsubscribe.
        throw new Error('SYNTHETIC_UNSUBSCRIBE_ACK_LOST');
      };
      return handle;
    };
    const lease = await f.service.observe(1, registration, binding.machineId, requestId);
    await expect(
      f.service.unsubscribe(1, registration, binding.machineId, requestId, lease.leaseId)
    ).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    expect(f.client.connectionState).toBe('connected');
    await expect(f.service.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    await expect(f.service.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    await f.client.close();
    await f.service.close();
  });
  it('releases a subscription whose initial snapshot cannot reach its product frame', async () => {
    const f = await fixture(),
      registration = f.register(1);
    f.listen(() => {
      throw new Error('SYNTHETIC_FRAME_GONE');
    });
    await expect(
      f.service.observe(1, registration, binding.machineId, randomUUID())
    ).rejects.toMatchObject({ code: 'restart_required' });
    await f.service.close();
    expect(f.client.connectionState).toBe('connected');
  });
  it('keeps a replacement exact lease when an older acquiring subscription finishes releasing', async () => {
    const f = await fixture(),
      registration = f.register(1),
      requestId = randomUUID();
    const allowHandle = deferred<void>(),
      handleReady = deferred<void>(),
      firstEvent = deferred<MachineCatalogIpcEvent>(),
      nextGrant = deferred<void>();
    const subscribe = f.client.flockSubscribe.bind(f.client);
    let firstSubscription = true;
    f.client.flockSubscribe = async (...args) => {
      const handle = await subscribe(...args);
      if (firstSubscription) {
        firstSubscription = false;
        handleReady.resolve();
        await allowHandle.promise;
      }
      return handle;
    };
    const onConnection = f.client.onConnectionStateChange.bind(f.client);
    let firstProof = true;
    f.client.onConnectionStateChange = (listener) => {
      const detach = onConnection(listener);
      if (!firstProof) return detach;
      firstProof = false;
      return () => {
        detach();
        // Resume the replacement grant at the actual old SDK release proof,
        // before its outer main slot-release continuation finishes.
        nextGrant.resolve();
      };
    };
    f.listen((event) => firstEvent.resolve(event));
    const old = f.service.observe(1, registration, binding.machineId, requestId);
    void old.catch(() => {});
    let replacement: Promise<{ leaseId: string }> | undefined;
    try {
      await handleReady.promise;
      // SDK 0.1.0's initial currentValue does not call onUpdate. A real live
      // write exposes the first exact lease while its handle is still pending.
      await f.rival.flockBatch(namespace, room, [
        {
          op: 'put',
          key: machineFlockKeys.agentConfig(saved.id as never),
          value: { ...saved, name: 'Before replacement' },
        },
      ]);
      const initial = await firstEvent.promise;
      const released = f.service.unsubscribe(
        1,
        registration,
        binding.machineId,
        requestId,
        initial.leaseId
      );
      f.holdAcquisition(nextGrant.promise);
      replacement = f.service.observe(1, registration, binding.machineId, requestId);
      void replacement.catch(() => {});
      allowHandle.resolve();
      const next = await replacement;
      await released;
      await expect(old).rejects.toMatchObject({ code: 'restart_required' });
      expect(next.leaseId).not.toBe(initial.leaseId);
      await f.service.unsubscribe(1, registration, binding.machineId, requestId, next.leaseId);
      const witnessId = randomUUID(),
        witnessed = deferred<void>();
      let escaped = false;
      f.listen((event) => {
        if (
          event.type !== 'snapshot' ||
          event.snapshot.projection.agents[0]?.name !== 'After exact release'
        )
          return;
        if (event.requestId === requestId && event.leaseId === next.leaseId) escaped = true;
        if (event.requestId === witnessId) witnessed.resolve();
      });
      const witness = await f.service.observe(1, registration, binding.machineId, witnessId);
      await f.rival.flockBatch(namespace, room, [
        {
          op: 'put',
          key: machineFlockKeys.agentConfig(saved.id as never),
          value: { ...saved, name: 'After exact release' },
        },
      ]);
      await witnessed.promise;
      expect(escaped).toBe(false);
      await f.service.unsubscribe(1, registration, binding.machineId, witnessId, witness.leaseId);
    } finally {
      allowHandle.resolve();
      nextGrant.resolve();
      await Promise.allSettled([old, ...(replacement ? [replacement] : [])]);
    }
  });
  it('rejects stale editor/write/upload generations before private authoring and leaves the actual room head unchanged', async () => {
    const f = await fixture(),
      registration = f.register(1);
    const before = await f.client.flockScan(namespace, room);
    f.setVerification(async () => {
      throw new Error('SYNTHETIC_PRIVATE_AUTHOR_MUST_NOT_RUN');
    });
    f.setUpload(async () => {
      await f.rival.flockBatch(namespace, room, [
        { op: 'put', key: ['upload-witness'], value: true },
      ]);
    });
    await expect(
      f.service.beginAgentConfigEdit(1, registration, binding.machineId, saved.id, 'stale')
    ).rejects.toMatchObject({ code: 'restart_required' });
    await expect(
      f.service.execute(
        1,
        registration,
        binding.machineId,
        { kind: 'create-agent', config: { ...saved, id: 'unadmitted-agent' } },
        'stale'
      )
    ).rejects.toMatchObject({ code: 'restart_required' });
    await expect(
      f.service.upload(1, registration, binding.machineId, 'stale')
    ).rejects.toMatchObject({ code: 'restart_required' });
    const after = await f.client.flockScan(namespace, room);
    expect(after.roomTxId).toBe(before.roomTxId);
    expect(after.entries).toEqual(before.entries);
    const editor = await f.service.beginAgentConfigEdit(
      1,
      registration,
      binding.machineId,
      saved.id,
      registration
    );
    expect(editor.generation).toBe(registration);
    const changed = await f.service.execute(
      1,
      registration,
      binding.machineId,
      {
        kind: 'edit-agent',
        id: saved.id,
        editToken: editor.editor.editToken,
        changes: { name: 'Current generation' },
      },
      registration
    );
    expect(changed).toEqual({ generation: registration, changed: true });
  });

  it('fences a canceled request before an asynchronous grant admission and remembers it until registration retirement', async () => {
    const f = await fixture(),
      registration = f.register(1),
      requestId = randomUUID(),
      gate = deferred<void>();
    const entered = f.holdAcquisition(gate.promise);
    const observation = f.service.observe(1, registration, binding.machineId, requestId);
    const rejected = expect(observation).rejects.toMatchObject({ code: 'restart_required' });
    await entered;
    const canceled = f.service.cancelObservation(1, registration, binding.machineId, requestId);
    gate.resolve();
    await expect(canceled).resolves.toEqual({ canceled: true });
    await rejected;
    await expect(
      f.service.observe(1, registration, binding.machineId, requestId)
    ).rejects.toMatchObject({ code: 'restart_required' });
    expect(f.events).toEqual([]);
    f.revoke(1, registration);
    await f.service.retire(1, registration);
    const replacement = f.register(1);
    const lease = await f.service.observe(1, replacement, binding.machineId, requestId);
    await f.service.unsubscribe(1, replacement, binding.machineId, requestId, lease.leaseId);
  });

  it('joins cancellation with a late real SDK subscription and emits nothing after the cancel receipt', async () => {
    const f = await fixture(),
      registration = f.register(1),
      requestId = randomUUID();
    const ready = deferred<void>(),
      gate = deferred<void>();
    const subscribe = f.client.flockSubscribe.bind(f.client);
    let first = true;
    f.client.flockSubscribe = async (...args) => {
      const handle = await subscribe(...args);
      if (first) {
        first = false;
        ready.resolve();
        await gate.promise;
      }
      return handle;
    };
    const observation = f.service.observe(1, registration, binding.machineId, requestId);
    const rejected = expect(observation).rejects.toMatchObject({ code: 'restart_required' });
    await ready.promise;
    const canceled = f.service.cancelObservation(1, registration, binding.machineId, requestId);
    gate.resolve();
    await expect(canceled).resolves.toEqual({ canceled: true });
    await rejected;
    const witnessId = randomUUID(),
      witnessed = deferred<void>();
    f.listen((event) => {
      if (
        event.requestId === witnessId &&
        event.type === 'snapshot' &&
        event.snapshot.projection.agents[0]?.name === 'After cancellation'
      )
        witnessed.resolve();
    });
    const witness = await f.service.observe(1, registration, binding.machineId, witnessId);
    await f.rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.agentConfig(saved.id as never),
        value: { ...saved, name: 'After cancellation' },
      },
    ]);
    await witnessed.promise;
    expect(f.events.filter((event) => event.requestId === requestId)).toEqual([]);
    await f.service.unsubscribe(1, registration, binding.machineId, witnessId, witness.leaseId);
  });

  it('retains partial-acquisition cleanup after an unknown ACK and never reports cancellation confirmed', async () => {
    const f = await fixture(),
      registration = f.register(1),
      requestId = randomUUID();
    const subscribe = f.client.flockSubscribe.bind(f.client);
    let first = true;
    f.client.flockSubscribe = async (...args) => {
      const handle = await subscribe(...args);
      if (first) {
        first = false;
        throw new Error('SYNTHETIC_SUBSCRIBE_ACK_LOST');
      }
      return handle;
    };
    await expect(
      f.service.observe(1, registration, binding.machineId, requestId)
    ).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    await expect(
      f.service.cancelObservation(1, registration, binding.machineId, requestId)
    ).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    expect(f.client.connectionState).toBe('connected');
    const independent = f.register(2),
      witnessId = randomUUID();
    const witness = await f.service.observe(2, independent, binding.machineId, witnessId);
    expect(
      (await f.service.read(2, independent, binding.machineId)).projection.agents[0]?.name
    ).toBe(saved.name);
    await f.service.unsubscribe(2, independent, binding.machineId, witnessId, witness.leaseId);
    await expect(f.service.retire(1, registration)).rejects.toMatchObject({
      code: 'cleanup_unconfirmed',
    });
    await f.client.close();
    await expect(
      f.service.cancelObservation(1, registration, binding.machineId, requestId)
    ).resolves.toEqual({ canceled: true });
    await f.service.retire(1, registration);
  });

  it('keeps cancellation tombstones bounded per window and frees their capacity only on confirmed retirement', async () => {
    const f = await fixture(),
      registration = f.register(1),
      next = f.register(1),
      independent = f.register(2);
    const requests = Array.from({ length: 256 }, () => randomUUID());
    for (const requestId of requests)
      await f.service.cancelObservation(1, registration, binding.machineId, requestId);
    await expect(
      f.service.cancelObservation(1, registration, binding.machineId, requests[0]!)
    ).resolves.toEqual({ canceled: true });
    await expect(
      f.service.cancelObservation(1, next, binding.machineId, randomUUID())
    ).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    await expect(
      f.service.cancelObservation(2, independent, binding.machineId, randomUUID())
    ).resolves.toEqual({ canceled: true });
    f.revoke(1, registration);
    await f.service.retire(1, registration);
    await expect(
      f.service.cancelObservation(1, next, binding.machineId, randomUUID())
    ).resolves.toEqual({ canceled: true });
  });

  it('distinguishes a disconnected borrowed transport from a genuinely revoked product registration', async () => {
    const f = await fixture(),
      revoked = f.register(1),
      current = f.register(2);
    const revokedRequest = randomUUID(),
      currentRequest = randomUUID();
    await f.service.observe(1, revoked, binding.machineId, revokedRequest);
    await f.service.observe(2, current, binding.machineId, currentRequest);
    const denied = deferred<MachineCatalogIpcEvent>(),
      disconnected = deferred<MachineCatalogIpcEvent>();
    f.listen((event) => {
      if (event.type === 'error' && event.requestId === revokedRequest) denied.resolve(event);
      if (event.type === 'error' && event.requestId === currentRequest) disconnected.resolve(event);
    });
    f.revoke(1, revoked);
    f.notifyAuthority();
    expect(await denied.promise).toMatchObject({ type: 'error', code: 'access_denied' });
    await f.client.close();
    expect(await disconnected.promise).toMatchObject({ type: 'error', code: 'restart_required' });
  });

  it('reports an in-flight read transport loss as restart-required without calling it a permission revocation', async () => {
    const f = await fixture(),
      registration = f.register(1),
      entered = deferred<void>(),
      gate = deferred<void>();
    const scan = f.client.flockScan.bind(f.client);
    f.client.flockScan = async (...args) => {
      await scan(...args);
      entered.resolve();
      await gate.promise;
      throw new Error('SYNTHETIC_READ_SOCKET_GONE');
    };
    const read = f.service.read(1, registration, binding.machineId);
    const rejected = expect(read).rejects.toMatchObject({ code: 'restart_required' });
    await entered.promise;
    await f.client.close();
    gate.resolve();
    await rejected;
    expect((await f.rival.flockScan(namespace, room)).entries).toHaveLength(1);
  });
});
