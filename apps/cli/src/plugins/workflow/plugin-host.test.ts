import { encryptedPluginDispatch } from '../machine-host-port';
import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { makePluginInvocations } from './plugin-invocations';
import { build } from 'esbuild';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
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
                yield* Queue.offer(messages, {
                  type: 'ready',
                  handlers: [],
                  subscribedEvents: [],
                  resumeEvents: [],
                  hasService: false,
                });
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
                yield* Queue.offer(messages, {
                  type: 'ready',
                  handlers: [],
                  subscribedEvents: [],
                  resumeEvents: [],
                  hasService: false,
                });
              if (f.type === 'start')
                yield* Queue.offer(messages, {
                  type: 'result',
                  callId: f.contextId,
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

it('serves nested host IPC during startup, drains events in order and preserves host denial', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-host-port-'));
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
      `const schema={safeParse:data=>({success:true,data})};export default {kind:'machine-plugin',register(m){const observed=[];let previous;m.query({id:'bind',scope:'machine',input:schema,output:schema},ctx=>{previous=ctx;return 'bound'});m.query({id:'reuse',scope:'machine',input:schema,output:schema},async()=>{try{await previous.lody.read(previous.machine,{id:'sessions'});return 'admitted'}catch(e){return e.code}});m.onStart(async ctx=>{const snap=await ctx.lody.unstable.readSnapshot({kind:'workspace-state',workspace:ctx.workspace});observed.push(Object.isFrozen(snap.items));});m.events.on('session.created',async(ctx,event)=>{observed.push(await ctx.lody.read(ctx.machine,{id:'sessions'},{value:event.value}));});m.query({id:'inspect',scope:'machine',input:schema,output:schema},async ctx=>{for(const op of [()=>ctx.lody.sessions.send(ctx.machine,{prompt:'test'}),()=>ctx.lody.execute(ctx.machine,{id:'sessionCreate'}, {})]){try{await op();observed.push('wrote input')}catch(e){observed.push(e.code)}}try{await ctx.lody.sessions.requestStop({workspaceId:'ws',machineId:'m',sessionId:'s'})}catch(e){observed.push(e.code)}return observed;});}}`
    );
    let started!: () => void, release!: () => void;
    const entered = new Promise<void>((r) => (started = r)),
      gate = new Promise<void>((r) => (release = r));
    const layer = makePluginHostLayer(
      worker,
      encryptedPluginDispatch(async (call) => {
        if (call.op === 'lody.unstable.readSnapshot' && call.origin.type === 'start') {
          started();
          await gate;
          return { items: [] };
        }
        if (call.op === 'lody.read' && call.origin.type === 'event') return call.payload.input;
        if (
          call.op === 'lody.execute' &&
          call.payload.descriptorId === 'sessionStop' &&
          call.origin.type === 'invoke'
        )
          throw Object.assign(new Error('denied'), { code: 'forbidden' });
        throw new Error('Unexpected host call');
      })
    ).pipe(Layer.provide(processLayer({})));
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        const boot = yield* host
          .reload({
            pluginId: 'loop',
            manifest: {
              id: 'loop',
              title: 'Loop',
              sdk: '^1.0.0',
              version: '1.0.0',
              machine: 'machine.mjs',
              permissions: ['unstable.rawState'],
            },
            machineEntry: entry,
            machineId: 'm',
            workspaceId: 'ws',
            config: {},
            dataDir: root,
          })
          .pipe(Effect.forkChild);
        yield* Effect.promise(() => entered);
        const query = {
          kind: 'query' as const,
          scope: 'machine' as const,
          target: { workspaceId: 'ws', machineId: 'm' },
          input: null,
          actorUserId: 'reader',
        };
        expect(yield* host.invoke('loop', { ...query, descriptorId: 'bind' })).toBe('bound');
        expect(yield* host.invoke('loop', { ...query, descriptorId: 'reuse' })).toBe('forbidden');
        for (const value of [1, 2])
          yield* host.broadcast({
            type: 'event',
            eventType: 'session.created',
            eventId: String(value),
            payload: { value },
          });
        release();
        yield* Fiber.join(boot);
        yield* host.broadcast({
          type: 'event',
          eventType: 'session.created',
          eventId: '3',
          payload: { value: 3 },
        });
        expect(
          yield* host.invoke('loop', {
            kind: 'query',
            descriptorId: 'inspect',
            scope: 'machine',
            target: { workspaceId: 'ws', machineId: 'm' },
            input: null,
            actorUserId: 'u',
          })
        ).toEqual([
          true,
          { value: 1 },
          { value: 2 },
          { value: 3 },
          'forbidden',
          'forbidden',
          'forbidden',
        ]);
      }).pipe(Effect.provide(layer))
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it('runs version hooks before start, composes event listeners, and aborts only the replaced service', async () => {
  const root = await mkdtemp(join(tmpdir(), 'plugin-lifecycle-'));
  try {
    const worker = join(root, 'worker.mjs'),
      entry = join(root, 'plugin.mjs');
    await build({
      entryPoints: [fileURLToPath(new URL('../plugin-worker-entry.ts', import.meta.url))],
      outfile: worker,
      bundle: true,
      platform: 'node',
      format: 'esm',
    });
    await writeFile(
      entry,
      `import {appendFileSync} from 'node:fs';import {join} from 'node:path';const record=(ctx,value)=>appendFileSync(join(ctx.dataDir,'journal'),value+'\\n');export default {kind:'machine-plugin',register(m){m.onUpgrade((ctx,v)=>record(ctx,v.fromVersion+'->'+v.toVersion));m.onStart(ctx=>record(ctx,'start'));m.service(async ctx=>{record(ctx,'serve');await new Promise(r=>ctx.signal.addEventListener('abort',r,{once:true}));record(ctx,'abort')});m.events.on('session.created',ctx=>record(ctx,'first'));m.events.on('session.created',ctx=>record(ctx,'second'));m.onUninstall(ctx=>record(ctx,'uninstall'));}}`
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const host = yield* PluginHost;
        const spec = {
          pluginId: 'hooks',
          machineEntry: entry,
          machineId: 'm',
          workspaceId: 'w',
          config: {},
          dataDir: root,
        };
        const manifest = {
          id: 'hooks',
          sdk: '^1.0.0',
          version: '1.0.0',
          title: 'Hooks',
          machine: 'plugin.mjs',
        };
        yield* host.reload({ ...spec, manifest });
        yield* host.event('hooks', {
          type: 'event',
          eventId: 'stable',
          eventType: 'session.created',
          payload: null,
        });
        yield* host.reload({ ...spec, manifest: { ...manifest, version: '2.0.0' } });
        yield* host.remove('hooks');
      }).pipe(Effect.provide(makePluginHostLayer(worker).pipe(Layer.provide(processLayer({})))))
    );
    const journal = (await readFile(join(root, 'journal'), 'utf8')).trim().split('\n');
    expect(journal.slice(0, 8)).toEqual([
      'start',
      'serve',
      'first',
      'second',
      'abort',
      '1.0.0->2.0.0',
      'start',
      'serve',
    ]);
    expect(journal.slice(8).sort()).toEqual(['abort', 'uninstall']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
