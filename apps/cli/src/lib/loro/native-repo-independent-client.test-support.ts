import { createInterface } from 'node:readline';
import { Effect, Layer } from 'effect';
import {
  IndependentNativeRepo,
  independentNativeRepoLayer,
} from '@lody/shared/node/native-repo-independent-host';
import { makeApplicationRuntime } from '@lody/shared/node/application-runtime';
import { readIndependentRun } from '@lody/shared/node/native-repo-independent-control';
import {
  nodeProcessLive,
  processLayer,
  terminateTree,
  squashProcessFailure,
  type ProcessTree,
} from '@lody/shared/node/process';

/** Synthetic OS client entry, never included in the production entry list. */
async function runClientLegacy() {
  const [dataDir, entry, binding = 'synthetic-account/workspace', handoff] = process.argv.slice(2);
  if (!dataDir || !entry) throw new Error('Missing synthetic host fixture arguments');
  const observed = new Set<ProcessTree>();
  let handedOff: ProcessTree | undefined;
  const owner = makeApplicationRuntime(
    independentNativeRepoLayer({
      dataDir,
      entry,
      executable: process.execPath,
      binding,
      ...(handoff === 'brokered-v1' ? { experimentalBrokeredHandoff: true as const } : {}),
    }).pipe(
      Layer.provide(
        processLayer({
          nodeProcess: {
            ...nodeProcessLive,
            observeTree: (tree) => {
              observed.add(tree);
            },
            handoffTree: (tree) => {
              observed.delete(tree);
              handedOff = tree;
            },
          },
        })
      )
    ),
    { project: squashProcessFailure, recover: (cause) => Effect.failCause(cause) }
  );
  const lease = await owner.runtime.runPromise(IndependentNativeRepo);
  const namespace = 'synthetic-independent';
  const room = { kind: 'flock' as const, id: 'synthetic:wf' };
  await lease.client.createRoom(namespace, room);
  process.stdout.write(
    JSON.stringify({
      type: 'ready',
      clientPid: process.pid,
      pid: lease.pid,
      engineRunId: lease.engineRunId,
      controlId: lease.controlId,
      ...(handoff === 'brokered-v1'
        ? { launcherPid: (await readIndependentRun(dataDir, binding)).launcherPid }
        : {}),
    }) + '\n'
  );
  const input = createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  input.on('line', (line) => {
    queue = queue
      .then(async () => {
        const command = JSON.parse(line) as {
          id: number;
          op: string;
          key?: string;
          value?: string;
        };
        let result: unknown;
        if (command.op === 'put' && command.key && command.value) {
          result = await lease.client.flockBatch(namespace, room, [
            { op: 'put', key: [command.key], value: command.value },
          ]);
        } else if (command.op === 'read' && command.key) {
          result = await lease.client.flockGet(namespace, room, [command.key]);
        } else if (command.op === 'lost') {
          await owner.runtime.runPromise(lease.lost);
          result = { lost: true };
        } else if (command.op === 'crash-host') {
          if (!handedOff) throw new Error('This synthetic client did not launch the data host');
          await Effect.runPromise(terminateTree(handedOff, { graceMs: 0, killWaitMs: 5_000 }));
          await owner.runtime.runPromise(lease.lost);
          result = { lost: true };
        } else if (command.op === 'retire-workspace') {
          await owner.runtime.runPromise(lease.retireWorkspace);
          result = { retired: true };
        } else if (command.op === 'close') {
          await owner.closeLegacy();
          let alive = false;
          for (const tree of observed) if (await Effect.runPromise(tree.isAlive)) alive = true;
          result = { closed: true, ownedExecutionTreeStillAlive: alive };
          input.close();
          process.stdin.destroy();
        } else throw new Error('Unsupported synthetic command');
        process.stdout.write(JSON.stringify({ type: 'reply', id: command.id, result }) + '\n');
      })
      .catch(async () => {
        process.stdout.write(JSON.stringify({ type: 'failed' }) + '\n');
        try {
          await owner.closeLegacy();
        } finally {
          input.close();
          process.stdin.destroy();
          process.exitCode = 1;
        }
      });
  });
}

void runClientLegacy().catch(() => {
  process.stdout.write(JSON.stringify({ type: 'failed' }) + '\n');
  process.exitCode = 1;
});
