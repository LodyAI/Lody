import {
  ManagedDaemonUpgradeOptionsSchema,
  DaemonReleaseSchema,
  type DaemonRelease,
} from '@lody/shared';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { resolveRuntimeArtifactsBaseUrl } from '@lody/platform';

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/);
export { DaemonReleaseSchema, type DaemonRelease } from '@lody/shared';
const ContextSchema = z.object({
  metadata: z.object({
    format: z.literal(1),
    product: z.enum(['lody-oss', 'lody-cloud']),
    distribution: z.string().regex(/^[a-z][a-z0-9-]{0,79}$/),
    version,
    channel: z.enum(['stable', 'next', 'nightly']),
    platform: z.string(),
    serviceProtocol: z.literal(1),
    payloadSha256: hash,
    node: z.object({
      sha256: hash,
      size: z.number().int().positive(),
      version: z.literal('26.13.0'),
    }),
  }),
  nodePath: z.string(),
  releaseDir: z.string(),
  capsulePath: z.string(),
});
export type SeaContext = z.infer<typeof ContextSchema>;
export function getSeaContext(): SeaContext | null {
  const value: unknown = Reflect.get(globalThis, Symbol.for('lody.sea.context'));
  const parsed = ContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
/** Child code runs under this real interpreter; never treat SEA as node <script>. */
export function getCliNodeExecutable(): string {
  return getSeaContext()?.nodePath ?? process.execPath;
}
export function managedDaemonRoot(): string {
  return path.join(getLodyDataDir(), 'daemon-managed');
}
export function verifyDaemonRelease(
  raw: string,
  trust: Pick<SeaContext['metadata'], 'product'> & { distribution?: string }
): DaemonRelease {
  const release = DaemonReleaseSchema.parse(JSON.parse(raw));
  if (
    release.product !== trust.product ||
    release.distribution !== (trust.distribution ?? `${trust.product}-daemon`) ||
    release.platform !== `${process.platform}-${process.arch}`
  )
    throw new Error('Daemon product/platform mismatch');
  return release;
}
/** Atomic durable record publication. Failure must propagate before stopping old processes. */
export async function writeManagedRecord(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = await fs.open(temporary, 'wx', 0o600);
  try {
    await fd.writeFile(JSON.stringify(value) + '\n');
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await fs.rename(temporary, file);
    // Windows does not support fsync on directory handles; file flush + atomic rename
    // is not claimed as native crash acceptance there.
    if (process.platform !== 'win32') {
      const dir = await fs.open(path.dirname(file), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
const OperationSchema = z
  .object({
    format: z.literal(1),
    requestId: z.string().min(1),
    machineId: z.string().min(1),
    serviceInstanceId: z.string().min(1),
    targetVersion: version,
    releaseDigest: hash,
    previousVersion: version,
    requestedTarget: z.string().min(1),
    upgrade: ManagedDaemonUpgradeOptionsSchema.optional(),
    expiresAtMs: z.number().finite().positive().optional(),
    phase: z.enum([
      'preparing',
      'prepared',
      'waiting',
      'switching',
      'observing',
      'applied',
      'rollback-stop',
      'rolled-back',
      'blocked',
      'failed',
    ]),
  })
  .strict();
export type ManagedDaemonOperation = z.infer<typeof OperationSchema>;
function operationFile(requestId: string): string {
  return path.join(managedDaemonRoot(), 'operations', digest(Buffer.from(requestId)) + '.json');
}
export async function readManagedOperation(
  requestId?: string
): Promise<ManagedDaemonOperation | null> {
  try {
    const selected = OperationSchema.parse(
      JSON.parse(
        await fs.readFile(
          requestId ? operationFile(requestId) : path.join(managedDaemonRoot(), 'operation.json'),
          'utf8'
        )
      )
    );
    if (requestId && selected.requestId !== requestId)
      throw new Error('Managed operation identity mismatch');
    if (!requestId) return (await readManagedOperation(selected.requestId)) ?? selected;
    return selected;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
    throw error;
  }
}
export async function saveManagedOperation(operation: ManagedDaemonOperation): Promise<void> {
  const parsed = OperationSchema.parse(operation);
  const existing = await readManagedOperation(parsed.requestId);
  if (
    existing &&
    (existing.machineId !== parsed.machineId ||
      existing.serviceInstanceId !== parsed.serviceInstanceId ||
      existing.releaseDigest !== parsed.releaseDigest ||
      existing.targetVersion !== parsed.targetVersion ||
      existing.requestedTarget !== parsed.requestedTarget ||
      existing.expiresAtMs !== parsed.expiresAtMs ||
      JSON.stringify(existing.upgrade) !== JSON.stringify(parsed.upgrade))
  )
    throw new Error('Managed operation target is immutable');
  // Publish a recoverable latest pointer first; a failed journal write cannot
  // authorize interruption because the caller has not observed success yet.
  await writeManagedRecord(path.join(managedDaemonRoot(), 'operation.json'), parsed);
  await writeManagedRecord(operationFile(parsed.requestId), parsed);
}
export type ManagedInstallation = {
  version: string;
  bin: string;
  node: string;
  channel?: 'stable' | 'next' | 'nightly';
  releaseDigest?: string;
};
export function initialManagedInstallation(context: SeaContext): ManagedInstallation {
  return {
    version: context.metadata.version,
    channel: context.metadata.channel,
    bin: path.join(context.releaseDir, 'index.js'),
    node: context.nodePath,
  };
}
export function installationForRelease(release: DaemonRelease): ManagedInstallation {
  return {
    version: release.version,
    channel: release.channel,
    bin: path.join(managedDaemonRoot(), 'payloads', release.payloadSha256, 'index.js'),
    node: path.join(
      managedDaemonRoot(),
      'nodes',
      release.node.contentSha256,
      process.platform === 'win32' ? 'node.exe' : 'node'
    ),
    releaseDigest: release.capsule.contentSha256,
  };
}
export async function checkInstallationFiles(release: DaemonRelease): Promise<void> {
  const installation = installationForRelease(release);
  const node = await fs.readFile(installation.node);
  if (node.length !== release.node.contentSize || digest(node) !== release.node.contentSha256)
    throw new Error('Managed Node identity mismatch');
  const marker = await fs.readFile(path.join(path.dirname(installation.bin), '.complete'), 'utf8');
  if (marker !== release.payloadSha256) throw new Error('Incomplete daemon payload');
  await fs.access(installation.bin);
}
export async function readSelectedInstallation(context: SeaContext): Promise<ManagedInstallation> {
  try {
    const selected = z
      .object({ format: z.literal(1), digest: hash.nullable() })
      .strict()
      .parse(
        JSON.parse(await fs.readFile(path.join(managedDaemonRoot(), 'selected.json'), 'utf8'))
      );
    if (selected.digest === null) return initialManagedInstallation(context);
    const envelope = await fs.readFile(
      path.join(managedDaemonRoot(), 'releases', selected.digest, 'manifest.json'),
      'utf8'
    );
    const release = verifyDaemonRelease(envelope, context.metadata);
    if (release.capsule.contentSha256 !== selected.digest)
      throw new Error('Selected release identity mismatch');
    await checkInstallationFiles(release);
    return installationForRelease(release);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      // Only a missing selection means first install. Missing selected files are corruption.
      try {
        await fs.access(path.join(managedDaemonRoot(), 'selected.json'));
      } catch (missing) {
        if (missing instanceof Error && 'code' in missing && missing.code === 'ENOENT')
          return initialManagedInstallation(context);
      }
    }
    throw error;
  }
}
async function downloadArtifact(
  url: string,
  description: DaemonRelease['capsule'],
  destination: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    const cached = await fs.readFile(destination);
    if (cached.length === description.contentSize && digest(cached) === description.contentSha256)
      return;
    throw new Error('Existing immutable daemon artifact is corrupt');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const partial = destination + '.partial';
  let failure: unknown;
  let compressed: Buffer | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    try {
      let offset = await fs
        .stat(partial)
        .then((stat) => stat.size)
        .catch((error) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 0;
          throw error;
        });
      if (offset > description.size) {
        await fs.truncate(partial, 0);
        offset = 0;
      }
      if (offset < description.size) {
        const response = await fetch(url, {
          headers: offset ? { Range: `bytes=${offset}-` } : undefined,
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
            : AbortSignal.timeout(120000),
          redirect: 'error',
        });
        if (!response.body || (response.status !== 200 && response.status !== 206)) {
          await response.body?.cancel().catch(() => {});
          throw new Error(`Daemon download failed: ${response.status}`);
        }
        if (
          response.status === 206 &&
          response.headers.get('content-range') !==
            `bytes ${offset}-${description.size - 1}/${description.size}`
        ) {
          await response.body.cancel().catch(() => {});
          throw new Error('Invalid daemon download range');
        }
        if (response.status === 200) offset = 0;
        const fd = await fs.open(partial, offset ? 'a' : 'w', 0o600);
        const reader = response.body.getReader();
        try {
          for (;;) {
            const item = await reader.read();
            if (item.done) break;
            offset += item.value.length;
            if (offset > description.size) throw new Error('Oversized daemon artifact');
            await fd.writeFile(item.value);
          }
          await fd.sync();
        } finally {
          await reader.cancel().catch(() => {});
          await fd.close();
        }
      }
      compressed = await fs.readFile(partial);
      if (compressed.length !== description.size || digest(compressed) !== description.sha256) {
        await fs.rm(partial, { force: true });
        throw new Error('Daemon artifact digest mismatch');
      }
      break;
    } catch (error) {
      failure = error;
    }
  }
  if (
    !compressed ||
    compressed.length !== description.size ||
    digest(compressed) !== description.sha256
  )
    throw failure ?? new Error('Incomplete daemon artifact');

  const content = gunzipSync(compressed, { maxOutputLength: description.contentSize });
  if (content.length !== description.contentSize || digest(content) !== description.contentSha256)
    throw new Error('Daemon executable digest mismatch');
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  const fd = await fs.open(temporary, 'wx', 0o700);
  try {
    await fd.writeFile(content);
    await fd.sync();
  } finally {
    await fd.close();
  }
  try {
    await fs.rename(temporary, destination);
    await fs.rm(partial, { force: true });
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
/** Target is resolved once; never accept a remote command or artifact URL. */
export async function prepareManagedRelease(
  context: SeaContext,
  target: string,
  options: {
    signal?: AbortSignal;
    baseUrl?: string;
    onResolved?: (release: DaemonRelease) => Promise<void>;
  } = {}
): Promise<{ release: DaemonRelease; envelope: string; capsule: string }> {
  if (!/^(latest|next|nightly|\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.test(target))
    throw new Error('Invalid daemon target');
  const base = resolveRuntimeArtifactsBaseUrl(options.baseUrl);
  const channel = target === 'latest' ? 'stable' : target;
  const floating = ['stable', 'next', 'nightly'].includes(channel);
  const prefix = `${base}/api/runtimes/${context.metadata.distribution}`;
  const url = floating
    ? `${prefix}/channels/${context.metadata.platform}/${channel}.json`
    : `${prefix}/${target}/${context.metadata.platform}/manifest.json`;
  const response = await fetch(url, {
    signal: options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
      : AbortSignal.timeout(15000),
    redirect: 'error',
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Daemon manifest unavailable: ${response.status}`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let manifestBytes = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      manifestBytes += item.value.length;
      if (manifestBytes > 131072) throw new Error('Oversized daemon manifest');
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const envelope = Buffer.concat(chunks).toString('utf8');
  const release = verifyDaemonRelease(envelope, context.metadata);
  if (floating ? release.channel !== channel : release.version !== target)
    throw new Error('Daemon target mismatch');
  await options.onResolved?.(release);
  const directory = path.join(managedDaemonRoot(), 'releases', release.capsule.contentSha256);
  const capsule = path.join(directory, process.platform === 'win32' ? 'daemon.exe' : 'daemon');
  const releaseBase = `${prefix}/${release.version}/${release.platform}`;
  await downloadArtifact(
    `${releaseBase}/${release.capsule.file}`,
    release.capsule,
    capsule,
    options.signal
  );
  await downloadArtifact(
    `${releaseBase}/${release.node.file}`,
    release.node,
    installationForRelease(release).node,
    options.signal
  );
  await writeManagedRecord(path.join(directory, 'manifest.json'), release);
  return { release, envelope, capsule };
}
