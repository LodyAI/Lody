import { readNativeMachineCatalogPublicView } from '../src/lib/native-machine-catalog-public';
import { describe, expect, it } from 'vitest';
import { MachineCatalogIpcError } from '@lody/shared/machine-catalog-ipc';
import { createElectronNativeMachineCatalog } from '../src/providers/electron-native-machine-catalog';
import {
  nativeMachineCatalogHarness,
  machineA,
  machineB,
  configId,
  deferred,
  view,
  openNativeMachineCatalogTestGroup,
  registrationId,
  binding,
} from './native-machine-catalog.test-support';

describe('selected native machine settings source', () => {
  it('keeps stable snapshots, exact machine groups and write-only editor tokens while passing actual settings commands', async () => {
    const host = nativeMachineCatalogHarness([machineA, machineB]),
      source = host.source();
    const initial = source.getSnapshot();
    expect(initial.agents).toEqual([]);
    expect(source.getSnapshot()).toBe(initial);
    await expect(initial.editor(machineA).load(configId(machineA))).rejects.toMatchObject({
      code: 'restart_required',
    });
    await source.start();
    const current = source.getSnapshot();
    expect(current.agents.map((agent) => agent.machineId)).toEqual([machineA, machineB]);
    expect(source.getSnapshot()).toBe(current);
    expect(JSON.stringify(current)).not.toContain('SYNTHETIC_SAVED_SECRET');
    const editor = await current.editor(machineA).load(configId(machineA));
    expect(editor.editToken).not.toContain('server-token');
    expect(JSON.stringify(editor)).not.toContain('SYNTHETIC_SAVED_SECRET');
    await expect(
      current.execute(machineB, {
        kind: 'edit-agent',
        id: configId(machineA),
        editToken: editor.editToken,
        changes: { name: 'Wrong machine' },
      })
    ).rejects.toMatchObject({ code: 'edit_expired' });
    expect(host.values.get(machineB)?.name).toBe('Synthetic agent');
    await current.editor(machineA).save({
      id: configId(machineA),
      editToken: editor.editToken,
      changes: {
        name: 'Edited agent',
        env: { kind: 'replace', value: { API_KEY: 'SYNTHETIC_NEW_SECRET' } },
      },
    });
    expect(host.values.get(machineA)).toMatchObject({
      name: 'Edited agent',
      env: { API_KEY: 'SYNTHETIC_NEW_SECRET' },
    });
    await expect(
      current.editor(machineA).save({
        id: configId(machineA),
        editToken: editor.editToken,
        changes: { name: 'Replayed' },
      })
    ).rejects.toMatchObject({ code: 'edit_expired' });
    expect(JSON.stringify(source.getSnapshot())).not.toContain('SYNTHETIC_NEW_SECRET');
    const beforeForeign = source.getSnapshot(),
      [lease] = host.leases.values();
    host.send({
      ...lease!.request,
      leaseId: lease!.leaseId,
      registrationId: crypto.randomUUID(),
      type: 'snapshot',
      snapshot: view(machineA, 'Foreign'),
    });
    expect(source.getSnapshot()).toBe(beforeForeign);
    await source.close();
    expect(host.leases.size).toBe(0);
    expect(source.getSnapshot().agents).toEqual([]);
    await expect(current.execute(machineA, { kind: 'clear-dot-lody-path' })).rejects.toMatchObject({
      code: 'access_denied',
    });
  });

  it('does not overwrite a live settings snapshot with an older initial read', async () => {
    const host = nativeMachineCatalogHarness(),
      read = deferred<unknown>();
    host.transport.readMachineCatalog = () => read.promise;
    const entered = deferred<void>(),
      published = deferred<void>(),
      observe = host.transport.observeMachineCatalog;
    host.transport.observeMachineCatalog = async (request) => {
      const receipt = await observe(request);
      entered.resolve();
      return receipt;
    };
    const source = host.source();
    const detach = source.subscribe(() => {
      if (source.getSnapshot().agents[0]?.name === 'Live rename') published.resolve();
    });
    const start = source.start();
    await entered.promise;
    const [lease] = host.leases.values();
    host.emit(lease!.request, view(machineA, 'Live rename'));
    await published.promise;
    read.resolve(view(machineA, 'Stale read'));
    await start;
    detach();
    expect(source.getSnapshot().agents[0]?.name).toBe('Live rename');
    await source.close();
  });

  it('admits a confirmed local read before a late subscription ACK, while Node still rejects revoked authoring', async () => {
    const host = nativeMachineCatalogHarness(),
      observe = host.transport.observeMachineCatalog,
      entered = deferred<void>(),
      receipt = deferred<void>(),
      local = deferred<void>();
    host.transport.observeMachineCatalog = async (request) => {
      const actual = await observe(request);
      entered.resolve();
      await receipt.promise;
      return actual;
    };
    const source = host.source();
    const detach = source.subscribe(() => {
      if (source.getStatus(machineA) === 'ready') local.resolve();
    });
    const start = source.start();
    await entered.promise;
    await local.promise;
    const editor = await source.getSnapshot().editor(machineA).load(configId(machineA));
    host.transport.executeMachineCatalog = async () => {
      throw new MachineCatalogIpcError('access_denied');
    };
    const [lease] = host.leases.values();
    host.send({ ...lease!.request, leaseId: lease!.leaseId, type: 'error', code: 'access_denied' });
    await expect(
      source
        .getSnapshot()
        .editor(machineA)
        .save({
          id: configId(machineA),
          editToken: editor.editToken,
          changes: { name: 'Revoked authoring' },
        })
    ).rejects.toMatchObject({ code: 'access_denied' });
    expect(host.values.get(machineA)?.name).toBe('Synthetic agent');
    expect(source.getStatus(machineA)).toBe('error');
    expect(source.getSnapshot().agents).toEqual([]);
    receipt.resolve();
    await start;
    detach();
    await source.close();
  });

  it('fences only the machine with a generation mismatch and rejects its late editor reply', async () => {
    const host = nativeMachineCatalogHarness([machineA, machineB]),
      source = host.source();
    await source.start();
    const reply = deferred<unknown>(),
      begin = host.transport.beginMachineAgentConfigEdit;
    host.transport.beginMachineAgentConfigEdit = async (request) => {
      const editor = await begin(request);
      await reply.promise;
      return editor;
    };
    const pending = source.getSnapshot().editor(machineA).load(configId(machineA));
    const outcome = expect(pending).rejects.toMatchObject({ code: 'restart_required' });
    const lease = [...host.leases.values()].find((lease) => lease.request.machineId === machineA)!;
    host.emit(lease.request, view(machineA, 'Replacement generation', 'generation-b'));
    expect(source.getStatus(machineA)).toBe('error');
    expect(source.getSnapshot().agents.map((agent) => agent.machineId)).toEqual([machineB]);
    reply.resolve(undefined);
    await outcome;
    await source.getSnapshot().execute(machineB, { kind: 'clear-dot-lody-path' });
    await source.close();
    expect(host.leases.size).toBe(0);
  });

  it('rejects a server-generation change even before its observation event reaches the renderer', async () => {
    const host = nativeMachineCatalogHarness([machineA, machineB]),
      source = host.source();
    await source.start();
    host.snapshots.set(machineA, view(machineA, 'Server replaced', 'generation-b'));
    await expect(
      source.getSnapshot().editor(machineA).load(configId(machineA))
    ).rejects.toMatchObject({ code: 'restart_required' });
    expect(source.getStatus(machineA)).toBe('unavailable');
    expect(source.getSnapshot().agents.map((agent) => agent.machineId)).toEqual([
      machineA,
      machineB,
    ]);
    const editor = await source.getSnapshot().editor(machineB).load(configId(machineB));
    await source
      .getSnapshot()
      .editor(machineB)
      .save({
        id: configId(machineB),
        editToken: editor.editToken,
        changes: { name: 'Independent edit' },
      });
    expect(host.values.get(machineB)?.name).toBe('Independent edit');
    await source.close();
  });

  it('keeps a local unsynced snapshot and its editor token usable, then pauses temporary faults until exact same-generation reacquisition', async () => {
    const host = nativeMachineCatalogHarness([machineA, machineB]),
      source = host.source();
    await source.start();
    const editor = await source.getSnapshot().editor(machineA).load(configId(machineA));
    const realm = source.getSnapshot().machineGeneration!(machineA),
      otherRealm = source.getSnapshot().machineGeneration!(machineB);
    const lease = [...host.leases.values()].find((item) => item.request.machineId === machineA)!;
    host.emit(lease.request, { ...view(machineA), synced: false });
    expect(source.getStatus(machineA)).toBe('ready');
    expect(source.getSnapshot().machineGeneration!(machineA)).toBe(realm);
    expect(source.getSnapshot().agents.map((agent) => agent.machineId)).toEqual([
      machineA,
      machineB,
    ]);
    host.send({
      ...lease.request,
      leaseId: lease.leaseId,
      type: 'error',
      code: 'restart_required',
    });
    expect(source.getStatus(machineA)).toBe('unavailable');
    expect(source.getSnapshot().agents.map((agent) => agent.machineId)).toEqual([
      machineA,
      machineB,
    ]);
    await expect(
      source
        .getSnapshot()
        .editor(machineA)
        .save({ id: configId(machineA), editToken: editor.editToken, changes: { name: 'Paused' } })
    ).rejects.toMatchObject({ code: 'restart_required' });
    await source.reacquire(machineA);
    expect(source.getSnapshot().machineGeneration!(machineA)).toBe(realm);
    expect(source.getSnapshot().machineGeneration!(machineB)).toBe(otherRealm);
    await source
      .getSnapshot()
      .editor(machineA)
      .save({
        id: configId(machineA),
        editToken: editor.editToken,
        changes: { name: 'Local committed after reacquisition' },
      });
    expect(host.values.get(machineA)?.name).toBe('Local committed after reacquisition');
    await source.close();
  });

  it('retains failed cancellation of an unknown observe ACK and retries the same logical request', async () => {
    const host = nativeMachineCatalogHarness(),
      observe = host.transport.observeMachineCatalog,
      cancel = host.transport.cancelMachineCatalogObservation;
    host.transport.observeMachineCatalog = async (request) => {
      await observe(request);
      throw new Error('Synthetic observe reply lost');
    };
    const cancelGate = deferred<void>();
    host.transport.cancelMachineCatalogObservation = async (request) => {
      await cancelGate.promise;
      return await cancel(request);
    };
    const source = host.source();
    await source.start();
    expect(source.getStatus(machineA)).toBe('unavailable');
    expect(host.leases.size).toBe(1);
    const close = source.close(),
      failed = expect(close).rejects.toBeInstanceOf(AggregateError);
    cancelGate.reject(new Error('Synthetic cancel ACK lost'));
    await failed;
    expect(host.leases.size).toBe(1);
    expect(source.getSnapshot().agents).toEqual([]);
    host.transport.cancelMachineCatalogObservation = cancel;
    await source.retryCleanup();
    expect(host.leases.size).toBe(0);
    expect(host.cancelled.size).toBe(1);
  });

  it('confirms exact-request cancellation before an unknown late receipt and never republishes its snapshot', async () => {
    const host = nativeMachineCatalogHarness(),
      observe = host.transport.observeMachineCatalog,
      entered = deferred<void>(),
      receipt = deferred<unknown>();
    host.transport.observeMachineCatalog = async (request) => {
      const actual = await observe(request);
      entered.resolve();
      await receipt.promise;
      return actual;
    };
    const source = host.source(),
      start = source.start();
    await entered.promise;
    const close = source.close();
    expect(source.getSnapshot().agents).toEqual([]);
    await close;
    await start;
    expect(host.leases.size).toBe(0);
    expect(host.cancelled.size).toBe(1);
    receipt.resolve(undefined);
    await Promise.resolve();
    expect(source.getSnapshot().agents).toEqual([]);
    await source.retryCleanup();
  });

  it('joins a real late lease release while exact cancellation is still pending, without dropping either attempt', async () => {
    const host = nativeMachineCatalogHarness(),
      observe = host.transport.observeMachineCatalog,
      cancel = host.transport.cancelMachineCatalogObservation;
    const entered = deferred<void>(),
      receipt = deferred<void>(),
      cancelAck = deferred<void>();
    host.transport.observeMachineCatalog = async (request) => {
      const actual = await observe(request);
      entered.resolve();
      await receipt.promise;
      return actual;
    };
    host.transport.cancelMachineCatalogObservation = async (request) => {
      await cancelAck.promise;
      return await cancel(request);
    };
    const source = host.source(),
      start = source.start();
    await entered.promise;
    const closing = source.close();
    expect(host.leases.size).toBe(1);
    receipt.resolve();
    await closing;
    await start;
    expect(host.leases.size).toBe(0);
    expect(source.getSnapshot().agents).toEqual([]);
    cancelAck.resolve();
    await source.retryCleanup();
  });

  it('retains a known lease on failed unobserve and requires a real successful release on retry', async () => {
    const host = nativeMachineCatalogHarness(),
      release = host.transport.unobserveMachineCatalog;
    const source = host.source();
    await source.start();
    host.transport.unobserveMachineCatalog = async () => {
      throw new Error('Synthetic release failed');
    };
    await expect(source.close()).rejects.toBeInstanceOf(AggregateError);
    expect(host.leases.size).toBe(1);
    host.transport.unobserveMachineCatalog = release;
    await source.retryCleanup();
    expect(host.leases.size).toBe(0);
  });

  it('does not replay a committed mutation when its reply arrives after retirement', async () => {
    const host = nativeMachineCatalogHarness(),
      execute = host.transport.executeMachineCatalog,
      committed = deferred<void>(),
      reply = deferred<void>();
    host.transport.executeMachineCatalog = async (request) => {
      const result = await execute(request);
      committed.resolve();
      await reply.promise;
      return result;
    };
    const source = host.source();
    await source.start();
    const editor = await source.getSnapshot().editor(machineA).load(configId(machineA));
    const writing = source
      .getSnapshot()
      .editor(machineA)
      .save({
        id: configId(machineA),
        editToken: editor.editToken,
        changes: { name: 'Committed once' },
      });
    const outcome = expect(writing).rejects.toMatchObject({ code: 'access_denied' });
    await committed.promise;
    await source.close();
    reply.resolve();
    await outcome;
    expect(host.values.get(machineA)?.name).toBe('Committed once');
    await source.retryCleanup();
    expect(host.values.get(machineA)?.name).toBe('Committed once');
  });
  it('uses the actual main bridge and hosted SDK, rejecting stale-generation authoring and cancelled logical observations', async () => {
    const group = await openNativeMachineCatalogTestGroup();
    try {
      expect(group.pid).not.toBe(process.pid);
      await group.source.start();
      expect(group.source.getSnapshot().agents.map((agent) => agent.machineId)).toEqual([
        machineA,
        machineB,
      ]);
      const editor = await group.source.getSnapshot().editor(machineB).load(configId(machineB));
      await group.source
        .getSnapshot()
        .editor(machineB)
        .save({
          id: configId(machineB),
          editToken: editor.editToken,
          changes: { env: { kind: 'replace', value: { API_KEY: 'SYNTHETIC_HOSTED_REPLACEMENT' } } },
        });
      expect((await group.rawConfig(machineB)).env).toEqual({
        API_KEY: 'SYNTHETIC_HOSTED_REPLACEMENT',
      });
      expect(JSON.stringify(group.source.getSnapshot())).not.toContain(
        'SYNTHETIC_HOSTED_REPLACEMENT'
      );
      const before = await group.client.flockScan(group.namespace, group.rooms.get(machineA)!);
      group.generations.set(machineA, 'replacement-generation');
      await expect(
        group.source.getSnapshot().execute(machineA, {
          kind: 'set-dot-lody-path',
          path: '/synthetic/STALE_AUTHORING_MUST_NOT_COMMIT',
        })
      ).rejects.toMatchObject({ code: 'restart_required' });
      const after = await group.client.flockScan(group.namespace, group.rooms.get(machineA)!);
      expect(after).toEqual(before);
      expect(group.source.getStatus(machineA)).toBe('unavailable');
      expect(group.source.getSnapshot().agents.map((agent) => agent.machineId)).toEqual([
        machineA,
        machineB,
      ]);
      const request = { registrationId, requestId: crypto.randomUUID(), machineId: machineB };
      expect(await group.transport.cancelMachineCatalogObservation(request)).toEqual({
        canceled: true,
      });
      await expect(group.transport.observeMachineCatalog(request)).rejects.toMatchObject({
        code: 'restart_required',
      });
      await group.source.upload(machineB);
      expect((await group.rawConfig(machineB)).env).toEqual({
        API_KEY: 'SYNTHETIC_HOSTED_REPLACEMENT',
      });
    } finally {
      await group.close();
    }
  });
  it('uses the real window IPC proxy, exact error channels and tuple-filtered pushes without leaking or replaying drafts', async () => {
    const host = nativeMachineCatalogHarness();
    const listeners = new Map<string, (raw: unknown) => void>();
    const stop = host.listen((event) => listeners.get('machineCatalog.event')?.(event));
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    let fault: string | undefined;
    const methods = {
      read: host.transport.readMachineCatalog,
      beginAgentConfigEdit: host.transport.beginMachineAgentConfigEdit,
      execute: host.transport.executeMachineCatalog,
      upload: host.transport.uploadMachineCatalog,
      observe: host.transport.observeMachineCatalog,
      unobserve: host.transport.unobserveMachineCatalog,
      cancelObservation: host.transport.cancelMachineCatalogObservation,
    };
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        ipc: {
          async invoke(channel: string, input: unknown) {
            if (fault) {
              const message = fault;
              fault = undefined;
              throw new Error(message);
            }
            const method = channel.startsWith('machineCatalog.')
              ? (channel.slice('machineCatalog.'.length) as keyof typeof methods)
              : undefined;
            if (!method || !methods[method]) throw new Error('Unexpected IPC channel');
            return (methods[method] as (request: unknown) => Promise<unknown>)(input);
          },
          on(channel: string, receive: (raw: unknown) => void) {
            listeners.set(channel, receive);
            return () => {
              listeners.delete(channel);
            };
          },
        },
      },
    });
    const source = createElectronNativeMachineCatalog({
      binding,
      registrationId,
      machineIds: [machineA],
    });
    try {
      await source.start();
      const editor = await source.getSnapshot().editor(machineA).load(configId(machineA));
      await source
        .getSnapshot()
        .editor(machineA)
        .save({
          id: configId(machineA),
          editToken: editor.editToken,
          changes: {
            name: 'Proxy committed',
            env: { kind: 'replace', value: { API_KEY: 'SYNTHETIC_PROXY_DRAFT' } },
          },
        });
      expect(host.values.get(machineA)).toMatchObject({
        name: 'Proxy committed',
        env: { API_KEY: 'SYNTHETIC_PROXY_DRAFT' },
      });
      expect(JSON.stringify(source.getSnapshot())).not.toContain('SYNTHETIC_PROXY_DRAFT');
      const [lease] = host.leases.values();
      const before = source.getSnapshot();
      const message = {
        ...lease!.request,
        leaseId: lease!.leaseId,
        type: 'snapshot',
        snapshot: view(machineA, 'Forged'),
      };
      for (const foreign of [
        { ...message, registrationId: crypto.randomUUID() },
        { ...message, requestId: crypto.randomUUID() },
        { ...message, leaseId: crypto.randomUUID() },
      ])
        listeners.get('machineCatalog.event')!(foreign);
      expect(source.getSnapshot()).toBe(before);
      host.snapshots.set(machineA, view(machineA, 'Legitimate push'));
      host.emit(lease!.request);
      expect(source.getSnapshot().agents[0]?.name).toBe('Legitimate push');
      for (const wrong of [
        "Error invoking remote method 'localPlatform.beginAgentConfigEdit': Error: machine_catalog_access_denied",
        'machine_catalog_access_denied',
        "Error invoking remote method 'machineCatalog.execute': Error: machine_catalog_access_denied",
        "Error invoking remote method 'machineCatalog.beginAgentConfigEdit': ForeignError: machine_catalog_access_denied",
      ]) {
        fault = wrong;
        await expect(
          source.getSnapshot().editor(machineA).load(configId(machineA))
        ).rejects.toMatchObject({ code: 'operation_failed' });
        expect(source.getStatus(machineA)).toBe('ready');
      }
      fault =
        "Error invoking remote method 'machineCatalog.beginAgentConfigEdit': Error: machine_catalog_edit_conflict";
      await expect(
        source.getSnapshot().editor(machineA).load(configId(machineA))
      ).rejects.toMatchObject({ code: 'edit_conflict' });
      expect(source.getStatus(machineA)).toBe('ready');
      fault =
        "Error invoking remote method 'machineCatalog.beginAgentConfigEdit': MachineCatalogIpcError: machine_catalog_access_denied";
      await expect(
        source.getSnapshot().editor(machineA).load(configId(machineA))
      ).rejects.toMatchObject({ code: 'access_denied' });
      expect(source.getSnapshot().agents).toEqual([]);
      await source.reacquire(machineA);
      const confirmed = source.getSnapshot();
      fault =
        "Error invoking remote method 'machineCatalog.execute': MachineCatalogIpcError: machine_catalog_restart_required";
      await expect(
        source.getSnapshot().execute(machineA, { kind: 'clear-dot-lody-path' })
      ).rejects.toMatchObject({ code: 'restart_required' });
      expect(source.getStatus(machineA)).toBe('unavailable');
      expect(source.getSnapshot().agents).toEqual(confirmed.agents);
      expect(host.values.get(machineA)?.name).toBe('Proxy committed');
      await source.reacquire(machineA);
      await source.upload(machineA);
    } finally {
      await source.close();
      stop();
      if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
    expect(host.leases.size).toBe(0);
  });
});

