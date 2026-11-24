import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Cause, Context, Deferred, Effect, Exit, Layer, Scope, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { NodeProcess, ProcessReleaseFailed } from '@lody/shared/node/process';
import { z } from 'zod';
import type { DispatchMachineHostCall, MachineHostOrigin } from '../machine-host-port';
import {
  pluginIpcErrorSchema,
  childToHostSchema,
  type HostToChildFrame,
} from '@lody/shared/plugins/ipc-protocol';
import { lostInvocationCode } from '../pure/call-policy';
import { makePluginInvocations, type InvocationFailure } from './plugin-invocations';

import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';

type Init = Extract<HostToChildFrame, { type: 'init' }>;
type Invoke = Omit<Extract<HostToChildFrame, { type: 'invoke' }>, 'type' | 'callId'>;
export interface PluginLaunchSpec {
  previousVersion?: string;
  installationId?: string;
  beforeStart?: Effect.Effect<void, unknown>;
  pluginId: string;
  workspaceId: string;
  machineId: string;
  dataDir: string;
  config: Init['config'];
  machineEntry?: string;
  machineDigest?: string;
  manifest?: PluginManifest;
  clientDigest?: string;
}
interface Status {
  instanceId?: number;
  pid?: number;
  clientDigest?: string;
}
type HostEvent = Omit<Extract<HostToChildFrame, { type: 'event' }>, 'contextId'>;
interface PluginMcpDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
interface Api {
  broadcast: (frame: HostEvent, admit?: () => Promise<boolean>) => Effect.Effect<void, unknown>;
  event: (id: string, frame: HostEvent) => Effect.Effect<void, unknown>;
  reload: (spec: PluginLaunchSpec) => Effect.Effect<Status, unknown>;
  remove: (id: string) => Effect.Effect<void, unknown>;
  disable: (id: string) => Effect.Effect<void, unknown>;
  inspect: (id: string) => {
    instanceId?: number;
    installationId?: string;
    machineDigest?: string;
    lifecycle: string;
    pid?: number;
    registrations: string[];
  };
  tools: (id: string) => readonly PluginMcpDescriptor[];
  logs: (id: string) => Effect.Effect<readonly string[]>;
  invoke: (
    id: string,
    frame: Invoke,
    execute?: DispatchMachineHostCall,
    onDispatch?: (callId: string) => void
  ) => Effect.Effect<unknown, InvocationFailure>;
}
export class PluginHost extends Context.Service<PluginHost, Api>()('lody/plugins/PluginHost') {}
export const makePluginHostLayer = (
  worker = fileURLToPath(new URL('./plugin-worker.js', import.meta.url)),
  dispatch?: DispatchMachineHostCall,
  store?: import('../plugin-state-store').PluginStateStore,
  readmit?: (frame: HostEvent) => Promise<boolean>
) =>
  Layer.effect(
    PluginHost,
    Effect.gen(function* () {
      const node = yield* NodeProcess,
        spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const owner = yield* Effect.scope;
      type Child = Effect.Success<ReturnType<typeof node.spawnIpcChild>>;
      type Generation = {
        scope: Scope.Closeable;
        child?: Child;
        spec: PluginLaunchSpec;
        status: Status;
        readyForReads?: boolean;
        faulted: boolean;
        calls: ReturnType<typeof makePluginInvocations>;
        lease?: ProcessReleaseFailed;
        running?: boolean;
        subscribed?: Set<string>;
        resume?: string[];
        draining?: boolean;
        origins: Map<string, { origin: MachineHostOrigin; controller: AbortController }>;
        registrations?: string[];
        tools?: PluginMcpDescriptor[];
        buffered: { frame: HostEvent; admit?: () => Promise<boolean> }[];
        eventTail?: Deferred.Deferred<void>;
        eventReply?: { contextId: string; reply: Deferred.Deferred<void, Error> };
      };
      const active = new Map<string, Generation>(),
        history = new Map<string, readonly string[]>(),
        tails = new Map<string, Deferred.Deferred<void>>();
      let generation = 0;
      const serialize = <A, E>(id: string, op: Effect.Effect<A, E>) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const next = yield* Deferred.make<void>();
            const prev = tails.get(id);
            tails.set(id, next);
            return yield* Effect.gen(function* () {
              if (prev) yield* Deferred.await(prev);
              return yield* op;
            }).pipe(
              Effect.ensuring(
                Effect.gen(function* () {
                  if (tails.get(id) === next) tails.delete(id);
                  yield* Deferred.succeed(next, undefined);
                })
              )
            );
          })
        );
      const stop = Effect.fnUntraced(function* (id: string, remove = false) {
        const g = active.get(id);
        if (!g) return;
        if (g.lease) {
          yield* g.lease.retryTermination();
        } else {
          const child = g.child;
          const disconnected = g.faulted;
          g.faulted = true;
          for (const o of g.origins.values()) o.controller.abort();
          g.origins.clear();
          yield* g.calls.close();
          if (child) {
            const uninstallContextId = remove ? randomUUID() : undefined;
            if (uninstallContextId)
              g.origins.set(uninstallContextId, {
                origin: { type: 'uninstall' },
                controller: new AbortController(),
              });
            yield* child
              .send({ type: 'shutdown', graceMs: 2000, uninstallContextId })
              .pipe(
                Effect.andThen(child.exit),
                Effect.timeoutOption(remove ? 10000 : 2000),
                Effect.ignore
              );
            const logs = yield* child.ringBuffer;
            history.set(id, disconnected ? [...logs, 'Plugin worker disconnected'] : logs);
          }
          const result = yield* Effect.exit(Scope.close(g.scope, Exit.void));
          if (Exit.isFailure(result)) {
            const failure = Cause.squash(result.cause);
            if (failure instanceof ProcessReleaseFailed) g.lease = failure;
            return yield* Effect.fail(failure);
          }
        }
        active.delete(id);
      });
      yield* Effect.addFinalizer(() =>
        Effect.forEach([...active.keys()], (id) => stop(id).pipe(Effect.orDie), {
          concurrency: 'unbounded',
          discard: true,
        })
      );
      const admissions = new Map<string, () => Promise<boolean>>();
      const deliverEvent = Effect.fnUntraced(function* (
        g: Generation,
        frame: HostEvent,
        admit?: () => Promise<boolean>
      ) {
        const contextId = randomUUID();
        const previous = g.eventTail;
        const done = yield* Deferred.make<void>();
        g.eventTail = done;
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (previous) yield* Deferred.await(previous);
            const child = g.child;
            if (!child || g.faulted) return;
            if (
              admit &&
              !(yield* Effect.tryPromise(admit).pipe(
                Effect.timeout(3000),
                Effect.orElseSucceed(() => false)
              ))
            )
              return;
            if (g.faulted) return;
            const reply = yield* Deferred.make<void, Error>();
            g.origins.set(contextId, {
              origin: { type: 'event', frame },
              controller: new AbortController(),
            });
            g.eventReply = { contextId, reply };
            yield* child
              .send({ ...frame, contextId })
              .pipe(Effect.andThen(Deferred.await(reply)), Effect.timeout(30000));
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                g.origins.get(contextId)?.controller.abort();
                g.origins.delete(contextId);
                g.eventReply = undefined;
                if (g.eventTail === done) g.eventTail = undefined;
                yield* Deferred.succeed(done, undefined);
              })
            )
          )
        );
      });
      const launch = Effect.fnUntraced(function* (spec: PluginLaunchSpec) {
        const id = spec.pluginId,
          old = active.get(id);
        if (
          old &&
          !old.faulted &&
          Boolean(old.spec.machineEntry) === Boolean(spec.machineEntry) &&
          (spec.machineDigest !== undefined || old.spec.machineEntry === spec.machineEntry) &&
          JSON.stringify(old.spec.manifest) === JSON.stringify(spec.manifest) &&
          old.spec.machineDigest === spec.machineDigest &&
          JSON.stringify(old.spec.config) === JSON.stringify(spec.config) &&
          old.spec.workspaceId === spec.workspaceId &&
          old.spec.machineId === spec.machineId &&
          old.spec.dataDir === spec.dataDir
        ) {
          if (spec.beforeStart) yield* spec.beforeStart;
          old.spec = spec;
          old.status = { ...old.status, clientDigest: spec.clientDigest };
          return old.status;
        }
        const previousVersion = old?.spec.manifest?.version ?? spec.previousVersion;
        yield* stop(id);
        const g: Generation = {
          spec,
          scope: yield* Scope.make(),
          status: { clientDigest: spec.clientDigest },
          calls: makePluginInvocations(),
          faulted: false,
          origins: new Map(),
          buffered: [],
        };
        active.set(id, g);
        if (spec.beforeStart) yield* spec.beforeStart;
        if (!spec.machineEntry) return g.status;
        const child = yield* Scope.provide(
          node.spawnIpcChild({
            command: process.execPath,
            args: [
              '--max-old-space-size=256',
              worker,
              spec.machineEntry,
              spec.workspaceId,
              spec.machineId,
            ],
            options: {
              cwd: spec.dataDir,
              env: {
                ...Object.fromEntries(
                  ['PATH', 'HOME', 'TMPDIR', 'LANG', 'TZ', 'NODE_ENV'].flatMap((key) =>
                    process.env[key] === undefined ? [] : [[key, process.env[key]]]
                  )
                ),
                ELECTRON_RUN_AS_NODE: '1',
                MALLOC_ARENA_MAX: '2',
                SystemRoot: process.env.SystemRoot,
              },
            },
          }),
          g.scope
        ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
        g.child = child;
        g.status = { ...g.status, pid: child.pid, instanceId: ++generation };
        const startupId = randomUUID();
        let serviceId: string | undefined;
        const ready = yield* Deferred.make<void, Error>(),
          started = yield* Deferred.make<void, Error>();
        let phase: 'init' | 'ready' | 'running' = 'init';
        const ended = Effect.gen(function* () {
          g.faulted = true;
          for (const o of g.origins.values()) o.controller.abort();
          g.origins.clear();
          const err = new Error('Plugin worker disconnected');
          yield* Deferred.fail(ready, err);
          yield* Deferred.fail(started, err);
          yield* g.calls.close();
          if (g.eventReply) yield* Deferred.fail(g.eventReply.reply, err);
        });
        const listen = Stream.runForEach(child.messages, (raw) =>
          Effect.gen(function* () {
            const parsed = childToHostSchema.safeParse(raw);
            if (!parsed.success) return yield* Effect.fail(new Error('Invalid plugin IPC'));
            const f = parsed.data;
            if (f.type === 'ready' && phase === 'init') {
              phase = 'ready';
              g.tools = f.handlers.flatMap(h => h.kind === 'tool' && h.tool ? [{ name: `plugin__${id}__${h.descriptorId}`, ...h.tool }] : []);
              g.registrations = [
                ...f.handlers.map((h) => `${h.kind}: ${h.descriptorId}`),
                ...f.subscribedEvents.map((e) => `event: ${e}`),
              ];
              g.subscribed = new Set(f.subscribedEvents);
              g.resume = f.resumeEvents.filter((t) => g.subscribed!.has(t));
              for (const t of g.resume) store?.subscribe(id, t);
              g.readyForReads = true;
              if (f.hasService) serviceId = randomUUID();
              g.origins.set(startupId, {
                origin: { type: 'start' },
                controller: new AbortController(),
              });
              yield* Deferred.succeed(ready, undefined);
            } else if (f.type === 'result' && phase === 'ready' && f.callId === startupId) {
              if (!f.ok) return yield* Effect.fail(new Error('Plugin startup failed'));
              g.origins.get(startupId)?.controller.abort();
              g.origins.delete(startupId);
              phase = 'running';

              yield* Deferred.succeed(started, undefined);
            } else if (f.type === 'result' && g.eventReply?.contextId === f.callId) {
              g.origins.get(g.eventReply.contextId)?.controller.abort();
              g.origins.delete(g.eventReply.contextId);
              if (f.ok) yield* Deferred.succeed(g.eventReply.reply, undefined);
              else yield* Deferred.fail(g.eventReply.reply, new Error('Plugin event failed'));
            } else if (f.type === 'result' && (phase === 'running' || phase === 'ready')) {
              const origin = g.origins.get(f.callId);
              if (origin?.origin.type === 'invoke') {
                origin.controller.abort();
                g.origins.delete(f.callId);
              }
              yield* g.calls.settle(f.callId, f);
            } else if (f.type === 'host_call') {
              const authority = g.origins.get(f.contextId);
              const instanceId = g.status.instanceId;
              const descriptor = f.payload.descriptorId;
              const gated =
                f.op === 'lody.execute'
                  ? descriptor === 'sessionRespondInteraction'
                    ? 'sessions.approve'
                    : [
                          'sessionCreate',
                          'sessionSend',
                          'sessionStop',
                          'sessionArchive',
                          'sessionRestore',
                          'sessionFork',
                        ].includes(descriptor ?? '')
                      ? 'sessions.write'
                      : undefined
                  : undefined;
              if (
                !authority ||
                (gated &&
                  (!spec.manifest?.permissions?.includes(gated) ||
                    (authority.origin.type !== 'invoke' &&
                      !spec.manifest?.permissions?.includes('workflow.autonomous')))) ||
                !dispatch ||
                !instanceId ||
                (g.faulted &&
                  !(authority.origin.type === 'uninstall' && f.op.startsWith('storage.'))) ||
                (f.op === 'lody.unstable.readSnapshot' &&
                  !spec.manifest?.permissions?.includes('unstable.rawState'))
              ) {
                yield* child.send({
                  type: 'host_result',
                  hostCallId: f.hostCallId,
                  ok: false,
                  error: { code: 'forbidden', message: 'Host call has no active authority' },
                });
                return;
              }
              const call = {
                pluginId: id,
                workspaceId: spec.workspaceId,
                machineId: spec.machineId,
                instanceId,
                origin: authority.origin,
                op: f.op,
                payload: f.payload,
              };
              yield* Effect.forkIn(
                Effect.tryPromise({
                  try: async (signal) =>
                    z
                      .json()
                      .parse(
                        (await dispatch(
                          call,
                          AbortSignal.any([signal, authority.controller.signal])
                        )) ?? null
                      ),
                  catch: (e) => {
                    const parsed = pluginIpcErrorSchema.safeParse(
                      e instanceof Error ? { message: e.message, code: Reflect.get(e, 'code') } : e
                    );
                    return parsed.success
                      ? parsed.data
                      : { code: 'handler_error' as const, message: 'Host call failed' };
                  },
                }).pipe(
                  Effect.matchEffect({
                    onSuccess: (data) =>
                      child.send({ type: 'host_result', hostCallId: f.hostCallId, ok: true, data }),
                    onFailure: (error) =>
                      child.send({
                        type: 'host_result',
                        hostCallId: f.hostCallId,
                        ok: false,
                        error,
                      }),
                  })
                ),
                g.scope
              );
            } else if (f.type !== 'invalidate')
              return yield* Effect.fail(new Error('Unexpected plugin IPC'));
          })
        ).pipe(Effect.ensuring(ended));
        yield* Effect.forkIn(
          listen.pipe(
            Effect.ensuring(
              Effect.forkIn(
                serialize(
                  id,
                  Effect.suspend(() => (active.get(id) === g && !g.lease ? stop(id) : Effect.void))
                ),
                owner
              )
            )
          ),
          g.scope
        );
        yield* child
          .send({
            type: 'init',
            pluginId: id,
            instanceId: g.status.instanceId,
            dataDir: spec.dataDir,
            config: spec.config,
            permissions: spec.manifest?.permissions ?? [],
          })
          .pipe(Effect.andThen(Deferred.await(ready)), Effect.timeout(10000));
        yield* child
          .send({
            type: 'start',
            contextId: startupId,

            ...(previousVersion && spec.manifest && previousVersion !== spec.manifest.version
              ? {
                  upgrade: {
                    fromVersion: previousVersion,
                    toVersion: spec.manifest.version,
                  },
                }
              : {}),
          })
          .pipe(Effect.andThen(Deferred.await(started)), Effect.timeout(30000));
        yield* drain(g);
        while (g.buffered.length) {
          const frame = g.buffered.shift();
          if (frame) yield* deliverEvent(g, frame.frame, frame.admit);
        }
        if (serviceId) {
          g.origins.set(serviceId, {
            origin: { type: 'service' },
            controller: new AbortController(),
          });
          yield* child.send({ type: 'service', contextId: serviceId });
        }
        g.running = true;
        return g.status;
      });
      const trailing = new Map<
        string,
        { spec: PluginLaunchSpec; result: Deferred.Deferred<Status, unknown> }
      >();
      const reload = Effect.fnUntraced(function* (spec: PluginLaunchSpec) {
        const id = spec.pluginId;
        const pending = trailing.get(id);
        if (pending) {
          pending.spec = spec;
          return yield* Deferred.await(pending.result);
        }
        const slot = { spec, result: yield* Deferred.make<Status, unknown>() };
        trailing.set(id, slot);
        return yield* serialize(
          id,
          Effect.gen(function* () {
            if (trailing.get(id) === slot) trailing.delete(id);
            const result = yield* Effect.exit(
              launch(slot.spec).pipe(
                Effect.onError(() =>
                  active.get(id)?.spec === slot.spec && !active.get(id)?.lease
                    ? stop(id).pipe(Effect.orDie)
                    : Effect.void
                )
              )
            );
            yield* Deferred.done(slot.result, result);
            return Exit.isSuccess(result) ? result.value : yield* Effect.failCause(result.cause);
          })
        );
      });
      const drain = Effect.fnUntraced(function* (g: Generation) {
        if (!store || !g.resume?.length || g.draining) return;
        g.draining = true;
        try {
          while (!g.faulted) {
            const next = store.next(g.spec.pluginId, g.resume);
            if (!next) return;
            const check =
              admissions.get(next.frame.eventId) ??
              (() => readmit?.(next.frame) ?? Promise.resolve(false));
            if (!(yield* Effect.tryPromise(check))) return;
            yield* deliverEvent(g, next.frame, async () => {
              if (!(await check())) throw Error('Event admission lost');
              return true;
            });
            store.ack(g.spec.pluginId, next.frame.eventType, next.seq);
          }
        } finally {
          g.draining = false;
        }
      });
      const event = (id: string, frame: HostEvent, admit?: () => Promise<boolean>) =>
        Effect.suspend(() => {
          const g = active.get(id);
          if (!g || g.faulted || !g.subscribed?.has(frame.eventType)) return Effect.void;
          if (g.resume?.includes(frame.eventType)) return g.running ? drain(g) : Effect.void;
          if (!g.running) {
            g.buffered.push({ frame, admit });
            return Effect.void;
          }
          return deliverEvent(g, frame, admit);
        });
      return PluginHost.of({
        reload,
        event,
        broadcast: (frame, admit) =>
          Effect.gen(function* () {
            if (admit && !(yield* Effect.tryPromise(admit))) return;
            store?.record(frame);
            if (admit) {
              admissions.set(frame.eventId, admit);
              if (admissions.size > 1024) admissions.delete(admissions.keys().next().value!);
            }
            return yield* Effect.forEach(
              [...active.keys()],
              (id) => event(id, frame, admit).pipe(Effect.exit),
              {
                concurrency: 'unbounded',
              }
            ).pipe(
              Effect.flatMap((exits) => {
                const failed = exits.find(Exit.isFailure);
                return failed ? Effect.failCause(failed.cause) : Effect.void;
              })
            );
          }),
        remove: (id) => serialize(id, stop(id, true)),
        disable: (id) =>
          Effect.suspend(() => {
            trailing.delete(id);
            return serialize(id, stop(id));
          }),
        inspect: (id) => {
          const g = active.get(id);
          return {
            lifecycle:
              !g || g.faulted
                ? 'Faulted'
                : g.readyForReads || !g.spec.machineEntry
                  ? 'Running'
                  : 'Starting',
            installationId: g?.spec.installationId,
            machineDigest: g?.spec.machineDigest,
            instanceId: g && !g.faulted && !g.lease ? g.status.instanceId : undefined,
            pid: g?.status.pid,
            registrations: g?.registrations ?? [],
          };
        },
        tools: (id) => {
          const g = active.get(id);
          return !g?.running || g.faulted || g.lease ? [] : (g.tools ?? []);
        },
        logs: (id) => active.get(id)?.child?.ringBuffer ?? Effect.succeed(history.get(id) ?? []),
        invoke: (id, frame, execute, onDispatch) =>
          Effect.suspend(() => {
            const g = active.get(id),
              child = g?.child;
            if (
              !g ||
              !child ||
              (!g.running && !(g.readyForReads && frame.kind === 'query')) ||
              g.faulted
            )
              return Effect.fail({ code: 'plugin_faulted', message: 'Plugin unavailable' });
            let dispatched: string | undefined;
            return g.calls
              .invoke(
                frame.kind,
                (callId) => {
                  dispatched = callId;
                  onDispatch?.(callId);
                  const invocation = { type: 'invoke' as const, callId, ...frame };
                  g.origins.set(callId, {
                    origin: { type: 'invoke', frame: invocation, execute },
                    controller: new AbortController(),
                  });
                  return child.send(invocation).pipe(
                    Effect.mapError(() => ({
                      code: lostInvocationCode(frame.kind, 'exit'),
                      message: 'Plugin disconnected',
                    }))
                  );
                },
                (callId) =>
                  child
                    .send({ type: 'cancel', callId })
                    .pipe(Effect.timeoutOption(100), Effect.ignore)
              )
              .pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    if (dispatched) {
                      g.origins.get(dispatched)?.controller.abort();
                      g.origins.delete(dispatched);
                    }
                  })
                )
              );
          }),
      });
    })
  );

export const pluginHostLayer = makePluginHostLayer();
