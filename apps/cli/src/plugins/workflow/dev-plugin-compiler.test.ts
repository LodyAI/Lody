import { it, expect } from '@effect/vitest';
import { Effect, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { processLayer, nodeProcessLive } from '@lody/shared/node/process';
import { DevPluginCompiler } from './dev-plugin-compiler';

it.effect(
  'failed compilation retains last generation; the compiler stays warm between edits and reaps after inactivity',
  () =>
    Effect.gen(function* () {
      const root = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), 'dev-plugin-lease-'))),
        (p) => Effect.promise(() => rm(p, { recursive: true, force: true }))
      );
      let running = 0;
      let ok = true;
      const child = Effect.acquireRelease(
        Effect.sync(() => {
          running++;
          return {
            pid: 3,
            send: () => Effect.void,
            messages: Stream.fromEffect(
              Effect.sync(() =>
                ok
                  ? {
                      ok: true,
                      manifest: {
                        id: 'demo',
                        title: 'Demo',
                        sdk: '^1.0.0',
                        version: '1.0.0',
                        machine: 'machine.js',
                      },
                    }
                  : { ok: false, message: 'syntax error' }
              )
            ),
            exit: Effect.never,
            ringBuffer: Effect.succeed([]),
          };
        }),
        () =>
          Effect.sync(() => {
            running--;
          })
      );
      const layer = DevPluginCompiler.layer.pipe(
        Layer.provide(
          processLayer({ nodeProcess: { ...nodeProcessLive, spawnIpcChild: () => child } })
        )
      );
      yield* Effect.gen(function* () {
        const compiler = yield* DevPluginCompiler;
        yield* compiler.build(root, root);
        yield* TestClock.adjust('20 seconds');
        expect(running).toBe(1);
        ok = false;
        expect((yield* Effect.flip(compiler.build(root, root))).message).toBe('syntax error');
        expect((yield* Effect.promise(() => readdir(root))).length).toBe(1);
        yield* TestClock.adjust('20 seconds');
        expect(running).toBe(1);
        yield* TestClock.adjust('10 seconds');
        expect(running).toBe(0);
      }).pipe(Effect.provide(layer));
    })
);
