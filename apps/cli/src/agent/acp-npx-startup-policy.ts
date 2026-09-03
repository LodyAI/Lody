import { ACP_COLD_NPX_INIT_TIMEOUT_MS } from '@lody/shared';
import type { AcpStartupTimeoutOptions } from './agent-client';
import { AcpTimeoutError } from './agent-client';
import type { Logger } from '@/utils/logger';
import {
  getConfiguredNpxCacheRoot,
  inspectNpxInstallState,
  isLikelyBrokenNpxInstall,
  isLikelyNpmCacheCorruption,
  isNpxCommand,
  parseNpxPackageSpecFromArgs,
  purgeBrokenNpxCache,
  purgeBrokenNpxInstall,
  purgeLodyNpmCache,
  type NpxCacheIo,
} from './npx-cache';

/**
 * Re-exported so the client-side backstop in `@lody/shared/acp-startup-budget`
 * and this startup path cannot drift into two different worst cases.
 */
export const COLD_NPX_INIT_TIMEOUT_MS = ACP_COLD_NPX_INIT_TIMEOUT_MS;

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

  const maxAttempts = options.maxAttempts ?? 3;
  const coldInitTimeoutMs = options.coldInitTimeoutMs ?? COLD_NPX_INIT_TIMEOUT_MS;
  const npxCacheRoot = getConfiguredNpxCacheRoot(options.env);
  const roots = options.npxCacheRoots ?? (npxCacheRoot ? [npxCacheRoot] : undefined);
  const allowedRoots = options.npxCacheRoots ?? (npxCacheRoot ? [npxCacheRoot] : []);
  let refreshMetadataOnNextAttempt = false;
  let metadataRefreshAttempted = false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let installState = inspectNpxInstallState(npxSpec.name, npxSpec.version, {
      env: options.env,
      roots,
      io: options.npxCacheIo,
    });
    let installWasCold = installState.kind === 'missing';

    if (installState.kind === 'broken') {
      const purged = purgeBrokenNpxInstall(installState, {
        io: options.npxCacheIo,
        allowedRoots,
      });
      installWasCold = true;
      options.logger.warn(
        `${options.logPrefix} ${npxSpec.name}@${npxSpec.version} has a broken npx install; ` +
          `purged ${purged.length} npx cache dir(s) before startup (attempt ${attempt}/${maxAttempts})`
      );
      installState = inspectNpxInstallState(npxSpec.name, npxSpec.version, {
        env: options.env,
        roots,
        io: options.npxCacheIo,
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
      return await options.attempt({
        attempt,
        args: attemptArgs,
        startupTimeouts,
      });
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
