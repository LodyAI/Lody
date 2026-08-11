import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { finished as waitForStreamFinished, pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';

import * as tar from 'tar';
import { decompressStream } from 'zstd-stream';
import claudePackageJson from '../../../../packages/acp-extension-claude/package.json';
import codexPackageJson from '../../../../packages/acp-extension-codex/package.json';
import claudeSdkManifestJson from '../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json';
import claudeSdkPackageJson from '../../node_modules/@anthropic-ai/claude-agent-sdk/package.json';
import kimiCodePackageJson from '../../node_modules/@moonshot-ai/kimi-code/package.json';

import {
  getManagedBuiltinRuntimeByRuntimeName,
  type ManagedBuiltinRuntimeName,
} from '@lody/shared';
import { formatErrorWithCauses } from '@/utils/format-error';
import { getCliHttpFetch, resolveCliHttpTransportConfig } from '@/utils/http-transport';
import { resolveProxyUrl } from '@/utils/proxy';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

const COMPLETE_MARKER = '.lody-complete';

function managedRuntimeAbortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new DOMException('Managed runtime extraction was cancelled', 'AbortError');
}

export type ManagedRuntimeName = ManagedBuiltinRuntimeName;

type RuntimeArchive = {
  fileName: string;
  sha256: string;
  size: number;
  cmd: string;
  compression: 'gzip' | 'zstd';
  stripComponents?: number;
  executableSha256?: string;
  executableSize?: number;
};

type RuntimeDefinition = {
  name: ManagedRuntimeName;
  version: string;
  kind?: 'node-package';
  minNodeVersion?: string;
  platforms: Record<string, RuntimeArchive>;
};

export type ManagedRuntimeStatus =
  | { kind: 'unsupported-platform'; platformArch: string }
  | {
      kind: 'incompatible-host';
      reason: 'node-version';
      current: string;
      required: string;
    }
  | { kind: 'not-installed'; platformArch: string; version: string }
  | { kind: 'installed'; platformArch: string; version: string; command: string };

export type ManagedRuntimeProgressPhase =
  'downloading' | 'verifying' | 'extracting' | 'publishing' | 'complete';

export type ManagedRuntimeProgressEvent = {
  runtimeName: ManagedRuntimeName;
  version: string;
  platformArch: string;
  phase: ManagedRuntimeProgressPhase;
  downloadedBytes?: number;
  totalBytes?: number;
  percent?: number;
};

export type ManagedRuntimeProgressCallback = (event: ManagedRuntimeProgressEvent) => void;

export type EnsureManagedRuntimeOptions = {
  onProgress?: ManagedRuntimeProgressCallback;
  signal?: AbortSignal;
};

type ManagedRuntimeInstallEntry = {
  consumers: Set<object>;
  controller: AbortController;
  promise: Promise<string>;
  settled: boolean;
};

export type ManagedRuntimeDiagnostics = {
  runtimeName: ManagedRuntimeName;
  version: string;
  platformArch: string;
  runtimeBaseHost?: string;
  proxyEnvPresent: boolean;
  proxyConfiguredForRuntimeUrl: boolean;
};

export type FetchImpl = (
  url: string,
  init?: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  headers: Headers;
  body: NodeReadableStream<Uint8Array> | null;
}>;

export type ManagedAgentRuntimeManagerOptions = {
  rootDir?: string;
  runtimeBaseUrl?: string | null;
  fetchImpl?: FetchImpl;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
};

export class ManagedRuntimeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ManagedRuntimeError';
  }
}

export class ManagedRuntimeUnsupportedPlatformError extends ManagedRuntimeError {
  readonly platformArch: string;

  constructor(name: ManagedRuntimeName, platformArch: string) {
    super(`Managed runtime '${name}' is not available for this platform (${platformArch})`);
    this.name = 'ManagedRuntimeUnsupportedPlatformError';
    this.platformArch = platformArch;
  }
}

export class ManagedRuntimeIncompatibleHostError extends ManagedRuntimeError {
  readonly current: string;
  readonly required: string;

  constructor(name: ManagedRuntimeName, current: string, required: string) {
    super(`Managed runtime '${name}' requires Node >=${required}; current Node is ${current}`);
    this.name = 'ManagedRuntimeIncompatibleHostError';
    this.current = current;
    this.required = required;
  }
}

export type ManagedRuntimeFailureReason =
  | 'unsupported_platform'
  | 'incompatible_host'
  | 'fetch_failed'
  | 'stream_failed'
  | 'http_failed'
  | 'integrity_mismatch'
  | 'missing_executable'
  | 'install_failed';

export function formatManagedRuntimeFailureMessage(error: unknown): string {
  return formatErrorWithCauses(error);
}

export function classifyManagedRuntimeFailureReason(error: unknown): ManagedRuntimeFailureReason {
  if (error instanceof ManagedRuntimeUnsupportedPlatformError) {
    return 'unsupported_platform';
  }
  if (error instanceof ManagedRuntimeIncompatibleHostError) {
    return 'incompatible_host';
  }
  const message = formatManagedRuntimeFailureMessage(error).toLowerCase();
  if (message.includes('failed to fetch managed runtime')) {
    return 'fetch_failed';
  }
  if (message.includes('failed to stream managed runtime')) {
    return 'stream_failed';
  }
  if (message.includes('(http ')) {
    return 'http_failed';
  }
  if (message.includes('sha256 mismatch') || message.includes('size mismatch')) {
    return 'integrity_mismatch';
  }
  if (message.includes('was not found after unpacking')) {
    return 'missing_executable';
  }
  return 'install_failed';
}

