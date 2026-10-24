import { ACP_COLD_NPX_INIT_TIMEOUT_MS, ACP_NPX_STARTUP_MAX_ATTEMPTS } from '@lody/shared';
import type { AcpStartupTimeoutOptions } from './agent-client';
import { AcpTimeoutError } from './agent-client';
import type { Logger } from '@/utils/logger';
import {
  findNpxCacheDirsForPackage,
  getConfiguredNpxCacheRoot,
  inspectNpxInstallState,
  isLikelyBrokenNpxInstall,
  isLikelyNpmCacheCorruption,
  isLikelyRuntimeIncompatibleNativeAddon,
  isNpxCommand,
  parseNpxPackageSpecFromArgs,
  purgeBrokenNpxCache,
  purgeBrokenNpxInstall,
  purgeLodyNpmCache,
  writeNpxRuntimeMarkers,
  type NpxCacheIo,
  type NpxRuntimeFingerprint,
} from './npx-cache';

/**
 * Re-exported so the client-side backstop in `@lody/shared/acp-startup-budget`
 * and this startup path cannot drift into two different worst cases. The
 * backstop has to cover every attempt this policy may make, not just one, so
 * the attempt count is part of the same shared binding as the timeout.
 */
export const COLD_NPX_INIT_TIMEOUT_MS = ACP_COLD_NPX_INIT_TIMEOUT_MS;
export const DEFAULT_NPX_STARTUP_MAX_ATTEMPTS = ACP_NPX_STARTUP_MAX_ATTEMPTS;

export type NpxStartupAttemptInput = {
  attempt: number;
  args: readonly string[];
  startupTimeouts?: AcpStartupTimeoutOptions;
};

export type RunNpxStartupWithRecoveryOptions<T> = {
  command: string;
  args: readonly string[];
  env: NodeJS.ProcessEnv;
  logger: Pick<Logger, 'debug' | 'warn'>;
  logPrefix: string;
  attempt(input: NpxStartupAttemptInput): Promise<T>;
  getStderrTail(): string;
  cleanupFailedAttempt?: () => Promise<void>;
  startupTimeouts?: AcpStartupTimeoutOptions;
  coldInitTimeoutMs?: number;
  maxAttempts?: number;
  npxCacheIo?: NpxCacheIo;
  npxCacheRoots?: string[];
  /**
   * Opt in to runtime validation for closures with native addons. DeepSeek
   * Harness passes its runtime identity so an Electron upgrade invalidates the
   * old closure; other npx agents keep their existing cache behavior.
   */
  runtimeFingerprint?: NpxRuntimeFingerprint;
};

function describeStartupError(error: unknown, stderrTail?: string): string {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const embeddedStderrTail =
    typeof error === 'object' &&
    error !== null &&
    'stderrTail' in error &&
    typeof error.stderrTail === 'string'
      ? error.stderrTail
      : undefined;
  const fallbackStderrTail = embeddedStderrTail ?? stderrTail?.trim() ?? '';
  return fallbackStderrTail ? `${errorMessage}\n${fallbackStderrTail}` : errorMessage;
}

function withColdNpxInitTimeout(
  startupTimeouts: AcpStartupTimeoutOptions | undefined,
  coldInitTimeoutMs: number
): AcpStartupTimeoutOptions {
  const currentInitTimeoutMs = startupTimeouts?.initTimeoutMs ?? 0;
  return {
    ...startupTimeouts,
    initTimeoutMs: Math.max(currentInitTimeoutMs, coldInitTimeoutMs),
  };
}

function isColdNpxInitializeTimeout(error: unknown, installWasCold: boolean): boolean {
  return (
    installWasCold &&
    error instanceof AcpTimeoutError &&
    error.operationName === 'connection.initialize'
  );
}

const EXACT_SEMVER_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function isLikelyStaleNpxPackageMetadata(text: string): boolean {
  const normalized = text.toLowerCase();
  return (
    normalized.includes('code etarget') ||
    normalized.includes('no matching version found for') ||
    (normalized.includes('code e404') && normalized.includes('no match found for version'))
  );
}

