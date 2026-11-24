import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { makePluginInvocations } from './plugin-invocations';
import { build } from 'esbuild';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Layer } from 'effect';
import { processLayer } from '@lody/shared/node/process';
import { PluginHost, makePluginHostLayer } from './plugin-host';
import { Queue, Stream } from 'effect';
import { nodeProcessLive, type NodeProcessApi } from '@lody/shared/node/process';
import { hostToChildSchema } from '@lody/shared/plugins/ipc-protocol';
import { FakeProcessTable } from '@lody/shared/node/process-testing';
import { ProcessReleaseFailed, TerminationFailed } from '@lody/shared/node/process';

describe('machine invocation ownership', () => {
  it.effect('settles a dispatched mutation as uncertain when its generation exits', () =>
    Effect.gen(function* () {
      const owner = makePluginInvocations();
      const sent = yield* Deferred.make<string>();
      const call = yield* owner
        .invoke(
          'mutation',
          (id) => Deferred.succeed(sent, id).pipe(Effect.asVoid),
          () => Effect.void
        )
        .pipe(Effect.flip, Effect.forkChild);
      const id = yield* Deferred.await(sent);
      yield* owner.close();
      yield* owner.settle(id, { ok: true, data: 'late' });
      expect((yield* Fiber.join(call)).code).toBe('outcome_unknown');
    })
  );
  it.effect('a tool keeps the longer deadline, then cancels the exact call without replay', () =>
    Effect.gen(function* () {
      const owner = makePluginInvocations();
      const sent = yield* Deferred.make<string>();
      const cancelled = yield* Deferred.make<string>();
      const call = yield* owner
        .invoke(
          'tool',
          (id) => Deferred.succeed(sent, id).pipe(Effect.asVoid),
          (id) => Deferred.succeed(cancelled, id).pipe(Effect.asVoid)
        )
        .pipe(Effect.flip, Effect.forkChild);
      const id = yield* Deferred.await(sent);
      yield* TestClock.adjust(599999);
      expect(yield* Deferred.isDone(cancelled)).toBe(false);
      yield* TestClock.adjust(1);
      expect(yield* Deferred.await(cancelled)).toBe(id);
      expect((yield* Fiber.join(call)).code).toBe('outcome_unknown');
    })
  );
});

it('runs a machine query, reuses its pid after a client edit, and contains a crashing mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lody-machine-plugin-'));
  try {
    const worker = join(root, 'worker.mjs'),
      entry = join(root, 'machine.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../plugin-worker-entry.ts', import.meta.url))],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    await writeFile(
      entry,
      `const input={safeParse:data=>({success:data===null,data})},output={safeParse:data=>({success:typeof data==='number',data})};export default {kind:'machine-plugin',register(machine){machine.query({id:'generation',scope:'machine',input,output},()=>process.pid);machine.mutation({id:'crash',scope:'machine',input,output},()=>process.exit(12));machine.mutation({id:'heap',scope:'machine',input,output},()=>{const retained=[];for(;;)retained.push(new Array(1000000).fill(1));});return ()=>{while(true){}};}}`
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        const spec = {
          pluginId: 'example',
          workspaceId: 'workspace',
          machineId: 'machine',
          config: {},
          dataDir: root,
          machineEntry: entry,
          machineDigest: 'one',
        };
        const first = yield* host.reload(spec);
        expect(first.pid).toBeGreaterThan(0);
        const second = yield* host.reload({
          ...spec,
          machineEntry: join(root, 'new-stage.mjs'),
          clientDigest: 'client-edit',
        });
        expect(second).toEqual({ ...first, clientDigest: 'client-edit' });
        const base = {
          scope: 'machine' as const,
          target: { machineId: 'machine', workspaceId: 'workspace' },
          input: null,
          actorUserId: 'user',
        };
        expect(
          yield* host.invoke('example', { ...base, kind: 'query', descriptorId: 'generation' })
        ).toBe(first.pid);
        expect(
          (yield* Effect.flip(
            host.invoke('example', { ...base, kind: 'mutation', descriptorId: 'crash' })
          )).code
        ).toBe('outcome_unknown');
        yield* host.disable('example');
        expect(yield* host.logs('example')).toContain('Plugin worker disconnected');
        const sibling = yield* host.reload({ ...spec, pluginId: 'sibling' });
        expect(
          (yield* Effect.flip(
            host.invoke('sibling', {
              ...base,
              kind: 'query',
              descriptorId: 'generation',
              input: 'invalid',
            })
          )).code
        ).toBe('validation_failed');

        const replacement = yield* host.reload(spec);
        expect(replacement.instanceId).not.toBe(first.instanceId);
        expect(
          (yield* Effect.flip(
            host.invoke('example', { ...base, kind: 'mutation', descriptorId: 'heap' })
          )).code
        ).toBe('outcome_unknown');
        yield* host.disable('example');
        expect((yield* host.logs('example')).join('\n')).toMatch(/heap limit|out of memory/i);
        expect(
          yield* host.invoke('sibling', { ...base, kind: 'query', descriptorId: 'generation' })
        ).toBe(sibling.pid);
        const hung = yield* host.reload(spec);
        yield* host.disable('example');
        expect(() => process.kill(hung.pid!, 0)).toThrowError(
          expect.objectContaining({ code: 'ESRCH' })
        );
        expect((yield* host.reload(spec)).instanceId).not.toBe(hung.instanceId);
        yield* Effect.flip(
          host.invoke('example', { ...base, kind: 'mutation', descriptorId: 'crash' })
        );
      }).pipe(Effect.provide(makePluginHostLayer(worker).pipe(Layer.provide(processLayer({})))))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const [stuck, deadline] of [
  ['init', 10000],
  ['start', 30000],
] as const) {
  it.effect(`drains a machine stuck in ${stuck} at the handshake deadline`, () =>
    Effect.gen(function* () {
      const arrived = yield* Deferred.make<void>();
      const shutdown = yield* Deferred.make<void>();
      const messages = yield* Queue.unbounded<unknown>();
      const spawnIpcChild: NodeProcessApi['spawnIpcChild'] = () =>
        Effect.succeed({
          pid: 101,
          messages: Stream.fromQueue(messages),
          exit: Effect.succeed({ code: 0, signal: null }),
          ringBuffer: Effect.succeed([]),
          send: (raw) =>
            Effect.gen(function* () {
              const frame = hostToChildSchema.parse(raw);
              if (frame.type === stuck) yield* Deferred.succeed(arrived, undefined);
              else if (frame.type === 'init')
                yield* Queue.offer(messages, { type: 'ready', handlers: [], subscribedEvents: [] });
              else if (frame.type === 'shutdown') yield* Deferred.succeed(shutdown, undefined);
            }),
        });
      const run = Effect.gen(function* () {
        const h = yield* PluginHost;
        const launch = yield* h
          .reload({
            pluginId: 'hung',
            workspaceId: 'w',
            machineId: 'm',
            dataDir: '/tmp',
            config: {},
            machineEntry: 'machine.js',
          })
          .pipe(Effect.flip, Effect.forkChild);
        yield* Deferred.await(arrived);
        yield* TestClock.adjust(deadline - 1);
        expect(yield* Deferred.isDone(shutdown)).toBe(false);
        yield* TestClock.adjust(1);
        yield* Deferred.await(shutdown);
        expect(yield* Fiber.join(launch)).toBeDefined();
      });
      yield* run.pipe(
        Effect.provide(
          makePluginHostLayer().pipe(
            Layer.provide(processLayer({ nodeProcess: { ...nodeProcessLive, spawnIpcChild } }))
          )
        )
      );
    })
  );
}