function resolveSingleDependencyVersion(packageName: string, dependency: string): string {
  const versionMatch = /^[~^]?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/u.exec(
    dependency
  );
  if (!versionMatch?.[1]) {
    throw new Error(`Expected a single ${packageName} version, received ${dependency}.`);
  }
  return versionMatch[1];
}

function resolveMinimumNodeVersion(packageName: string, engineRange: string): string {
  const versionMatch = /^\s*>=\s*(\d+\.\d+\.\d+)\s*$/u.exec(engineRange);
  if (!versionMatch?.[1]) {
    throw new Error(
      `Expected a single minimum Node version for ${packageName}, received ${engineRange}.`
    );
  }
  return versionMatch[1];
}

function parseNodeVersion(version: string): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(version.trim());
  if (!match?.[1] || !match[2] || !match[3]) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isNodeVersionAtLeast(current: string, required: string): boolean {
  const currentParts = parseNodeVersion(current);
  const requiredParts = parseNodeVersion(required);
  if (!currentParts || !requiredParts) return false;
  for (let index = 0; index < currentParts.length; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const requiredPart = requiredParts[index] ?? 0;
    if (currentPart !== requiredPart) return currentPart > requiredPart;
  }
  return true;
}

export const CODEX_RUNTIME_VERSION = resolveSingleDependencyVersion(
  '@openai/codex',
  codexPackageJson.dependencies['@openai/codex']
);
export const CLAUDE_AGENT_SDK_VERSION = resolveSingleDependencyVersion(
  '@anthropic-ai/claude-agent-sdk',
  claudePackageJson.dependencies['@anthropic-ai/claude-agent-sdk']
);
if (claudeSdkPackageJson.version !== CLAUDE_AGENT_SDK_VERSION) {
  throw new Error(
    `Expected installed @anthropic-ai/claude-agent-sdk ${CLAUDE_AGENT_SDK_VERSION}, received ${claudeSdkPackageJson.version}.`
  );
}
export const CODEX_ACP_ADAPTER_VERSION = codexPackageJson.version;
export const CLAUDE_ACP_ADAPTER_VERSION = claudePackageJson.version;
export const CLAUDE_CODE_RUNTIME_VERSION = claudeSdkManifestJson.version;
export const KIMI_CODE_VERSION = kimiCodePackageJson.version;
export const KIMI_CODE_MIN_NODE_VERSION = resolveMinimumNodeVersion(
  '@moonshot-ai/kimi-code',
  kimiCodePackageJson.engines.node
);

export const BUILTIN_CODEX_CAPABILITY_SOURCE_VERSION = `builtin-codex-acp:${CODEX_ACP_ADAPTER_VERSION}+codex:${CODEX_RUNTIME_VERSION}`;
export const BUILTIN_CLAUDE_CAPABILITY_SOURCE_VERSION = `builtin-claude-acp:${CLAUDE_ACP_ADAPTER_VERSION}+agent-sdk:${CLAUDE_AGENT_SDK_VERSION}+claude-code:${CLAUDE_CODE_RUNTIME_VERSION}`;
export const BUILTIN_KIMI_CAPABILITY_SOURCE_VERSION = `builtin-kimi:${KIMI_CODE_VERSION}`;

