import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import * as tar from 'tar';
import { z } from 'zod';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { withFileLock } from '@/utils/file-lock';
import { getCliHttpFetch, type CliFetch } from '@/utils/http-transport';
import manifest from './cloudflared-manifest.json';
import notices from './cloudflared-notices.generated.json';

const ArtifactSchema = z.object({
  fileName: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().positive(),
  archive: z.boolean(),
});
const ManifestSchema = z.object({
  version: z.string(),
  source: z.string(),
  artifacts: z.record(z.string(), ArtifactSchema),
});
export const CLOUDFLARED_MANIFEST = ManifestSchema.parse(manifest);
const CacheRecord = z
  .object({ version: z.string(), archiveSha256: z.string(), executableSha256: z.string() })
  .strict();

async function hashFile(file: string, signal: AbortSignal): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/** Uses the existing runtime channel, HTTP proxy configuration, profile root and file lock. */
export async function ensureCloudflaredBinary(options: {
  runtimeBaseUrl: string;
  signal: AbortSignal;
  platform?: string;
  rootDir?: string;
  fetch?: CliFetch;
}): Promise<string> {
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const artifact = CLOUDFLARED_MANIFEST.artifacts[platform];
  if (!artifact) throw new Error(`Quick Tunnel is not supported on ${platform}`);
  const root = options.rootDir ?? join(getLodyDataDir(), 'runtimes', 'cloudflared');
  const version = CLOUDFLARED_MANIFEST.version;
  if (notices.version !== version || notices.source !== CLOUDFLARED_MANIFEST.source) {
    throw new Error('Bundled cloudflared notices do not match the pinned release');
  }
  const noticeText = [
    `cloudflared ${version}\nSource: ${notices.source}\nRelease toolchains: ${notices.goVersions.join(', ')}\n`,
    ...notices.files.map(({ name, content }) => `===== ${name} =====\n${content}`),
  ].join('\n');
  const versionRoot = join(root, version);
  const installDir = join(versionRoot, platform);
  const executable = platform.startsWith('win32-') ? 'cloudflared.exe' : 'cloudflared';
  const command = join(installDir, executable);
  const channel = new URL(options.runtimeBaseUrl);
  if (!['https:', 'http:'].includes(channel.protocol) || channel.username || channel.password) {
    throw new Error('Invalid runtime artifact channel');
  }
  const url = new URL(
    `/api/runtimes/cloudflared/${version}/${platform}/${artifact.fileName}`,
    channel
  );
  return withFileLock(
    `cloudflared-${version}-${platform}`,
    async () => {
      options.signal.throwIfAborted();
      const installed = await lstat(installDir).then(
        () => true,
        (error: unknown) => {
          if (isMissing(error)) return false;
          throw error;
        }
      );
      if (installed) {
        const record = CacheRecord.parse(
          JSON.parse(await readFile(join(installDir, 'complete.json'), 'utf8'))
        );
        if (
          record.version !== version ||
          record.archiveSha256 !== artifact.sha256 ||
          (await hashFile(command, options.signal)) !== record.executableSha256
        ) {
          throw new Error(
            'Cached cloudflared integrity check failed; remove its versioned cache and retry'
          );
        }
        if ((await readFile(join(installDir, 'THIRD_PARTY_NOTICES.txt'), 'utf8')) !== noticeText) {
          throw new Error(
            'Cached cloudflared notices do not match the bundled release; remove its versioned cache and retry'
          );
        }
        return command;
      }

      await mkdir(versionRoot, { recursive: true });
      const scratch = await mkdtemp(join(versionRoot, `${platform}-download-`));
      const unpacked = join(scratch, 'unpacked');
      try {
        const signal = AbortSignal.any([options.signal, AbortSignal.timeout(5 * 60_000)]);
        const response = await (options.fetch ?? getCliHttpFetch())(url, { signal });
        if (!response.ok || !response.body)
          throw new Error(`cloudflared download failed (HTTP ${response.status})`);
        const archive = join(scratch, artifact.fileName);
        let size = 0;
        const hash = createHash('sha256');
        const verify = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            size += chunk.byteLength;
            if (size > artifact.size) {
              callback(new Error('cloudflared download exceeds pinned size'));
              return;
            }
            hash.update(chunk);
            callback(null, chunk);
          },
        });
        // DOM and Node declare different ReadableStream interfaces; both are the
        // same WHATWG stream at runtime. fromWeb also propagates pipeline cancellation.
        await pipeline(
          Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
          verify,
          createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
          { signal }
        );
        if (size !== artifact.size || hash.digest('hex') !== artifact.sha256) {
          throw new Error('cloudflared download integrity check failed');
        }
        await mkdir(unpacked);
        const extracted = join(unpacked, executable);
        if (artifact.archive) {
          await pipeline(
            createReadStream(archive),
            tar.x({
              cwd: unpacked,
              strict: true,
              filter: (name, entry) =>
                name === 'cloudflared' &&
                'type' in entry &&
                entry.type === 'File' &&
                entry.size <= 128 * 1024 * 1024,
            }),
            { signal }
          );
        } else {
          await rename(archive, extracted);
        }
        if (!(await lstat(extracted)).isFile())
          throw new Error('cloudflared artifact does not contain its executable');
        await chmod(extracted, 0o700);
        const executableSha256 = await hashFile(extracted, signal);
        await writeFile(join(unpacked, 'THIRD_PARTY_NOTICES.txt'), noticeText, { mode: 0o600 });
        await writeFile(
          join(unpacked, 'complete.json'),
          JSON.stringify({ version, archiveSha256: artifact.sha256, executableSha256 }),
          { mode: 0o600 }
        );
        signal.throwIfAborted();
        // No overwrite/repair fallback: incomplete or corrupt existing caches are explicit errors.
        await rename(unpacked, installDir);
        return command;
      } finally {
        await rm(scratch, { recursive: true });
      }
    },
    { locksDir: join(root, 'locks'), timeout: 5 * 60_000 }
  );
}
