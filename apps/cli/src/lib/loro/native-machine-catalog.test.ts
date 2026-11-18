import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';
import { Effect, Scope, Exit } from 'effect';
import { LoroRepo } from 'loro-repo';
import { getLogger } from '../../utils/logger';
import { Flock } from '@loro-dev/flock-wasm';
import { readNativeFlockSnapshot } from './native-repo-migration';
import { ProviderSetupManager, type ProviderSetupManagerOptions } from '../provider-setup-manager';
import { MessageHandler } from '../message-handler';
import { LoroDocumentManager } from './doc';
import { resolveSessionLaunchConfig } from '../../session/session-launch-config-resolver';
import {
  readMachineAgentConfigs,
  readMergedAgentConfigById,
  listMergedAgentConfigs,
  upsertMachineAgentConfig,
} from '../agent-config-machine-flock';
import { readMachineLocalProjects, upsertMachineLocalProject } from '../local-project-meta';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { getAcpCapabilitySourceVersion } from '../../agent/setting';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startEngine } from '@loro-dev/loro-repo-engine';
import { connectEngine } from '@loro-dev/loro-repo-client/node';
import { type RepoClient } from '@loro-dev/loro-repo-client';
import {
  getMachineFlockDocId,
  ACP_CAPABILITY_CACHE_VERSION,
  machineFlockKeys,
  type MachineCatalogBinding,
  type AgentConfigMeta,
  type AgentConfigId,
  type SessionId,
  type ProviderSetupTask,
} from '@lody/shared';
import {
  createNativeMachineCatalog,
  createNativeProviderSetupStorage,
  createNativeMachineExecutionPort,
  createNativeMachineRuntimePorts,
  createNativeMachineLaunchData,
  createNativeMachineRuntimeCatalog,
  createNativeMachineAgentConfigReadPort,
  makeNativeMachineCatalog,
  makeNativeMachineRuntimeCatalog,
  type NativeMachineCatalogOptions,
  type NativeMachineCommandWork,
} from './native-machine-catalog';