const RUNTIMES: Record<ManagedRuntimeName, RuntimeDefinition> = {
  codex: {
    name: 'codex',
    version: CODEX_RUNTIME_VERSION,
    platforms: {
      'darwin-arm64': {
        fileName: 'codex-package-aarch64-apple-darwin.tar.zst',
        sha256: '4b0a3c2967f6db11b67dac0a6f0630327077888157b2020b5b1159e8d4a5a01c',
        size: 77491677,
        compression: 'zstd',
        cmd: 'bin/codex',
      },
      'darwin-x64': {
        fileName: 'codex-package-x86_64-apple-darwin.tar.zst',
        sha256: '373c728c0912b7c65af742bb649f0ff056300f8e8a33a619be0bab62f2afc6ba',
        size: 85008508,
        compression: 'zstd',
        cmd: 'bin/codex',
      },
      'linux-arm64': {
        fileName: 'codex-package-aarch64-unknown-linux-musl.tar.zst',
        sha256: '692ff5c5d9eb86774c0448d930895e46659eee6a2c12f46b97399da458c1e8b7',
        size: 80608473,
        compression: 'zstd',
        cmd: 'bin/codex',
      },
      'linux-x64': {
        fileName: 'codex-package-x86_64-unknown-linux-musl.tar.zst',
        sha256: '494368127e27ab625b2a5e759f83447e1d7d00b6ae49a5e2c17df5fd7c4aac1d',
        size: 86804357,
        compression: 'zstd',
        cmd: 'bin/codex',
      },
      'win32-arm64': {
        fileName: 'codex-package-aarch64-pc-windows-msvc.tar.zst',
        sha256: '0c9d43e1ce013900850c82ab558cbafae9e8b05363689ab68cc0b4c87ac2b267',
        size: 88080469,
        compression: 'zstd',
        cmd: 'bin/codex.exe',
      },
      'win32-x64': {
        fileName: 'codex-package-x86_64-pc-windows-msvc.tar.zst',
        sha256: '5931e080440a0bff1413d55b62921e26238f5410d82d79e5327202bfef1833a4',
        size: 95093149,
        compression: 'zstd',
        cmd: 'bin/codex.exe',
      },
    },
  },
  'claude-code': {
    name: 'claude-code',
    version: CLAUDE_CODE_RUNTIME_VERSION,
    platforms: {
      'darwin-arm64': {
        fileName: `anthropic-ai-claude-agent-sdk-darwin-arm64-${CLAUDE_AGENT_SDK_VERSION}.tar.zst`,
        sha256: '2c2f74e529066d85f9f8815e7ff1ef5a5e78107c43b1fa368acec86f07faf57d',
        size: 60180862,
        compression: 'zstd',
        cmd: 'claude',
        stripComponents: 1,
        executableSha256: claudeSdkManifestJson.platforms['darwin-arm64'].checksum,
        executableSize: claudeSdkManifestJson.platforms['darwin-arm64'].size,
      },
      'darwin-x64': {
        fileName: `anthropic-ai-claude-agent-sdk-darwin-x64-${CLAUDE_AGENT_SDK_VERSION}.tar.zst`,
        sha256: '5c74a294444e69f9b13f4e103247b6b51a7b10c555cfbce9f5434c37e662e9bb',
        size: 64691464,
        compression: 'zstd',
        cmd: 'claude',
        stripComponents: 1,
        executableSha256: claudeSdkManifestJson.platforms['darwin-x64'].checksum,
        executableSize: claudeSdkManifestJson.platforms['darwin-x64'].size,
      },
      'linux-arm64': {
        fileName: `anthropic-ai-claude-agent-sdk-linux-arm64-${CLAUDE_AGENT_SDK_VERSION}.tar.zst`,
        sha256: 'bc41781f1003c2856e3ce0044da3fa752ef279a1cc29a8e23e3ce13c8033650e',
        size: 69763140,
        compression: 'zstd',
        cmd: 'claude',
        stripComponents: 1,
        executableSha256: claudeSdkManifestJson.platforms['linux-arm64'].checksum,
        executableSize: claudeSdkManifestJson.platforms['linux-arm64'].size,
      },
      'linux-x64': {
        fileName: `anthropic-ai-claude-agent-sdk-linux-x64-${CLAUDE_AGENT_SDK_VERSION}.tar.zst`,
        sha256: '076972a61402e14afffb5d64a40e50ab5074a3a7f3740fed44d64b6cb7839c84',
        size: 70585519,
        compression: 'zstd',
        cmd: 'claude',
        stripComponents: 1,
        executableSha256: claudeSdkManifestJson.platforms['linux-x64'].checksum,
        executableSize: claudeSdkManifestJson.platforms['linux-x64'].size,
      },
      'linux-arm64-musl': {
        fileName: `anthropic-ai-claude-agent-sdk-linux-arm64-musl-${CLAUDE_AGENT_SDK_VERSION}.tar.zst`,
        sha256: 'e9282b3ab96cb89aeb1eecba2bf7ab354486dbd48546ca8c8b0ace0844d88f75',
        size: 68233742,
        compression: 'zstd',
        cmd: 'claude',
        stripComponents: 1,
        executableSha256: claudeSdkManifestJson.platforms['linux-arm64-musl'].checksum,
        executableSize: claudeSdkManifestJson.platforms['linux-arm64-musl'].size,
      },
      'linux-x64-musl': {
        fileName: `anthropic-ai-claude-agent-sdk-linux-x64-musl-${CLAUDE_AGENT_SDK_VERSION}.tar.zst`,
        sha256: '331f1470a4234ac1636971b7c586f41ae8c76ff987fe8d7e5736214186a93e86',
        size: 69249229,
        compression: 'zstd',
        cmd: 'claude',
        stripComponents: 1,
        executableSha256: claudeSdkManifestJson.platforms['linux-x64-musl'].checksum,
        executableSize: claudeSdkManifestJson.platforms['linux-x64-musl'].size,
      },
      'win32-arm64': {
        fileName: `anthropic-ai-claude-agent-sdk-win32-arm64-${CLAUDE_AGENT_SDK_VERSION}.tar.zst`,
        sha256: '483e1285703ba75050055cc305a5b47526ac449bc223c2e30acaa3a7ac87560e',
        size: 69235703,
        compression: 'zstd',
        cmd: 'claude.exe',
        stripComponents: 1,
        executableSha256: claudeSdkManifestJson.platforms['win32-arm64'].checksum,
        executableSize: claudeSdkManifestJson.platforms['win32-arm64'].size,
      },
      'win32-x64': {
        fileName: `anthropic-ai-claude-agent-sdk-win32-x64-${CLAUDE_AGENT_SDK_VERSION}.tar.zst`,
        sha256: '961eeabb2eaf9b3027fdc3caf10417ea738fb3ea64132307a7ae3a1d9f2309b8',
        size: 71046598,
        compression: 'zstd',
        cmd: 'claude.exe',
        stripComponents: 1,
        executableSha256: claudeSdkManifestJson.platforms['win32-x64'].checksum,
        executableSize: claudeSdkManifestJson.platforms['win32-x64'].size,
      },
    },
  },
  'kimi-code': {
    name: 'kimi-code',
    version: KIMI_CODE_VERSION,
    kind: 'node-package',
    minNodeVersion: KIMI_CODE_MIN_NODE_VERSION,
    platforms: {
      node: {
        fileName: `moonshot-ai-kimi-code-${KIMI_CODE_VERSION}.tar.zst`,
        sha256: 'fa791d79b4fc0890e95f5e9de2136a2b444fa7aeb7751073ccf1c7874d1dec33',
        size: 3386360,
        compression: 'zstd',
        cmd: 'package/dist/main.mjs',
      },
    },
  },
};

