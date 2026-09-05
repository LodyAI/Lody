import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
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
import { z } from 'zod';
import { decompressStream } from 'zstd-stream';
import claudePackageJson from '../../../../packages/acp-extension-claude/package.json';
import codexPackageJson from '../../../../packages/acp-extension-codex/package.json';
import grokPackageJson from '../../../../packages/acp-extension-grok/package.json';
import grokRuntimeManifestJson from '../../../../packages/acp-extension-grok/runtime-manifest.json';
import claudeSdkManifestJson from '../../node_modules/@anthropic-ai/claude-agent-sdk/manifest.json';
import claudeSdkPackageJson from '../../node_modules/@anthropic-ai/claude-agent-sdk/package.json';
import claudeRuntimeManifestJson from './claude-runtime-manifest.json';
import codexRuntimeManifestJson from './codex-runtime-manifest.json';
import kimiRuntimeManifestJson from './kimi-runtime-manifest.json';

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
  | {
      kind: 'installed';
      platformArch: string;
      version: string;
      targetVersion: string;
      command: string;
      updateAvailable: boolean;
    };

export type ManagedRuntimeInstallation = {
  runtimeName: ManagedRuntimeName;
  version: string;
  platformArch: string;
  command: string;
};

export type ManagedRuntimeLaunch = ManagedRuntimeInstallation & {
  targetVersion: string;
  updateAvailable: boolean;
};

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
  promise: Promise<ManagedRuntimeInstallation>;
  settled: boolean;
};

const MANAGED_RUNTIME_NAME_VALUES = [
  'codex',
  'claude-code',
  'kimi-code',
  'grok-build',
] as const satisfies readonly ManagedRuntimeName[];

const ManagedRuntimeNameSchema = z.enum(MANAGED_RUNTIME_NAME_VALUES);

const ManagedRuntimeInstallMetadataSchema = z
  .object({
    schemaVersion: z.literal(1),
    runtimeName: ManagedRuntimeNameSchema,
    runtimeVersion: z.string().min(1),
    platformArch: z.string().min(1),
    command: z.string().min(1),
    minNodeVersion: z.string().min(1).optional(),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    archiveSize: z.number().int().positive(),
    installedAt: z.string().min(1),
  })
  .strict();

type ManagedRuntimeInstallMetadata = z.infer<typeof ManagedRuntimeInstallMetadataSchema>;

const LegacyManagedRuntimeInstallMetadataSchema = z
  .object({
    name: ManagedRuntimeNameSchema,
    version: z.string().min(1),
    platform: z.string().min(1),
    archiveSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    archiveSize: z.number().int().positive(),
    executableSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    executableSize: z.number().int().positive().optional(),
    installedAt: z.string().min(1),
  })
  .strict();

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

const CODEX_DEPENDENCY_VERSION = resolveSingleDependencyVersion(
  '@openai/codex',
  codexPackageJson.dependencies['@openai/codex']
);
export const CODEX_RUNTIME_VERSION = codexRuntimeManifestJson.version;
if (CODEX_RUNTIME_VERSION !== CODEX_DEPENDENCY_VERSION) {
  throw new Error(
    `Codex runtime manifest ${CODEX_RUNTIME_VERSION} does not match @openai/codex ${CODEX_DEPENDENCY_VERSION}. Run pnpm mirror:agent-runtimes -- --runtime codex to refresh it.`
  );
}
const CLAUDE_DEPENDENCY_VERSION = resolveSingleDependencyVersion(
  '@anthropic-ai/claude-agent-sdk',
  claudePackageJson.dependencies['@anthropic-ai/claude-agent-sdk']
);
export const CLAUDE_AGENT_SDK_VERSION = claudeRuntimeManifestJson.sdkVersion;
export const CLAUDE_CODE_RUNTIME_VERSION = claudeRuntimeManifestJson.version;
if (
  claudeSdkPackageJson.version !== CLAUDE_DEPENDENCY_VERSION ||
  CLAUDE_AGENT_SDK_VERSION !== CLAUDE_DEPENDENCY_VERSION ||
  CLAUDE_CODE_RUNTIME_VERSION !== claudeSdkManifestJson.version
) {
  throw new Error(
    `Claude runtime manifest ${CLAUDE_AGENT_SDK_VERSION}/${CLAUDE_CODE_RUNTIME_VERSION} does not match @anthropic-ai/claude-agent-sdk ${CLAUDE_DEPENDENCY_VERSION}/${claudeSdkManifestJson.version}. Run pnpm mirror:agent-runtimes -- --runtime claude-code to refresh it.`
  );
}
export const CODEX_ACP_ADAPTER_VERSION = codexPackageJson.version;
export const CLAUDE_ACP_ADAPTER_VERSION = claudePackageJson.version;
export const KIMI_CODE_VERSION = kimiRuntimeManifestJson.version;
export const GROK_ACP_ADAPTER_VERSION = grokPackageJson.version;
export const GROK_BUILD_RUNTIME_VERSION = grokRuntimeManifestJson.officialRuntime.version;
export const KIMI_CODE_MIN_NODE_VERSION = resolveMinimumNodeVersion(
  'Kimi managed runtime manifest',
  `>=${kimiRuntimeManifestJson.minNodeVersion}`
);