const binding = {
  accountId: 'synthetic-owner',
  workspaceId: 'synthetic-workspace',
  machineId: 'synthetic-machine',
} as MachineCatalogBinding;
const namespace = 'native-machine-catalog';
const room = {
  kind: 'flock' as const,
  id: getMachineFlockDocId(binding.workspaceId, binding.machineId),
};
const configId = 'synthetic-agent' as AgentConfigId;
const original = (): AgentConfigMeta => ({
  id: configId,
  machineId: binding.machineId,
  name: 'Synthetic agent',
  description: 'Synthetic description',
  cliType: 'builtin',
  agentType: 'claude',
  env: { API_KEY: 'SYNTHETIC_SAVED_SECRET', RETAIN: 'unchanged' },
  prompt: 'Synthetic prompt',
});
const pending = (): ProviderSetupTask => ({
  v: 1,
  id: 'pending-agent' as AgentConfigId,
  machineId: binding.machineId,
  config: { ...original(), id: 'pending-agent' as AgentConfigId },
  status: 'queued',
  attempt: 1,
  createdAt: 1,
  updatedAt: 1,
});
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe('native whole-machine catalog', () => {
  let directory: string, client: RepoClient, rival: RepoClient;
  let engine: ReturnType<typeof startEngine>;
  let epoch: string, synced: boolean, allowed: boolean, clock: number;
  const authorityListeners = new Set<() => void>();
  const resources: { close(): void | Promise<void>; cleanup?(): Promise<void> }[] = [];
  const notify = () => {
    for (const listener of [...authorityListeners]) listener();
  };
  const options = (
    extra: Partial<NativeMachineCatalogOptions> = {}
  ): NativeMachineCatalogOptions => ({
    client,
    namespace,
    writer: 'owner:test',
    binding,
    authorize: () => allowed,
    now: () => clock,
    authority: {
      current: () => (allowed ? { epoch, synced } : undefined),
      subscribe(listener) {
        authorityListeners.add(listener);
        return () => authorityListeners.delete(listener);
      },
    },
    ...extra,
  });
  const catalog = (extra: Partial<NativeMachineCatalogOptions> = {}) => {
    const value = createNativeMachineCatalog(options(extra));
    resources.push(value);
    return value;
  };
  const runtime = () => {
    const value = createNativeMachineRuntimeCatalog(options());
    resources.push(value);
    return value;
  };
  const rawConfig = async () =>
    (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(configId)))
      .value as unknown as AgentConfigMeta & { future: unknown };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'lody-native-machine-'));
    engine = startEngine({ dataDir: directory });
    client = await connectEngine(directory, { autoReconnect: false });
    rival = await connectEngine(directory, { autoReconnect: false });
    epoch = 'generation-a';
    synced = true;
    allowed = true;
    clock = 1000;
    await client.createRoom(namespace, room, 'plaintext');
    await client.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.agentConfig(configId),
        value: {
          ...original(),
          future: { opaque: 'retained', bytes: Uint8Array.of(1, 2), integer: 12345 },
        } as never,
      },
      { op: 'put', key: machineFlockKeys.providerSetup(pending().id), value: pending() as never },
      {
        op: 'put',
        key: machineFlockKeys.sessionLaunchConfig('old-session' as SessionId),
        value: {
          cliType: 'builtin',
          agentType: 'claude',
          env: { OLD_KEY: 'SYNTHETIC_LEGACY_SECRET' },
        },
      },
      { op: 'put', key: ['future-family', 'opaque'], value: { retained: true } },
      {
        op: 'put',
        key: machineFlockKeys.acpCapability(configId),
        value: {
          cliType: 'builtin',
          agentType: 'claude',
          fetchedAt: 1,
          modes: [],
          models: [],
          env: { API_KEY: 'SYNTHETIC_CACHE_SECRET' },
        },
      },
    ]);
  });
  afterEach(async () => {
    await Promise.all(
      resources.splice(0).map((value) => (value.cleanup ? value.cleanup() : value.close()))
    );
    authorityListeners.clear();
    await Promise.all([client.close(), rival.close()]);
    engine.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('bundles and loads the shared owner from the Electron main boundary without the legacy WASM repository', async () => {
    const result = await build({
      stdin: {
        contents:
          "export { createNativeMachineCatalog } from '@lody/shared/node/native-machine-catalog'",
        resolveDir: fileURLToPath(new URL('../../../../electron/', import.meta.url)),
      },
      bundle: true,
      platform: 'node',
      format: 'esm',
      write: false,
      metafile: true,
      logLevel: 'silent',
    });
    expect(
      Object.keys(result.metafile!.inputs).filter((path) =>
        /loro-mirror|loro-crdt|flock-wasm|apps\/cli|\.wasm$/.test(path)
      )
    ).toEqual([]);
    const loaded = await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles![0]!.text).toString('base64')}`
    );
    expect(typeof loaded.createNativeMachineCatalog).toBe('function');
  });

  it('withholds private runtime provenance from public snapshots, editors and observations while retaining trusted runtime reads', async () => {
    const sourceVersion = getAcpCapabilitySourceVersion({
      cliType: 'builtin',
      agentType: 'claude',
      runtimeOverrides: { claudeCodeExecutable: '/synthetic/PRIVATE_EXECUTABLE' },
    });
    const modelSourceVersion = getAcpCapabilitySourceVersion({
      cliType: 'custom',
      agentType: 'custom',
      customAcp: { command: '/synthetic/PRIVATE_EXECUTABLE', args: ['SYNTHETIC_PRIVATE_ARGUMENT'] },
    });
    expect(sourceVersion).toContain('PRIVATE_EXECUTABLE');
    expect(modelSourceVersion).toContain('SYNTHETIC_PRIVATE_ARGUMENT');
    await client.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.acpCapability(configId),
        value: {
          cliType: 'custom',
          agentType: 'custom',
          fetchedAt: 1,
          modes: [],
          models: [],
          sourceVersion,
        },
      },
      {
        op: 'put',
        key: machineFlockKeys.acpModelCapability(configId),
        value: {
          version: 1,
          models: { model: { fastMode: true } },
          sourceVersion: modelSourceVersion,
        },
      },
    ]);
    const value = catalog(),
      frames: unknown[] = [];
    const observation = await value.observe(
      binding,
      (update) => frames.push(update),
      (error) => {
        throw error;
      }
    );
    const outward = JSON.stringify([
      await value.read(binding),
      await value.beginAgentConfigEdit(binding, configId),
      frames,
    ]);
    expect(outward).not.toContain('sourceVersion');
    expect(outward).not.toContain('PRIVATE_EXECUTABLE');
    expect(outward).not.toContain('SYNTHETIC_PRIVATE');
    const trusted = await runtime().readCatalog(binding);
    expect(trusted.capabilities[configId]?.sourceVersion).toBe(sourceVersion);
    expect(
      trusted.modelCapabilities.find((row) => row.configId === configId)?.entry.sourceVersion
    ).toBe(modelSourceVersion);
    await observation.close();
  });

  it('retains a lost unsubscribe acknowledgement while connected instead of accepting the SDK local no-op as release proof', async () => {
    const subscribe = client.flockSubscribe.bind(client);
    vi.spyOn(client, 'flockSubscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args),
        release = handle.unsubscribe.bind(handle);
      handle.unsubscribe = async () => {
        await release();
        throw new Error('Synthetic unsubscribe acknowledgement lost');
      };
      return handle;
    });
    const value = createNativeMachineCatalog(options());
    await value.observe(
      binding,
      () => {},
      (error) => {
        throw error;
      }
    );
    await expect(value.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    await expect(value.retryCleanup()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    expect(client.connectionState).toBe('connected');
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).value
    ).toMatchObject({ id: configId });
    await client.close();
    await value.retryCleanup();
    expect(
      (await rival.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).value
    ).toMatchObject({ id: configId });
  });

  it('joins an unconfirmed observer release in the Effect finalizer instead of reporting a successful scope close', async () => {
    const subscribe = client.flockSubscribe.bind(client);
    vi.spyOn(client, 'flockSubscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args),
        release = handle.unsubscribe.bind(handle);
      handle.unsubscribe = async () => {
        await release();
        throw new Error('Synthetic scope unsubscribe ACK lost');
      };
      return handle;
    });
    const scope = Effect.runSync(Scope.make());
    const value = await Effect.runPromise(
      Scope.provide(makeNativeMachineCatalog(options()), scope)
    );
    await value.observe(
      binding,
      () => {},
      (error) => {
        throw error;
      }
    );
    const exit = await Effect.runPromiseExit(Scope.close(scope, Exit.void));
    expect(Exit.isFailure(exit)).toBe(true);
    await expect(value.read(binding)).rejects.toMatchObject({ code: 'access_denied' });
    expect(
      (await rival.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).found
    ).toBe(true);
    await client.close();
    await value.retryCleanup();
  });

  it('bounds close without discarding the actual pending unsubscribe, then joins its late acknowledgement', async () => {
    let releaseAck!: () => void;
    const ack = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const subscribe = client.flockSubscribe.bind(client);
    vi.spyOn(client, 'flockSubscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args),
        release = handle.unsubscribe.bind(handle);
      handle.unsubscribe = async () => {
        await release();
        await ack;
      };
      return handle;
    });
    const value = createNativeMachineCatalog(options({ cleanupTimeoutMs: 1000 }));
    await value.observe(
      binding,
      () => {},
      (error) => {
        throw error;
      }
    );
    vi.useFakeTimers();
    try {
      const closed = expect(value.close()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
      await vi.advanceTimersByTimeAsync(1000);
      await closed;
    } finally {
      vi.useRealTimers();
    }
    expect(client.connectionState).toBe('connected');
    releaseAck();
    await value.retryCleanup();
    expect(
      (await rival.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).found
    ).toBe(true);
  });

  it('never returns saved credentials from summaries, editor context or live public projection; trusted launch is separately gated', async () => {
    const value = catalog(),
      frames: unknown[] = [];
    const summary = await value.read(binding),
      editor = await value.beginAgentConfigEdit(binding, configId);
    const observation = await value.observe(
      binding,
      (frame) => frames.push(frame),
      (error) => {
        throw error;
      }
    );
    expect(summary.agents).toMatchObject([{ id: configId, name: 'Synthetic agent' }]);
    expect(editor.credentials.envPresent).toBe(true);
    const outward = JSON.stringify([summary, editor, frames]);
    expect(outward).not.toContain('SYNTHETIC_SAVED_SECRET');
    expect(outward).not.toContain('SYNTHETIC_LEGACY_SECRET');
    expect(outward).not.toContain('API_KEY');
    expect(outward).not.toContain('SYNTHETIC_CACHE_SECRET');
    expect(outward).not.toContain('future');
    observation.close();
    const launch = createNativeMachineLaunchData(options());
    expect((await launch.readAgentConfig(binding, configId))?.config.env.API_KEY).toBe(
      'SYNTHETIC_SAVED_SECRET'
    );
    const denied = createNativeMachineLaunchData(
      options({ authorize: (operation) => operation !== 'launch' })
    );
    await expect(denied.readAgentConfig(binding, configId)).rejects.toMatchObject({
      code: 'access_denied',
    });
    await expect(
      value.read({ ...binding, machineId: 'other-machine' as never })
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('keeps saved credentials and opaque binary/integer extensions on rename, then applies verified per-key replacement/clear without secret echo', async () => {
    const value = catalog({ verifyAgentChange: async () => true });
    const initialOpaque = (await rawConfig()).future;
    expect(initialOpaque).toMatchObject({ integer: 12345 });
    let editor = await value.beginAgentConfigEdit(binding, configId);
    await value.execute(binding, {
      kind: 'edit-agent',
      id: configId,
      editToken: editor.editToken,
      changes: { name: 'Renamed', env: { kind: 'keep' } },
    });
    expect(await rawConfig()).toMatchObject({
      name: 'Renamed',
      env: original().env,
      future: { bytes: Uint8Array.of(1, 2), integer: 12345 },
    });
    editor = await value.beginAgentConfigEdit(binding, configId);
    await value.execute(binding, {
      kind: 'edit-agent',
      id: configId,
      editToken: editor.editToken,
      changes: {
        envEntries: [
          { name: 'API_KEY', value: { kind: 'replace', value: 'SYNTHETIC_NEW_SECRET' } },
          { name: 'RETAIN', value: { kind: 'clear' } },
        ],
      },
    });
    expect((await rawConfig()).env).toEqual({ API_KEY: 'SYNTHETIC_NEW_SECRET' });
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.acpCapability(configId))).found
    ).toBe(false);
    expect(JSON.stringify(await value.read(binding))).not.toContain('SYNTHETIC_NEW_SECRET');
    editor = await value.beginAgentConfigEdit(binding, configId);
    await value.execute(binding, {
      kind: 'edit-agent',
      id: configId,
      editToken: editor.editToken,
      changes: { env: { kind: 'clear' }, prompt: { kind: 'clear' } },
    });
    expect((await rawConfig()).env).toEqual({});
    expect((await rawConfig()).prompt).toBeUndefined();
    expect((await client.flockGet(namespace, room, ['future-family', 'opaque'])).value).toEqual({
      retained: true,
    });
  });

  it('requires trusted credential verification, rejects stale row edits, and permits unrelated whole-mf CAS races', async () => {
    const noProbe = catalog(),
      editor = await noProbe.beginAgentConfigEdit(binding, configId);
    await expect(
      noProbe.execute(binding, {
        kind: 'edit-agent',
        id: configId,
        editToken: editor.editToken,
        changes: { env: { kind: 'clear' } },
      })
    ).rejects.toMatchObject({ code: 'verification_required' });
    expect((await rawConfig()).env).toEqual(original().env);
    await rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.agentConfig(configId),
        value: { ...original(), name: 'Peer changed' } as never,
      },
    ]);
    await expect(
      noProbe.execute(binding, {
        kind: 'edit-agent',
        id: configId,
        editToken: editor.editToken,
        changes: { name: 'Stale rename' },
      })
    ).rejects.toMatchObject({ code: 'edit_conflict' });
    let raced = false;
    const proxied = new Proxy(client, {
      get(target, key) {
        if (key === 'flockBatch')
          return async (...args: Parameters<RepoClient['flockBatch']>) => {
            if (!raced) {
              raced = true;
              await rival.flockBatch(namespace, room, [
                { op: 'put', key: machineFlockKeys.dotlodyPath(), value: '/synthetic/peer' },
              ]);
            }
            return target.flockBatch(...args);
          };
        const member = Reflect.get(target, key);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const value = catalog({ client: proxied }),
      fresh = await value.beginAgentConfigEdit(binding, configId);
    await value.execute(binding, {
      kind: 'edit-agent',
      id: configId,
      editToken: fresh.editToken,
      changes: { name: 'Fresh rename' },
    });
    expect((await rawConfig()).name).toBe('Fresh rename');
    expect((await value.read(binding)).dotlodyPath).toBe('/synthetic/peer');
  });

  it('cancels an in-flight trusted verification on authority change and rejects expired edit contexts without writing', async () => {
    const entered = deferred<AbortSignal>(),
      finish = deferred<boolean>();
    const value = catalog({
      verifyAgentChange: async (_before, _after, signal) => {
        entered.resolve(signal);
        return finish.promise;
      },
      editTtlMs: 5,
    });
    const editor = await value.beginAgentConfigEdit(binding, configId);
    const write = value.execute(binding, {
      kind: 'edit-agent',
      id: configId,
      editToken: editor.editToken,
      changes: { env: { kind: 'clear' } },
    });
    const signal = await entered.promise;
    epoch = 'generation-b';
    notify();
    expect(signal.aborted).toBe(true);
    finish.resolve(true);
    await expect(write).rejects.toMatchObject({ code: 'access_denied' });
    expect((await rawConfig()).env).toEqual(original().env);
    const fresh = await value.beginAgentConfigEdit(binding, configId);
    clock += 5;
    await expect(
      value.execute(binding, {
        kind: 'edit-agent',
        id: configId,
        editToken: fresh.editToken,
        changes: { name: 'Expired' },
      })
    ).rejects.toMatchObject({ code: 'edit_expired' });
  });

  it('rescans durable work on initial authority and rejoin, aborts stale work, retains receipts across unrelated rows, and guards completion', async () => {
    const value = catalog(),
      consumer = runtime();
    await value.execute(binding, {
      kind: 'archive-session',
      sessionId: 'archive-me' as SessionId,
      command: { v: 1, requestedAt: 1 },
    });
    synced = false;
    const initial = deferred<{ work: readonly NativeMachineCommandWork[]; signal: AbortSignal }>();
    const rejoined = deferred<{ work: readonly NativeMachineCommandWork[]; signal: AbortSignal }>();
    let frames = 0;
    const observation = await consumer.observeCommands(
      binding,
      (work, context) => {
        frames++;
        if (context.epoch === 'generation-a') initial.resolve({ work, signal: context.signal });
        else rejoined.resolve({ work, signal: context.signal });
      },
      (error) => {
        throw error;
      }
    );
    expect(frames).toBe(0);
    synced = true;
    notify();
    const first = await initial.promise;
    const archive = first.work.find((entry) => entry.command.key[0] === 'cmd')!;
    expect(archive.command).toMatchObject({ key: ['cmd', 'archiveSession', 'archive-me'] });
    await value.execute(binding, { kind: 'set-dot-lody-path', path: '/synthetic/new' });
    await consumer.execute(binding, { kind: 'complete-command', receipt: archive.receipt });
    expect(
      (await client.flockGet(namespace, room, ['cmd', 'archiveSession', 'archive-me'])).found
    ).toBe(false);
    synced = false;
    notify();
    expect(first.signal.aborted).toBe(true);
    await value.execute(binding, {
      kind: 'delete-session',
      sessionId: 'offline-command' as SessionId,
      command: { v: 1, requestedAt: 2 },
    });
    epoch = 'generation-b';
    synced = true;
    notify();
    const second = await rejoined.promise;
    expect(second.signal.aborted).toBe(false);
    expect(second.work).toContainEqual(
      expect.objectContaining({
        command: expect.objectContaining({ key: ['cmd', 'deleteSession', 'offline-command'] }),
      })
    );
    await expect(
      consumer.execute(binding, { kind: 'complete-command', receipt: archive.receipt })
    ).rejects.toMatchObject({ code: 'edit_expired' });
    const deletion = second.work.find((entry) => entry.command.key[0] === 'cmd')!;
    await rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key: ['cmd', 'deleteSession', 'offline-command'],
        value: { v: 1, requestedAt: 3 },
      },
    ]);
    const failure = await consumer
      .execute(binding, { kind: 'complete-command', receipt: deletion.receipt })
      .catch((error) => error);
    expect(['edit_conflict', 'edit_expired']).toContain(failure.code);
    expect(
      (await client.flockGet(namespace, room, ['cmd', 'deleteSession', 'offline-command'])).value
    ).toMatchObject({ requestedAt: 3 });
    observation.close();
    expect(second.signal.aborted).toBe(true);
  });
  it('requires compatibility proof before rewriting opaque integers and preserves exact values when proven', async () => {
    await rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.agentConfig(configId),
        value: { ...original(), futureInteger: 9007199254740993n } as never,
      },
    ]);
    const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
    // Official 0.1.0 is a negative control; the local joint artifact must read
    // exactly, while an adapter lacking its trusted proof still refuses writes.
    const before = await client.flockGet(namespace, room, machineFlockKeys.agentConfig(configId));
    expect((before.value as Record<string, unknown>).futureInteger).toBe(
      proof ? 9007199254740993n : 9007199254740992n
    );
    const value = catalog(),
      editor = await value.beginAgentConfigEdit(binding, configId);
    await expect(
      value.execute(binding, {
        kind: 'edit-agent',
        id: configId,
        editToken: editor.editToken,
        changes: { name: 'Must not write' },
      })
    ).rejects.toMatchObject({ code: 'invalid_edit' });
    const after = await client.flockGet(namespace, room, machineFlockKeys.agentConfig(configId));
    expect(after.roomTxId).toBe(before.roomTxId);
    if (proof) {
      const verified = catalog({ losslessWireI64: true });
      const edit = await verified.beginAgentConfigEdit(binding, configId);
      await verified.execute(binding, {
        kind: 'edit-agent',
        id: configId,
        editToken: edit.editToken,
        changes: { name: 'Proof-authorized change' },
      });
      expect(
        (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).value
      ).toMatchObject({ name: 'Proof-authorized change', futureInteger: 9007199254740993n });
    }

    expect(after.value).toEqual(before.value);
  });

  it('keeps provider cancellation authoritative over late publication and runtime setup updates', async () => {
    const value = catalog(),
      consumer = runtime();
    const ready = deferred<readonly NativeMachineCommandWork[]>();
    const observation = await consumer.observeCommands(
      binding,
      (work) => ready.resolve(work),
      (error) => {
        throw error;
      }
    );
    const first = await ready.promise;
    const work = first.find((entry) => entry.command.key[0] === 'providerSetup')!;
    await value.execute(binding, {
      kind: 'cancel-provider-setup',
      cancellation: { v: 1, id: pending().id, machineId: binding.machineId, cancelledAt: 2 },
    });
    await expect(
      consumer.execute(binding, { kind: 'publish-agent', config: pending().config })
    ).rejects.toMatchObject({ code: 'edit_conflict' });
    const failure = await consumer
      .execute(binding, {
        kind: 'update-provider-setup',
        receipt: work.receipt,
        status: 'verifying',
        attempt: 1,
        updatedAt: 3,
      })
      .catch((error) => error);
    expect(['edit_expired', 'edit_conflict']).toContain(failure.code);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.providerSetup(pending().id))).found
    ).toBe(false);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(pending().id))).found
    ).toBe(false);
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.providerSetupCancellation(pending().id)
        )
      ).found
    ).toBe(true);
    observation.close();
  });

  it('feeds existing CLI Agent config readers through the selected private port without reviving legacy metadata', async () => {
    const port = createNativeMachineAgentConfigReadPort(options());
    const retired = new Proxy(
      {},
      {
        get() {
          throw new Error('Retired legacy Repo must not be opened');
        },
      }
    ) as never;
    const configs = await readMachineAgentConfigs(
      retired,
      binding.workspaceId,
      binding.machineId,
      port
    );
    expect(configs[configId].env.API_KEY).toBe('SYNTHETIC_SAVED_SECRET');
    expect(
      await readMergedAgentConfigById(
        retired,
        binding.workspaceId,
        binding.machineId,
        configId,
        port
      )
    ).toMatchObject({ source: 'machine-flock', config: { id: configId } });
    expect(
      await readMergedAgentConfigById(
        retired,
        binding.workspaceId,
        binding.machineId,
        'absent' as AgentConfigId,
        port
      )
    ).toEqual({ source: 'none', config: null });
    await expect(
      readMachineAgentConfigs(retired, binding.workspaceId, 'other' as never, port)
    ).rejects.toThrow('source binding mismatch');
  });

  it('compares legacy binary and native raw snapshots against the actual SDK artifact integer precision', async () => {
    const key = ['integer-probe'];
    const large = 9007199254740993n;
    const legacy = new Flock();
    // The legacy JS facade deliberately normalizes unsafe bigints to null.
    // Seed the underlying published WASM binding to create a valid Rust i64
    // fixture, then use the ordinary old exportFile binary path.
    (
      legacy as unknown as { inner: { put(key: string[], value: unknown, now: number): void } }
    ).inner.put(key, { integer: large }, 1);
    const rawInteger = (flock: Flock) => {
      try {
        return flock.get(key);
      } catch (error) {
        return String(error);
      }
    };
    expect(rawInteger(legacy)).toContain("9007199254740993 can't be represented");
    const importedRoom = { kind: 'flock' as const, id: 'integer-import-probe' };
    const putRoom = { kind: 'flock' as const, id: 'integer-put-probe' };
    await client.createRoom(namespace, importedRoom, 'plaintext');
    await client.createRoom(namespace, putRoom, 'plaintext');
    await client.importRoomState(namespace, importedRoom, {
      snapshot: legacy.exportFile(),
      enqueueOutbox: false,
    });
    await client.compactRoom(namespace, importedRoom);
    const importedRaw = Flock.strictFromFile(
      readNativeFlockSnapshot({ dataDir: directory, namespace, room: importedRoom }).bytes
    );
    const importedRpc = (await client.flockGet(namespace, importedRoom, key)).value;
    await client.flockBatch(namespace, putRoom, [{ op: 'put', key, value: { integer: large } }]);
    await client.compactRoom(namespace, putRoom);
    const putRaw = Flock.strictFromFile(
      readNativeFlockSnapshot({ dataDir: directory, namespace, room: putRoom }).bytes
    );
    const putRpc = (await client.flockGet(namespace, putRoom, key)).value;
    expect(rawInteger(importedRaw)).toContain("9007199254740993 can't be represented");
    const proof = await loadNativeRepoSdkCompatibility(import.meta.url);
    const expected = proof ? large : 9007199254740992n;
    expect(importedRpc).toEqual({ integer: expected });
    expect(rawInteger(putRaw)).toContain(`${expected} can't be represented`);
    expect(putRpc).toEqual({ integer: expected });
  });

  it('projects public choices with Node-verified private override identity and quota eligibility without exposing saved credentials', async () => {
    const privateConfig = {
      ...original(),
      runtimeOverrides: { claudeCodeExecutable: '/synthetic/PRIVATE_EXECUTABLE' },
      env: { ANTHROPIC_API_KEY: 'SYNTHETIC_SAVED_SECRET' },
    };
    const sourceVersion = getAcpCapabilitySourceVersion(privateConfig);
    const entry = {
      cliType: 'builtin',
      agentType: 'claude',
      cacheVersion: ACP_CAPABILITY_CACHE_VERSION,
      provenance: 'runtime',
      sourceVersion,
      fetchedAt: 1,
      modes: [{ id: 'safe', name: 'Safe' }],
      models: [
        {
          modelId: 'native-model',
          name: 'Native model',
          _meta: { secret: 'SYNTHETIC_SAVED_SECRET' },
        },
      ],
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'native-model',
          options: [{ value: 'native-model', name: 'Native model' }],
        },
        {
          id: 'api_key',
          name: 'Credential',
          type: 'select',
          currentValue: 'SYNTHETIC_SAVED_SECRET',
          options: [{ value: 'SYNTHETIC_SAVED_SECRET', name: 'Private' }],
        },
      ],
      availableCommands: [{ name: 'public-command', description: 'Synthetic command' }],
      sessionFork: true,
      goalActions: ['set', 'pause', 'resume', 'clear'],
      rateLimits: { version: 1, query: true },
      opaque: { sourceVersion, env: privateConfig.env },
    };
    await client.flockBatch(namespace, room, [
      { op: 'put', key: machineFlockKeys.agentConfig(configId), value: privateConfig as never },
      { op: 'put', key: machineFlockKeys.acpCapability(configId), value: entry as never },
    ]);
    const value = catalog();
    const projection = await value.read(binding);
    const capability = projection.acp.find((row) => row.configId === configId);
    expect(capability?.publicCapability).toMatchObject({
      authority: 'authoritative',
      canValidateRolePins: true,
      sessionFork: true,
      goalActions: ['set', 'pause', 'resume', 'clear'],
      availableCommands: [{ name: 'public-command' }],
    });
    expect(capability?.publicCapability?.configOptions?.map((option) => option.id)).toEqual([
      'model',
    ]);
    expect(capability?.publicCapability?.optionCoverage).toEqual({
      complete: false,
      withheldOptionIds: ['api_key'],
    });
    expect(capability?.quotaEligibility).toMatchObject({ subscription: false, query: true });
    expect(JSON.stringify(projection)).not.toContain('PRIVATE_EXECUTABLE');
    expect(JSON.stringify(projection)).not.toContain('SYNTHETIC_SAVED_SECRET');
    expect(JSON.stringify(projection)).not.toContain('sourceVersion');
    await client.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.acpCapability(configId),
        value: { ...entry, sourceVersion: 'different-private-launch' } as never,
      },
    ]);
    const mismatched = (await value.read(binding)).acp.find((row) => row.configId === configId);
    expect(mismatched?.publicCapability).toBeUndefined();
    expect(mismatched?.quotaEligibility?.subscription).toBe(false);
    expect((await rawConfig()).env).toEqual(privateConfig.env);
    await client.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.agentConfig(configId),
        value: { ...privateConfig, env: {} } as never,
      },
      { op: 'put', key: machineFlockKeys.acpCapability(configId), value: entry as never },
      {
        op: 'put',
        key: machineFlockKeys.rateLimit(configId, 'claude', 'account-quota'),
        value: {
          limitId: 'account-quota',
          scope: { providerId: 'claude', accountId: 'SYNTHETIC_ACCOUNT_SECRET' },
          windows: [
            {
              usedPercent: 25,
              windowDurationSeconds: 18000,
              resetsAtEpochSeconds: 50,
              opaqueCredential: 'SYNTHETIC_QUOTA_SECRET',
            },
          ],
        } as never,
      },
    ]);
    const quotaView = await value.read(binding);
    expect(
      quotaView.acp.find((row) => row.configId === configId)?.quotaEligibility?.subscription
    ).toBe(true);
    expect(
      quotaView.quotas.find((row) => row.limitId === 'account-quota')?.snapshot?.windows
    ).toEqual([{ usedPercent: 25, windowDurationSeconds: 18000, resetsAtEpochSeconds: 50 }]);
    expect(JSON.stringify(quotaView)).not.toContain('SYNTHETIC_ACCOUNT_SECRET');
    expect(JSON.stringify(quotaView)).not.toContain('SYNTHETIC_QUOTA_SECRET');
  });

  it('links without overwriting concurrent memory edits and returns the exact CAS association while preserving stored future fields', async () => {
    const association = {
      machineId: binding.machineId,
      providerId: 'memory-provider',
      memoryId: 'reviewer',
      name: 'Reviewer',
    };
    const key = machineFlockKeys.memory(association.providerId, association.memoryId);
    const value = catalog();
    await expect(
      value.execute(binding, { kind: 'edit-memory', association })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await value.execute(binding, { kind: 'link-memory', association })).toEqual({
      changed: true,
      association,
    });
    await rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key,
        value: {
          ...association,
          name: 'Peer edit',
          future: { opaque: 'SYNTHETIC_MEMORY_PRIVATE_EXTENSION', bytes: Uint8Array.of(1, 2) },
        },
      },
    ]);
    const duplicate = await value.execute(binding, { kind: 'link-memory', association });
    expect(duplicate).toEqual({
      changed: false,
      association: { ...association, name: 'Peer edit' },
    });
    expect(JSON.stringify(duplicate)).not.toContain('SYNTHETIC_MEMORY_PRIVATE_EXTENSION');
    let raced = false;
    const competing = new Proxy(client, {
      get(target, field) {
        if (field === 'flockBatch')
          return async (...args: Parameters<RepoClient['flockBatch']>) => {
            if (!raced) {
              raced = true;
              await rival.flockBatch(namespace, room, [
                {
                  op: 'put',
                  key,
                  value: {
                    ...association,
                    name: 'Concurrent peer',
                    future: {
                      opaque: 'SYNTHETIC_NEW_MEMORY_EXTENSION',
                      bytes: Uint8Array.of(3, 4),
                    },
                  },
                },
              ]);
            }
            return target.flockBatch(...args);
          };
        const member = Reflect.get(target, field);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const edited = await catalog({ client: competing }).execute(binding, {
      kind: 'edit-memory',
      association: { ...association, name: 'Updated', description: 'Updated description' },
    });
    expect(edited).toEqual({
      changed: true,
      association: { ...association, name: 'Updated', description: 'Updated description' },
    });
    expect((await client.flockGet(namespace, room, key)).value).toMatchObject({
      name: 'Updated',
      future: { opaque: 'SYNTHETIC_NEW_MEMORY_EXTENSION', bytes: Uint8Array.of(3, 4) },
    });
    expect((await value.read(binding)).memories).toEqual([edited.association]);
    await value.execute(binding, {
      kind: 'remove-memory',
      providerId: association.providerId,
      memoryId: association.memoryId,
    });
    await expect(
      value.execute(binding, { kind: 'edit-memory', association })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      value.execute(binding, {
        kind: 'link-memory',
        association: { ...association, machineId: 'foreign-machine' },
      })
    ).rejects.toMatchObject({ code: 'invalid_edit' });
    expect((await value.read(binding)).memories).toEqual([]);
  });

  it('ensures local project identity without replacing an existing row and applies narrow edits against the latest native CAS state', async () => {
    const value = catalog();
    const project = {
      id: 'project-registration' as never,
      name: 'Project',
      rootPath: '/synthetic/project',
      createdAtMs: 1,
      standaloneVisible: false,
    };
    const key = machineFlockKeys.localProject(project.id);
    await expect(
      value.execute(binding, {
        kind: 'edit-local-project',
        id: project.id,
        changes: { standaloneVisible: true },
      })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await value.execute(binding, { kind: 'ensure-local-project', project })).toEqual({
      changed: true,
      project,
    });
    await rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key,
        value: {
          ...project,
          name: 'Peer project',
          history: { futureProvider: { opaque: 'SYNTHETIC_PRIVATE_HISTORY' } },
          future: { integer: 42, bytes: Uint8Array.of(1, 2) },
        },
      },
    ]);
    expect(
      await value.execute(binding, {
        kind: 'ensure-local-project',
        project: { ...project, name: 'Must not overwrite', rootPath: '/different/path' },
      })
    ).toEqual({ changed: false, project: { ...project, name: 'Peer project' } });
    let raced = false;
    const competing = new Proxy(client, {
      get(target, field) {
        if (field === 'flockBatch')
          return async (...args: Parameters<RepoClient['flockBatch']>) => {
            if (!raced) {
              raced = true;
              await rival.flockBatch(namespace, room, [
                {
                  op: 'put',
                  key,
                  value: {
                    ...project,
                    name: 'Newest peer',
                    history: { futureProvider: { opaque: 'SYNTHETIC_NEW_PRIVATE_HISTORY' } },
                    future: { integer: 43, bytes: Uint8Array.of(3, 4) },
                  },
                },
              ]);
            }
            return target.flockBatch(...args);
          };
        const member = Reflect.get(target, field);
        return typeof member === 'function' ? member.bind(target) : member;
      },
    });
    const changed = await catalog({ client: competing }).execute(binding, {
      kind: 'edit-local-project',
      id: project.id,
      changes: {
        standaloneVisible: true,
        githubRepoFullName: { kind: 'set', value: 'owner/repo' },
      },
    });
    expect(changed).toEqual({
      changed: true,
      project: {
        ...project,
        name: 'Newest peer',
        standaloneVisible: true,
        githubRepoFullName: 'owner/repo',
      },
    });
    expect(JSON.stringify(changed)).not.toContain('PRIVATE_HISTORY');
    expect((await client.flockGet(namespace, room, key)).value).toMatchObject({
      history: { futureProvider: { opaque: 'SYNTHETIC_NEW_PRIVATE_HISTORY' } },
      future: { integer: 43, bytes: Uint8Array.of(3, 4) },
    });
    expect(
      (
        await value.execute(binding, {
          kind: 'edit-local-project',
          id: project.id,
          changes: { standaloneVisible: true },
        })
      ).changed
    ).toBe(false);
    const cleared = await value.execute(binding, {
      kind: 'edit-local-project',
      id: project.id,
      changes: { githubRepoFullName: { kind: 'clear' } },
    });
    expect(cleared.project).not.toHaveProperty('githubRepoFullName');
    expect((await client.flockGet(namespace, room, key)).value).toMatchObject({
      name: 'Newest peer',
      standaloneVisible: true,
      future: { integer: 43 },
    });
  });

  it('invalidates only the exact provider and imported Session reference without exposing or rewriting private history catalogs', async () => {
    const { getLocalProjectHistoryCatalogKey, planLocalProjectHistoryInvalidation } =
      await import('@lody/shared');
    const value = catalog();
    const projectId = 'history-project' as never;
    const provider = { cliType: 'builtin' as const, agentType: 'claude', agentConfigId: configId };
    const providerKey = getLocalProjectHistoryCatalogKey(provider);
    const sourceAcpSessionId = 'external-history';
    const importedSessionId = 'imported-session' as SessionId;
    const project = {
      id: projectId,
      name: 'Project',
      rootPath: '/synthetic/project',
      createdAtMs: 1,
      future: { bytes: Uint8Array.of(7, 8) },
      history: {
        [providerKey]: {
          lastListedAt: 2,
          futureCatalog: 'SYNTHETIC_PRIVATE_CATALOG',
          sessions: {
            [sourceAcpSessionId]: {
              acpSessionId: sourceAcpSessionId,
              title: 'External',
              importedSessionId,
              status: 'imported',
              futureItem: { retained: true },
            },
          },
        },
        'builtin:claude': {
          lastListedAt: 3,
          sessions: {
            external: {
              acpSessionId: 'external',
              title: 'Another provider',
              importedSessionId: 'other-session',
            },
          },
        },
      },
    };
    const key = machineFlockKeys.localProject(projectId);
    await client.flockBatch(namespace, room, [{ op: 'put', key, value: project as never }]);
    const command = {
      kind: 'invalidate-project-history-import' as const,
      projectId,
      provider,
      sourceAcpSessionId,
      importedSessionId,
    };
    expect(
      (
        await value.execute(binding, {
          ...command,
          importedSessionId: 'other-session' as SessionId,
        })
      ).changed
    ).toBe(false);
    expect(
      (
        await value.execute(binding, {
          ...command,
          provider: { ...provider, agentConfigId: 'another-provider' as AgentConfigId },
        })
      ).changed
    ).toBe(false);
    const legacy = new Flock();
    legacy.put(key, project as never);
    const plan = planLocalProjectHistoryInvalidation(legacy.get(key), command);
    expect(plan.value).toBeDefined();
    legacy.put(key, plan.value as never);
    expect((await value.execute(binding, command)).changed).toBe(true);
    const after = (await client.flockGet(namespace, room, key)).value;
    // The old JS facade normalizes typed bytes to indexed objects; compare the
    // shared planner before that facade conversion and preserve native bytes.
    expect(after).toEqual(planLocalProjectHistoryInvalidation(project, command).value);
    expect((after as unknown as typeof project).history).toEqual(
      (legacy.get(key) as unknown as typeof project).history
    );
    expect(after).toMatchObject({
      future: project.future,
      history: {
        [providerKey]: {
          futureCatalog: 'SYNTHETIC_PRIVATE_CATALOG',
          sessions: {
            [sourceAcpSessionId]: { status: 'available', futureItem: { retained: true } },
          },
        },
        'builtin:claude': project.history['builtin:claude'],
      },
    });
    expect(
      (after as unknown as typeof project).history[providerKey]!.sessions[sourceAcpSessionId]
    ).not.toHaveProperty('importedSessionId');
    expect((await value.execute(binding, command)).changed).toBe(false);
    expect(JSON.stringify((await value.read(binding)).projects)).not.toContain(
      'SYNTHETIC_PRIVATE_CATALOG'
    );
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.sessionLaunchConfig('old-session' as SessionId)
        )
      ).found
    ).toBe(true);
    expect(
      (
        await value.execute(binding, {
          kind: 'remove-session-launch-reference',
          sessionId: 'old-session' as SessionId,
        })
      ).changed
    ).toBe(true);
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.sessionLaunchConfig('old-session' as SessionId)
        )
      ).found
    ).toBe(false);
    expect((await client.flockGet(namespace, room, ['future-family', 'opaque'])).value).toEqual({
      retained: true,
    });
  });

  it('covers machine catalog families and private runtime cache publication in the same physical room', async () => {
    const value = catalog(),
      consumer = runtime();
    await value.execute(binding, { kind: 'set-dot-lody-path', path: '/synthetic/dotlody' });
    await value.execute(binding, {
      kind: 'save-local-project',
      project: {
        id: 'project' as never,
        name: 'Synthetic project',
        rootPath: '/synthetic/project',
        createdAtMs: 1,
      },
    });
    await value.execute(binding, {
      kind: 'associate-memory',
      association: {
        providerId: 'memory-provider',
        memoryId: 'memory',
        machineId: binding.machineId,
        name: 'Synthetic memory',
      },
    });
    await value.execute(binding, {
      kind: 'delete-local-project',
      projectId: 'project' as never,
      command: { v: 1, requestedAt: 1, cleanupWorktrees: true },
    });
    await consumer.execute(binding, {
      kind: 'publish-capabilities',
      id: configId,
      entry: {
        cliType: 'builtin',
        agentType: 'claude',
        modes: [{ id: 'safe', name: 'Safe' }],
        models: [{ modelId: 'model', name: 'Model' }],
        fetchedAt: 2,
        sourceVersion: 'synthetic-source',
      },
    });
    await consumer.execute(binding, {
      kind: 'publish-model-capabilities',
      id: configId,
      entry: {
        version: 1,
        sourceVersion: 'synthetic-source',
        models: { model: { effortValues: ['high'], fastMode: true } },
      },
    });
    await consumer.execute(binding, {
      kind: 'publish-model-options',
      id: configId,
      sourceVersion: 'synthetic-source',
      answers: {
        model: [
          {
            id: 'option',
            name: 'Option',
            type: 'select',
            currentValue: 'SYNTHETIC_OPTION_SECRET',
            options: [{ name: 'Choice', value: 'SYNTHETIC_OPTION_SECRET' }],
          },
        ],
      },
    });
    await consumer.execute(binding, {
      kind: 'publish-rate-limit',
      id: configId,
      cliType: 'claude',
      limitId: 'synthetic-limit',
      entry: { used: 1, limit: 10, remaining: 9, opaqueCredential: 'SYNTHETIC_QUOTA_SECRET' },
    });
    const projection = await value.read(binding);
    expect(projection).toMatchObject({
      dotlodyPath: '/synthetic/dotlody',
      projects: [{ id: 'project' }],
      memories: [{ memoryId: 'memory' }],
      modelCapabilities: [{ modelIds: ['model'] }],
      modelOptions: [{ modelId: 'model' }],
      modelShapes: [{ optionIds: ['option'] }],
      quotas: [{ used: 1, remaining: 9 }],
      commandCounts: { deleteLocalProject: 1 },
    });
    const privateCatalog = await consumer.readCatalog(binding);
    expect(privateCatalog.capabilities[configId].observedModelConfigOptions?.model).toMatchObject([
      { currentValue: 'SYNTHETIC_OPTION_SECRET' },
    ]);
    expect(privateCatalog.rateLimits).toBeDefined();
    expect(JSON.stringify(projection)).not.toContain('SYNTHETIC_OPTION_SECRET');
    expect(JSON.stringify(projection)).not.toContain('SYNTHETIC_QUOTA_SECRET');
    await value.execute(binding, {
      kind: 'remove-memory',
      providerId: 'memory-provider',
      memoryId: 'memory',
    });
    expect((await value.read(binding)).memories).toEqual([]);
  });

  it('creates only after trusted verification and deletes provider/index/quotas with the shared last-provider opt-out rule', async () => {
    const value = catalog({ verifyAgentChange: async () => true });
    const added = {
      ...original(),
      id: 'new-agent' as AgentConfigId,
      env: { API_KEY: 'SYNTHETIC_NEW_INPUT' },
    };
    const denied = catalog();
    await expect(
      denied.execute(binding, { kind: 'create-agent', config: added })
    ).rejects.toMatchObject({ code: 'verification_required' });
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(added.id))).found
    ).toBe(false);
    await value.execute(binding, { kind: 'create-agent', config: added });
    let editor = await value.beginAgentConfigEdit(binding, added.id);
    await value.execute(binding, {
      kind: 'remove-agent',
      id: added.id,
      editToken: editor.editToken,
      now: 2,
    });
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfigIndex(added.id))).found
    ).toBe(false);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.builtinAgentOptOut('claude'))).found
    ).toBe(false);
    editor = await value.beginAgentConfigEdit(binding, configId);
    await value.execute(binding, {
      kind: 'remove-agent',
      id: configId,
      editToken: editor.editToken,
      now: 3,
    });
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.builtinAgentOptOut('claude'))).value
    ).toMatchObject({ removedAt: 3 });
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.sessionLaunchConfig('old-session' as SessionId)
        )
      ).found
    ).toBe(true);
  });

  it('revokes public observation and edit access without blocking an independent machine catalog holder', async () => {
    const value = catalog(),
      publications: unknown[] = [],
      failures: unknown[] = [];
    const observation = await value.observe(
      binding,
      (update) => publications.push(update),
      (error) => failures.push(error)
    );
    const initialCount = publications.length;
    allowed = false;
    notify();
    await rival.flockBatch(namespace, room, [
      { op: 'put', key: machineFlockKeys.dotlodyPath(), value: '/synthetic/after-revoke' },
    ]);
    await expect(value.read(binding)).rejects.toMatchObject({ code: 'access_denied' });
    expect(publications).toHaveLength(initialCount);
    expect(failures).toContainEqual(expect.objectContaining({ code: 'access_denied' }));
    observation.close();
    value.close();
    allowed = true;
    epoch = 'generation-b';
    notify();
    const independent = catalog();
    expect((await independent.read(binding)).dotlodyPath).toBe('/synthetic/after-revoke');
    await expect(value.beginAgentConfigEdit(binding, configId)).rejects.toMatchObject({
      code: 'access_denied',
    });
  });
  it('releases scoped catalog observations and probe admission without closing the shared SDK client', async () => {
    const scope = Effect.runSync(Scope.make());
    const entered = deferred<AbortSignal>(),
      finish = deferred<boolean>();
    const value = await Effect.runPromise(
      Scope.provide(
        makeNativeMachineCatalog(
          options({
            verifyAgentChange: async (_old, _next, signal) => {
              entered.resolve(signal);
              return finish.promise;
            },
          })
        ),
        scope
      )
    );
    const consumer = await Effect.runPromise(
      Scope.provide(makeNativeMachineRuntimeCatalog(options()), scope)
    );
    const work = deferred<AbortSignal>();
    await consumer.observeCommands(
      binding,
      (_work, context) => work.resolve(context.signal),
      (error) => {
        throw error;
      }
    );
    const commandSignal = await work.promise;
    const editor = await value.beginAgentConfigEdit(binding, configId);
    const write = value.execute(binding, {
      kind: 'edit-agent',
      id: configId,
      editToken: editor.editToken,
      changes: { env: { kind: 'clear' } },
    });
    const probeSignal = await entered.promise;
    await Effect.runPromise(Scope.close(scope, Exit.void));
    expect(commandSignal.aborted).toBe(true);
    expect(probeSignal.aborted).toBe(true);
    finish.resolve(true);
    await expect(write).rejects.toMatchObject({ code: 'access_denied' });
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).found
    ).toBe(true);
    expect((await rawConfig()).env).toEqual(original().env);
    await expect(value.read(binding)).rejects.toMatchObject({ code: 'access_denied' });
  });
  it('retains completed worktree cleanup evidence until explicit dismissal and finishes provider publication atomically', async () => {
    const value = catalog(),
      consumer = runtime();
    await client.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.providerSetup(pending().id),
        value: { ...pending(), status: 'verifying' } as never,
      },
    ]);
    await value.execute(binding, {
      kind: 'save-local-project',
      project: {
        id: 'cleanup-project' as never,
        name: 'Cleanup',
        rootPath: '/synthetic/cleanup',
        createdAtMs: 1,
      },
    });
    await value.execute(binding, {
      kind: 'delete-local-project',
      projectId: 'cleanup-project' as never,
      command: { v: 1, requestedAt: 1, cleanupWorktrees: true },
    });
    const ready = deferred<readonly NativeMachineCommandWork[]>();
    const observation = await consumer.observeCommands(
      binding,
      (work) => ready.resolve(work),
      (error) => {
        throw error;
      }
    );
    const work = await ready.promise;
    const cleanup = work.find((entry) => entry.command.key[0] === 'cmd')!;
    const setup = work.find((entry) => entry.command.key[0] === 'providerSetup')!;
    await expect(
      consumer.execute(binding, { kind: 'complete-command', receipt: cleanup.receipt })
    ).rejects.toMatchObject({ code: 'invalid_edit' });
    await expect(
      consumer.execute(binding, {
        kind: 'remove-local-project-metadata',
        projectId: 'cleanup-project' as never,
        expectedRootPath: '/wrong-root',
      })
    ).rejects.toMatchObject({ code: 'edit_conflict' });
    await consumer.execute(binding, {
      kind: 'remove-local-project-metadata',
      projectId: 'cleanup-project' as never,
      expectedRootPath: '/synthetic/cleanup',
    });
    await consumer.execute(binding, {
      kind: 'complete-local-project-deletion',
      receipt: cleanup.receipt,
      result: { completedAt: 10, deleted: [], skippedDirty: [], failed: [] },
    });
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.deleteLocalProjectCommand('cleanup-project' as never)
        )
      ).value
    ).toMatchObject({ status: 'completed', cleanupResult: { completedAt: 10 } });
    expect((await value.read(binding)).localProjectDeletionResults).toMatchObject([
      { projectId: 'cleanup-project', completedAt: 10, failedCount: 0 },
    ]);
    await expect(
      value.execute(binding, {
        kind: 'dismiss-local-project-deletion',
        projectId: 'cleanup-project' as never,
        completedAt: 11,
      })
    ).rejects.toMatchObject({ code: 'edit_conflict' });
    await value.execute(binding, {
      kind: 'dismiss-local-project-deletion',
      projectId: 'cleanup-project' as never,
      completedAt: 10,
    });
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.deleteLocalProjectCommand('cleanup-project' as never)
        )
      ).found
    ).toBe(false);
    await consumer.execute(binding, { kind: 'finish-provider-setup', receipt: setup.receipt });
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.providerSetup(pending().id))).found
    ).toBe(false);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(pending().id))).found
    ).toBe(true);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfigIndex(pending().id)))
        .found
    ).toBe(true);
    observation.close();
  });
  it('runs the real provider worker through native storage and capability publication without a legacy Repo read', async () => {
    const storage = createNativeProviderSetupStorage(options());
    resources.push(storage);
    const executionPort = createNativeMachineExecutionPort(options());
    const probeEntered = deferred<void>();
    const execution: ProviderSetupManagerOptions['execution'] = {
      getMachineAcpBinaryStatus: async () => ({ success: true, status: 'installed' }) as never,
      installMachineAcpBinary: async () => {
        throw new Error('installed fixture must not install');
      },
      refreshMachineAcpCapabilities: async (request, progress) => {
        probeEntered.resolve();
        const config = await executionPort.getAgentConfigForMachineLaunch(
          request.configId,
          binding.machineId
        );
        expect(config?.env).toEqual(pending().config.env);
        const capability = await executionPort.updateAcpCapabilities(
          binding.machineId,
          request.configId,
          'builtin',
          'claude',
          [],
          [{ modelId: 'synthetic-model' }],
          undefined,
          undefined,
          false,
          'native-runtime',
          undefined,
          false,
          undefined,
          { signal: progress?.signal }
        );
        return { success: true, capability } as never;
      },
    };
    const manager = new ProviderSetupManager({
      repo: {
        openFlockDoc: () => {
          throw new Error('native worker opened legacy MF');
        },
      } as never,
      workspaceId: binding.workspaceId,
      machineId: binding.machineId,
      execution,
      storage,
      sync: {
        markMachineFlockDocDirty: () => {
          throw new Error('native worker dirtied legacy MF');
        },
      },
      logger: { debug: () => {}, warn: () => {} } as never,
    });
    try {
      manager.start();
      await probeEntered.promise;
      await manager.kick();
    } finally {
      manager.stop();
    }
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.providerSetup(pending().id))).found
    ).toBe(false);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(pending().id))).value
    ).toMatchObject({ env: pending().config.env });
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfigIndex(pending().id)))
        .found
    ).toBe(true);
    expect(await executionPort.getAcpCapabilities(binding.machineId, pending().id)).toMatchObject({
      sourceVersion: 'native-runtime',
      models: [{ modelId: 'synthetic-model', name: 'synthetic-model' }],
    });
    expect(JSON.stringify(await catalog().read(binding))).not.toContain('SYNTHETIC_SAVED_SECRET');
  });

  it('retries a summarized setup only at its observed version and retains machine-private credentials', async () => {
    const value = catalog();
    const expected = { attempt: 1, status: 'queued' as const, updatedAt: 1 };
    await value.execute(binding, {
      kind: 'retry-provider-setup',
      id: pending().id,
      expected,
      now: 20,
    });
    const row = await client.flockGet(
      namespace,
      room,
      machineFlockKeys.providerSetup(pending().id)
    );
    expect(row.value).toMatchObject({
      attempt: 2,
      status: 'queued',
      updatedAt: 20,
      config: { env: pending().config.env },
    });
    await expect(
      value.execute(binding, { kind: 'retry-provider-setup', id: pending().id, expected, now: 30 })
    ).rejects.toMatchObject({ code: 'edit_conflict' });
    expect(JSON.stringify(await value.read(binding))).not.toContain('SYNTHETIC_SAVED_SECRET');
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.providerSetup(pending().id))).value
    ).toEqual(row.value);
  });

  it('rejects static-create foreign native identities and an unbound native SR before touching the legacy data directory', async () => {
    const execution = createNativeMachineExecutionPort(options());
    resources.push(execution);
    const root = join(directory, 'isolated-static-create');
    await mkdir(root);
    const source = new Flock();
    source.set(['synthetic', 'retained'], { opaque: 'existing source' });
    source.commit();
    const sourcePath = join(root, 'existing-source.flock');
    const sourceBytes = source.exportFile();
    await writeFile(sourcePath, sourceBytes);
    const originalDataDir = process.env.LODY_DATA_DIR;
    process.env.LODY_DATA_DIR = root;
    try {
      const before = (await readdir(root, { recursive: true })).sort();
      const logger = getLogger('native-machine-static-preflight');
      const cases = [
        {
          workspaceId: 'foreign-workspace' as typeof binding.workspaceId,
          accountId: binding.accountId,
          options: { machineCatalogRuntime: execution },
          error: 'Machine catalog identity mismatch',
        },
        {
          workspaceId: binding.workspaceId,
          accountId: 'foreign-account',
          options: { machineCatalogRuntime: execution },
          error: 'Machine catalog identity mismatch',
        },
        {
          workspaceId: binding.workspaceId,
          accountId: binding.accountId,
          options: { scheduleRegistryOwnership: 'native' as const },
          error: 'Bound native schedule registry port is required',
        },
      ];
      for (const entry of cases) {
        await expect(
          LoroDocumentManager.create(entry.workspaceId, entry.accountId, logger, {
            attachRemoteOnCreate: false,
            ...entry.options,
          })
        ).rejects.toThrow(entry.error);
        expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
        expect(await readFile(sourcePath)).toEqual(Buffer.from(sourceBytes));
      }
    } finally {
      if (originalDataDir === undefined) delete process.env.LODY_DATA_DIR;
      else process.env.LODY_DATA_DIR = originalDataDir;
    }
  });

  it('selects the whole MF owner during real manager construction before legacy consumers or room admission', async () => {
    const repo = await LoroRepo.create({});
    const legacy = await repo.openFlockDoc(room.id);
    legacy.flock.set(machineFlockKeys.agentConfig(configId), {
      ...original(),
      name: 'Stale legacy',
      env: { API_KEY: 'SYNTHETIC_STALE_SECRET' },
    });
    legacy.flock.commit();
    const execution = createNativeMachineExecutionPort(options());
    const manager = new LoroDocumentManager({
      repo,
      workspaceId: binding.workspaceId,
      userId: binding.accountId,
      metaSub: null,
      logger: getLogger('native-machine-constructor'),
      machineCatalogRuntime: execution,
    });
    try {
      expect(manager.getMachineCatalogRuntimePort(binding.machineId)).toBe(execution);
      expect(manager.ownsNativeFlockRoom(room.id)).toBe(true);
      expect(await manager.getAgentConfigById(configId)).toMatchObject({
        name: original().name,
        env: original().env,
      });
      expect(legacy.flock.get(machineFlockKeys.agentConfig(configId))).toMatchObject({
        name: 'Stale legacy',
      });
      await manager.cleanUp({ preserveSessionStatus: true });
      expect(manager.ownsNativeFlockRoom(room.id)).toBe(true);
      await expect(manager.getAgentConfigById(configId)).rejects.toMatchObject({
        code: 'access_denied',
      });
    } finally {
      await manager.cleanUp({ preserveSessionStatus: true });
    }
  });

  it('routes the real document machine API through one bound owner and keeps it closed after retirement', async () => {
    const execution = createNativeMachineExecutionPort(options());
    resources.push(execution);
    const manager = Object.assign(Object.create(LoroDocumentManager.prototype), {
      workspaceId: binding.workspaceId,
      userId: binding.accountId,
      repo: new Proxy(
        {},
        {
          get() {
            throw new Error('Native document API touched legacy Repo/Meta');
          },
        }
      ),
    }) as LoroDocumentManager;
    expect(() => manager.selectMachineCatalogRuntime(execution, 'wrong-machine' as never)).toThrow(
      'identity mismatch'
    );
    const retire = manager.selectMachineCatalogRuntime(execution, binding.machineId);
    expect(await manager.hasAgentConfig('builtin', 'claude', binding.machineId)).toBe(true);
    expect((await manager.getAgentConfigById(configId))?.env).toEqual(original().env);
    const launchInput = {
      workspaceDocument: manager,
      workspaceId: binding.workspaceId,
      machineId: binding.machineId,
      sessionId: 'old-session' as SessionId,
      sessionMeta: {
        agentConfigId: configId,
        machineId: binding.machineId,
        env: { BAD_FALLBACK: 'SYNTHETIC_STALE_SECRET' },
      } as never,
      logger: { debug: () => {} },
    };
    expect(await resolveSessionLaunchConfig(launchInput)).toMatchObject({
      source: 'agent-config',
      config: { env: original().env },
    });
    expect((await manager.findSoleAgentConfig('builtin', 'claude', binding.machineId))?.id).toBe(
      configId
    );
    const newId = await manager.createAgentConfig('builtin', 'pi', binding.machineId, 'Native Pi');
    expect((await manager.getAgentConfigForMachineLaunch(newId, binding.machineId))?.name).toBe(
      'Native Pi'
    );
    await manager.updateRateLimits(
      binding.machineId,
      configId,
      'claude',
      { limitId: 'usage', used: 5 } as never,
      () => false,
      original()
    );
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.rateLimit(configId, 'claude', 'usage')
        )
      ).found
    ).toBe(false);
    const expected = await manager.getAgentConfigById(configId);
    await manager.updateRateLimits(
      binding.machineId,
      configId,
      'claude',
      { limitId: 'usage', used: 5 } as never,
      () => true,
      expected!
    );
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.rateLimit(configId, 'claude', 'usage')
        )
      ).value
    ).toMatchObject({ used: 5 });
    await catalog().execute(binding, {
      kind: 'cancel-provider-setup',
      cancellation: { v: 1, id: configId, machineId: binding.machineId, cancelledAt: 100 },
    });
    await expect(resolveSessionLaunchConfig(launchInput)).rejects.toMatchObject({
      code: 'edit_conflict',
    });
    retire();
    await expect(manager.getAgentConfigById(configId)).rejects.toMatchObject({
      code: 'access_denied',
    });
    await expect(
      manager.createAgentConfig('builtin', 'pi', binding.machineId)
    ).rejects.toMatchObject({ code: 'access_denied' });
  });

  it('uses existing CLI config and project helpers with native version guards and no legacy Flock/Meta access', async () => {
    const source = createNativeMachineExecutionPort(options());
    resources.push(source);
    const legacy = new Proxy(
      {},
      {
        get() {
          throw new Error('Native helper reopened legacy Flock/Meta');
        },
      }
    ) as never;
    const configs = await listMergedAgentConfigs(
      legacy,
      binding.workspaceId,
      [binding.machineId],
      source
    );
    const before = configs.find((config) => config.id === configId)!;
    await rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.agentConfig(configId),
        value: {
          ...before,
          name: 'Peer renamed',
          future: { opaque: 'private extension' },
        } as never,
      },
    ]);
    await expect(
      upsertMachineAgentConfig(
        legacy,
        binding.workspaceId,
        { ...before, name: 'Stale rename' },
        { native: source, expected: before }
      )
    ).rejects.toMatchObject({ code: 'edit_conflict' });
    const current = (await source.readAgentConfig(configId))!;
    await upsertMachineAgentConfig(
      legacy,
      binding.workspaceId,
      { ...current, name: 'Native rename' },
      { native: source, expected: current }
    );
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).value
    ).toMatchObject({
      name: 'Native rename',
      env: original().env,
      future: { opaque: 'private extension' },
    });
    const projectId = 'native-helper-project' as import('@lody/shared').LocalProjectId;
    const project = {
      id: projectId,
      name: 'Project',
      rootPath: '/synthetic/native-helper',
      createdAtMs: 1,
    };
    await upsertMachineLocalProject(
      legacy,
      binding.workspaceId,
      binding.machineId,
      project,
      undefined,
      { native: source }
    );
    const observed = (
      await readMachineLocalProjects(legacy, binding.workspaceId, binding.machineId, source)
    )[projectId]!;
    await rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.localProject(projectId),
        value: { ...observed, name: 'Peer project' } as never,
      },
    ]);
    await expect(
      upsertMachineLocalProject(
        legacy,
        binding.workspaceId,
        binding.machineId,
        { ...observed, name: 'Stale project' },
        undefined,
        { native: source, expected: observed }
      )
    ).rejects.toMatchObject({ code: 'edit_conflict' });
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.localProject(projectId))).value
    ).toMatchObject({ name: 'Peer project' });
  });

  it('runs the existing Magpie import planner atomically through private CLI and confirmed public domain commands', async () => {
    const machine = {
      id: binding.machineId,
      protocolCapabilities: { magpieImport: 1, providerSetup: 1, builtinPi: 1 },
    } as import('@lody/shared').MachineMeta;
    const source = createNativeMachineExecutionPort(options());
    resources.push(source);
    const request = {
      gatewayUrl: 'http://127.0.0.1:3425',
      targets: ['claude', 'dsh'] as import('@lody/shared').MagpieTarget[],
    };
    const first = await source.importMagpie(machine, request);
    expect(first.map((provider) => provider.status)).toEqual(['queued', 'created']);
    expect(
      (await source.importMagpie(machine, request)).map((provider) => provider.agentConfigId)
    ).toEqual(first.map((provider) => provider.agentConfigId));
    expect((await source.readAgentConfig(first[1]!.agentConfigId))?.magpieGatewayUrl).toBe(
      request.gatewayUrl
    );
    await expect(source.upload()).rejects.toMatchObject({ code: 'operation_failed' });
    const view = catalog({ machineMetadata: async () => machine });
    await view.execute(binding, {
      kind: 'import-magpie',
      request: { gatewayUrl: request.gatewayUrl, targets: ['pi'] },
    });
    expect(
      (await view.read(binding)).providerSetups.some((task) => task.config.agentType === 'pi')
    ).toBe(true);
    const before = await client.flockScan(namespace, room);
    await expect(
      view.execute(binding, {
        kind: 'import-magpie',
        request: { gatewayUrl: 'https://vendor.invalid', targets: ['claude'] },
      })
    ).rejects.toBeDefined();
    expect((await client.flockScan(namespace, room)).roomTxId).toBe(before.roomTxId);
    expect(JSON.stringify(await view.read(binding))).not.toContain('SYNTHETIC_SAVED_SECRET');
  });

  it('keeps composed runtime cleanup awaitable after synchronous retirement when its durable command unsubscribe ACK is lost', async () => {
    const subscribe = client.flockSubscribe.bind(client);
    vi.spyOn(client, 'flockSubscribe').mockImplementation(async (...args) => {
      const handle = await subscribe(...args),
        release = handle.unsubscribe.bind(handle);
      handle.unsubscribe = async () => {
        await release();
        throw new Error('Synthetic command unsubscribe ACK lost');
      };
      return handle;
    });
    const ports = createNativeMachineRuntimePorts(options());
    await ports.catalog.observeCommands(
      binding,
      () => {},
      (error) => {
        throw error;
      }
    );
    const providerSignal = ports.providerSetup.signal();
    ports.execution.close();
    expect(providerSignal.aborted).toBe(true);
    await expect(ports.cleanup()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    await expect(ports.retryCleanup()).rejects.toMatchObject({ code: 'cleanup_unconfirmed' });
    expect(client.connectionState).toBe('connected');
    await client.close();
    await ports.retryCleanup();
    expect(
      (await rival.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).found
    ).toBe(true);
  });

  it('retires every composed machine capability through the selected execution port without closing its borrowed engine', async () => {
    const ports = createNativeMachineRuntimePorts(options());
    resources.push(ports);
    const ready = deferred<AbortSignal>();
    await ports.catalog.observeCommands(
      binding,
      (_work, context) => ready.resolve(context.signal),
      (error) => {
        throw error;
      }
    );
    const commandSignal = await ready.promise,
      providerSignal = ports.providerSetup.signal();
    ports.execution.close();
    expect(commandSignal.aborted).toBe(true);
    expect(providerSignal.aborted).toBe(true);
    await expect(ports.execution.readAgentConfigs()).rejects.toMatchObject({
      code: 'access_denied',
    });
    await expect(ports.catalog.readCatalog(binding)).rejects.toMatchObject({
      code: 'access_denied',
    });
    expect(client.connectionState).toBe('connected');
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(configId))).found
    ).toBe(true);
  });

  it('executes real MessageHandler durable command and local-project cleanup against native MF after authoritative initial scan and rejoin', async () => {
    const value = catalog(),
      consumer = runtime();
    const projectId = 'native-project' as import('@lody/shared').LocalProjectId;
    const command = { v: 1 as const, requestedAt: 10 };
    await value.execute(binding, {
      kind: 'save-local-project',
      project: {
        id: projectId,
        name: 'Native project',
        rootPath: '/synthetic/native-project',
        createdAtMs: 1,
      },
    });
    await value.execute(binding, { kind: 'delete-local-project', projectId, command });
    const ready = deferred<{ work: readonly NativeMachineCommandWork[]; signal: AbortSignal }>();
    let rejoined:
      | ReturnType<
          typeof deferred<{ work: readonly NativeMachineCommandWork[]; signal: AbortSignal }>
        >
      | undefined;
    const observer = await consumer.observeCommands(
      binding,
      (work, context) => {
        if (!work.some((item) => item.command.key[0] === 'cmd')) return;
        (rejoined ?? ready).resolve({ work, signal: context.signal });
      },
      (error) => {
        throw error;
      }
    );
    const handler = Object.assign(Object.create(MessageHandler.prototype), {
      machineCatalogRuntime: { catalog: consumer, binding },
      machineId: binding.machineId,
      workspaceId: binding.workspaceId,
      nativeMachineCommandsStopped: false,
      deleteLocalProjectInFlight: new Set(),
      workspaceDocument: {
        repo: {
          flock: { scan: async () => [] },
          openFlockDoc() {
            throw new Error('Native cleanup opened old MF');
          },
          getDocMeta() {
            throw new Error('Native cleanup opened old machine Meta');
          },
        },
        catalogBaselineReady: async () => true,
        readWorkspaceCatalog: async () => ({ projects: [] }),
      },
      logger: { debug: () => {}, error: () => {} },
    }) as {
      processNativeMachineCommands(
        work: readonly NativeMachineCommandWork[],
        signal: AbortSignal
      ): Promise<void>;
    };
    const initial = await ready.promise;
    rejoined = deferred();
    await rival.flockBatch(namespace, room, [
      {
        op: 'put',
        key: machineFlockKeys.deleteLocalProjectCommand(projectId),
        value: { ...command, requestedAt: 20 },
      },
    ]);
    const replaced = await rejoined.promise;
    expect(initial.work.find((item) => item.command.key[0] === 'cmd')!.signal.aborted).toBe(true);
    await handler.processNativeMachineCommands(initial.work, initial.signal);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.localProject(projectId))).found
    ).toBe(true);
    synced = false;
    notify();
    await handler.processNativeMachineCommands(replaced.work, replaced.signal);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.localProject(projectId))).found
    ).toBe(true);
    rejoined = deferred();
    synced = true;
    epoch = 'native-rejoined';
    notify();
    const fresh = await rejoined.promise;
    await handler.processNativeMachineCommands(fresh.work, fresh.signal);
    expect(
      (await client.flockGet(namespace, room, machineFlockKeys.localProject(projectId))).found
    ).toBe(false);
    expect(
      (
        await client.flockGet(
          namespace,
          room,
          machineFlockKeys.deleteLocalProjectCommand(projectId)
        )
      ).found
    ).toBe(false);
    observer.close();
  });

  it('does not publish a cancelled or authority-revoked real provider probe when its response arrives late', async () => {
    for (const revoke of [false, true]) {
      await client.flockBatch(namespace, room, [
        { op: 'put', key: machineFlockKeys.providerSetup(pending().id), value: pending() as never },
      ]);
      const storage = createNativeProviderSetupStorage(options());
      resources.push(storage);
      const entered = deferred<AbortSignal | undefined>(),
        release = deferred<void>();
      const manager = new ProviderSetupManager({
        repo: {
          openFlockDoc: () => {
            throw new Error('legacy MF read');
          },
        } as never,
        workspaceId: binding.workspaceId,
        machineId: binding.machineId,
        storage,
        execution: {
          getMachineAcpBinaryStatus: async () => ({ success: true, status: 'installed' }) as never,
          installMachineAcpBinary: async () => {
            throw new Error('unexpected install');
          },
          refreshMachineAcpCapabilities: async (_request, progress) => {
            entered.resolve(progress?.signal);
            await release.promise;
            return { success: true } as never;
          },
        },
        sync: {
          markMachineFlockDocDirty: () => {
            throw new Error('legacy MF write');
          },
        },
        logger: { debug: () => {}, warn: () => {} } as never,
      });
      const work = manager.kick();
      const signal = await entered.promise;
      if (revoke) {
        synced = false;
        notify();
        expect(signal?.aborted).toBe(true);
        synced = true;
        epoch = 'rejoined';
        notify();
      } else
        await catalog().execute(binding, {
          kind: 'cancel-provider-setup',
          cancellation: { v: 1, id: pending().id, machineId: binding.machineId, cancelledAt: 10 },
        });
      release.resolve();
      await work;
      manager.stop();
      storage.close();
      expect(
        (await client.flockGet(namespace, room, machineFlockKeys.agentConfig(pending().id))).found
      ).toBe(false);
      if (!revoke)
        await client.flockBatch(namespace, room, [
          { op: 'delete', key: machineFlockKeys.providerSetupCancellation(pending().id) },
        ]);
    }
  });
});