function sanitizeSegment(segment: string): string {
  return segment.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function normalizeBaseUrl(value?: string | null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/\/+$/u, '');
  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new ManagedRuntimeError(`Invalid managed runtime base URL: ${value}`);
  }
  return normalized;
}

function getDownloadPercent(downloadedBytes: number, totalBytes: number): number | undefined {
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    return undefined;
  }
  return Math.min(100, Math.max(0, Math.floor((downloadedBytes / totalBytes) * 100)));
}

function isMuslLibc(): boolean {
  if (process.platform !== 'linux') return false;
  const report =
    typeof process.report?.getReport === 'function'
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null;
  const header = report?.header;
  return !header?.glibcVersionRuntime;
}

export function mapManagedRuntimePlatform(
  name: ManagedRuntimeName,
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): string | undefined {
  if (RUNTIMES[name].kind === 'node-package') return 'node';
  const archPart = arch === 'arm64' ? 'arm64' : arch === 'x64' ? 'x64' : undefined;
  if (!archPart) return undefined;
  if (platform === 'darwin') return `darwin-${archPart}`;
  if (platform === 'win32') return `win32-${archPart}`;
  if (platform === 'linux') {
    const muslSuffix = name === 'claude-code' && isMuslLibc() ? '-musl' : '';
    return `linux-${archPart}${muslSuffix}`;
  }
  return undefined;
}

async function sha256File(
  path: string,
  signal?: AbortSignal
): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  const hashingStream = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk);
      size += chunk.byteLength;
      callback();
    },
  });
  await pipeline(createReadStream(path), hashingStream, { signal });
  return {
    sha256: hash.digest('hex'),
    size,
  };
}

export class ManagedAgentRuntimeManager {
  private readonly rootDir: string;
  private readonly runtimeBaseUrl: string | null;
  private readonly fetchImpl: FetchImpl;
  private readonly platform: NodeJS.Platform;
  private readonly arch: string;
  private readonly nodeVersion: string;
  private readonly inFlight = new Map<string, ManagedRuntimeInstallEntry>();
  private readonly progressListeners = new Map<string, Set<ManagedRuntimeProgressCallback>>();

  constructor(options: ManagedAgentRuntimeManagerOptions = {}) {
    this.rootDir = options.rootDir ?? join(getLodyDataDir(), 'agent-binaries');
    this.runtimeBaseUrl = normalizeBaseUrl(options.runtimeBaseUrl);
    this.fetchImpl =
      options.fetchImpl ?? ((url, init) => getCliHttpFetch()(url, init) as ReturnType<FetchImpl>);
    this.platform = options.platform ?? process.platform;
    this.arch = options.arch ?? process.arch;
    this.nodeVersion = options.nodeVersion ?? process.versions.node;
  }

  getDefinition(name: ManagedRuntimeName): RuntimeDefinition {
    return RUNTIMES[name];
  }

  getDiagnostics(name: ManagedRuntimeName): ManagedRuntimeDiagnostics {
    const resolvedArchive = this.resolveArchive(name);
    const definition = RUNTIMES[name];
    const platformArch = resolvedArchive.platformArch;
    const archive = 'unsupported' in resolvedArchive ? undefined : resolvedArchive.archive;
    const targetUrl =
      archive && this.runtimeBaseUrl
        ? this.artifactUrl(name, definition.version, platformArch, archive.fileName)
        : this.runtimeBaseUrl;
    let runtimeBaseHost: string | undefined;
    try {
      runtimeBaseHost = this.runtimeBaseUrl ? new URL(this.runtimeBaseUrl).host : undefined;
    } catch {
      runtimeBaseHost = undefined;
    }

    return {
      runtimeName: name,
      version: definition.version,
      platformArch,
      runtimeBaseHost,
      proxyEnvPresent: resolveCliHttpTransportConfig().proxyEnvPresent,
      proxyConfiguredForRuntimeUrl: targetUrl
        ? Boolean(resolveProxyUrl(targetUrl).proxyUrl)
        : false,
    };
  }

  private resolveArchive(
    name: ManagedRuntimeName
  ):
    | { definition: RuntimeDefinition; platformArch: string; archive: RuntimeArchive }
    | { unsupported: true; platformArch: string } {
    const platformArch =
      mapManagedRuntimePlatform(name, this.platform, this.arch) ?? `${this.platform}-${this.arch}`;
    const definition = RUNTIMES[name];
    const archive = definition.platforms[platformArch];
    if (!archive) return { unsupported: true, platformArch };
    return { definition, platformArch, archive };
  }

  private targetDir(name: ManagedRuntimeName, version: string, platformArch: string): string {
    return join(
      this.rootDir,
      sanitizeSegment(name),
      sanitizeSegment(version),
      sanitizeSegment(platformArch)
    );
  }