function preferOnlineNpxArgs(args: readonly string[]): readonly string[] {
  return args.map((arg) => (arg === '--prefer-offline' ? '--prefer-online' : arg));
}

function recordNpxRuntimeMarkers(args: {
  packageName: string;
  version: string;
  env: NodeJS.ProcessEnv;
  roots: string[] | undefined;
  allowedRoots: string[];
  fingerprint: NpxRuntimeFingerprint | undefined;
  io: NpxCacheIo | undefined;
  logger: Pick<Logger, 'debug'>;
  logPrefix: string;
}): void {
  if (!args.fingerprint) {
    return;
  }
  try {
    const dirs = findNpxCacheDirsForPackage(args.packageName, args.version, {
      env: args.env,
      roots: args.roots,
      io: args.io,
    });
    writeNpxRuntimeMarkers(dirs, args.fingerprint, {
      io: args.io,
      allowedRoots: args.allowedRoots,
    });
  } catch (error) {
    // The agent already started; a marker is an optimization, not a launch condition.
    args.logger.debug(
      `${args.logPrefix} could not record the npx runtime marker: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function runNpxStartupWithRecovery<T>(
  options: RunNpxStartupWithRecoveryOptions<T>
): Promise<T> {
  const npxSpec = isNpxCommand(options.command)
    ? parseNpxPackageSpecFromArgs(options.args)
    : undefined;
  if (!npxSpec) {
    return options.attempt({
      attempt: 1,
      args: options.args,
      startupTimeouts: options.startupTimeouts,
    });
  }

  const maxAttempts = options.maxAttempts ?? DEFAULT_NPX_STARTUP_MAX_ATTEMPTS;
  const coldInitTimeoutMs = options.coldInitTimeoutMs ?? COLD_NPX_INIT_TIMEOUT_MS;
  const npxCacheRoot = getConfiguredNpxCacheRoot(options.env);
  const roots = options.npxCacheRoots ?? (npxCacheRoot ? [npxCacheRoot] : undefined);
  const allowedRoots = options.npxCacheRoots ?? (npxCacheRoot ? [npxCacheRoot] : []);
  let refreshMetadataOnNextAttempt = false;
  let metadataRefreshAttempted = false;
  let runtimeRecoveryAttempted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let installState = inspectNpxInstallState(npxSpec.name, npxSpec.version, {
      env: options.env,
      roots,
      io: options.npxCacheIo,
      runtimeFingerprint: options.runtimeFingerprint,
    });
    let installWasCold = installState.kind === 'missing';

    if (installState.kind === 'broken') {
      const hasRuntimeMismatch = installState.problems.some(
        (problem) => problem.reason === 'runtime-fingerprint-mismatch'
      );
      const purged = purgeBrokenNpxInstall(installState, {
        io: options.npxCacheIo,
        allowedRoots,
      });
      installWasCold = true;
      if (hasRuntimeMismatch && purged.length > 0 && options.args.includes('--prefer-offline')) {
        // The retained packument may resolve the same runtime-incompatible
        // dependency again; revalidate it before the reinstall.
        refreshMetadataOnNextAttempt = true;
        metadataRefreshAttempted = true;
      }
      options.logger.warn(
        `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} has a broken npx install` +
          `${hasRuntimeMismatch ? ' for the current runtime' : ''}; ` +
          `purged ${purged.length} npx cache dir(s) before startup (attempt ${attempt}/${maxAttempts})`
      );
      installState = inspectNpxInstallState(npxSpec.name, npxSpec.version, {
        env: options.env,
        roots,
        io: options.npxCacheIo,
        runtimeFingerprint: options.runtimeFingerprint,
      });
    }

    const startupTimeouts = installWasCold
      ? withColdNpxInitTimeout(options.startupTimeouts, coldInitTimeoutMs)
      : options.startupTimeouts;
    const attemptArgs = refreshMetadataOnNextAttempt
      ? preferOnlineNpxArgs(options.args)
      : options.args;
    refreshMetadataOnNextAttempt = false;

    try {
      const result = await options.attempt({
        attempt,
        args: attemptArgs,
        startupTimeouts,
      });
      recordNpxRuntimeMarkers({
        packageName: npxSpec.name,
        version: npxSpec.version,
        env: options.env,
        roots,
        allowedRoots,
        fingerprint: options.runtimeFingerprint,
        io: options.npxCacheIo,
        logger: options.logger,
        logPrefix: options.logPrefix,
      });
      return result;
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }

      const hintText = describeStartupError(error, options.getStderrTail());
      const shouldRefreshPackageMetadata =
        installWasCold &&
        !metadataRefreshAttempted &&
        options.args.includes('--prefer-offline') &&
        EXACT_SEMVER_RE.test(npxSpec.version) &&
        isLikelyStaleNpxPackageMetadata(hintText);
      if (shouldRefreshPackageMetadata) {
        metadataRefreshAttempted = true;
        refreshMetadataOnNextAttempt = true;
        await options.cleanupFailedAttempt?.();
        options.logger.warn(
          `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} was missing from cached npm ` +
            `metadata; retrying once with an online metadata refresh (attempt ${
              attempt + 1
            }/${maxAttempts})`
        );
        continue;
      }

      if (!runtimeRecoveryAttempted && isLikelyRuntimeIncompatibleNativeAddon(hintText)) {
        runtimeRecoveryAttempted = true;
        const purged = purgeBrokenNpxCache({
          packageName: npxSpec.name,
          version: npxSpec.version,
          hintText,
          env: options.env,
          roots,
          allowedRoots,
          io: options.npxCacheIo,
        });
        if (purged.length > 0) {
          if (options.args.includes('--prefer-offline')) {
            // The cached packument may still resolve the incompatible native
            // dependency; revalidate it before reinstalling.
            refreshMetadataOnNextAttempt = true;
            metadataRefreshAttempted = true;
          }
          await options.cleanupFailedAttempt?.();
          options.logger.warn(
            `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} failed with a ` +
              `runtime-incompatible native dependency; purged ${purged.length} npx cache ` +
              `dir(s), retrying (attempt ${attempt + 1}/${maxAttempts})`
          );
          continue;
        }
      }

      const shouldPurgeLodyNpmCache =
        isLikelyNpmCacheCorruption(hintText) || isColdNpxInitializeTimeout(error, installWasCold);
      if (shouldPurgeLodyNpmCache) {
        const brokenPurged = purgeBrokenNpxCache({
          packageName: npxSpec.name,
          version: npxSpec.version,
          hintText,
          env: options.env,
          roots,
          allowedRoots,
          io: options.npxCacheIo,
        });
        const lodyPurged =
          brokenPurged.length === 0
            ? purgeLodyNpmCache({ env: options.env, io: options.npxCacheIo })
            : [];
        await options.cleanupFailedAttempt?.();
        options.logger.warn(
          `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} failed during npx startup; ` +
            `purged ${brokenPurged.length + lodyPurged.length} Lody npm cache dir(s), retrying ` +
            `(attempt ${attempt + 1}/${maxAttempts})`
        );
        continue;
      }

      if (isLikelyBrokenNpxInstall(hintText)) {
        const purged = purgeBrokenNpxCache({
          packageName: npxSpec.name,
          version: npxSpec.version,
          hintText,
          env: options.env,
          roots,
          allowedRoots,
          io: options.npxCacheIo,
        });
        await options.cleanupFailedAttempt?.();
        options.logger.warn(
          `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} failed with a broken-install error; ` +
            `purged ${purged.length} npx cache dir(s), retrying (attempt ${
              attempt + 1
            }/${maxAttempts})`
        );
        continue;
      }

      throw error;
    }
  }

  throw new Error('[acp-startup] exhausted ACP startup attempts without a result');
}
