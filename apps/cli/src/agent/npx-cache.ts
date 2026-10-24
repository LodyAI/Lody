import {
  existsSync as fsExistsSync,
  readdirSync as fsReaddirSync,
  readFileSync as fsReadFileSync,
  renameSync as fsRenameSync,
  rmSync as fsRmSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getLodyDataDir } from '@lody/shared/node/installation-profile';

/**
 * Self-healing for `npx`-launched ACP agents (codex/claude/registry npx agents).
 *
 * `npx pkg@version` materializes the install under `~/.npm/_npx/<hash>/` keyed by a hash
 * of the package spec, then reuses that dir on every later launch — its "already
 * installed?" check only verifies the top-level package is present, never that a native
 * binary / nested dependency actually landed. So a partial download, an `omit=optional`
 * config, or an interrupted first install leaves a sticky broken cache dir that fails the
 * same way forever until it is wiped. This module detects that failure class and removes
 * the poisoned dir(s) so a retry reinstalls cleanly — i.e. it automates the manual
 * "delete ~/.npm/_npx and try again" workaround.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Substrings that mark a broken/partial npx install (missing package, missing native
 * binary, unresolved module) as opposed to a legitimate agent runtime error (auth,
 * model, protocol). Only these trigger a cache wipe + retry; anything else falls through.
 */
const BROKEN_INSTALL_SIGNATURES: readonly string[] = [
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'Cannot find package',
  'Cannot find module',
  'Failed to locate', // acp-extension wrapper's own missing-binary message
  'no prebuilt binary for', // reasonix wrapper when its optional platform package is missing
  'optional dependency was not installed',
  'could not determine executable to run', // npm exec when the bin is absent
  // ESM subpath/dir resolution failures from an incompatible or partially-extracted
  // transitive dep, e.g. @agentclientprotocol/sdk's `import "zod/v4"` landing on a zod
  // whose `./v4` resolves to a bare directory (the claude ACP failure on Node ≥ 20).
  'ERR_UNSUPPORTED_DIR_IMPORT',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
  'ERR_INVALID_PACKAGE_TARGET',
];

/**
 * Native addons can reject the active Electron/V8 fingerprint or Node ABI even
 * though the top-level npx package and its bin are intact. These failures need
 * the same cache purge as a broken install, plus one online metadata refresh:
 * the retained packument may resolve the same incompatible dependency again.
 */
const RUNTIME_INCOMPATIBLE_SIGNATURES: readonly string[] = [
  'unsupported Electron runtime fingerprint',
  'node-addon-require-builtin unsupported',
  'was compiled against a different Node.js version',
  'NODE_MODULE_VERSION',
];

declare const NPX_INSTALL_STATE_BRAND: unique symbol;

type NpxInstallStateBrand = {
  readonly [NPX_INSTALL_STATE_BRAND]: true;
};

type NonEmptyReadonlyArray<T> = readonly [T, ...T[]];

export type NpxInstallProblemReason =
  | 'root-package-json-missing'
  | 'root-package-json-invalid'
  | 'package-json-missing'
  | 'package-json-invalid'
  | 'package-version-mismatch'
  | 'package-bin-missing'
  | 'package-bin-target-missing'
  | 'runtime-fingerprint-mismatch';

export type NpxInstallProblem = Readonly<{
  dir: string;
  reason: NpxInstallProblemReason;
  path?: string;
  message?: string;
}>;

export type ReadyNpxInstallState = Readonly<
  {
    kind: 'ready';
    dirs: NonEmptyReadonlyArray<string>;
  } & NpxInstallStateBrand
>;

export type MissingNpxInstallState = Readonly<
  {
    kind: 'missing';
  } & NpxInstallStateBrand
>;

export type BrokenNpxInstallState = Readonly<
  {
    kind: 'broken';
    dirs: NonEmptyReadonlyArray<string>;
    problems: NonEmptyReadonlyArray<NpxInstallProblem>;
  } & NpxInstallStateBrand
>;

export type NpxInstallState = ReadyNpxInstallState | MissingNpxInstallState | BrokenNpxInstallState;

/**
 * Identity of the runtime that executes an npx closure. Native prebuilds may
 * reject a different Electron/V8 fingerprint at load time, so a closure
 * installed under one Lody runtime must not be reused by another.
 */
