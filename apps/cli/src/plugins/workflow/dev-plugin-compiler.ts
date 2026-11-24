import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { watch } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Cause,
  Queue,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  RcRef,
  Semaphore,
  Stream,
} from 'effect';
import { z } from 'zod';
import { NodeProcess } from '@lody/shared/node/process';
import { pluginManifestSchema, type PluginManifest } from '@lody/shared/plugins/manifest-schema';
import { getCliNodeExecutable } from '@/lib/managed-daemon-release';

export interface PluginBuild {
  manifest: PluginManifest;
  directory: string;
  machineEntry?: string;
  machineDigest?: string;
  clientDigest?: string;
}
const diagnostic = z.object({
  message: z.string(),
  file: z.string().optional(),
  line: z.number().optional(),
  column: z.number().optional(),
});
export class PluginBuildError extends Error {
  constructor(
    message: string,
    readonly diagnostics: ReadonlyArray<z.infer<typeof diagnostic>>
  ) {
    super(message);
    this.name = 'PluginBuildError';
  }
}
const reply = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    manifest: pluginManifestSchema,
    machineDigest: z.string().optional(),
    clientDigest: z.string().optional(),
  }),
  z.object({
    ok: z.literal(false),
    message: z.string(),
    diagnostics: z.array(diagnostic).default([]),
  }),
]);
const error = (cause: unknown) => (cause instanceof Error ? cause : new Error(String(cause)));
const io = <T>(f: () => Promise<T>) => Effect.tryPromise({ try: f, catch: error });
export class DevPluginCompiler extends Context.Service<
  DevPluginCompiler,
  { build: (sourceDir: string, outputRoot: string) => Effect.Effect<PluginBuild, Error> }
>()('lody/plugins/DevPluginCompiler') {
  static readonly layer = Layer.effect(
    DevPluginCompiler,
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      const env: NodeJS.ProcessEnv = {};
      for (const key of [
        'PATH',
        'HOME',
        'TMPDIR',
        'LANG',
        'TZ',
        'SYSTEMROOT',
        'ELECTRON_RUN_AS_NODE',
      ])
        if (process.env[key]) env[key] = process.env[key];
      const processes = yield* NodeProcess;
      const lease = yield* RcRef.make({
        acquire: processes.spawnIpcChild({
          command: getCliNodeExecutable(),
          args: [
            '--max-old-space-size=256',
            fileURLToPath(new URL('./plugin-compiler-worker.js', import.meta.url)),
          ],
          options: { env },
        }),
        idleTimeToLive: 1000,
      });
      const build = Effect.fn('DevPluginCompiler.build')(
        function* (sourceDir: string, outputRoot: string) {
          yield* io(() => mkdir(outputRoot, { recursive: true }));
          const stage = yield* Effect.acquireRelease(
            io(() => mkdtemp(join(outputRoot, '.stage-'))),
            (p) => io(() => rm(p, { recursive: true, force: true })).pipe(Effect.orDie)
          );
          const child = yield* RcRef.get(lease);
          const result = yield* Effect.gen(function* () {
            yield* child.send({ sourceDir, stage });
            const frame = yield* Stream.runHead(child.messages);
            if (Option.isNone(frame))
              return yield* Effect.fail(new Error('Compiler exited without a result'));
            const parsed = reply.safeParse(frame.value);
            if (!parsed.success) return yield* Effect.fail(parsed.error);
            return parsed.data;
          }).pipe(
            Effect.onExit((exit) => (Exit.isFailure(exit) ? RcRef.invalidate(lease) : Effect.void))
          );
          if (!result.ok)
            return yield* Effect.fail(new PluginBuildError(result.message, result.diagnostics));
          const directory = join(outputRoot, randomUUID());
          yield* io(() => rename(stage, directory));
          return {
            directory,
            manifest: result.manifest,
            machineDigest: result.machineDigest,
            clientDigest: result.clientDigest,
            machineEntry: result.manifest.machine
              ? join(directory, result.manifest.machine)
              : undefined,
          };
        },
        Effect.scoped,
        lock.withPermits(1),
        Effect.mapError(error)
      );
      return DevPluginCompiler.of({ build });
    })
  );
}
export function watchPluginSources(sourceDir: string) {
  return Stream.callback<void, Error>(
    (queue) =>
      Effect.acquireRelease(
        Effect.try({
          try: () => {
            const watcher = watch(sourceDir, { recursive: true }, (_, filename) => {
              if (!filename?.split(/[\\/]/).some((p) => p === '.git' || p === 'node_modules'))
                Queue.offerUnsafe(queue, undefined);
            });
            watcher.on('error', (e) => Queue.failCauseUnsafe(queue, Cause.fail(error(e))));
            return watcher;
          },
          catch: error,
        }),
        (watcher) => Effect.sync(() => watcher.close())
      ),
    { bufferSize: 1, strategy: 'sliding' }
  ).pipe(Stream.debounce(150));
}
