import { it, expect } from '@effect/vitest';
import { Deferred, Effect, Layer } from 'effect';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nodeProcessLive, processLayer, type ProcessExit } from '@lody/shared/node/process';
import { DevPluginCompiler } from '../src/plugins/workflow/dev-plugin-compiler';

it('reaps the real compiler after its last build without closing the daemon scope', () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const root = yield* Effect.acquireRelease(
          Effect.promise(() => mkdtemp(join(tmpdir(), 'compiler-reap-'))),
          (p) => Effect.promise(() => rm(p, { recursive: true, force: true }))
        );
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(
              join(root, 'lody.plugin.json'),
              JSON.stringify({
                id: 'demo',
                sdk: '^1.0.0',
                version: '1.0.0',
                title: 'Demo',
                machine: 'machine.ts',
              })
            ),
            writeFile(join(root, 'machine.ts'), 'export default {kind:"machine-plugin"}'),
          ])
        );
        const spawned = yield* Deferred.make<Effect.Effect<ProcessExit>>();
        const platform = processLayer({
          nodeProcess: {
            ...nodeProcessLive,
            spawnIpcChild: (spec) =>
              nodeProcessLive
                .spawnIpcChild({
                  ...spec,
                  args: [
                    ...spec.args.slice(0, -1),
                    '--import',
                    import.meta.resolve('tsx'),
                    fileURLToPath(
                      new URL('../src/plugins/plugin-compiler-worker.ts', import.meta.url)
                    ),
                  ],
                })
                .pipe(Effect.tap((child) => Deferred.succeed(spawned, child.exit))),
          },
        });
        yield* Effect.gen(function* () {
          const compiler = yield* DevPluginCompiler;
          const result = yield* compiler.build(root, join(root, 'out'));
          expect(result.machineDigest).toBeTruthy();
          const exited = yield* Deferred.await(spawned);
          yield* exited;
        }).pipe(Effect.provide(DevPluginCompiler.layer.pipe(Layer.provide(platform))));
      })
    )
  ));
