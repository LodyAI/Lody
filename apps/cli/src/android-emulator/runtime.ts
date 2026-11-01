import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';
import { fileLocksLegacy } from '@/utils/file-lock';
import { getCliHttpFetch } from '@/utils/http-transport';
import notices from './scrcpy-notices.json';

export const SCRCPY_VERSION = '3.3.3';
export const SCRCPY_SIZE = 90164;
export const SCRCPY_SHA256 = '7e70323ba7f259649dd4acce97ac4fefbae8102b2c6d91e2e7be613fd5354be0';
export function verifyScrcpy(bytes: Buffer): void {
  if (
    bytes.length !== SCRCPY_SIZE ||
    createHash('sha256').update(bytes).digest('hex') !== SCRCPY_SHA256
  )
    throw Error('scrcpy server integrity check failed');
}
export async function ensureScrcpyServer(
  signal: AbortSignal,
  runtimeBaseUrl: string
): Promise<string> {
  const root = join(getLodyDataDir(), 'runtimes', 'scrcpy', SCRCPY_VERSION);
  return fileLocksLegacy.withLock(
    `scrcpy-${SCRCPY_VERSION}`,
    async () => {
      signal.throwIfAborted();
      const installed = join(root, 'server');
      const file = join(installed, 'scrcpy-server');
      try {
        verifyScrcpy(await readFile(file));
        await writeFile(join(installed, 'THIRD_PARTY_NOTICES.txt'), notices.text, { mode: 0o600 });
        return file;
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
      }
      await mkdir(root, { recursive: true });
      const scratch = await mkdtemp(join(root, 'download-'));
      try {
        const url = new URL(
          `/api/runtimes/scrcpy/${SCRCPY_VERSION}/universal/scrcpy-server-v${SCRCPY_VERSION}`,
          runtimeBaseUrl
        );
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password)
          throw Error('Invalid runtime channel');
        const response = await getCliHttpFetch()(url, {
          signal: AbortSignal.any([signal, AbortSignal.timeout(60000)]),
        });
        if (!response.ok || !response.body)
          throw Error('scrcpy runtime unavailable from managed channel');
        const chunks: Uint8Array[] = [];
        let size = 0;
        const reader = response.body.getReader();
        try {
          for (;;) {
            const part = await reader.read();
            if (part.done) break;
            size += part.value.length;
            if (size > SCRCPY_SIZE) throw Error('Oversized scrcpy runtime');
            chunks.push(part.value);
          }
        } finally {
          await reader.cancel();
        }
        const bytes = Buffer.concat(chunks);
        verifyScrcpy(bytes);
        signal.throwIfAborted();
        await writeFile(join(scratch, 'scrcpy-server'), bytes, { mode: 0o600 });
        await writeFile(join(scratch, 'THIRD_PARTY_NOTICES.txt'), notices.text, { mode: 0o600 });
        await rename(scratch, installed);
        return file;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    { locksDir: join(root, 'locks'), timeout: 90000, signal }
  );
}