it('binds public capabilities to the selected source snapshot and revokes old public proof after a reset or transport loss', async () => {
  const host = nativeMachineCatalogHarness([machineA]);
  const initial = view(machineA);
  const capability = {
    cliType: 'builtin' as const,
    agentType: 'claude',
    modes: [],
    models: [{ modelId: 'native-model', name: 'Native model' }],
    authority: 'authoritative' as const,
    canValidateRolePins: true,
  };
  host.snapshots.set(machineA, {
    ...initial,
    projection: {
      ...initial.projection,
      acp: [
        {
          configId: configId(machineA),
          cliType: 'builtin',
          agentType: 'claude',
          fetchedAt: 1,
          modes: [],
          models: [],
          optionIds: [],
          sessionFork: false,
          sessionTitle: false,
          acknowledgedSteer: false,
          publicCapability: capability,
          quotaEligibility: { subscription: false, query: true, resetForecast: false },
        },
      ],
    },
  });
  const source = host.source();
  await source.start();
  try {
    const runtime = {
      ownsNativeMachineCatalog: (id: typeof machineA) => id === machineA,
      nativeMachineCatalogSource: source,
    };
    const summary = source.getSnapshot().agents[0]!;
    const admitted = readNativeMachineCatalogPublicView(runtime, machineA);
    if (admitted.kind !== 'native') throw new Error('Expected native owner');
    expect(admitted.synced).toBe(true);
    expect(admitted.roleCapability(summary)?.models[0]?.modelId).toBe('native-model');
    expect(admitted.capability({ ...summary, machineId: machineB })).toBeUndefined();
    expect(admitted.quota(summary)?.subscription).toBe(false);
    const lease = [...host.leases.values()][0]!;
    const reset = {
      ...host.snapshots.get(machineA)!,
      projection: { ...initial.projection, acp: [] },
    };
    host.emit(lease.request, reset);
    expect(admitted.synced).toBe(false);
    expect(admitted.roleCapability(summary)).toBeUndefined();
    const fresh = readNativeMachineCatalogPublicView(runtime, machineA);
    expect(fresh.kind).toBe('native');
    host.send({
      ...lease.request,
      leaseId: lease.leaseId,
      type: 'error',
      code: 'restart_required',
    });
    const failed = readNativeMachineCatalogPublicView(runtime, machineA);
    expect(failed.kind).toBe('native');
    if (failed.kind === 'native') {
      expect(failed.synced).toBe(false);
      expect(failed.capability(summary)).toBeUndefined();
    }
  } finally {
    await source.close();
  }
});

