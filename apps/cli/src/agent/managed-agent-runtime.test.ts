import { existsSync } from 'node:fs';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';

import * as tar from 'tar';
import { compressStream } from 'zstd-stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import claudePackageLock from '../../../../packages/acp-extension-claude/package-lock.json';
import codexPackageLock from '../../../../packages/acp-extension-codex/package-lock.json';
import claudeSdkManifest from '../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json';
import claudeRuntimeManifestJson from './claude-runtime-manifest.json';
import codexRuntimeManifestJson from './codex-runtime-manifest.json';
import kimiRuntimeManifestJson from './kimi-runtime-manifest.json';
import grokRuntimeManifest from '../../../../packages/acp-extension-grok/runtime-manifest.json';

import {
  classifyManagedRuntimeFailureReason,
  CLAUDE_AGENT_SDK_VERSION,
  CLAUDE_CODE_RUNTIME_VERSION,
  CODEX_RUNTIME_VERSION,
  GROK_BUILD_RUNTIME_VERSION,
  KIMI_CODE_MIN_NODE_VERSION,
  KIMI_CODE_VERSION,
  formatManagedRuntimeFailureMessage,
  isNodeVersionAtLeast,
  mapManagedRuntimePlatform,
  ManagedAgentRuntimeManager,
  ManagedRuntimeIncompatibleHostError,
  ManagedRuntimeError,
  type ManagedRuntimeName,
  type FetchImpl,
  type ManagedRuntimeProgressEvent,
} from './managed-agent-runtime';

async function sha256(bytes: Uint8Array): Promise<string> {
  return createHash('sha256').update(bytes).digest('hex');
}