  private partialDownloadPath(
    name: ManagedRuntimeName,
    version: string,
    platformArch: string,
    fileName: string
  ): string {
    const fileKey = [name, version, platformArch, fileName].map(sanitizeSegment).join('-');
    return join(this.rootDir, '.downloads', `${fileKey}.part`);
  }

  private artifactUrl(
    name: ManagedRuntimeName,
    version: string,
    platformArch: string,
    fileName: string
  ): string {
    if (!this.runtimeBaseUrl) {
      throw new ManagedRuntimeError(
        'Managed runtime downloads are not configured; assemble RuntimeArtifactsPort before downloading'
      );
    }
    return `${this.runtimeBaseUrl}/api/runtimes/${encodeURIComponent(name)}/${encodeURIComponent(
      version
    )}/${encodeURIComponent(platformArch)}/${encodeURIComponent(fileName)}`;
  }

  async getRuntimeStatus(name: ManagedRuntimeName): Promise<ManagedRuntimeStatus> {
    const resolvedArchive = this.resolveArchive(name);
    if ('unsupported' in resolvedArchive) {
      return { kind: 'unsupported-platform', platformArch: resolvedArchive.platformArch };
    }
    const { definition, platformArch, archive } = resolvedArchive;
    if (
      definition.minNodeVersion &&
      !isNodeVersionAtLeast(this.nodeVersion, definition.minNodeVersion)
    ) {
      return {
        kind: 'incompatible-host',
        reason: 'node-version',
        current: this.nodeVersion,
        required: definition.minNodeVersion,
      };
    }
    const dir = this.targetDir(name, definition.version, platformArch);
    const command = resolve(dir, archive.cmd);
    if (existsSync(join(dir, COMPLETE_MARKER)) && existsSync(command)) {
      return { kind: 'installed', platformArch, version: definition.version, command };
    }
    return { kind: 'not-installed', platformArch, version: definition.version };
  }

  async ensureRuntime(
    name: ManagedRuntimeName,
    options: EnsureManagedRuntimeOptions = {}
  ): Promise<string> {
    options.signal?.throwIfAborted();
    const resolvedArchive = this.resolveArchive(name);
    if ('unsupported' in resolvedArchive) {
      throw new ManagedRuntimeUnsupportedPlatformError(name, resolvedArchive.platformArch);
    }
    const { definition, platformArch, archive } = resolvedArchive;
    if (
      definition.minNodeVersion &&
      !isNodeVersionAtLeast(this.nodeVersion, definition.minNodeVersion)
    ) {
      throw new ManagedRuntimeIncompatibleHostError(
        name,
        this.nodeVersion,
        definition.minNodeVersion
      );
    }
    const dir = this.targetDir(name, definition.version, platformArch);
    const command = resolve(dir, archive.cmd);
    if (existsSync(join(dir, COMPLETE_MARKER)) && existsSync(command)) {
      options.onProgress?.({
        runtimeName: name,
        version: definition.version,
        platformArch,
        phase: 'complete',
        downloadedBytes: archive.size,
        totalBytes: archive.size,
        percent: 100,
      });
      return command;
    }

    const key = `${name}:${definition.version}:${platformArch}`;
    let entry = this.inFlight.get(key);
    if (entry?.controller.signal.aborted) {
      await this.waitForCancelledInstallCleanup(entry, options.signal);
      return await this.ensureRuntime(name, options);
    }

    if (!entry) {
      const controller = new AbortController();
      let nextEntry!: ManagedRuntimeInstallEntry;
      const promise = this.downloadAndPublish(
        key,
        name,
        definition,
        platformArch,
        archive,
        dir,
        controller.signal
      )
        .catch((error: unknown) => {
          if (error instanceof ManagedRuntimeError) {
            throw error;
          }
          throw new ManagedRuntimeError(
            `Failed to install managed runtime ${name}: ${formatErrorWithCauses(error)}`,
            { cause: error }
          );
        })
        .finally(() => {
          nextEntry.settled = true;
          if (this.inFlight.get(key) === nextEntry) {
            this.inFlight.delete(key);
            this.progressListeners.delete(key);
          }
        });
      nextEntry = {
        consumers: new Set(),
        controller,
        promise,
        settled: false,
      };
      this.inFlight.set(key, nextEntry);
      entry = nextEntry;
    }

    const cleanupProgress = options.onProgress
      ? this.addProgressListener(key, options.onProgress)
      : undefined;
    return await this.waitForInstall(entry, options.signal, cleanupProgress);
  }

  private async waitForCancelledInstallCleanup(
    entry: ManagedRuntimeInstallEntry,
    signal: AbortSignal | undefined
  ): Promise<void> {
    if (!signal) {
      await entry.promise.catch(() => undefined);
      return;
    }
    signal.throwIfAborted();
    await new Promise<void>((completeCleanup, reject) => {
      const handleAbort = () => {
        cleanup();
        reject(new DOMException('Managed runtime installation was cancelled', 'AbortError'));
      };
      const cleanup = () => signal.removeEventListener('abort', handleAbort);
      signal.addEventListener('abort', handleAbort, { once: true });
      void entry.promise.then(
        () => {
          cleanup();
          completeCleanup();
        },
        () => {
          cleanup();
          completeCleanup();
        }
      );
    });
  }

