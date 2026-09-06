import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { RegistryAcpAgent } from '@lody/shared';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AcpBinaryManager,
  AcpBinaryDownloadError,
  AcpBinaryUnsupportedPlatformError,
  mapPlatformArch,
  type FetchImpl,
} from './acp-binary-manager';

const okResponse = (bytes: Uint8Array) => ({
  ok: true,
  status: 200,
  body: new Response(bytes).body,
});

const rawAgent: RegistryAcpAgent = {
  id: 'test-raw',
  name: 'Test Raw',
  version: '1.0.0',
  distribution: {
    binary: {
      'linux-x86_64': {
        archive: 'https://example.test/test-raw-linux-x86_64',
        cmd: './foo',
        args: ['acp'],
      },
    },
  },
};

const npxAgent: RegistryAcpAgent = {
  id: 'test-npx',
  name: 'Test Npx',
  version: '1.0.0',
  distribution: { npx: { package: 'test-npx@1.0.0' }, binary: rawAgent.distribution.binary },
};

describe('mapPlatformArch', () => {
  it('maps node platform/arch to registry keys', () => {
    expect(mapPlatformArch('darwin', 'arm64')).toBe('darwin-aarch64');
    expect(mapPlatformArch('darwin', 'x64')).toBe('darwin-x86_64');
    expect(mapPlatformArch('linux', 'arm64')).toBe('linux-aarch64');
    expect(mapPlatformArch('linux', 'x64')).toBe('linux-x86_64');
    expect(mapPlatformArch('win32', 'x64')).toBe('windows-x86_64');
  });

  it('returns undefined for unsupported combinations', () => {
    expect(mapPlatformArch('aix', 'x64')).toBeUndefined();
    expect(mapPlatformArch('linux', 'ia32')).toBeUndefined();
  });
});

