// Only this application boundary executes the Effect runtime.
import { mkdirSync, openSync, closeSync, readSync } from 'node:fs';
function readBounded(path: string, limit: number) {
  const fd = openSync(path, 'r');
  try {
    const bytes = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > limit) throw new Error('input-budget');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
  } finally {
    closeSync(fd);
  }
}
import { dirname, resolve } from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { runLabScenario } from './platform/scenario-runner';
import { inspectLabEvidence } from './platform/action-executor';
import { replayLabActions, minimizeLabActions } from './platform/repro-runner';
import { exploreLabAttacks, makeLabAttackPlanModel } from './platform/model-explorer';
const [command, output, plan] = process.argv.slice(2);
const main = Effect.gen(function* () {
  if (command === 'explore' && output && plan) {
    const directory = resolve(output);
    const configuration = JSON.parse(readBounded(resolve(plan), 1024 * 1024)) as {
      actors?: import('./pure/actor-config').LabActorConfiguration[];
      goal: string;
      maxPlans?: number;
    };
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const model = yield* makeLabAttackPlanModel({
          key: process.env.OPENAI_API_KEY ?? '',
          model: process.env.E2EE_LAB_MODEL ?? '',
        });
        yield* Effect.try({
          try: () => mkdirSync(directory, { mode: 0o700 }),
          catch: (cause) => cause,
        });
        return yield* exploreLabAttacks({ directory, model, ...configuration });
      })
    );
    console.log(JSON.stringify(result));
    process.exitCode = 0; // Diagnostic exploration never acts as a CI gate.
    return;
  }
  if ((command === 'replay' || command === 'minimize') && output && plan) {
    const pack = yield* Effect.try({
      try: () => JSON.parse(readBounded(resolve(output), 32 * 1024 * 1024)) as unknown,
      catch: (cause) => cause,
    });
    const directory = resolve(plan);
    if (command === 'replay') {
      yield* Effect.try({
        try: () => mkdirSync(directory, { mode: 0o700 }),
        catch: (cause) => cause,
      });
      const result = yield* replayLabActions({
        pack,
        directory,
        sourceDirectory: dirname(resolve(output)),
      });
      console.log(JSON.stringify(result));
      process.exitCode = result.reproduced ? 0 : 2;
    } else {
      const result = yield* minimizeLabActions({
        pack,
        directory,
        sourceDirectory: dirname(resolve(output)),
      });
      console.log(JSON.stringify(result));
      process.exitCode = 0;
    }
    return;
  }
  if (command === 'inspect' && output) {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(readBounded(resolve(output), 64 * 1024 * 1024)) as unknown,
      catch: (cause) => cause,
    });
    const artifact = yield* Effect.try({
      try: () => inspectLabEvidence(parsed),
      catch: (cause) => cause,
    });
    console.log(JSON.stringify(artifact));
    process.exitCode =
      artifact.run.verdict === 'pass' ? 0 : artifact.run.verdict === 'harness-error' ? 1 : 2;
    return;
  }
  if (command !== 'run' || !output) {
    console.error(
      'Usage: e2ee-lab explore <new-output-directory> <goal-and-actors.json> | run <new-output-directory> [actions.json] | inspect <evidence.json> | replay <evidence.json> <new-output-directory> | minimize <evidence.json> <new-output-directory>'
    );
    process.exitCode = 64;
    return;
  }
  const directory = resolve(output);
  const configuration = plan
    ? yield* Effect.try({
        try: () => {
          const body = readBounded(resolve(plan), 1024 * 1024);
          if (body.length > 1024 * 1024) throw new Error('plan-budget');
          const value = JSON.parse(body) as unknown;
          return Array.isArray(value)
            ? { actions: value }
            : (value as {
                actions: readonly unknown[];
                actors?: import('./pure/actor-config').LabActorConfiguration[];
              });
        },
        catch: (cause) => cause,
      })
    : undefined;
  yield* Effect.try({ try: () => mkdirSync(directory, { mode: 0o700 }), catch: (cause) => cause });
  const result = yield* runLabScenario({ directory, ...configuration });
  if (result.run.verdict === 'violation') {
    const minimized = yield* minimizeLabActions({
      pack: result,
      directory: resolve(directory, 'automatic-minimize'),
      sourceDirectory: directory,
      maxTrials: 16,
    });
    console.log(JSON.stringify({ automaticMinimize: minimized }));
  }
  console.log(
    JSON.stringify({
      directory,
      verdict: result.run.verdict,
      actions: result.run.observations.length,
      report: result.report,
      limits: result.limits,
    })
  );
  process.exitCode =
    result.run.verdict === 'pass' ? 0 : result.run.verdict === 'harness-error' ? 1 : 2;
});
const abort = new AbortController();
const stop = () => abort.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
const exit = await Effect.runPromiseExit(main, { signal: abort.signal });
process.off('SIGINT', stop);
process.off('SIGTERM', stop);
if (Exit.isFailure(exit)) {
  console.error(
    JSON.stringify({ error: 'Lab execution failed', cause: String(Cause.squash(exit.cause)) })
  );
  process.exitCode = 1;
}