export type NpxRuntimeFingerprint = Readonly<{
  electron: string | null;
  node: string;
  v8: string;
  modules: string;
  platform: string;
  arch: string;
}>;

export type NpxRuntimeVersionSource = {
  readonly electron?: string;
  readonly node: string;
  readonly v8: string;
  readonly modules: string;
};

export const NPX_RUNTIME_MARKER_FILE = '.lody-runtime.json';
const NPX_RUNTIME_MARKER_SCHEMA = 1;

export function getNpxRuntimeFingerprint(
  versions: NpxRuntimeVersionSource = process.versions,
  platform: string = process.platform,
  arch: string = process.arch
): NpxRuntimeFingerprint {
  return Object.freeze({
    electron: versions.electron ?? null,
    node: versions.node,
    v8: versions.v8,
    modules: versions.modules,
    platform,
    arch,
  });
}

const NPM_CACHE_CORRUPTION_SIGNATURES: readonly string[] = [
  'eintegrity',
  'tarball data seems to be corrupted',
  'zlib: unexpected end of file',
  'invalid tar header',
];

const NPX_COMMAND_NAMES = new Set(['npx', 'npx.cmd', 'npx.exe']);

export function isNpxCommand(command: string): boolean {
  const normalized = command.trim().replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  const basename = (lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized).toLowerCase();
  return NPX_COMMAND_NAMES.has(basename);
}

export function getLodyNpmCacheDir(home: string = homedir()): string {
  return join(getLodyDataDir(undefined, home), 'npm-cache');
}