  private async waitForInstall(
    entry: ManagedRuntimeInstallEntry,
    signal: AbortSignal | undefined,
    cleanupProgress: (() => void) | undefined
  ): Promise<string> {
    if (signal?.aborted) {
      cleanupProgress?.();
      signal.throwIfAborted();
    }
    const consumer = {};
    entry.consumers.add(consumer);
    return await new Promise<string>((completeInstall, reject) => {
      let finished = false;
      const release = (): void => {
        signal?.removeEventListener('abort', handleAbort);
        cleanupProgress?.();
        entry.consumers.delete(consumer);
        if (!entry.settled && entry.consumers.size === 0) {
          entry.controller.abort();
        }
      };
      const finish = (complete: () => void): void => {
        if (finished) return;
        finished = true;
        release();
        complete();
      };
      const handleAbort = (): void =>
        finish(() =>
          reject(new DOMException('Managed runtime installation was cancelled', 'AbortError'))
        );

      signal?.addEventListener('abort', handleAbort, { once: true });
      if (signal?.aborted) {
        handleAbort();
        return;
      }
      void entry.promise.then(
        (command) => finish(() => completeInstall(command)),
        (error: unknown) => finish(() => reject(error))
      );
    });
  }

  private addProgressListener(key: string, callback: ManagedRuntimeProgressCallback): () => void {
    let listeners = this.progressListeners.get(key);
    if (!listeners) {
      listeners = new Set();
      this.progressListeners.set(key, listeners);
    }
    listeners.add(callback);
    return () => {
      const current = this.progressListeners.get(key);
      if (!current) return;
      current.delete(callback);
      if (current.size === 0) {
        this.progressListeners.delete(key);
      }
    };
  }

  private emitProgress(key: string, event: ManagedRuntimeProgressEvent): void {
    const listeners = this.progressListeners.get(key);
    if (!listeners || listeners.size === 0) return;
    for (const listener of listeners) {
      try {
        listener(event);
      } catch {
        // Progress callbacks are observational and must not break installation.
      }
    }
  }

