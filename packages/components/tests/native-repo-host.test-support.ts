import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Cause, Context, Deferred, Effect, Exit, Layer } from 'effect';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import type { IndependentNativeRepoLease } from '@lody/shared/node/native-repo-independent-host';
import {
  spawnProcess,
  processLayer,
  ProcessReleaseFailed,
  runCommandOk,
  type ManagedProcess,
} from '@lody/shared/node/process';

type Client = IndependentNativeRepoLease['client'];
export type NativeRepoTestHost = {
  readonly client: Client;
  readonly pid: number;
  /** Joins actual SDK/OS release. Never deletes the caller's engine dataDir. */
  close(): Promise<void>;
};
/** Startup failed with an outstanding cleanup owner. The caller must retain this
 * error/retry closure rather than replacing an unconfirmed process/storage scope. */
export class NativeRepoTestHostOpenFailed extends AggregateError {
  constructor(
    startup: unknown,
    cleanup: unknown,
    readonly retryCleanup: () => Promise<void>
  ) {
    super([startup, cleanup], 'Native test host startup and cleanup failed');
  }
}

const electronPackage = path.resolve(import.meta.dirname, '../../../apps/electron/package.json');
const sdk = createRequire(electronPackage);
const { connectEngine } = sdk('@loro-dev/loro-repo-client/node') as {
  connectEngine(dataDir: string, options: { autoReconnect: false }): Promise<Client>;
};
const hostEnvironment = (): NodeJS.ProcessEnv => ({
  ELECTRON_RUN_AS_NODE: '1',
  ...Object.fromEntries(
    ['PATH', 'SystemRoot', 'TMPDIR', 'TMP', 'TEMP'].flatMap((key) =>
      process.env[key] === undefined ? [] : [[key, process.env[key]]]
    )
  ),
});
const transferredReleases = (cause: Cause.Cause<unknown>) =>
  cause.reasons.flatMap((reason) =>
    Cause.isDieReason(reason) && reason.defect instanceof ProcessReleaseFailed
      ? [reason.defect]
      : []
  );
class FixtureRepoHost extends Context.Service<
  FixtureRepoHost,
  {
    client: Client;
    child: ManagedProcess['child'];
  }
>()('tests/components/NativeRepoHost') {}

const fixtureHostLayer = (
  entry: string,
  dataDir: string,
  onChild: (child: ManagedProcess['child']) => void
) =>
  Layer.effect(
    FixtureRepoHost,
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void, Error>();
      let detach = () => {};
      yield* Effect.addFinalizer(() => Effect.sync(() => detach()));
      const child = yield* spawnProcess({
        command: process.execPath,
        args: [entry, dataDir],
        processGroup: true,
        options: {
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          windowsHide: true,
          env: hostEnvironment(),
        },
        onSpawned(handle) {
          onChild(handle);
          const message = (value: unknown) => {
            if (
              value &&
              typeof value === 'object' &&
              'type' in value &&
              value.type === 'ready' &&
              'version' in value &&
              value.version === '0.1.0'
            )
              Deferred.doneUnsafe(ready, Effect.void);
          };
          const failed = () =>
            Deferred.doneUnsafe(
              ready,
              Effect.fail(new Error('Native fixture exited before readiness'))
            );
          handle.on('message', message);
          handle.once('error', failed);
          handle.once('exit', failed);
          detach = () => {
            handle.off('message', message);
            handle.off('error', failed);
            handle.off('exit', failed);
          };
        },
      });
      yield* child.started;
      yield* Deferred.await(ready).pipe(Effect.timeout('15 seconds'));
      const client = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => connectEngine(dataDir, { autoReconnect: false }),
          catch: (cause) => cause,
        }),
        (value) => Effect.promise(() => value.close())
      );
      return { client, child: child.child };
    }).pipe(Effect.timeout('25 seconds'))
  ).pipe(Layer.provide(processLayer({})));

/**
 * No test hooks or cached lifetime: each caller owns its compiled entry and Scope.
 * Native NAPI loads only in the real Node child. SDK/client requests are not mocked.
 * The caller deletes its synthetic dataDir only after successful close. A fatal
 * native signal keeps close failed on retry so that evidence cannot be erased.
 */