export const BUILTIN_CODEX_CAPABILITY_SOURCE_VERSION = `builtin-codex-acp:${CODEX_ACP_ADAPTER_VERSION}+codex:${CODEX_RUNTIME_VERSION}`;
export const BUILTIN_CLAUDE_CAPABILITY_SOURCE_VERSION = `builtin-claude-acp:${CLAUDE_ACP_ADAPTER_VERSION}+agent-sdk:${CLAUDE_AGENT_SDK_VERSION}+claude-code:${CLAUDE_CODE_RUNTIME_VERSION}`;
export const BUILTIN_KIMI_CAPABILITY_SOURCE_VERSION = `builtin-kimi:${KIMI_CODE_VERSION}`;
export const BUILTIN_GROK_CAPABILITY_SOURCE_VERSION = `builtin-grok-acp:${GROK_ACP_ADAPTER_VERSION}+official-grok:${GROK_BUILD_RUNTIME_VERSION}`;

type CodexRuntimePlatform = keyof typeof codexRuntimeManifestJson.artifacts;

function createCodexRuntimeArchive(platform: CodexRuntimePlatform): RuntimeArchive {
  const artifact = codexRuntimeManifestJson.artifacts[platform];
  return {
    fileName: artifact.fileName,
    sha256: artifact.sha256,
    size: artifact.size,
    compression: 'zstd',
    cmd: platform.startsWith('win32-') ? 'bin/codex.exe' : 'bin/codex',
  };
}

type ClaudeRuntimePlatform = keyof typeof claudeRuntimeManifestJson.artifacts;

function createClaudeRuntimeArchive(platform: ClaudeRuntimePlatform): RuntimeArchive {
  const artifact = claudeRuntimeManifestJson.artifacts[platform];
  const executable = claudeSdkManifestJson.platforms[platform];
  return {
    fileName: artifact.fileName,
    sha256: artifact.sha256,
    size: artifact.size,
    compression: 'zstd',
    cmd: platform.startsWith('win32-') ? 'claude.exe' : 'claude',
    stripComponents: 1,
    executableSha256: executable.checksum,
    executableSize: executable.size,
  };
}