  private async downloadAndPublish(
    progressKey: string,
    name: ManagedRuntimeName,
    definition: RuntimeDefinition,
    platformArch: string,
    archive: RuntimeArchive,
    dir: string,
    signal: AbortSignal
  ): Promise<string> {
    signal.throwIfAborted();
    await mkdir(this.rootDir, { recursive: true });
    const scratch = await mkdtemp(join(this.rootDir, 'tmp-'));
    const artifactPath = join(scratch, basename(archive.fileName));
    const partialPath = this.partialDownloadPath(
      name,
      definition.version,
      platformArch,
      archive.fileName
    );
    const unpackDir = join(scratch, 'unpack');
    try {
      await mkdir(unpackDir, { recursive: true });
      await this.download(
        progressKey,
        name,
        definition.version,
        platformArch,
        this.artifactUrl(name, definition.version, platformArch, archive.fileName),
        artifactPath,
        partialPath,
        archive,
        signal
      );
      signal.throwIfAborted();
      this.emitProgress(progressKey, {
        runtimeName: name,
        version: definition.version,
        platformArch,
        phase: 'extracting',
        downloadedBytes: archive.size,
        totalBytes: archive.size,
        percent: 100,
      });
      await this.extractArchive(artifactPath, unpackDir, archive, signal);
      signal.throwIfAborted();

      const cmdPath = resolve(unpackDir, archive.cmd);
      if (!existsSync(cmdPath)) {
        throw new ManagedRuntimeError(
          `Runtime executable '${archive.cmd}' was not found after unpacking`
        );
      }
      if (archive.executableSha256 || archive.executableSize !== undefined) {
        const actual = await sha256File(cmdPath, signal);
        if (archive.executableSha256 && actual.sha256 !== archive.executableSha256) {
          throw new ManagedRuntimeError(
            `Runtime executable sha256 mismatch for ${archive.cmd}: expected ${archive.executableSha256}, got ${actual.sha256}`
          );
        }
        if (archive.executableSize !== undefined && actual.size !== archive.executableSize) {
          throw new ManagedRuntimeError(
            `Runtime executable size mismatch for ${archive.cmd}: expected ${archive.executableSize}, got ${actual.size}`
          );
        }
      }
      if (this.platform !== 'win32') {
        await chmod(cmdPath, 0o755);
      }

      signal.throwIfAborted();
      this.emitProgress(progressKey, {
        runtimeName: name,
        version: definition.version,
        platformArch,
        phase: 'publishing',
        downloadedBytes: archive.size,
        totalBytes: archive.size,
        percent: 100,
      });
      await this.publish(unpackDir, dir);
      signal.throwIfAborted();
      await writeFile(
        join(dir, 'metadata.json'),
        JSON.stringify(
          {
            name,
            version: definition.version,
            platform: platformArch,
            archiveSha256: archive.sha256,
            archiveSize: archive.size,
            executableSha256: archive.executableSha256,
            executableSize: archive.executableSize,
            installedAt: new Date().toISOString(),
          },
          null,
          2
        )
      );
      signal.throwIfAborted();
      await writeFile(join(dir, COMPLETE_MARKER), '');
      signal.throwIfAborted();
      // A repacked JS package is an internal ACP runtime, not a complete user
      // CLI. Publishing its partial command surface on PATH would make commands
      // such as `kimi web` resolve to an intentionally stripped package.
      if (definition.kind !== 'node-package') {
        await this.publishBinLink(name, resolve(dir, archive.cmd));
      }
      await this.pruneOldVersions(name, definition.version);
      this.emitProgress(progressKey, {
        runtimeName: name,
        version: definition.version,
        platformArch,
        phase: 'complete',
        downloadedBytes: archive.size,
        totalBytes: archive.size,
        percent: 100,
      });
      return resolve(dir, archive.cmd);
    } catch (error) {
      if (
        signal.aborted &&
        !existsSync(join(dir, COMPLETE_MARKER)) &&
        existsSync(artifactPath) &&
        !existsSync(partialPath)
      ) {
        await mkdir(dirname(partialPath), { recursive: true });
        await rename(artifactPath, partialPath).catch(() => undefined);
      }
      throw error;
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async extractArchive(
    artifactPath: string,
    unpackDir: string,
    archive: RuntimeArchive,
    signal: AbortSignal
  ): Promise<void> {
    signal.throwIfAborted();
    if (archive.compression === 'zstd') {
      const compressedSource = createReadStream(artifactPath);
      const sourceFinished = waitForStreamFinished(compressedSource).catch(() => undefined);
      const handleAbort = (): void => {
        compressedSource.destroy(managedRuntimeAbortError(signal));
      };
      signal.addEventListener('abort', handleAbort, { once: true });
      try {
        const decompressed = await decompressStream(
          Readable.toWeb(compressedSource) as ReadableStream<Uint8Array>
        );
        signal.throwIfAborted();
        await pipeline(
          Readable.fromWeb(decompressed as NodeReadableStream<Uint8Array>),
          tar.x({
            cwd: unpackDir,
            strip: archive.stripComponents ?? 0,
          }),
          { signal }
        );
      } finally {
        signal.removeEventListener('abort', handleAbort);
        if (!compressedSource.destroyed) {
          compressedSource.destroy(signal.aborted ? managedRuntimeAbortError(signal) : undefined);
        }
        await sourceFinished;
      }
      return;
    }

    await pipeline(
      createReadStream(artifactPath),
      tar.x({
        cwd: unpackDir,
        strip: archive.stripComponents ?? 0,
      }),
      { signal }
    );
  }

  private async download(
    progressKey: string,
    name: ManagedRuntimeName,
    version: string,
    platformArch: string,
    url: string,
    dest: string,
    partialPath: string,
    archive: RuntimeArchive,
    signal: AbortSignal
  ): Promise<void> {
    // Progress reporting belongs in this loop/pipeline: count fetched bytes,
    // include any resumed offset, and keep the Range-resume semantics intact.
    await mkdir(dirname(partialPath), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      signal.throwIfAborted();
      const existingSize = await this.getExistingPartialSize(partialPath, archive.size);
      signal.throwIfAborted();
      this.emitProgress(progressKey, {
        runtimeName: name,
        version,
        platformArch,
        phase: 'downloading',
        downloadedBytes: existingSize,
        totalBytes: archive.size,
        percent: getDownloadPercent(existingSize, archive.size),
      });
      if (existingSize === archive.size) {
        this.emitProgress(progressKey, {
          runtimeName: name,
          version,
          platformArch,
          phase: 'verifying',
          downloadedBytes: archive.size,
          totalBytes: archive.size,
          percent: 100,
        });
        const verified = await this.verifyArchive(partialPath, archive, signal);
        signal.throwIfAborted();
        if (verified) {
          await rename(partialPath, dest);
          return;
        }
        await rm(partialPath, { force: true });
        continue;
      }

      const resumed = await this.downloadAttempt(
        progressKey,
        name,
        version,
        platformArch,
        url,
        partialPath,
        archive,
        existingSize,
        signal
      );
      signal.throwIfAborted();
      if (resumed === 'retry-from-start') {
        await rm(partialPath, { force: true });
        continue;
      }
      const downloadedSize = await this.getExistingPartialSize(partialPath, archive.size);
      signal.throwIfAborted();
      if (downloadedSize < archive.size) {
        continue;
      }
      this.emitProgress(progressKey, {
        runtimeName: name,
        version,
        platformArch,
        phase: 'verifying',
        downloadedBytes: downloadedSize,
        totalBytes: archive.size,
        percent: getDownloadPercent(downloadedSize, archive.size),
      });
      const verified =
        downloadedSize === archive.size && (await this.verifyArchive(partialPath, archive, signal));
      signal.throwIfAborted();
      if (verified) {
        await rename(partialPath, dest);
        return;
      }
      await rm(partialPath, { force: true });
    }

    throw new ManagedRuntimeError(`Failed to download managed runtime ${url}`);
  }

  private async getExistingPartialSize(partialPath: string, expectedSize: number): Promise<number> {
    const partialStat = await stat(partialPath).catch(() => undefined);
    if (!partialStat) return 0;
    if (partialStat.size > expectedSize) {
      await rm(partialPath, { force: true });
      return 0;
    }
    return partialStat.size;
  }

  private async downloadAttempt(
    progressKey: string,
    name: ManagedRuntimeName,
    version: string,
    platformArch: string,
    url: string,
    partialPath: string,
    archive: RuntimeArchive,
    offset: number,
    signal: AbortSignal
  ): Promise<'downloaded' | 'retry-from-start'> {
    const headers = new Headers();
    if (offset > 0) {
      headers.set('Range', `bytes=${offset}-`);
    }

    let response: Awaited<ReturnType<FetchImpl>>;
    try {
      response = await this.fetchImpl(url, {
        ...(offset > 0 ? { headers } : {}),
        signal,
      });
    } catch (error) {
      throw new ManagedRuntimeError(
        `Failed to fetch managed runtime ${url}: ${formatErrorWithCauses(error)}`,
        { cause: error }
      );
    }
    if (offset > 0 && response.status === 416) {
      return 'retry-from-start';
    }
    if (offset > 0 && response.status === 200) {
      return 'retry-from-start';
    }
    if (offset > 0 && response.status !== 206) {
      throw new ManagedRuntimeError(
        `Failed to resume managed runtime ${url} (HTTP ${response.status})`
      );
    }
    if (!response.ok || !response.body) {
      throw new ManagedRuntimeError(
        `Failed to download managed runtime ${url} (HTTP ${response.status})`
      );
    }

    let downloadedBytes = offset;
    let lastPercent = -1;
    let lastEmitAtMs = 0;
    const emitDownloadProgress = (force = false) => {
      const percent = getDownloadPercent(downloadedBytes, archive.size);
      const nowMs = Date.now();
      if (!force && percent === lastPercent && nowMs - lastEmitAtMs < 500) {
        return;
      }
      lastPercent = percent ?? -1;
      lastEmitAtMs = nowMs;
      this.emitProgress(progressKey, {
        runtimeName: name,
        version,
        platformArch,
        phase: 'downloading',
        downloadedBytes,
        totalBytes: archive.size,
        percent,
      });
    };
    const progressStream = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        downloadedBytes += chunk.byteLength;
        emitDownloadProgress();
        callback(null, chunk);
      },
    });

