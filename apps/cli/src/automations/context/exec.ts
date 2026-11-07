import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { Deferred, Effect } from 'effect';
import { spawnProcess } from '@lody/shared/node/process';

export interface AutomationExecInput {
  command: string;
  args?: string[];
  cwd?: string;
}

/** Execute within a caller-resolved Session directory. The environment is explicitly supplied by the owner. */
export const execAutomationCommand = Effect.fn('Automations.exec')(function* (
  input: AutomationExecInput,
  root: string,
  env: NodeJS.ProcessEnv
) {
  if (
    !input.command ||
    input.command.includes('\0') ||
    input.args?.some((arg) => arg.includes('\0'))
  )
    return yield* Effect.fail(new Error('AUTOMATION_EXEC_INVALID_COMMAND'));
  if (path.isAbsolute(input.cwd ?? '.'))
    return yield* Effect.fail(new Error('AUTOMATION_EXEC_INVALID_CWD'));
  const cwd = yield* Effect.tryPromise({
    try: async () => {
      const canonicalRoot = await realpath(root);
      const resolved = await realpath(path.resolve(canonicalRoot, input.cwd ?? '.'));
      const relative = path.relative(canonicalRoot, resolved);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        throw new Error('AUTOMATION_EXEC_INVALID_CWD');
      if (!(await stat(resolved)).isDirectory()) throw new Error('AUTOMATION_EXEC_INVALID_CWD');
      return resolved;
    },
    catch: () => new Error('AUTOMATION_EXEC_INVALID_CWD'),
  });
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const tooLarge = yield* Deferred.make<never, Error>();
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let bytes = 0;
      const collect = (target: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 128 * 1024) {
          Deferred.doneUnsafe(tooLarge, Effect.fail(new Error('AUTOMATION_EXEC_OUTPUT_TOO_LARGE')));
          return;
        }
        target.push(chunk);
      };
      const child = yield* spawnProcess({
        command: input.command,
        args: input.args ?? [],
        options: { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
        processGroup: true,
        onSpawned: (process) => {
          process.stdout?.on('data', collect(stdout));
          process.stderr?.on('data', collect(stderr));
        },
      });
      const exit = yield* Effect.raceFirst(child.exited, Deferred.await(tooLarge));
      // Release descendants before waiting for pipe closure: they may inherit stdout.
      yield* child.terminate({ graceMs: 2_000, killWaitMs: 2_000 });
      yield* Effect.raceFirst(child.closed, Deferred.await(tooLarge));
      const result = {
        exitCode: exit.code,
        signal: exit.signal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      };
      if (Buffer.byteLength(JSON.stringify(result)) > 128 * 1024)
        return yield* Effect.fail(new Error('AUTOMATION_EXEC_OUTPUT_TOO_LARGE'));
      return result;
    })
  );
});