const RUNTIMES: Record<ManagedRuntimeName, RuntimeDefinition> = {
  codex: {
    name: 'codex',
    version: CODEX_RUNTIME_VERSION,
    platforms: {
      'darwin-arm64': createCodexRuntimeArchive('darwin-arm64'),
      'darwin-x64': createCodexRuntimeArchive('darwin-x64'),
      'linux-arm64': createCodexRuntimeArchive('linux-arm64'),
      'linux-x64': createCodexRuntimeArchive('linux-x64'),
      'win32-arm64': createCodexRuntimeArchive('win32-arm64'),
      'win32-x64': createCodexRuntimeArchive('win32-x64'),
    },
  },
  'claude-code': {
    name: 'claude-code',
    version: CLAUDE_CODE_RUNTIME_VERSION,
    platforms: {
      'darwin-arm64': createClaudeRuntimeArchive('darwin-arm64'),
      'darwin-x64': createClaudeRuntimeArchive('darwin-x64'),
      'linux-arm64': createClaudeRuntimeArchive('linux-arm64'),
      'linux-x64': createClaudeRuntimeArchive('linux-x64'),
      'linux-arm64-musl': createClaudeRuntimeArchive('linux-arm64-musl'),
      'linux-x64-musl': createClaudeRuntimeArchive('linux-x64-musl'),
      'win32-arm64': createClaudeRuntimeArchive('win32-arm64'),
      'win32-x64': createClaudeRuntimeArchive('win32-x64'),
    },
  },
  'kimi-code': {
    name: 'kimi-code',
    version: KIMI_CODE_VERSION,
    kind: 'node-package',
    minNodeVersion: KIMI_CODE_MIN_NODE_VERSION,
    platforms: {
      node: {
        fileName: kimiRuntimeManifestJson.artifact.fileName,
        sha256: kimiRuntimeManifestJson.artifact.sha256,
        size: kimiRuntimeManifestJson.artifact.size,
        compression: kimiRuntimeManifestJson.artifact.compression as 'zstd',
        cmd: kimiRuntimeManifestJson.artifact.cmd,
      },
    },
  },
  'grok-build': {
    name: 'grok-build',
    version: GROK_BUILD_RUNTIME_VERSION,
    platforms: {
      'darwin-arm64': {
        fileName: `xai-official-grok-darwin-arm64-${GROK_BUILD_RUNTIME_VERSION}.tar.zst`,
        sha256: '63aa0a0a95e7a555a372f1a501dcf59151376d7e4d900e24e1c591ff6cc8f818',
        size: 46222120,
        compression: 'zstd',
        cmd: 'grok',
        executableSha256: '13c7f4f0b9abb00bf38216302ea4bab31f03e13555e3576620eca1de572a8d21',
        executableSize: 131817232,
      },
      'darwin-x64': {
        fileName: `xai-official-grok-darwin-x64-${GROK_BUILD_RUNTIME_VERSION}.tar.zst`,
        sha256: '7bf0af43ba1f3dc8e860e7f887b75966ece7bb6102cc7a3b2fb5af275f757c8a',
        size: 50590131,
        compression: 'zstd',
        cmd: 'grok',
        executableSha256: 'a82210a961deac9f0cb72ec6c334196abf76a587be4593bc59db2deab85ee6dc',
        executableSize: 147358000,
      },
      'linux-arm64': {
        fileName: `xai-official-grok-linux-arm64-${GROK_BUILD_RUNTIME_VERSION}.tar.zst`,
        sha256: 'c888d404ad218caa251cbdbbd0da5836c807957be5a83fd8ab21b69de93469d9',
        size: 49704069,
        compression: 'zstd',
        cmd: 'grok',
        executableSha256: 'bb7c51116564a2219f6a49850815060f416918ac407f1f2ba82c53c0b0d4383f',
        executableSize: 133745832,
      },
      'linux-x64': {
        fileName: `xai-official-grok-linux-x64-${GROK_BUILD_RUNTIME_VERSION}.tar.zst`,
        sha256: '7d0bb4309e634e0ecb63403f35fa468120f5ecf2173feb6518371be1633ecd99',
        size: 53264623,
        compression: 'zstd',
        cmd: 'grok',
        executableSha256: '28dbc967a5843dae2374b6834dadbab95354e685c7e5c8dc750b92a4e5fc7c3e',
        executableSize: 163676672,
      },
      'win32-arm64': {
        fileName: `xai-official-grok-win32-arm64-${GROK_BUILD_RUNTIME_VERSION}.tar.zst`,
        sha256: 'c821de276cb1fa835567bd6c5589709e6ba29182d6b0c9ad7c160cc3df91145c',
        size: 45241480,
        compression: 'zstd',
        cmd: 'grok.exe',
        executableSha256: '9d41447b6eee77cfb7359b7f50935ae64b4e7b7e7ef56c40e6d203f5660317e1',
        executableSize: 121471488,
      },
      'win32-x64': {
        fileName: `xai-official-grok-win32-x64-${GROK_BUILD_RUNTIME_VERSION}.tar.zst`,
        sha256: '5d66d3e0c1e54b050c76b77dfc1dadefbf3e909459a31b4361d8307a671c179c',
        size: 48124303,
        compression: 'zstd',
        cmd: 'grok.exe',
        executableSha256: 'd546dbc995c2ce9ba97c044d6af6b53f8c11c414a6355bf006802d07c572f406',
        executableSize: 139903488,
      },
    },
  },
};

