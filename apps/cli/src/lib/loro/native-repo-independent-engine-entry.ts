import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { loadNativeRepoSdkCompatibility } from '@lody/shared/node/native-repo-sdk-compatibility';

const options = z
  .object({ dataDir: z.string().min(1) })
  .strict()
  .parse(workerData);
const sdk = await loadNativeRepoSdkCompatibility(import.meta.url);
// Resolve and load through the same closure whose package/binary proof was checked.
// A bundle's external-import rewrite must not select a different addon.
const { startEngine, engineVersion } = createRequire(import.meta.url)(
  '@loro-dev/loro-repo-engine'
) as typeof import('@loro-dev/loro-repo-engine');
const version = engineVersion();
if (version.package !== '0.1.0' || version.protocol !== 2)
  throw new Error('Unsupported independent native Repo engine');
const engine = startEngine({ dataDir: options.dataDir });
parentPort?.postMessage({
  type: 'ready',
  engineRunId: engine.endpoint.runId,
  version: version.package,
  protocol: version.protocol,
  ...(sdk ? { sdkArtifactId: sdk.artifactId } : {}),
});
parentPort?.on('message', (value: unknown) => {
  if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'stop') return;
  engine.stop();
  parentPort?.postMessage({ type: 'stopped' });
  parentPort?.close();
});