export async function openNativeRepoTestHost(dataDir: string): Promise<NativeRepoTestHost> {
  if (!path.isAbsolute(dataDir))
    throw new Error('Native fixture requires an absolute owned dataDir');
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'native-repo-test-host-'));
  const entry = path.join(output, 'native-repo-host.mjs');
  const removeOutput = () => fs.rm(output, { recursive: true, force: true });
  try {
    // esbuild checks its TextEncoder/Uint8Array realm at module load. A jsdom
    // worker cannot safely require it; build in a real, bounded Node process.
    const builder = path.join(output, 'build-host.cjs');
    await fs.writeFile(
      builder,
      `
const sdk = require('node:module').createRequire(process.argv[2]);
const esbuild = sdk('esbuild');
esbuild.build({
  entryPoints: [process.argv[3]], outfile: process.argv[4],
  bundle: true, platform: 'node', format: 'esm', target: 'node26',
  plugins: [{ name: 'absolute-native-addon', setup(build) {
    build.onResolve({filter: /^@loro-dev\\/loro-repo-engine$/}, () => ({
      path: sdk.resolve('@loro-dev/loro-repo-engine'), external: true
    }));
  }}]
}).then(() => esbuild.stop(), error => {
  console.error(error); esbuild.stop(); process.exitCode = 70;
});
`,
      { encoding: 'utf8', mode: 0o600 }
    );
    const built = await Effect.runPromiseExit(
      runCommandOk({
        command: process.execPath,
        args: [
          builder,
          electronPackage,
          path.resolve(
            import.meta.dirname,
            '../../../apps/cli/src/lib/loro/native-repo-host-entry.ts'
          ),
          entry,
        ],
        env: hostEnvironment(),
        timeout: 15_000,
        maxOutputBytes: 8 * 1024,
      }).pipe(Effect.provide(processLayer({})))
    );
    if (Exit.isFailure(built)) {
      const startup = new Error('Native test host build failed', { cause: built.cause });
      const releases = transferredReleases(built.cause);
      if (releases.length)
        throw new NativeRepoTestHostOpenFailed(startup, built.cause, async () => {
          await Effect.runPromise(
            Effect.forEach(releases, (release) => release.retryTermination(), { discard: true })
          );
          await removeOutput();
        });
      throw startup;
    }
  } catch (startup) {
    if (startup instanceof NativeRepoTestHostOpenFailed) throw startup;
    try {
      await removeOutput();
    } catch (cleanup) {
      throw new NativeRepoTestHostOpenFailed(startup, cleanup, removeOutput);
    }
    throw startup;
  }
  let child: ManagedProcess['child'] | undefined;
  const owner = makeApplicationRuntime(
    fixtureHostLayer(entry, dataDir, (value) => {
      child = value;
    }),
    {
      project: (cause) => new Error('Native fixture process failed', { cause }),
      recover: (cause) => {
        const releases = transferredReleases(cause);
        return releases.length
          ? Effect.forEach(releases, (release) => release.retryTermination(), { discard: true })
          : Effect.failCause(cause);
      },
    }
  );
  let closed = false;
  let fatal: Error | undefined;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (fatal) return Promise.reject(fatal);
    if (closed) return Promise.resolve();
    if (closing) return closing;
    closing = (async () => {
      await owner.closeLegacy();
      if (!owner.isReleased() || (child && child.exitCode === null && child.signalCode === null))
        throw new Error('Native fixture process exit remains unconfirmed');
      if (
        child?.signalCode &&
        ['SIGBUS', 'SIGSEGV', 'SIGABRT', 'SIGILL'].includes(child.signalCode)
      ) {
        fatal = new Error(
          `Native fixture crashed (${child.signalCode}); retained dataDir=${dataDir}, helper=${output}`
        );
        throw fatal;
      }
      await removeOutput();
      closed = true;
    })().finally(() => {
      closing = undefined;
    });
    return closing;
  };
  try {
    const host = await owner.runtime.runPromise(FixtureRepoHost);
    if (!host.child.pid || host.child.pid === process.pid)
      throw new Error('Native fixture must run in its own OS process');
    const endpoint = JSON.parse(await fs.readFile(path.join(dataDir, 'engine.json'), 'utf8')) as {
      pid: number;
    };
    if (endpoint.pid !== host.child.pid)
      throw new Error('Native fixture connected to an unexpected engine process');
    const images = (process.report.getReport() as { sharedObjects?: string[] }).sharedObjects ?? [];
    if (
      images.some(
        (image) => path.basename(image).startsWith('loro-repo-engine.') && image.endsWith('.node')
      )
    )
      throw new Error('Native engine addon must not load in the test runner');
    return { client: host.client, pid: host.child.pid, close };
  } catch (startup) {
    try {
      await close();
    } catch (cleanup) {
      throw new NativeRepoTestHostOpenFailed(startup, cleanup, close);
    }
    throw startup;
  }
}