function normalizeCachePathForCompare(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

export function getConfiguredNpmCacheDir(env: NodeJS.ProcessEnv): string | undefined {
  const cacheDir = env.npm_config_cache?.trim() || env.NPM_CONFIG_CACHE?.trim();
  return cacheDir || undefined;
}

export function getConfiguredNpxCacheRoot(env: NodeJS.ProcessEnv): string | undefined {
  const cacheDir = getConfiguredNpmCacheDir(env);
  return cacheDir ? join(cacheDir, '_npx') : undefined;
}

export function isLodyNpmCacheDir(cacheDir: string | undefined, home: string = homedir()): boolean {
  if (!cacheDir) {
    return false;
  }
  return (
    normalizeCachePathForCompare(cacheDir) ===
    normalizeCachePathForCompare(getLodyNpmCacheDir(home))
  );
}

/**
 * ACP agents launched through npx should not share the user's default npm cache.
 * User-level ~/.npm is commonly corrupted or made root-owned by `sudo npm`, which
 * then prevents ACP from starting before Lody can show a useful agent response.
 * Keep only npx-launched ACP adapters on a Lody-owned cache; local binaries and
 * non-npx custom agents keep their normal environment.
 */
export function withLodyNpmCacheForNpx(
  command: string,
  env: NodeJS.ProcessEnv,
  options: { home?: string } = {}
): NodeJS.ProcessEnv {
  if (!isNpxCommand(command)) {
    return env;
  }

  const cacheDir = getLodyNpmCacheDir(options.home);
  return {
    ...env,
    npm_config_cache: cacheDir,
    NPM_CONFIG_CACHE: cacheDir,
  };
}

export function isLikelyBrokenNpxInstall(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  if (
    normalized.includes('_npx') &&
    normalized.includes('package.json') &&
    (normalized.includes('could not read package.json') || normalized.includes('enoent'))
  ) {
    return true;
  }
  return BROKEN_INSTALL_SIGNATURES.some((signature) => text.includes(signature));
}

export function isLikelyRuntimeIncompatibleNativeAddon(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  return RUNTIME_INCOMPATIBLE_SIGNATURES.some((signature) =>
    normalized.includes(signature.toLowerCase())
  );
}

export function isLikelyNpmCacheCorruption(text: string | null | undefined): boolean {
  if (!text) {
    return false;
  }
  const normalized = text.toLowerCase();
  if (NPM_CACHE_CORRUPTION_SIGNATURES.some((signature) => normalized.includes(signature))) {
    return true;
  }

  const mentionsNpmCache =
    normalized.includes('_cacache') ||
    normalized.includes('npm cache') ||
    normalized.includes('.lody/npm-cache') ||
    normalized.includes('.lody\\npm-cache') ||
    normalized.includes('.lody-oss/npm-cache') ||
    normalized.includes('.lody-oss\\npm-cache');
  if (!mentionsNpmCache) {
    return false;
  }

  return (
    normalized.includes('syscall rename') ||
    normalized.includes('eexist') ||
    normalized.includes('eacces') ||
    normalized.includes('eperm') ||
    normalized.includes('permission denied') ||
    normalized.includes('file exists')
  );
}

// Capture `<...>/_npx/<hash>` prefixes that npm prints inside error paths (e.g.
// "imported from /Users/u/.npm/_npx/4ecc.../node_modules/..."). The greedy run of
// non-whitespace chars backtracks to the `_npx/<hash>` boundary, so the match ends right
// after the hash and excludes the trailing `/node_modules/...`.
const NPX_CACHE_DIR_RE = /([^\s'"`()]*[/\\]_npx[/\\][0-9a-fA-F]+)/g;

export function extractNpxCacheDirsFromText(text: string | null | undefined): string[] {
  if (!text) {
    return [];
  }
  const dirs = new Set<string>();
  for (const match of text.matchAll(NPX_CACHE_DIR_RE)) {
    if (match[1]) {
      dirs.add(match[1]);
    }
  }
  return [...dirs];
}

export interface NpxCacheIo {
  existsSync(path: string): boolean;
  readFileSync(path: string): string;
  readdirSync(path: string): string[];
  rmSync(path: string): void;
  writeFileSync(path: string, content: string): void;
  renameSync(from: string, to: string): void;
}

const defaultIo: NpxCacheIo = {
  existsSync: (path) => fsExistsSync(path),
  readFileSync: (path) => fsReadFileSync(path, 'utf8'),
  readdirSync: (path) => fsReaddirSync(path),
  rmSync: (path) => fsRmSync(path, { recursive: true, force: true }),
  writeFileSync: (path, content) => fsWriteFileSync(path, content, 'utf8'),
  renameSync: (from, to) => fsRenameSync(from, to),
};

function listNpxCacheDirs(
  roots: readonly string[],
  io: Pick<NpxCacheIo, 'existsSync' | 'readdirSync'>
): string[] {
  const dirs: string[] = [];
  for (const root of roots) {
    try {
      if (!io.existsSync(root)) {
        continue;
      }
      for (const entry of io.readdirSync(root)) {
        dirs.push(join(root, entry));
      }
    } catch {
      // Ignore unreadable roots; startup will still surface the original npm error.
    }
  }
  return dirs;
}

function purgeExistingDirs(
  candidates: Iterable<string>,
  io: Pick<NpxCacheIo, 'existsSync' | 'rmSync'>,
  allowedRoots?: readonly string[]
): string[] {
  const normalizedAllowedRoots = allowedRoots?.map(normalizeCachePathForCompare);
  const purged: string[] = [];

  for (const dir of new Set(candidates)) {
    if (normalizedAllowedRoots) {
      const normalizedDir = normalizeCachePathForCompare(dir);
      const isAllowed = normalizedAllowedRoots.some(
        (root) => normalizedDir === root || normalizedDir.startsWith(`${root}/`)
      );
      if (!isAllowed) {
        continue;
      }
    }

    try {
      if (!io.existsSync(dir)) {
        continue;
      }
      io.rmSync(dir);
      purged.push(dir);
    } catch {
      // Best effort only; a final startup failure will still surface the original error.
    }
  }

  return purged;
}

function brandNpxInstallState<T extends object>(state: T): Readonly<T & NpxInstallStateBrand> {
  return Object.freeze(state) as Readonly<T & NpxInstallStateBrand>;
}

function toNonEmptyReadonlyArray<T>(items: readonly T[]): NonEmptyReadonlyArray<T> | undefined {
  if (items.length === 0) {
    return undefined;
  }
  return Object.freeze([...items]) as NonEmptyReadonlyArray<T>;
}

function createMissingNpxInstallState(): MissingNpxInstallState {
  return brandNpxInstallState({ kind: 'missing' });
}

function createReadyNpxInstallState(dirs: readonly string[]): ReadyNpxInstallState {
  const nonEmptyDirs = toNonEmptyReadonlyArray([...new Set(dirs)]);
  if (!nonEmptyDirs) {
    throw new Error('ready npx install state requires at least one directory');
  }
  return brandNpxInstallState({ kind: 'ready', dirs: nonEmptyDirs });
}

function createBrokenNpxInstallState(
  problems: readonly NpxInstallProblem[]
): BrokenNpxInstallState | MissingNpxInstallState {
  const dirs = toNonEmptyReadonlyArray([...new Set(problems.map((problem) => problem.dir))]);
  const nonEmptyProblems = toNonEmptyReadonlyArray(problems);
  if (!dirs || !nonEmptyProblems) {
    return createMissingNpxInstallState();
  }
  return brandNpxInstallState({
    kind: 'broken',
    dirs,
    problems: nonEmptyProblems,
  });
}

function readJsonRecord(
  io: Pick<NpxCacheIo, 'readFileSync'>,
  filePath: string
): { ok: true; value: Record<string, unknown> } | { ok: false; message: string } {
  try {
    const parsed: unknown = JSON.parse(io.readFileSync(filePath));
    if (!isRecord(parsed)) {
      return { ok: false, message: 'JSON root is not an object' };
    }
    return { ok: true, value: parsed };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function parseRuntimeFingerprint(value: unknown): NpxRuntimeFingerprint | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const electronValue = value.electron;
  const electron =
    electronValue === null ? null : typeof electronValue === 'string' ? electronValue : undefined;
  const node = readString(value, 'node');
  const v8 = readString(value, 'v8');
  const modules = readString(value, 'modules');
  const platform = readString(value, 'platform');
  const arch = readString(value, 'arch');
  if (
    electron === undefined ||
    node === undefined ||
    v8 === undefined ||
    modules === undefined ||
    platform === undefined ||
    arch === undefined
  ) {
    return undefined;
  }
  return { electron, node, v8, modules, platform, arch };
}

function describeRuntimeFingerprint(fingerprint: NpxRuntimeFingerprint): string {
  const runtime =
    fingerprint.electron === null ? `Node ${fingerprint.node}` : `Electron ${fingerprint.electron}`;
  return (
    `${runtime}, V8 ${fingerprint.v8}, modules ${fingerprint.modules}, ` +
    `${fingerprint.platform}-${fingerprint.arch}`
  );
}

function runtimeFingerprintsMatch(
  expected: NpxRuntimeFingerprint,
  actual: NpxRuntimeFingerprint
): boolean {
  return (
    expected.electron === actual.electron &&
    expected.node === actual.node &&
    expected.v8 === actual.v8 &&
    expected.modules === actual.modules &&
    expected.platform === actual.platform &&
    expected.arch === actual.arch
  );
}

/**
 * A missing marker keeps legacy closures healthy: they predate this check, and
 * invalidating every existing npx install on upgrade is worse than letting the
 * runtime-incompatible signature recover a closure that is actually broken.
 */
function inspectRuntimeMarker(
  io: Pick<NpxCacheIo, 'existsSync' | 'readFileSync'>,
  dir: string,
  expected: NpxRuntimeFingerprint
): NpxInstallProblem | null {
  const markerPath = join(dir, NPX_RUNTIME_MARKER_FILE);
  if (!io.existsSync(markerPath)) {
    return null;
  }

  const markerRead = readJsonRecord(io, markerPath);
  if (!markerRead.ok) {
    return {
      dir,
      reason: 'runtime-fingerprint-mismatch',
      path: markerPath,
      message: `invalid runtime marker: ${markerRead.message}`,
    };
  }

  const fingerprint = parseRuntimeFingerprint(markerRead.value.fingerprint);
  if (markerRead.value.schema !== NPX_RUNTIME_MARKER_SCHEMA || !fingerprint) {
    return {
      dir,
      reason: 'runtime-fingerprint-mismatch',
      path: markerPath,
      message: 'invalid runtime marker',
    };
  }

  if (!runtimeFingerprintsMatch(expected, fingerprint)) {
    return {
      dir,
      reason: 'runtime-fingerprint-mismatch',
      path: markerPath,
      message:
        `expected ${describeRuntimeFingerprint(expected)}, ` +
        `found ${describeRuntimeFingerprint(fingerprint)}`,
    };
  }

  return null;
}

export interface WriteNpxRuntimeMarkersArgs {
  io?: Pick<NpxCacheIo, 'writeFileSync' | 'renameSync' | 'rmSync'>;
  allowedRoots?: readonly string[];
}

let runtimeMarkerWriteSequence = 0;

/**
 * Record the runtime that validated a ready npx closure. Best effort: a cache
 * directory that cannot accept the marker must not prevent agent startup.
 */
export function writeNpxRuntimeMarkers(
  dirs: readonly string[],
  fingerprint: NpxRuntimeFingerprint,
  args: WriteNpxRuntimeMarkersArgs = {}
): string[] {
  const io = args.io ?? defaultIo;
  const normalizedAllowedRoots = args.allowedRoots?.map(normalizeCachePathForCompare);
  const content = `${JSON.stringify(
    { schema: NPX_RUNTIME_MARKER_SCHEMA, fingerprint },
    null,
    2
  )}\n`;
  const written: string[] = [];

  for (const dir of new Set(dirs)) {
    if (normalizedAllowedRoots) {
      const normalizedDir = normalizeCachePathForCompare(dir);
      const isAllowed = normalizedAllowedRoots.some(
        (root) => normalizedDir === root || normalizedDir.startsWith(`${root}/`)
      );
      if (!isAllowed) {
        continue;
      }
    }

    const markerPath = join(dir, NPX_RUNTIME_MARKER_FILE);
    const temporaryPath = `${markerPath}.${process.pid}.${runtimeMarkerWriteSequence++}.tmp`;
    let writeStarted = false;
    try {
      // Rename the completed document into place so a concurrent preflight
      // never reads a half-written marker and purges a healthy closure.
      io.writeFileSync(temporaryPath, content);
      writeStarted = true;
      io.renameSync(temporaryPath, markerPath);
      written.push(dir);
    } catch {
      if (writeStarted) {
        try {
          io.rmSync(temporaryPath);
        } catch {
          // Best effort only; the closure is already usable.
        }
      }
    }
  }

  return written;
}

function recordHasPackageVersion(
  rootPackageJson: Record<string, unknown>,
  packageName: string,
  version: string
): boolean {
  const npxMeta = rootPackageJson._npx;
  if (isRecord(npxMeta) && Array.isArray(npxMeta.packages)) {
    return npxMeta.packages.includes(`${packageName}@${version}`);
  }

  const dependencies = rootPackageJson.dependencies;
  if (isRecord(dependencies) && typeof dependencies[packageName] === 'string') {
    const dependencyVersion = dependencies[packageName].trim();
    return (
      dependencyVersion === version ||
      dependencyVersion === `^${version}` ||
      dependencyVersion === `~${version}`
    );
  }

  return false;
}

function resolvePackageBinTargets(
  packageJson: Record<string, unknown>,
  packageDir: string
): string[] {
  const bin = packageJson.bin;
  if (typeof bin === 'string' && bin.trim()) {
    return [join(packageDir, bin)];
  }
  if (!isRecord(bin)) {
    return [];
  }
  return Object.values(bin)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .map((relativePath) => join(packageDir, relativePath));
}

export interface NpxCacheLocateOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
}

/**
 * Candidate `_npx` root dirs. Respects a user-configured cache (`npm_config_cache`) and
 * falls back to the npm defaults per platform, so we still find the dir when stderr did
 * not happen to print its path.
 */
export function getNpxCacheRoots(options: NpxCacheLocateOptions = {}): string[] {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.home ?? homedir();
  const roots = new Set<string>();

  const configuredCache = env.npm_config_cache?.trim();
  if (configuredCache) {
    roots.add(join(configuredCache, '_npx'));
  }

  if (home) {
    if (platform === 'win32') {
      const localAppData = env.LOCALAPPDATA?.trim();
      if (localAppData) {
        roots.add(join(localAppData, 'npm-cache', '_npx'));
      }
      roots.add(join(home, 'AppData', 'Local', 'npm-cache', '_npx'));
    } else {
      roots.add(join(home, '.npm', '_npx'));
    }
  }

  return [...roots];
}

export interface InspectNpxInstallStateOptions extends NpxCacheLocateOptions {
  io?: NpxCacheIo;
  roots?: string[];
  /** Opt in to invalidating closures installed under a different runtime. */
  runtimeFingerprint?: NpxRuntimeFingerprint;
}

export function inspectNpxInstallState(
  packageName: string,
  version: string,
  options: InspectNpxInstallStateOptions = {}
): NpxInstallState {
  const io = options.io ?? defaultIo;
  const roots = options.roots ?? getNpxCacheRoots(options);
  const readyDirs: string[] = [];
  const problems: NpxInstallProblem[] = [];

  for (const dir of listNpxCacheDirs(roots, io)) {
    const rootPackageJsonPath = join(dir, 'package.json');
    const packageDir = join(dir, 'node_modules', packageName);
    const packageJsonPath = join(packageDir, 'package.json');
    const hasRootPackageJson = io.existsSync(rootPackageJsonPath);
    const hasPackageJson = io.existsSync(packageJsonPath);
    let rootPackageJson: Record<string, unknown> | null = null;
    let rootProblem: NpxInstallProblem | null = null;

    if (hasRootPackageJson) {
      const rootRead = readJsonRecord(io, rootPackageJsonPath);
      if (rootRead.ok) {
        rootPackageJson = rootRead.value;
      } else {
        rootProblem = {
          dir,
          reason: 'root-package-json-invalid',
          path: rootPackageJsonPath,
          message: rootRead.message,
        };
      }
    } else if (hasPackageJson) {
      rootProblem = {
        dir,
        reason: 'root-package-json-missing',
        path: rootPackageJsonPath,
      };
    }

    const rootReferencesPackage = rootPackageJson
      ? recordHasPackageVersion(rootPackageJson, packageName, version)
      : false;
    if (!rootReferencesPackage && !hasPackageJson) {
      continue;
    }

    if (!hasPackageJson) {
      problems.push({
        dir,
        reason: 'package-json-missing',
        path: packageJsonPath,
      });
      continue;
    }

    const packageRead = readJsonRecord(io, packageJsonPath);
    if (!packageRead.ok) {
      if (rootProblem) {
        problems.push(rootProblem);
      }
      problems.push({
        dir,
        reason: 'package-json-invalid',
        path: packageJsonPath,
        message: packageRead.message,
      });
      continue;
    }

    if (packageRead.value.version !== version) {
      if (rootReferencesPackage) {
        problems.push({
          dir,
          reason: 'package-version-mismatch',
          path: packageJsonPath,
          message: `expected ${version}, found ${String(packageRead.value.version)}`,
        });
      }
      continue;
    }

    if (rootProblem) {
      problems.push(rootProblem);
      continue;
    }

    const binTargets = resolvePackageBinTargets(packageRead.value, packageDir);
    if (binTargets.length === 0) {
      problems.push({
        dir,
        reason: 'package-bin-missing',
        path: packageJsonPath,
      });
      continue;
    }

    if (!binTargets.some((target) => io.existsSync(target))) {
      problems.push({
        dir,
        reason: 'package-bin-target-missing',
        path: binTargets[0],
      });
      continue;
    }

    if (options.runtimeFingerprint) {
      const runtimeProblem = inspectRuntimeMarker(io, dir, options.runtimeFingerprint);
      if (runtimeProblem) {
        problems.push(runtimeProblem);
        continue;
      }
    }

    readyDirs.push(dir);
  }

  if (problems.length > 0) {
    return createBrokenNpxInstallState(problems);
  }

  if (readyDirs.length > 0) {
    return createReadyNpxInstallState(readyDirs);
  }

  return createMissingNpxInstallState();
}

/**
 * Scan the npx cache roots for `_npx/<hash>` dirs that hold the given package at the
 * given version. A cache dir whose `package.json` is unreadable/corrupt is treated as a
 * match (it is broken and should be purged too).
 */
export function findNpxCacheDirsForPackage(
  packageName: string,
  version: string,
  options: NpxCacheLocateOptions & { io?: NpxCacheIo; roots?: string[] } = {}
): string[] {
  const io = options.io ?? defaultIo;
  const roots = options.roots ?? getNpxCacheRoots(options);
  const found = new Set<string>();

  for (const dir of listNpxCacheDirs(roots, io)) {
    const packageJsonPath = join(dir, 'node_modules', packageName, 'package.json');
    try {
      if (!io.existsSync(packageJsonPath)) {
        continue;
      }
      const parsed: unknown = JSON.parse(io.readFileSync(packageJsonPath));
      if (isRecord(parsed) && parsed.version === version) {
        found.add(dir);
      }
    } catch {
      found.add(dir);
    }
  }

  return [...found];
}

export interface PurgeBrokenNpxCacheArgs extends NpxCacheLocateOptions {
  /** Package name we asked npx to install (used to scan the cache by content). */
  packageName?: string;
  version?: string;
  /** Error text / stderr tail that may embed the failing `_npx/<hash>` path directly. */
  hintText?: string | null;
  io?: NpxCacheIo;
  roots?: string[];
  allowedRoots?: string[];
}

/**
 * Remove poisoned npx cache dirs for a failed launch. Combines two sources: dirs parsed
 * straight out of the error text (precise, always present for the codex case) and a scan
 * of the cache roots by package+version (covers cases where the path is not in stderr).
 * Best-effort: a dir we cannot remove is skipped, never throws. Returns the dirs purged.
 */
export function purgeBrokenNpxCache(args: PurgeBrokenNpxCacheArgs): string[] {
  const io = args.io ?? defaultIo;
  const candidates = new Set<string>(extractNpxCacheDirsFromText(args.hintText));

  if (args.packageName && args.version) {
    for (const dir of findNpxCacheDirsForPackage(args.packageName, args.version, {
      io,
      roots: args.roots,
      env: args.env,
      platform: args.platform,
      home: args.home,
    })) {
      candidates.add(dir);
    }
  }

  return purgeExistingDirs(candidates, io, args.allowedRoots);
}

export interface PurgeBrokenNpxInstallArgs {
  io?: Pick<NpxCacheIo, 'existsSync' | 'rmSync'>;
  allowedRoots?: string[];
}

export function purgeBrokenNpxInstall(
  state: BrokenNpxInstallState,
  args: PurgeBrokenNpxInstallArgs = {}
): string[] {
  const io = args.io ?? defaultIo;
  return purgeExistingDirs(state.dirs, io, args.allowedRoots);
}

export interface PurgeLodyNpmCacheArgs extends NpxCacheLocateOptions {
  io?: Pick<NpxCacheIo, 'existsSync' | 'rmSync'>;
}

/**
 * Remove only Lody-owned npm cache state after npm itself reports cache
 * corruption/permission trouble. This intentionally refuses to touch arbitrary
 * `npm_config_cache` values: user-level `~/.npm` may contain unrelated package
 * manager state, while the active Lody installation's `npm-cache` exists solely
 * for ACP npx adapters and can be rebuilt safely on the next retry.
 */
export function purgeLodyNpmCache(args: PurgeLodyNpmCacheArgs): string[] {
  const io = args.io ?? defaultIo;
  const cacheDir = getConfiguredNpmCacheDir(args.env ?? process.env);
  if (!cacheDir || !isLodyNpmCacheDir(cacheDir, args.home)) {
    return [];
  }

  const candidates = [join(cacheDir, '_npx'), join(cacheDir, '_cacache')];
  return purgeExistingDirs(candidates, io);
}

export interface NpxPackageSpec {
  name: string;
  version: string;
}

/** Parse `pkg@version` / `@scope/pkg@version` into its name and version. */
export function parseNpxPackageSpec(spec: string | undefined): NpxPackageSpec | undefined {
  if (!spec) {
    return undefined;
  }
  const at = spec.lastIndexOf('@');
  // `at <= 0` means there is no version separator (a bare name, or a scope-only `@scope`).
  if (at <= 0) {
    return undefined;
  }
  const name = spec.slice(0, at);
  const version = spec.slice(at + 1);
  if (!name || !version) {
    return undefined;
  }
  return { name, version };
}

/**
 * Recover the primary installed package spec from a built `npx` arg list.
 * Single-package launches put it immediately after `-y`/`--yes`; composed
 * launches use one or more `--package` selectors followed by a bin name.
 */
export function parseNpxPackageSpecFromArgs(args: readonly string[]): NpxPackageSpec | undefined {
  const yesIndex = args.findIndex((arg) => arg === '-y' || arg === '--yes');
  if (yesIndex === -1) {
    return undefined;
  }
  const directSpec = parseNpxPackageSpec(args[yesIndex + 1]);
  if (directSpec) {
    return directSpec;
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--package' || arg === '-p') {
      const packageSpec = parseNpxPackageSpec(args[index + 1]);
      if (packageSpec) return packageSpec;
      index += 1;
      continue;
    }
    if (arg?.startsWith('--package=')) {
      const packageSpec = parseNpxPackageSpec(arg.slice('--package='.length));
      if (packageSpec) return packageSpec;
    }
  }
  return undefined;
}
