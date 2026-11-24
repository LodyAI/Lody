import { fileURLToPath } from 'node:url';
import { Cause, Context, Deferred, Effect, Exit, Layer, Scope, Stream } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { NodeProcess, ProcessReleaseFailed } from '@lody/shared/node/process';
import { childToHostSchema, type HostToChildFrame } from '@lody/shared/plugins/ipc-protocol';
import { lostInvocationCode } from '../pure/call-policy';
import { makePluginInvocations, type InvocationFailure } from './plugin-invocations';

import type { PluginManifest } from '@lody/shared/plugins/manifest-schema';

type Init = Extract<HostToChildFrame, { type: 'init' }>;
type Invoke = Omit<Extract<HostToChildFrame, { type: 'invoke' }>, 'type' | 'callId'>;
export interface PluginLaunchSpec {
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
  event: (id: string, frame: HostEvent) => Effect.Effect<void, unknown>;
  reload: (spec: PluginLaunchSpec) => Effect.Effect<Status, unknown>;
  disable: (id: string) => Effect.Effect<void, unknown>;
  logs: (id: string) => Effect.Effect<readonly string[]>;
  invoke: (id: string, frame: Invoke) => Effect.Effect<unknown, InvocationFailure>;
}
export class PluginHost extends Context.Service<PluginHost, Api>()('lody/plugins/PluginHost') {}
export const makePluginHostLayer = (
  worker = fileURLToPath(new URL('./plugin-worker.js', import.meta.url))
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
        buffered: HostEvent[];
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
      const deliverEvent = Effect.fnUntraced(function* (g: Generation, frame: HostEvent) {
        const previous = g.eventTail;
        const done = yield* Deferred.make<void>();
        g.eventTail = done;
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            if (previous) yield* Deferred.await(previous);
            const child = g.child;
            if (!child || g.faulted) return;
            const reply = yield* Deferred.make<void, Error>();
            g.eventReply = { id: frame.eventId, reply };
            yield* child
              .send(frame)
              .pipe(Effect.andThen(Deferred.await(reply)), Effect.timeout(30000));
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
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
          buffered: [],
        };
        active.set(id, g);
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
              g.subscribed = new Set(f.subscribedEvents);
              yield* Deferred.succeed(ready, undefined);
            } else if (f.type === 'result' && phase === 'ready' && f.callId === 'start' && f.ok) {
              phase = 'running';

              yield* Deferred.succeed(started, undefined);
            } else if (f.type === 'result' && g.eventReply?.id === f.callId) {
              if (f.ok) yield* Deferred.succeed(g.eventReply.reply, undefined);
              else yield* Deferred.fail(g.eventReply.reply, new Error('Plugin event failed'));
            } else if (f.type === 'result' && phase === 'running')
              yield* g.calls.settle(f.callId, f);
            else if (f.type === 'host_call')
              yield* child.send({
                type: 'host_result',
                hostCallId: f.hostCallId,
                ok: false,
                error: { code: 'forbidden', message: 'Host operation unavailable' },
              });
            else if (f.type !== 'invalidate')
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
          if (frame) yield* deliverEvent(g, frame);
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
      return PluginHost.of({
        reload,
        event: (id, frame) =>
          Effect.suspend(() => {
            const g = active.get(id);
            if (!g || g.faulted || !g.subscribed?.has(frame.eventType)) return Effect.void;
            if (!g.running) {
              g.buffered.push(frame);
              return Effect.void;
            }
            return deliverEvent(g, frame);
          }),
        disable: (id) =>
          Effect.suspend(() => {
            trailing.delete(id);
            return serialize(id, stop(id));
          }),
        logs: (id) => active.get(id)?.child?.ringBuffer ?? Effect.succeed(history.get(id) ?? []),
        invoke: (id, frame) =>
          Effect.suspend(() => {
            const g = active.get(id),
              child = g?.child;
            if (!g || !child || !g.running || g.faulted)
              return Effect.fail({ code: 'plugin_faulted', message: 'Plugin unavailable' });
            return g.calls.invoke(
              frame.kind,
              (callId) =>
                child.send({ type: 'invoke', callId, ...frame }).pipe(
                  Effect.mapError(() => ({
                    code: lostInvocationCode(frame.kind, 'exit'),
                    message: 'Plugin disconnected',
                  }))
                ),
              (callId) =>
                child
                  .send({ type: 'cancel', callId })
                  .pipe(Effect.timeoutOption(100), Effect.ignore)
            );
          }),
      });
    })
  );

export const pluginHostLayer = makePluginHostLayer();