describe('AcpBinaryManager', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'acp-bin-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  const manager = (fetchImpl: FetchImpl) =>
    new AcpBinaryManager({ rootDir, fetchImpl, platform: 'linux', arch: 'x64' });

  describe('getBinaryStatus', () => {
    it('is not-applicable when the agent launches via npx', async () => {
      const m = manager(vi.fn());
      expect((await m.getBinaryStatus(npxAgent)).kind).toBe('not-applicable');
    });

    it('is unsupported-platform when no entry matches the machine', async () => {
      const m = new AcpBinaryManager({
        rootDir,
        fetchImpl: vi.fn(),
        platform: 'win32',
        arch: 'arm64',
      });
      const status = await m.getBinaryStatus(rawAgent);
      expect(status.kind).toBe('unsupported-platform');
    });

    it('is not-installed before download and installed after', async () => {
      const fetchImpl = vi.fn(async () => okResponse(new Uint8Array([1, 2, 3])));
      const m = manager(fetchImpl);
      expect((await m.getBinaryStatus(rawAgent)).kind).toBe('not-installed');
      await m.ensureBinary(rawAgent);
      const status = await m.getBinaryStatus(rawAgent);
      expect(status.kind).toBe('installed');
    });
  });

  describe('ensureBinary', () => {
    it('downloads a raw binary, makes it executable, and returns the command', async () => {
      const fetchImpl = vi.fn(async () => okResponse(new Uint8Array([0x7f, 0x45, 0x4c, 0x46])));
      const m = manager(fetchImpl);
      const launch = await m.ensureBinary(rawAgent);

      expect(launch.command).toBe(join(rootDir, 'test-raw', '1.0.0', 'linux-x86_64', 'foo'));
      expect(launch.args).toEqual(['acp']);
      expect(existsSync(launch.command)).toBe(true);
      if (process.platform !== 'win32') {
        const mode = (await stat(launch.command)).mode;
        expect(mode & 0o100).toBe(0o100); // POSIX owner-executable bit
      }
    });

    it('extracts a .tar.gz archive and resolves the nested cmd', async () => {
      // Build a real tar.gz containing `foo`.
      const srcDir = await mkdtemp(join(tmpdir(), 'acp-bin-src-'));
      await writeFile(join(srcDir, 'foo'), 'hello');
      const tgzPath = join(srcDir, 'archive.tar.gz');
      await tar.c({ gzip: true, file: tgzPath, cwd: srcDir }, ['foo']);
      const tgzBytes = await readFile(tgzPath);

      const agent: RegistryAcpAgent = {
        ...rawAgent,
        distribution: {
          binary: {
            'linux-x86_64': {
              archive: 'https://example.test/test-raw-linux-x86_64.tar.gz',
              cmd: './foo',
            },
          },
        },
      };
      const fetchImpl = vi.fn(async () => okResponse(new Uint8Array(tgzBytes)));
      const launch = await manager(fetchImpl).ensureBinary(agent);

      expect(existsSync(launch.command)).toBe(true);
      expect(await readFile(launch.command, 'utf8')).toBe('hello');
      await rm(srcDir, { recursive: true, force: true });
    });

    it('does not re-download on a cache hit', async () => {
      const fetchImpl = vi.fn(async () => okResponse(new Uint8Array([1])));
      const m = manager(fetchImpl);
      await m.ensureBinary(rawAgent);
      await m.ensureBinary(rawAgent);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('dedupes concurrent installs into a single download', async () => {
      const fetchImpl = vi.fn(async () => okResponse(new Uint8Array([1])));
      const m = manager(fetchImpl);
      await Promise.all([m.ensureBinary(rawAgent), m.ensureBinary(rawAgent)]);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('keeps a shared download alive when one consumer cancels', async () => {
      let markFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      let resolveFetch!: (response: ReturnType<typeof okResponse>) => void;
      let sharedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn<FetchImpl>(async (_url, init) => {
        const requestSignal = init?.signal;
        if (!requestSignal) {
          throw new Error('Expected the shared install signal');
        }
        sharedSignal = requestSignal;
        markFetchStarted();
        return await new Promise<ReturnType<typeof okResponse>>((resolve) => {
          resolveFetch = resolve;
        });
      });
      const m = manager(fetchImpl);
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = m.ensureBinary(rawAgent, { signal: firstController.signal });
      const second = m.ensureBinary(rawAgent, { signal: secondController.signal });
      await fetchStarted;

      const firstCancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      firstController.abort();
      await firstCancelled;
      expect(sharedSignal?.aborted).toBe(false);

      resolveFetch(okResponse(new Uint8Array([1])));
      const launch = await second;
      expect(launch.command).toBe(join(rootDir, 'test-raw', '1.0.0', 'linux-x86_64', 'foo'));
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });

    it('waits for an aborted install generation to clean up before retrying', async () => {
      let markFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      let releaseCancelledFetch!: () => void;
      const cancelledFetchCanSettle = new Promise<void>((resolve) => {
        releaseCancelledFetch = resolve;
      });
      let fetchCount = 0;
      const fetchImpl = vi.fn<FetchImpl>(async (_url, init) => {
        fetchCount += 1;
        if (fetchCount > 1) {
          return okResponse(new Uint8Array([1]));
        }
        const requestSignal = init?.signal;
        if (!requestSignal) {
          throw new Error('Expected the shared install signal');
        }
        markFetchStarted();
        await new Promise<void>((resolve) => {
          if (requestSignal.aborted) {
            resolve();
            return;
          }
          requestSignal.addEventListener('abort', () => resolve(), { once: true });
        });
        await cancelledFetchCanSettle;
        throw requestSignal.reason;
      });
      const m = manager(fetchImpl);
      const controller = new AbortController();
      const cancelledInstall = m.ensureBinary(rawAgent, { signal: controller.signal });
      await fetchStarted;

      const cancellation = expect(cancelledInstall).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await cancellation;

      const retry = m.ensureBinary(rawAgent);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      releaseCancelledFetch();

      const launch = await retry;
      expect(launch.command).toBe(join(rootDir, 'test-raw', '1.0.0', 'linux-x86_64', 'foo'));
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });

    it('throws on an unsupported platform', async () => {
      const m = new AcpBinaryManager({
        rootDir,
        fetchImpl: vi.fn(),
        platform: 'win32',
        arch: 'arm64',
      });
      await expect(m.ensureBinary(rawAgent)).rejects.toBeInstanceOf(
        AcpBinaryUnsupportedPlatformError
      );
    });

    it('surfaces a download error and leaves nothing installed', async () => {
      const fetchImpl = vi.fn(async () => ({ ok: false, status: 404, body: null }));
      const m = manager(fetchImpl);
      await expect(m.ensureBinary(rawAgent)).rejects.toThrow();
      expect((await m.getBinaryStatus(rawAgent)).kind).toBe('not-installed');
    });

    it('preserves nested transport causes in fetch failures', async () => {
      const lowLevel = new Error('connect ECONNREFUSED 127.0.0.1:7890');
      (lowLevel as Error & { code: string }).code = 'ECONNREFUSED';
      const fetchImpl = vi.fn<FetchImpl>(async () => {
        throw new TypeError('fetch failed', { cause: lowLevel });
      });

      let caught: unknown;
      try {
        await manager(fetchImpl).ensureBinary(rawAgent);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AcpBinaryDownloadError);
      expect((caught as Error).message).toContain('https://example.test/test-raw-linux-x86_64');
      expect((caught as Error).message).toContain('fetch failed');
      expect((caught as Error).message).toContain('code=ECONNREFUSED');
    });

    it('preserves the archive URL and cause for body stream failures', async () => {
      let sentChunk = false;
      const failingBody = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sentChunk) {
            sentChunk = true;
            controller.enqueue(new Uint8Array([1, 2, 3]));
            return;
          }
          controller.error(new Error('socket reset during body'));
        },
      });
      const fetchImpl = vi.fn<FetchImpl>(async () => ({
        ok: true,
        status: 200,
        body: failingBody,
      }));

      let caught: unknown;
      try {
        await manager(fetchImpl).ensureBinary(rawAgent);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(AcpBinaryDownloadError);
      expect((caught as Error).message).toContain(
        'Failed to stream https://example.test/test-raw-linux-x86_64'
      );
      expect((caught as Error).message).toContain('socket reset during body');
    });
  });

  it('treats a pre-existing complete marker as installed without downloading', async () => {
    const dir = join(rootDir, 'test-raw', '1.0.0', 'linux-x86_64');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'foo'), 'cached');
    await writeFile(join(dir, '.lody-complete'), '');
    const fetchImpl = vi.fn();
    const launch = await manager(fetchImpl).ensureBinary(rawAgent);
    expect(launch.command).toBe(join(dir, 'foo'));
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