it.effect('fences replacement behind the unreleased tree, even after its IPC worker exited', () =>
  Effect.gen(function* () {
    const table = new FakeProcessTable();
    let alive = true;
    let generations = 0;
    const failure = new TerminationFailed({
      target: 'plugin',
      reason: 'still-alive',
      message: 'descendant still alive',
    });
    const spawnIpcChild: NodeProcessApi['spawnIpcChild'] = () =>
      Effect.gen(function* () {
        const pid = ++generations;
        const messages = yield* Queue.unbounded<unknown>();
        const exited = Effect.succeed({ code: 0, signal: null });
        if (pid === 1) {
          const child = table.api.spawn('node', [], {});
          const lease = new ProcessReleaseFailed(
            {
              child,
              tree: {
                description: 'plugin',
                isAlive: Effect.sync(() => alive),
                signal: () => Effect.fail(failure),
              },
              started: Effect.succeed(pid),
              exited,
              closed: exited,
              terminate: () => Effect.fail(failure),
            },
            { graceMs: 0, killWaitMs: 0 },
            failure
          );
          yield* Effect.addFinalizer(() => Effect.die(lease));
        }
        return {
          pid,
          messages: Stream.fromQueue(messages),
          exit: exited,
          ringBuffer: Effect.succeed([]),
          send: (
            raw: Parameters<Effect.Success<ReturnType<NodeProcessApi['spawnIpcChild']>>['send']>[0]
          ) =>
            Effect.gen(function* () {
              const f = hostToChildSchema.parse(raw);
              if (f.type === 'init')
                yield* Queue.offer(messages, { type: 'ready', handlers: [], subscribedEvents: [] });
              if (f.type === 'start')
                yield* Queue.offer(messages, {
                  type: 'result',
                  callId: 'start',
                  ok: true,
                  data: null,
                });
            }),
        };
      });
    yield* Effect.gen(function* () {
      const host = yield* PluginHost;
      const first = {
        pluginId: 'owner',
        workspaceId: 'w',
        machineId: 'm',
        dataDir: '/tmp',
        config: {},
        machineEntry: 'v1',
      };
      const replacement = { ...first, machineEntry: 'v2' };
      expect((yield* host.reload(first)).pid).toBe(1);
      expect(yield* Effect.flip(host.reload(replacement))).toBeInstanceOf(ProcessReleaseFailed);
      expect(yield* Effect.flip(host.reload(replacement))).toBeInstanceOf(TerminationFailed);
      expect(generations).toBe(1);
      alive = false;
      expect((yield* host.reload(replacement)).pid).toBe(2);
    }).pipe(
      Effect.provide(
        makePluginHostLayer().pipe(
          Layer.provide(processLayer({ nodeProcess: { ...nodeProcessLive, spawnIpcChild } }))
        )
      )
    );
  })
);
