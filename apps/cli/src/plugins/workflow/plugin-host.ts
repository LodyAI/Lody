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
type HostEvent = Extract<HostToChildFrame, { type: 'event' }>;
interface Api {
  broadcast: (frame: HostEvent, admit?: () => Promise<boolean>) => Effect.Effect<void, unknown>;
  event: (id: string, frame: HostEvent) => Effect.Effect<void, unknown>;
  reload: (spec: PluginLaunchSpec) => Effect.Effect<Status, unknown>;
  disable: (id: string) => Effect.Effect<void, unknown>;
  inspect: (id: string) => {
    instanceId?: number;
    installationId?: string;
    machineDigest?: string;
    lifecycle: string;
    pid?: number;
    registrations: string[];
  };
  logs: (id: string) => Effect.Effect<readonly string[]>;
  invoke: (id: string, frame: Invoke) => Effect.Effect<unknown, InvocationFailure>;
}
export class PluginHost extends Context.Service<PluginHost, Api>()('lody/plugins/PluginHost') {}
export const makePluginHostLayer = (
  worker = fileURLToPath(new URL('./plugin-worker.js', import.meta.url)),
  dispatch?: DispatchMachineHostCall
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
        faulted: boolean;
        calls: ReturnType<typeof makePluginInvocations>;
        lease?: ProcessReleaseFailed;
        running?: boolean;
        subscribed?: Set<string>;
        origins: Map<string, { origin: MachineHostOrigin; controller: AbortController }>;
        registrations?: string[];
        buffered: { frame: HostEvent; admit?: () => Promise<boolean> }[];
        eventTail?: Deferred.Deferred<void>;
        eventReply?: { id: string; reply: Deferred.Deferred<void, Error> };
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
      const stop = Effect.fnUntraced(function* (id: string) {
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
            yield* child
              .send({ type: 'shutdown', graceMs: 2000 })
              .pipe(Effect.andThen(child.exit), Effect.timeoutOption(2000), Effect.ignore);
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
      const deliverEvent = Effect.fnUntraced(function* (
        g: Generation,
        frame: HostEvent,
        admit?: () => Promise<boolean>
      ) {
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
            g.origins.set(frame.eventId, {
              origin: { type: 'event', frame },
              controller: new AbortController(),
            });
            g.eventReply = { id: frame.eventId, reply };
            yield* child
              .send(frame)
              .pipe(Effect.andThen(Deferred.await(reply)), Effect.timeout(30000));
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                g.origins.get(frame.eventId)?.controller.abort();
                g.origins.delete(frame.eventId);
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
              g.registrations = [
                ...f.handlers.map((h) => `${h.kind}: ${h.descriptorId}`),
                ...f.subscribedEvents.map((e) => `event: ${e}`),
              ];
              g.subscribed = new Set(f.subscribedEvents);
              g.origins.set('start', {
                origin: { type: 'start' },
                controller: new AbortController(),
              });
              yield* Deferred.succeed(ready, undefined);
            } else if (f.type === 'result' && phase === 'ready' && f.callId === 'start' && f.ok) {
              g.origins.get('start')?.controller.abort();
              g.origins.delete('start');
              phase = 'running';

              yield* Deferred.succeed(started, undefined);
            } else if (f.type === 'result' && g.eventReply?.id === f.callId) {
              if (f.ok) yield* Deferred.succeed(g.eventReply.reply, undefined);
              else yield* Deferred.fail(g.eventReply.reply, new Error('Plugin event failed'));
            } else if (f.type === 'result' && phase === 'running')
              yield* g.calls.settle(f.callId, f);
            else if (f.type === 'host_call') {
              const authority = g.origins.get(f.contextId);
              const instanceId = g.status.instanceId;
              if (!authority || !dispatch || !instanceId || g.faulted) {
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
          })
          .pipe(Effect.andThen(Deferred.await(ready)), Effect.timeout(10000));
        yield* child
          .send({ type: 'start' })
          .pipe(Effect.andThen(Deferred.await(started)), Effect.timeout(30000));
        while (g.buffered.length) {
          const frame = g.buffered.shift();
          if (frame) yield* deliverEvent(g, frame.frame, frame.admit);
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
      const event = (id: string, frame: HostEvent, admit?: () => Promise<boolean>) =>
        Effect.suspend(() => {
          const g = active.get(id);
          if (!g || g.faulted || !g.subscribed?.has(frame.eventType)) return Effect.void;
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
          Effect.forEach([...active.keys()], (id) => event(id, frame, admit).pipe(Effect.exit), {
            concurrency: 'unbounded',
          }).pipe(
            Effect.flatMap((exits) => {
              const failed = exits.find(Exit.isFailure);
              return failed ? Effect.failCause(failed.cause) : Effect.void;
            })
          ),
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
                : g.running || !g.spec.machineEntry
                  ? 'Running'
                  : 'Starting',
            installationId: g?.spec.installationId,
            machineDigest: g?.spec.machineDigest,
            instanceId: g && !g.faulted && !g.lease ? g.status.instanceId : undefined,
            pid: g?.status.pid,
            registrations: g?.registrations ?? [],
          };
        },
        logs: (id) => active.get(id)?.child?.ringBuffer ?? Effect.succeed(history.get(id) ?? []),
        invoke: (id, frame) =>
          Effect.suspend(() => {
            const g = active.get(id),
              child = g?.child;
            if (!g || !child || !g.running || g.faulted)
              return Effect.fail({ code: 'plugin_faulted', message: 'Plugin unavailable' });
            let dispatched: string | undefined;
            return g.calls
              .invoke(
                frame.kind,
                (callId) => {
                  dispatched = callId;
                  const invocation = { type: 'invoke' as const, callId, ...frame };
                  g.origins.set(callId, {
                    origin: { type: 'invoke', frame: invocation },
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