async function createTinyRuntimeArchive(rootDir: string): Promise<Uint8Array> {
  const srcDir = await mkdtemp(join(rootDir, 'runtime-src-'));
  await mkdir(join(srcDir, 'bin'), { recursive: true });
  await writeFile(join(srcDir, 'bin', 'codex'), 'tiny-codex');
  const tarPath = join(srcDir, 'runtime.tar');
  await tar.c({ file: tarPath, cwd: srcDir }, ['bin']);
  const compressed = await compressStream(
    Readable.toWeb(createReadStream(tarPath)) as ReadableStream<Uint8Array>,
    { level: 10 }
  );
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

async function createTinyKimiRuntimeArchive(rootDir: string): Promise<Uint8Array> {
  const srcDir = await mkdtemp(join(rootDir, 'kimi-runtime-src-'));
  await mkdir(join(srcDir, 'package', 'dist'), { recursive: true });
  await writeFile(join(srcDir, 'package', 'dist', 'main.mjs'), 'console.log("tiny-kimi")');
  const tarPath = join(srcDir, 'runtime.tar');
  await tar.c({ file: tarPath, cwd: srcDir }, ['package']);
  const compressed = await compressStream(
    Readable.toWeb(createReadStream(tarPath)) as ReadableStream<Uint8Array>,
    { level: 10 }
  );
  return new Uint8Array(await new Response(compressed).arrayBuffer());
}

describe('ManagedAgentRuntimeManager', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'managed-runtime-test-'));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  async function installTinyCodexArchiveDefinition(fileName: string) {
    const manager = new ManagedAgentRuntimeManager({
      rootDir,
      platform: 'linux',
      arch: 'x64',
      runtimeBaseUrl: 'https://runtime.example.test',
      fetchImpl: vi.fn(),
    });
    const definition = manager.getDefinition('codex');
    const originalArchive = definition.platforms['linux-x64'];
    const archiveBytes = await createTinyRuntimeArchive(rootDir);
    definition.platforms['linux-x64'] = {
      fileName,
      sha256: await sha256(archiveBytes),
      size: archiveBytes.byteLength,
      compression: 'zstd',
      cmd: 'bin/codex',
    };
    return { archiveBytes, definition, originalArchive };
  }

  async function installCachedCodex(options: {
    version: string;
    installedAt: string;
    metadataFormat?: 'current' | 'legacy';
    archiveSha256?: string;
    archiveSize?: number;
  }): Promise<string> {
    const dir = join(rootDir, 'codex', options.version, 'linux-x64');
    const command = join(dir, 'bin', 'codex');
    await mkdir(join(dir, 'bin'), { recursive: true });
    await writeFile(command, `codex-${options.version}`);
    const archiveSha256 = options.archiveSha256 ?? '0'.repeat(64);
    const archiveSize = options.archiveSize ?? 1;
    await writeFile(
      join(dir, 'metadata.json'),
      JSON.stringify(
        options.metadataFormat === 'legacy'
          ? {
              name: 'codex',
              version: options.version,
              platform: 'linux-x64',
              archiveSha256,
              archiveSize,
              installedAt: options.installedAt,
            }
          : {
              schemaVersion: 1,
              runtimeName: 'codex',
              runtimeVersion: options.version,
              platformArch: 'linux-x64',
              command: 'bin/codex',
              archiveSha256,
              archiveSize,
              installedAt: options.installedAt,
            }
      )
    );
    await writeFile(join(dir, '.lody-complete'), '');
    return command;
  }

  async function installLegacyCachedRuntime(options: {
    manager: ManagedAgentRuntimeManager;
    name: ManagedRuntimeName;
    platformArch: string;
  }): Promise<{ command: string; version: string }> {
    const definition = options.manager.getDefinition(options.name);
    const archive = definition.platforms[options.platformArch];
    if (!archive) {
      throw new Error(`Missing ${options.name}/${options.platformArch} test archive`);
    }
    const dir = join(rootDir, options.name, definition.version, options.platformArch);
    const command = join(dir, archive.cmd);
    await mkdir(dirname(command), { recursive: true });
    await writeFile(command, `cached-${options.name}`);
    await writeFile(
      join(dir, 'metadata.json'),
      JSON.stringify({
        name: options.name,
        version: definition.version,
        platform: options.platformArch,
        archiveSha256: archive.sha256,
        archiveSize: archive.size,
        executableSha256: archive.executableSha256,
        executableSize: archive.executableSize,
        installedAt: '2026-08-01T00:00:00.000Z',
      })
    );
    await writeFile(join(dir, '.lody-complete'), '');
    return { command, version: definition.version };
  }

  it('launches the newest reusable installed runtime without downloading the target', async () => {
    const olderCommand = await installCachedCodex({
      version: '0.1.0',
      installedAt: '2026-01-01T00:00:00.000Z',
    });
    const newestCommand = await installCachedCodex({
      version: '0.2.0',
      installedAt: '2026-02-01T00:00:00.000Z',
      metadataFormat: 'legacy',
    });
    const fetchImpl = vi.fn<FetchImpl>();
    const manager = new ManagedAgentRuntimeManager({
      rootDir,
      platform: 'linux',
      arch: 'x64',
      runtimeBaseUrl: 'https://runtime.example.test',
      fetchImpl,
    });

    await expect(manager.resolveRuntimeForLaunch('codex')).resolves.toMatchObject({
      command: newestCommand,
      version: '0.2.0',
      targetVersion: CODEX_RUNTIME_VERSION,
      updateAvailable: true,
    });
    await expect(manager.listAvailableUpdates()).resolves.toContain('codex');
    expect(fetchImpl).not.toHaveBeenCalled();

    await manager.pruneSupersededVersions('codex');
    expect(existsSync(newestCommand)).toBe(true);
    expect(existsSync(olderCommand)).toBe(false);
  });

  it.each([
    ['codex', 'linux', 'x64', 'linux-x64'],
    ['claude-code', 'linux', 'x64', 'linux-x64'],
    ['kimi-code', 'linux', 'x64', 'node'],
    ['grok-build', 'linux', 'x64', 'linux-x64'],
    ['grok-build', 'win32', 'x64', 'win32-x64'],
  ] as const)(
    'reuses a completed %s/%s runtime written with legacy metadata',
    async (name, platform, arch, platformArch) => {
      const manager = new ManagedAgentRuntimeManager({
        rootDir,
        platform,
        arch,
        nodeVersion: KIMI_CODE_MIN_NODE_VERSION,
        runtimeBaseUrl: 'https://runtime.example.test',
        fetchImpl: vi.fn(),
      });
      const cached = await installLegacyCachedRuntime({
        manager,
        name,
        platformArch,
      });

      await expect(manager.getRuntimeStatus(name)).resolves.toMatchObject({
        kind: 'installed',
        version: cached.version,
        command: cached.command,
        updateAvailable: false,
      });
      await expect(manager.prepareCache()).resolves.toBeUndefined();
      expect(existsSync(cached.command)).toBe(true);
    }
  );

  it('rejects malformed legacy runtime metadata', async () => {
    const command = await installCachedCodex({
      version: '0.147.0',
      installedAt: '2026-08-01T00:00:00.000Z',
      metadataFormat: 'legacy',
    });
    const metadataPath = join(rootDir, 'codex', '0.147.0', 'linux-x64', 'metadata.json');
    const metadata = JSON.parse(await readFile(metadataPath, 'utf8')) as Record<string, unknown>;
    await writeFile(metadataPath, JSON.stringify({ ...metadata, unexpected: true }));
    const manager = new ManagedAgentRuntimeManager({
      rootDir,
      platform: 'linux',
      arch: 'x64',
    });

    await expect(manager.prepareCache()).rejects.toThrow(
      'Managed runtime cache metadata is invalid for codex/0.147.0/linux-x64'
    );
    expect(existsSync(command)).toBe(true);
  });

  it('matches the exact locked Codex dependency version', () => {
    expect(CODEX_RUNTIME_VERSION).toBe(
      codexPackageLock.packages['node_modules/@openai/codex']?.version
    );
    expect(CODEX_RUNTIME_VERSION).toBe(codexRuntimeManifestJson.version);
    const manager = new ManagedAgentRuntimeManager({ rootDir });
    expect(manager.getDefinition('codex').platforms).toMatchObject(
      codexRuntimeManifestJson.artifacts
    );
  });

  it('matches the exact locked Claude SDK and its embedded Claude Code version', () => {
    expect(CLAUDE_AGENT_SDK_VERSION).toBe(
      claudePackageLock.packages['node_modules/@anthropic-ai/claude-agent-sdk']?.version
    );
    expect(CLAUDE_CODE_RUNTIME_VERSION).toBe(claudeSdkManifest.version);
    expect(CLAUDE_AGENT_SDK_VERSION).toBe(claudeRuntimeManifestJson.sdkVersion);
    expect(CLAUDE_CODE_RUNTIME_VERSION).toBe(claudeRuntimeManifestJson.version);
    const manager = new ManagedAgentRuntimeManager({ rootDir });
    expect(manager.getDefinition('claude-code').platforms).toMatchObject(
      claudeRuntimeManifestJson.artifacts
    );
  });

  it('matches the pinned Kimi runtime manifest and Node engine', () => {
    expect(KIMI_CODE_VERSION).toBe(kimiRuntimeManifestJson.version);
    expect(kimiRuntimeManifestJson.minNodeVersion).toBe(KIMI_CODE_MIN_NODE_VERSION);
  });

  it('maps the Kimi node package to one platform-independent artifact', () => {
    expect(mapManagedRuntimePlatform('kimi-code', 'darwin', 'arm64')).toBe('node');
    expect(mapManagedRuntimePlatform('kimi-code', 'linux', 'x64')).toBe('node');
    expect(mapManagedRuntimePlatform('kimi-code', 'win32', 'x64')).toBe('node');
  });

  it('pins Grok 1.0.13 for every supported native platform', () => {
    expect(GROK_BUILD_RUNTIME_VERSION).toBe(grokRuntimeManifest.officialRuntime.version);
    expect(grokRuntimeManifest.officialRuntime.minimumSupportedVersion).toBe('1.0.13');
    expect(mapManagedRuntimePlatform('grok-build', 'darwin', 'arm64')).toBe('darwin-arm64');
    expect(mapManagedRuntimePlatform('grok-build', 'linux', 'x64')).toBe('linux-x64');
    expect(mapManagedRuntimePlatform('grok-build', 'win32', 'arm64')).toBe('win32-arm64');

    const manager = new ManagedAgentRuntimeManager({ rootDir });
    const definition = manager.getDefinition('grok-build');
    expect(Object.keys(definition.platforms).sort()).toEqual([
      'darwin-arm64',
      'darwin-x64',
      'linux-arm64',
      'linux-x64',
      'win32-arm64',
      'win32-x64',
    ]);
    expect(
      Object.values(definition.platforms).every(
        (archive) => archive.executableSha256 && archive.executableSize
      )
    ).toBe(true);
  });

  it('rejects Kimi before download when the host Node version is too old', async () => {
    expect(isNodeVersionAtLeast('22.18.0', KIMI_CODE_MIN_NODE_VERSION)).toBe(false);
    const manager = new ManagedAgentRuntimeManager({
      rootDir,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: '22.18.0',
      fetchImpl: vi.fn(),
    });

    await expect(manager.getRuntimeStatus('kimi-code')).resolves.toEqual({
      kind: 'incompatible-host',
      reason: 'node-version',
      current: '22.18.0',
      required: KIMI_CODE_MIN_NODE_VERSION,
    });
    await expect(manager.ensureCurrentRuntime('kimi-code')).rejects.toBeInstanceOf(
      ManagedRuntimeIncompatibleHostError
    );
  });

  it('downloads and extracts the Kimi node package artifact', async () => {
    const managedRoot = join(rootDir, 'agent-binaries');
    const manager = new ManagedAgentRuntimeManager({
      rootDir: managedRoot,
      platform: 'darwin',
      arch: 'arm64',
      nodeVersion: KIMI_CODE_MIN_NODE_VERSION,
      runtimeBaseUrl: 'https://runtime.example.test',
      fetchImpl: vi.fn(),
    });
    const definition = manager.getDefinition('kimi-code');
    const originalArchive = definition.platforms.node;
    const archiveBytes = await createTinyKimiRuntimeArchive(rootDir);
    definition.platforms.node = {
      fileName: 'tiny-kimi.tar.zst',
      sha256: await sha256(archiveBytes),
      size: archiveBytes.byteLength,
      compression: 'zstd',
      cmd: 'package/dist/main.mjs',
    };
    try {
      const fetchImpl = vi.fn<FetchImpl>(async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new Response(archiveBytes).body,
      }));
      const downloadingManager = new ManagedAgentRuntimeManager({
        rootDir: managedRoot,
        platform: 'darwin',
        arch: 'x64',
        nodeVersion: KIMI_CODE_MIN_NODE_VERSION,
        runtimeBaseUrl: 'https://runtime.example.test',
        fetchImpl,
      });

      const installation = await downloadingManager.ensureCurrentRuntime('kimi-code');

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(installation.command).toBe(
        join(managedRoot, 'kimi-code', KIMI_CODE_VERSION, 'node', 'package', 'dist', 'main.mjs')
      );
      expect(await readFile(installation.command, 'utf8')).toBe('console.log("tiny-kimi")');
      expect(existsSync(join(rootDir, 'bin', 'kimi'))).toBe(false);
    } finally {
      definition.platforms.node = originalArchive;
    }
  });

  it('uses the runtime artifact channel assembled by the process boundary', () => {
    const manager = new ManagedAgentRuntimeManager({
      rootDir,
      platform: 'darwin',
      arch: 'arm64',
      runtimeBaseUrl: 'https://runtime.example.test',
      fetchImpl: vi.fn(),
    });

    expect(manager.getDiagnostics('codex').runtimeBaseHost).toBe('runtime.example.test');
  });

  it('resumes a partial zstd runtime download and extracts it', async () => {
    const manager = new ManagedAgentRuntimeManager({
      rootDir,
      platform: 'linux',
      arch: 'x64',
      runtimeBaseUrl: 'https://runtime.example.test',
      fetchImpl: vi.fn(),
    });
    const definition = manager.getDefinition('codex');
    const originalArchive = definition.platforms['linux-x64'];
    const archiveBytes = await createTinyRuntimeArchive(rootDir);
    const fileName = 'tiny-codex.tar.zst';
    definition.platforms['linux-x64'] = {
      fileName,
      sha256: await sha256(archiveBytes),
      size: archiveBytes.byteLength,
      compression: 'zstd',
      cmd: 'bin/codex',
    };

    try {
      const splitAt = Math.floor(archiveBytes.byteLength / 2);
      const partialPath = join(
        rootDir,
        '.downloads',
        `codex-${CODEX_RUNTIME_VERSION}-linux-x64-${fileName}.part`
      );
      await mkdir(join(rootDir, '.downloads'), { recursive: true });
      await writeFile(partialPath, archiveBytes.slice(0, splitAt));

      const fetchImpl = vi.fn<FetchImpl>(async (_url, init) => {
        expect(init).toBeDefined();
        const headers = init?.headers;
        expect(headers).toBeInstanceOf(Headers);
        expect((headers as Headers).get('Range')).toBe(`bytes=${splitAt}-`);
        return {
          ok: true,
          status: 206,
          headers: new Headers(),
          body: new Response(archiveBytes.slice(splitAt)).body,
        };
      });
      const resumedManager = new ManagedAgentRuntimeManager({
        rootDir,
        platform: 'linux',
        arch: 'x64',
        runtimeBaseUrl: 'https://runtime.example.test',
        fetchImpl,
      });

      const progressEvents: ManagedRuntimeProgressEvent[] = [];
      const installation = await resumedManager.ensureCurrentRuntime('codex', {
        onProgress: (event) => {
          progressEvents.push(event);
        },
      });

      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(installation.command).toBe(
        join(rootDir, 'codex', CODEX_RUNTIME_VERSION, 'linux-x64', 'bin', 'codex')
      );
      expect(existsSync(installation.command)).toBe(true);
      expect(await readFile(installation.command, 'utf8')).toBe('tiny-codex');
      expect(existsSync(partialPath)).toBe(false);
      expect(progressEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ phase: 'verifying', percent: 100 }),
          expect.objectContaining({ phase: 'extracting', percent: 100 }),
          expect.objectContaining({ phase: 'publishing', percent: 100 }),
          expect.objectContaining({ phase: 'complete', percent: 100 }),
        ])
      );
      expect(
        progressEvents.some(
          (event) =>
            event.phase === 'downloading' &&
            event.totalBytes === archiveBytes.byteLength &&
            event.downloadedBytes !== undefined &&
            event.downloadedBytes >= splitAt
        )
      ).toBe(true);
    } finally {
      definition.platforms['linux-x64'] = originalArchive;
    }
  });

  it('keeps a shared runtime download alive when one consumer cancels', async () => {
    const { archiveBytes, definition, originalArchive } =
      await installTinyCodexArchiveDefinition('shared-codex.tar.zst');

    try {
      let markFetchStarted!: () => void;
      const fetchStarted = new Promise<void>((resolve) => {
        markFetchStarted = resolve;
      });
      let resolveFetch!: (response: Awaited<ReturnType<FetchImpl>>) => void;
      let sharedSignal: AbortSignal | undefined;
      const fetchImpl = vi.fn<FetchImpl>(async (_url, init) => {
        const requestSignal = init?.signal;
        if (!requestSignal) {
          throw new Error('Expected the shared install signal');
        }
        sharedSignal = requestSignal;
        markFetchStarted();
        return await new Promise<Awaited<ReturnType<FetchImpl>>>((resolve) => {
          resolveFetch = resolve;
        });
      });
      const downloadingManager = new ManagedAgentRuntimeManager({
        rootDir,
        platform: 'linux',
        arch: 'x64',
        runtimeBaseUrl: 'https://runtime.example.test',
        fetchImpl,
      });
      const firstController = new AbortController();
      const secondController = new AbortController();
      const first = downloadingManager.ensureCurrentRuntime('codex', {
        signal: firstController.signal,
      });
      const second = downloadingManager.ensureCurrentRuntime('codex', {
        signal: secondController.signal,
      });
      await fetchStarted;

      const firstCancelled = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      firstController.abort();
      await firstCancelled;
      expect(sharedSignal?.aborted).toBe(false);

      resolveFetch({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: new Response(archiveBytes).body,
      });

      const installation = await second;
      expect(installation.command).toBe(
        join(rootDir, 'codex', CODEX_RUNTIME_VERSION, 'linux-x64', 'bin', 'codex')
      );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      definition.platforms['linux-x64'] = originalArchive;
    }
  });

  it('waits for an aborted runtime generation to clean up before retrying', async () => {
    const { archiveBytes, definition, originalArchive } =
      await installTinyCodexArchiveDefinition('retry-codex.tar.zst');

    try {
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
          return {
            ok: true,
            status: 200,
            headers: new Headers(),
            body: new Response(archiveBytes).body,
          };
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
      const downloadingManager = new ManagedAgentRuntimeManager({
        rootDir,
        platform: 'linux',
        arch: 'x64',
        runtimeBaseUrl: 'https://runtime.example.test',
        fetchImpl,
      });
      const controller = new AbortController();
      const cancelledInstall = downloadingManager.ensureCurrentRuntime('codex', {
        signal: controller.signal,
      });
      await fetchStarted;

      const cancellation = expect(cancelledInstall).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await cancellation;

      const retry = downloadingManager.ensureCurrentRuntime('codex');
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      releaseCancelledFetch();

      const installation = await retry;
      expect(installation.command).toBe(
        join(rootDir, 'codex', CODEX_RUNTIME_VERSION, 'linux-x64', 'bin', 'codex')
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    } finally {
      definition.platforms['linux-x64'] = originalArchive;
    }
  });

  it('cancels checksum work without discarding the resumable runtime archive', async () => {
    const fileName = 'checksum-cancelled-codex.tar.zst';
    const { archiveBytes, definition, originalArchive } =
      await installTinyCodexArchiveDefinition(fileName);

    try {
      const partialPath = join(
        rootDir,
        '.downloads',
        `codex-${CODEX_RUNTIME_VERSION}-linux-x64-${fileName}.part`
      );
      await mkdir(join(rootDir, '.downloads'), { recursive: true });
      await writeFile(partialPath, archiveBytes);
      const fetchImpl = vi.fn<FetchImpl>();
      const downloadingManager = new ManagedAgentRuntimeManager({
        rootDir,
        platform: 'linux',
        arch: 'x64',
        runtimeBaseUrl: 'https://runtime.example.test',
        fetchImpl,
      });
      const controller = new AbortController();

      const cancelledInstall = downloadingManager.ensureCurrentRuntime('codex', {
        signal: controller.signal,
        onProgress: (event) => {
          if (event.phase === 'verifying') controller.abort();
        },
      });
      await expect(cancelledInstall).rejects.toMatchObject({ name: 'AbortError' });

      const installation = await downloadingManager.ensureCurrentRuntime('codex');
      expect(installation.command).toBe(
        join(rootDir, 'codex', CODEX_RUNTIME_VERSION, 'linux-x64', 'bin', 'codex')
      );
      expect(fetchImpl).not.toHaveBeenCalled();
    } finally {
      definition.platforms['linux-x64'] = originalArchive;
    }
  });

  it('wraps runtime body stream failures as managed runtime errors', async () => {
    const manager = new ManagedAgentRuntimeManager({
      rootDir,
      platform: 'linux',
      arch: 'x64',
      runtimeBaseUrl: 'https://runtime.example.test',
      fetchImpl: vi.fn(),
    });
    const definition = manager.getDefinition('codex');
    const originalArchive = definition.platforms['linux-x64'];
    const fileName = 'stream-fails.tar.zst';
    definition.platforms['linux-x64'] = {
      fileName,
      sha256: 'sha256-does-not-matter',
      size: 100,
      compression: 'zstd',
      cmd: 'bin/codex',
    };

    try {
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
        headers: new Headers(),
        body: failingBody,
      }));
      const streamingManager = new ManagedAgentRuntimeManager({
        rootDir,
        platform: 'linux',
        arch: 'x64',
        runtimeBaseUrl: 'https://runtime.example.test',
        fetchImpl,
      });

      let caught: unknown;
      try {
        await streamingManager.ensureCurrentRuntime('codex');
      } catch (error) {
        caught = error;
      }

      if (!(caught instanceof ManagedRuntimeError)) {
        throw new Error('Expected stream failure to be wrapped as ManagedRuntimeError');
      }
      expect(caught.message).toContain('Failed to stream managed runtime');
      expect(caught.message).toContain('socket reset during body');
      expect(classifyManagedRuntimeFailureReason(caught)).toBe('stream_failed');
    } finally {
      definition.platforms['linux-x64'] = originalArchive;
    }
  });

  it('includes nested fetch failure causes in managed runtime messages', () => {
    const lowLevel = new Error('connect ECONNREFUSED 127.0.0.1:7890');
    (lowLevel as Error & { code: string }).code = 'ECONNREFUSED';
    const fetchError = new TypeError('fetch failed', { cause: lowLevel });
    const error = new ManagedRuntimeError(
      'Failed to fetch managed runtime https://runtime.example.test/runtime.tar.zst: ' +
        formatManagedRuntimeFailureMessage(fetchError),
      { cause: fetchError }
    );

    expect(error.message).toContain('fetch failed');
    expect(error.message).toContain('connect ECONNREFUSED 127.0.0.1:7890');
    expect(error.message).toContain('code=ECONNREFUSED');
  });
});