it('publishes native project deletion intent and consumes only finite completion counts without reopening the legacy MF writer', async () => {
  const { requestLocalProjectRemoval } = await import('../src/hooks/use-remove-local-project');
  const { machineFlockKeys } = await import('@lody/shared');
  const group = await openNativeMachineCatalogTestGroup([machineA]);
  const projectId = 'native-removal' as import('@lody/shared').LocalProjectId;
  const room = group.rooms.get(machineA)!;
  const key = machineFlockKeys.deleteLocalProjectCommand(projectId);
  const waitFor = (predicate: () => boolean) => {
    const done = deferred<void>();
    const check = () => {
      if (predicate()) {
        off();
        done.resolve();
      }
    };
    const off = group.source.subscribe(check);
    check();
    return done.promise;
  };
  try {
    await group.client.flockBatch(group.namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.localProject(projectId),
        value: { id: projectId, name: 'Project', rootPath: '/synthetic/project', createdAtMs: 1 },
      },
    ]);
    await group.source.start();
    const retired = () => {
      throw new Error('Retired MF must not reopen');
    };
    const runtime = {
      ...binding,
      nativeMachineCatalogSource: group.source,
      ownsNativeMachineCatalog: () => true,
      repo: { openFlockDoc: retired },
      writer: { flockRowPut: retired, flockRowDelete: retired },
    } as never;
    const pending = waitFor(
      () =>
        group.source
          .readProjection(machineA)
          ?.projection.localProjectDeletions?.some(
            (value) => value.projectId === projectId && !value.completed
          ) === true
    );
    await requestLocalProjectRemoval(
      runtime,
      {
        machineId: machineA,
        localProjectId: projectId,
        projectName: 'Project',
        originalRootPath: '/synthetic/project',
      },
      'synthetic-user'
    );
    await pending;
    const saved = await group.client.flockGet(group.namespace, room, key);
    expect(saved.value).toMatchObject({
      requestedBy: 'synthetic-user',
      originalRootPath: '/synthetic/project',
      projectName: 'Project',
    });
    const completed = waitFor(
      () =>
        group.source
          .readProjection(machineA)
          ?.projection.localProjectDeletionResults.some(
            (value) => value.projectId === projectId
          ) === true
    );
    await group.client.flockBatch(group.namespace, room, [
      {
        op: 'put',
        key,
        value: {
          ...(saved.value as object),
          status: 'completed',
          cleanupResult: {
            completedAt: 123,
            deleted: [],
            skippedDirty: [],
            failed: [
              {
                sessionId: 'session',
                title: 'Synthetic',
                path: '/synthetic/worktree',
                message: 'SYNTHETIC_PRIVATE_CLEANUP_ERROR',
              },
            ],
          },
        },
      },
    ]);
    await completed;
    const projection = group.source.readProjection(machineA)!.projection;
    expect(projection.localProjectDeletionResults).toEqual([
      {
        projectId,
        projectName: 'Project',
        completedAt: 123,
        deletedCount: 0,
        skippedDirtyCount: 0,
        failedCount: 1,
      },
    ]);
    expect(JSON.stringify(projection)).not.toContain('SYNTHETIC_PRIVATE_CLEANUP_ERROR');
    await expect(
      group.source
        .getSnapshot()
        .execute(machineA, { kind: 'dismiss-local-project-deletion', projectId, completedAt: 122 })
    ).rejects.toMatchObject({ code: 'edit_conflict' });
    expect((await group.client.flockGet(group.namespace, room, key)).found).toBe(true);
    await group.source
      .getSnapshot()
      .execute(machineA, { kind: 'dismiss-local-project-deletion', projectId, completedAt: 123 });
    expect((await group.client.flockGet(group.namespace, room, key)).found).toBe(false);
  } finally {
    await group.close();
  }
});
