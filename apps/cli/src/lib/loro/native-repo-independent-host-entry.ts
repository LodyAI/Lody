import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIndependentNativeRepoController } from '@lody/shared/node/native-repo-independent-runtime';
import { launchIndependentRepoBroker } from '@lody/shared/node/native-repo-independent-host';
import { Effect } from 'effect';
import { processLayer, squashProcessFailure } from '@lody/shared/node/process';

try {
  const dataDir = process.argv[2];
  const startupId = process.argv[3];
  if (!dataDir || !startupId) throw new Error('Missing independent native Repo launch identity');
  const mode = process.argv[4];
  if (mode === '--launch-broker') {
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        launchIndependentRepoBroker({
          dataDir,
          startupId,
          executable: process.execPath,
          entry: fileURLToPath(import.meta.url),
        })
      ).pipe(Effect.provide(processLayer({})))
    );
    if (exit._tag === 'Failure') throw squashProcessFailure(exit.cause);
  } else {
    if (mode !== undefined && mode !== '--brokered-controller')
      throw new Error('Invalid independent host mode');
    await runIndependentNativeRepoController({
      dataDir,
      startupId,
      workerEntry: path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        'native-repo-independent-engine.js'
      ),
      ...(mode === '--brokered-controller' ? { brokeredHandoff: true as const } : {}),
    });
  }
} catch {
  process.stderr.write('Independent native Repo host failed\n');
  process.exit(70);
}