export const MANAGED_RUNTIME_NAMES = Object.freeze([...MANAGED_RUNTIME_NAME_VALUES]);

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

  getTargetVersion(name: ManagedRuntimeName): string {
    return RUNTIMES[name].version;
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

  private async readInstallation(
    name: ManagedRuntimeName,
    version: string,
    platformArch: string
  ): Promise<(ManagedRuntimeInstallation & { metadata: ManagedRuntimeInstallMetadata }) | null> {
    const dir = this.targetDir(name, version, platformArch);
    if (!existsSync(join(dir, COMPLETE_MARKER))) {
      return null;
    }

    let metadata: ManagedRuntimeInstallMetadata;
    try {
      const rawMetadata: unknown = JSON.parse(await readFile(join(dir, 'metadata.json'), 'utf8'));
      const currentMetadata = ManagedRuntimeInstallMetadataSchema.safeParse(rawMetadata);
      if (currentMetadata.success) {
        metadata = currentMetadata.data;
      } else {
        const legacyMetadata = LegacyManagedRuntimeInstallMetadataSchema.parse(rawMetadata);
        const legacyDefinition = RUNTIMES[legacyMetadata.name];
        const legacyArchive = legacyDefinition.platforms[legacyMetadata.platform];
        if (!legacyArchive) {
          throw new ManagedRuntimeError(
            `Managed runtime legacy cache platform is unsupported for ${legacyMetadata.name}/${legacyMetadata.version}/${legacyMetadata.platform}`
          );
        }
        metadata = {
          schemaVersion: 1,
          runtimeName: legacyMetadata.name,
          runtimeVersion: legacyMetadata.version,
          platformArch: legacyMetadata.platform,
          command: legacyArchive.cmd,
          minNodeVersion: legacyDefinition.minNodeVersion,
          archiveSha256: legacyMetadata.archiveSha256,
          archiveSize: legacyMetadata.archiveSize,
          installedAt: legacyMetadata.installedAt,
        };
      }
    } catch (error) {
      throw new ManagedRuntimeError(
        `Managed runtime cache metadata is invalid for ${name}/${version}/${platformArch}`,
        { cause: error }
      );
    }
    if (
      metadata.runtimeName !== name ||
      metadata.runtimeVersion !== version ||
      metadata.platformArch !== platformArch
    ) {
      throw new ManagedRuntimeError(
        `Managed runtime cache metadata does not match its directory for ${name}/${version}/${platformArch}`
      );
    }
    const command = resolve(dir, metadata.command);
    const relativeCommand = relative(dir, command);
    if (
      relativeCommand === '' ||
      relativeCommand === '..' ||
      relativeCommand.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
      !existsSync(command)
    ) {
      throw new ManagedRuntimeError(
        `Managed runtime command is invalid for ${name}/${version}/${platformArch}: ${metadata.command}`
      );
    }
    return {
      runtimeName: name,
      version,
      platformArch,
      command,
      metadata,
    };
  }

  private isHostCompatible(installation: { metadata: ManagedRuntimeInstallMetadata }): boolean {
    const required = installation.metadata.minNodeVersion;
    return !required || isNodeVersionAtLeast(this.nodeVersion, required);
  }

  private isTargetHostCompatible(definition: RuntimeDefinition): boolean {
    return (
      !definition.minNodeVersion ||
      isNodeVersionAtLeast(this.nodeVersion, definition.minNodeVersion)
    );
  }

  private async readCurrentInstallation(
    name: ManagedRuntimeName,
    definition: RuntimeDefinition,
    platformArch: string,
    archive: RuntimeArchive
  ): Promise<(ManagedRuntimeInstallation & { metadata: ManagedRuntimeInstallMetadata }) | null> {
    const installation = await this.readInstallation(name, definition.version, platformArch);
    if (!installation) return null;
    if (
      installation.metadata.command !== archive.cmd ||
      installation.metadata.archiveSha256 !== archive.sha256 ||
      installation.metadata.archiveSize !== archive.size ||
      installation.metadata.minNodeVersion !== definition.minNodeVersion
    ) {
      throw new ManagedRuntimeError(
        `Managed runtime cache metadata does not match the current definition for ${name}/${definition.version}/${platformArch}`
      );
    }
    return installation;
  }

  private async findReusableInstallation(
    name: ManagedRuntimeName,
    definition: RuntimeDefinition,
    platformArch: string
  ): Promise<(ManagedRuntimeInstallation & { metadata: ManagedRuntimeInstallMetadata }) | null> {
    const runtimeRoot = join(this.rootDir, sanitizeSegment(name));
    const entries = await readdir(runtimeRoot, { withFileTypes: true }).catch(() => []);
    const installations: Array<
      ManagedRuntimeInstallation & { metadata: ManagedRuntimeInstallMetadata }
    > = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === sanitizeSegment(definition.version)) continue;
      const installation = await this.readInstallation(name, entry.name, platformArch);
      if (installation && this.isHostCompatible(installation)) {
        installations.push(installation);
      }
    }
    installations.sort((left, right) =>
      right.metadata.installedAt.localeCompare(left.metadata.installedAt)
    );
    return installations[0] ?? null;
  }

  private toLaunch(
    installation: ManagedRuntimeInstallation,
    targetVersion: string,
    targetInstallable = true
  ): ManagedRuntimeLaunch {
    return {
      ...installation,
      targetVersion,
      updateAvailable: targetInstallable && installation.version !== targetVersion,
    };
  }

  async getRuntimeStatus(name: ManagedRuntimeName): Promise<ManagedRuntimeStatus> {
    const resolvedArchive = this.resolveArchive(name);
    if ('unsupported' in resolvedArchive) {
      return { kind: 'unsupported-platform', platformArch: resolvedArchive.platformArch };
    }
    const { definition, platformArch, archive } = resolvedArchive;
    const current = await this.readCurrentInstallation(name, definition, platformArch, archive);
    if (current && this.isHostCompatible(current)) {
      return {
        kind: 'installed',
        platformArch,
        version: current.version,
        targetVersion: definition.version,
        command: current.command,
        updateAvailable: false,
      };
    }
    const fallback = await this.findReusableInstallation(name, definition, platformArch);
    if (fallback) {
      return {
        kind: 'installed',
        platformArch,
        version: fallback.version,
        targetVersion: definition.version,
        command: fallback.command,
        updateAvailable: this.isTargetHostCompatible(definition),
      };
    }
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
    return { kind: 'not-installed', platformArch, version: definition.version };
  }

  async resolveRuntimeForLaunch(
    name: ManagedRuntimeName,
    options: EnsureManagedRuntimeOptions = {}
  ): Promise<ManagedRuntimeLaunch> {
    options.signal?.throwIfAborted();
    const resolvedArchive = this.resolveArchive(name);
    if ('unsupported' in resolvedArchive) {
      throw new ManagedRuntimeUnsupportedPlatformError(name, resolvedArchive.platformArch);
    }
    const { definition, platformArch, archive } = resolvedArchive;
    const current = await this.readCurrentInstallation(name, definition, platformArch, archive);
    if (current && this.isHostCompatible(current)) {
      return this.toLaunch(current, definition.version);
    }
    const fallback = await this.findReusableInstallation(name, definition, platformArch);
    if (fallback) {
      return this.toLaunch(fallback, definition.version, this.isTargetHostCompatible(definition));
    }
    return this.toLaunch(await this.ensureCurrentRuntime(name, options), definition.version);
  }

  async listAvailableUpdates(): Promise<ManagedRuntimeName[]> {
    const updates: ManagedRuntimeName[] = [];
    for (const name of MANAGED_RUNTIME_NAMES) {
      const status = await this.getRuntimeStatus(name);
      if (status.kind === 'installed' && status.updateAvailable) {
        updates.push(name);
      }
    }
    return updates;
  }

  async pruneSupersededVersions(name: ManagedRuntimeName): Promise<void> {
    const resolvedArchive = this.resolveArchive(name);
    if ('unsupported' in resolvedArchive) return;
    const { definition, platformArch, archive } = resolvedArchive;
    const current = await this.readCurrentInstallation(name, definition, platformArch, archive);
    const fallback = await this.findReusableInstallation(name, definition, platformArch);
    const retainedVersions = new Set(
      [current?.version, fallback?.version].filter((version): version is string => Boolean(version))
    );
    const runtimeRoot = join(this.rootDir, sanitizeSegment(name));
    const entries = await readdir(runtimeRoot, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory() && !retainedVersions.has(entry.name)) {
        await rm(join(runtimeRoot, entry.name), { recursive: true, force: true });
      }
    }
  }

  async prepareCache(): Promise<void> {
    for (const name of MANAGED_RUNTIME_NAMES) {
      await this.pruneSupersededVersions(name);
    }
  }

  async ensureCurrentRuntime(
    name: ManagedRuntimeName,
    options: EnsureManagedRuntimeOptions = {}
  ): Promise<ManagedRuntimeInstallation> {
    options.signal?.throwIfAborted();
    const resolvedArchive = this.resolveArchive(name);
    if ('unsupported' in resolvedArchive) {
      throw new ManagedRuntimeUnsupportedPlatformError(name, resolvedArchive.platformArch);
    }
    const { definition, platformArch, archive } = resolvedArchive;
    const dir = this.targetDir(name, definition.version, platformArch);
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
    const current = await this.readCurrentInstallation(name, definition, platformArch, archive);
    if (current) {
      options.onProgress?.({
        runtimeName: name,
        version: definition.version,
        platformArch,
        phase: 'complete',
        downloadedBytes: archive.size,
        totalBytes: archive.size,
        percent: 100,
      });
      return current;
    }

    const key = `${name}:${definition.version}:${platformArch}`;
    let entry = this.inFlight.get(key);
    if (entry?.controller.signal.aborted) {
      await this.waitForCancelledInstallCleanup(entry, options.signal);
      return await this.ensureCurrentRuntime(name, options);
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
  ): Promise<ManagedRuntimeInstallation> {
    if (signal?.aborted) {
      cleanupProgress?.();
      signal.throwIfAborted();
    }
    const consumer = {};
    entry.consumers.add(consumer);
    return await new Promise<ManagedRuntimeInstallation>((completeInstall, reject) => {
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
  ): Promise<ManagedRuntimeInstallation> {
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
            schemaVersion: 1,
            runtimeName: name,
            runtimeVersion: definition.version,
            platformArch,
            command: archive.cmd,
            minNodeVersion: definition.minNodeVersion,
            archiveSha256: archive.sha256,
            archiveSize: archive.size,
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
      this.emitProgress(progressKey, {
        runtimeName: name,
        version: definition.version,
        platformArch,
        phase: 'complete',
        downloadedBytes: archive.size,
        totalBytes: archive.size,
        percent: 100,
      });
      return {
        runtimeName: name,
        version: definition.version,
        platformArch,
        command: resolve(dir, archive.cmd),
      };
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
}

let sharedManager: ManagedAgentRuntimeManager | undefined;
let sharedManagerBaseUrl: string | null | undefined;

export function configureManagedAgentRuntimeManager(options: {
  runtimeBaseUrl: string | null;
}): ManagedAgentRuntimeManager {
  const runtimeBaseUrl = normalizeBaseUrl(options.runtimeBaseUrl);
  if (sharedManager) {
    if (sharedManagerBaseUrl !== runtimeBaseUrl) {
      throw new Error(
        `Managed runtime channel was already configured as ${sharedManagerBaseUrl ?? 'disabled'}`
      );
    }
    return sharedManager;
  }
  sharedManagerBaseUrl = runtimeBaseUrl;
  sharedManager = new ManagedAgentRuntimeManager({ runtimeBaseUrl });
  return sharedManager;
}

export function getManagedAgentRuntimeManager(): ManagedAgentRuntimeManager {
  if (!sharedManager) {
    throw new Error(
      'Managed agent runtime channel is not configured; assemble CloudPort before agent startup'
    );
  }
  return sharedManager;
}
