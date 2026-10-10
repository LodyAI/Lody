import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { fileLocksLegacy } from '@/utils/file-lock';
import { getCliHttpFetch } from '@/utils/http-transport';
import manifest from './baguette-manifest.json';
import notices from './baguette-notices.json';

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
/** Uses the platform public artifact channel; never PATH/Homebrew or an upstream fallback. */
export async function ensureBaguetteBinary(
  signal: AbortSignal,
  runtimeBaseUrl: string
): Promise<string> {
  if (`${process.platform}-${process.arch}` !== manifest.platform)
    throw new Error('Baguette requires Apple Silicon macOS 15 or newer.');
  const root = join(getLodyDataDir(), 'runtimes', 'baguette', manifest.version);
  return fileLocksLegacy.withLock(
    `baguette-${manifest.version}`,
    async () => {
      signal.throwIfAborted();
      const installed = join(root, manifest.platform);
      const binary = join(installed, 'Baguette');
      try {
        if ((await digest(binary)) !== manifest.executableSha256)
          throw new Error(
            'Baguette cache integrity check failed. Remove its versioned runtime cache and retry.'
          );
        const noticePath = join(installed, 'THIRD_PARTY_NOTICES.txt');
        const installedNotices = await readFile(noticePath, 'utf8').catch((error: unknown) => {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null;
          throw error;
        });
        // Lody may correct notices without changing the pinned native bytes.
        if (installedNotices !== notices.text)
          await writeFile(noticePath, notices.text, { mode: 0o600 });
        return binary;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await mkdir(root, { recursive: true });
      const scratch = await mkdtemp(join(root, 'download-'));
      try {
        const url = new URL(
          `/api/runtimes/baguette/${manifest.version}/${manifest.platform}/${manifest.fileName}`,
          runtimeBaseUrl
        );
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
          throw new Error('Invalid runtime artifact channel.');
        const response = await getCliHttpFetch()(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(300_000)]),
        });
        if (!response.ok || !response.body)
          throw new Error(`Baguette download failed (HTTP ${response.status}).`);
        let size = 0;
        const hash = createHash('sha256');
        const archive = join(scratch, 'runtime.tar.gz');
        await pipeline(
          Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>),
          new Transform({
            transform(chunk: Buffer, _encoding, done) {
              size += chunk.length;
              if (size > manifest.size)
                return done(new Error('Baguette download exceeds pinned size.'));
              hash.update(chunk);
              done(null, chunk);
            },
          }),
          createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
          { signal }
        );
        if (size !== manifest.size || hash.digest('hex') !== manifest.sha256)
          throw new Error('Baguette archive integrity check failed.');
        const unpacked = join(scratch, 'unpacked');
        await mkdir(unpacked);
        await tar.x({
          file: archive,
          cwd: unpacked,
          strip: 1,
          strict: true,
          filter: (path, entry) =>
            !path.split('/').includes('..') &&
            'type' in entry &&
            (entry.type === 'Directory' || entry.type === 'File'),
        });
        signal.throwIfAborted();
        if ((await digest(join(unpacked, 'Baguette'))) !== manifest.executableSha256)
          throw new Error('Baguette executable integrity check failed.');
        await chmod(join(unpacked, 'Baguette'), 0o700);
        await writeFile(join(unpacked, 'THIRD_PARTY_NOTICES.txt'), notices.text, { mode: 0o600 });
        await rename(unpacked, installed);
        return binary;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    { locksDir: join(root, 'locks'), timeout: 300_000, signal }
  );
}
