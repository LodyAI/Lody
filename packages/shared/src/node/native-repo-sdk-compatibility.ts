import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

declare const __LODY_LOCAL_REPO_SDK_ARTIFACT__: string;

export type NativeRepoSdkCompatibility = {
  readonly artifactId: string;
  readonly setValue: true;
  readonly losslessWireI64: true;
  readonly rawFlockExport: true;
  readonly flockStateEntries?: true;
};

/** Read from the actual Node application's dependency closure, never a renderer
 * DTO or a semver inference. Published 0.1.0 returns no new-feature proof. The
 * host must additionally bind artifactId to its actual engine generation. */
export async function loadNativeRepoSdkCompatibility(
  resolveFrom: string | URL
): Promise<NativeRepoSdkCompatibility | undefined> {
  const resolver = createRequire(resolveFrom);
  const engineFile = resolver.resolve('@loro-dev/loro-repo-engine/package.json');
  const engine = JSON.parse(await readFile(engineFile, 'utf8'));
  const marker = engine.lodyLocalSdk;
  const builtArtifact =
    typeof __LODY_LOCAL_REPO_SDK_ARTIFACT__ === 'string'
      ? __LODY_LOCAL_REPO_SDK_ARTIFACT__
      : undefined;
  if (marker === undefined) {
    if (builtArtifact) throw new Error('Compiled Repo SDK artifact is not installed');
    return undefined;
  }
  if (builtArtifact !== undefined && builtArtifact !== marker?.artifactId)
    throw new Error('Compiled Repo SDK and installed packages are from different builds');
  if (
    engine.name !== '@loro-dev/loro-repo-engine' ||
    marker.schemaVersion !== 1 ||
    marker.developmentOnly !== true ||
    !/^[a-f0-9]{64}$/.test(marker.artifactId) ||
    !/^[a-f0-9]{64}$/.test(marker.sourceFingerprint) ||
    marker.platform !== process.platform ||
    marker.arch !== process.arch ||
    marker.binaryName !== `loro-repo-engine.${process.platform}-${process.arch}.node` ||
    !/^[a-f0-9]{64}$/.test(marker.binarySha256) ||
    engine.version !== `0.1.0-lody-local.${marker.artifactId.slice(0, 16)}`
  )
    throw new Error('Local native Repo SDK identity mismatch');
  const clientEntry = resolver.resolve('@loro-dev/loro-repo-client/node');
  // package.json is not an exported client subpath; walk from its actual dist entry.
  const clientFile = path.resolve(path.dirname(clientEntry), '../package.json');
  const client = JSON.parse(await readFile(clientFile, 'utf8'));
  const patchEntry = createRequire(clientFile).resolve('@loro-dev/json-patch');
  const patch = JSON.parse(
    await readFile(path.resolve(path.dirname(patchEntry), '../package.json'), 'utf8')
  );
  for (const [name, pkg] of [
    ['@loro-dev/loro-repo-client', client],
    ['@loro-dev/json-patch', patch],
  ] as const) {
    if (
      pkg.name !== name ||
      pkg.version !== engine.version ||
      pkg.lodyLocalSdk?.artifactId !== marker.artifactId ||
      pkg.lodyLocalSdk?.sourceFingerprint !== marker.sourceFingerprint
    )
      throw new Error('Local native Repo SDK packages are from different builds');
  }
  for (const pkg of [engine, client, patch]) {
    const capabilities = pkg.lodyLocalSdk.capabilities;
    if (
      capabilities?.literalSet !== true ||
      capabilities?.rawFlockExport !== true ||
      capabilities?.losslessWireI64 !== true
    )
      throw new Error('Local native Repo SDK capability receipt is incomplete');
  }
  const binary = await readFile(path.join(path.dirname(engineFile), marker.binaryName));
  if (createHash('sha256').update(binary).digest('hex') !== marker.binarySha256)
    throw new Error('Local native Repo SDK addon does not match its receipt');
  return {
    artifactId: marker.artifactId,
    setValue: true,
    losslessWireI64: true,
    rawFlockExport: true,
    ...(marker.capabilities.flockStateEntries === true &&
    client.lodyLocalSdk.capabilities.flockStateEntries === true &&
    patch.lodyLocalSdk.capabilities.flockStateEntries === true
      ? { flockStateEntries: true }
      : {}),
  };
}