    emitDownloadProgress(true);
    try {
      await pipeline(
        Readable.fromWeb(response.body),
        progressStream,
        createWriteStream(partialPath, { flags: offset > 0 ? 'a' : 'w' }),
        { signal }
      );
    } catch (error) {
      throw new ManagedRuntimeError(
        `Failed to stream managed runtime ${url}: ${formatErrorWithCauses(error)}`,
        { cause: error }
      );
    }
    emitDownloadProgress(true);
    return 'downloaded';
  }

  private async verifyArchive(
    path: string,
    archive: RuntimeArchive,
    signal: AbortSignal
  ): Promise<boolean> {
    const actual = await sha256File(path, signal);
    if (actual.sha256 !== archive.sha256 || actual.size !== archive.size) {
      return false;
    }
    return true;
  }

  private async publishBinLink(name: ManagedRuntimeName, command: string): Promise<void> {
    if (this.platform === 'win32') return;

    const binName = getManagedBuiltinRuntimeByRuntimeName(name)?.agentType ?? name;
    const binDir = join(dirname(this.rootDir), 'bin');
    const linkPath = join(binDir, binName);
    try {
      await mkdir(binDir, { recursive: true });
      const existing = await lstat(linkPath).catch(() => undefined);
      if (existing && !existing.isSymbolicLink()) {
        return;
      }
      await rm(linkPath, { force: true });
      await symlink(relative(binDir, command), linkPath);
    } catch {
      // The direct executable path is used for launches; the bin symlink is only
      // a convenience and must not make runtime installation fail.
    }
  }

  private async publish(unpackDir: string, dir: string): Promise<void> {
    await mkdir(dirname(dir), { recursive: true });
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
    try {
      await rename(unpackDir, dir);
    } catch (error) {
      if (existsSync(join(dir, COMPLETE_MARKER))) return;
      throw error;
    }
  }

  private async pruneOldVersions(name: ManagedRuntimeName, currentVersion: string): Promise<void> {
    const runtimeRoot = join(this.rootDir, sanitizeSegment(name));
    const entries = await readdir(runtimeRoot, { withFileTypes: true }).catch(() => []);
    const oldVersions = entries
      .filter((entry) => entry.isDirectory() && entry.name !== sanitizeSegment(currentVersion))
      .map((entry) => entry.name)
      .sort();
    while (oldVersions.length > 1) {
      const stale = oldVersions.shift();
      if (stale) {
        await rm(join(runtimeRoot, stale), { recursive: true, force: true });
      }
    }
  }
}

let sharedManager: ManagedAgentRuntimeManager | undefined;
let sharedManagerBaseUrl: string | null | undefined;

export function configureManagedAgentRuntimeManager(options: {
  runtimeBaseUrl: string | null;
}): void {
  const runtimeBaseUrl = normalizeBaseUrl(options.runtimeBaseUrl);
  if (sharedManager) {
    if (sharedManagerBaseUrl !== runtimeBaseUrl) {
      throw new Error(
        `Managed runtime channel was already configured as ${sharedManagerBaseUrl ?? 'disabled'}`
      );
    }
    return;
  }
  sharedManagerBaseUrl = runtimeBaseUrl;
  sharedManager = new ManagedAgentRuntimeManager({ runtimeBaseUrl });
}

export function getManagedAgentRuntimeManager(): ManagedAgentRuntimeManager {
  if (!sharedManager) {
    throw new Error(
      'Managed agent runtime channel is not configured; assemble CloudPort before agent startup'
    );
  }
  return sharedManager;
}
