import { join } from 'node:path';
import { Effect } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { prepareDeepSeekNodeEnvironment } from './deepseek-system-node';
import { withFileLock } from '@/utils/file-lock';
import {
  dshProfileLockName,
  resolveDeepSeekHarnessSpawn,
  type resolveDeepSeekHarnessProcessLaunch,
} from './deepseek-harness-runtime';

/** Native CLI owns package semantics and failure recovery; Lody binds the Provider home. */
export const runDshPlugin = Effect.fnUntraced(function* (
  launch: Awaited<ReturnType<typeof resolveDeepSeekHarnessProcessLaunch>>,
  cwd: string,
  hostEnv: NodeJS.ProcessEnv = process.env
) {
  const rootDir = launch.env.DSH_HOME;
  const env = yield* prepareDeepSeekNodeEnvironment(
    {
      ...hostEnv,
      ...launch.env,
      npm_config_cache: join(rootDir, 'npm-cache'),
    },
    cwd
  );
  const command = resolveDeepSeekHarnessSpawn({ ...launch, env, workdir: cwd });
  return yield* withFileLock(
    dshProfileLockName(rootDir),
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command.command, command.args, {
          cwd,
          env,
          extendEnv: false,
          stdin: 'inherit',
          stdout: 'inherit',
          stderr: 'inherit',
        })
      );
      return yield* child.exitCode;
    }).pipe(Effect.scoped),
    { locksDir: join(rootDir, 'lody-locks'), timeout: 300_000 }
  );
});
