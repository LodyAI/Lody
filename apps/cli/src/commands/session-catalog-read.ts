import { Data } from 'effect';
import { RepoSyncError, RepoTransportError } from 'loro-repo';
import type { LodyError } from '@lody/shared';
import { FlockSyncTimeoutError } from '@/lib/loro/timeout-utils';
import { FlockSyncUnavailableError } from '@/lib/loro/flock-sync-errors';

export type MachineFlockSelection = {
  kind: 'project' | 'agent config' | 'ACP model' | 'ACP mode' | 'ACP option' | 'ACP run config';
  /** Caller-supplied selection id only; never option values, cached records, or transport details. */
  id?: string;
};

/** Agent-facing retry budget, not a server-enforced counter or an Operation deadline. */
export const MACHINE_CATALOG_RETRY_GUIDANCE =
  ' If no active Operation handle was returned, wait at least 5 seconds between attempts, make at most 3 total attempts (the initial call plus 2 retries), and reuse the identical request and operationId when present. Then stop and report the catalog blocker; do not create a new operationId to retry. If an active Operation handle was returned, let the daemon recover it and await automatic completion.';

export type MachineFlockFreshness = { confirmed: true } | { confirmed: false; error: unknown };

// Bind to the CLI's Repo constructors, not the shared package's pnpm peer instance.
// Unknown failures must not acquire retryability merely because a cache is missing.
function getSyncRetryability(
  error: unknown,
  seen = new Set<unknown>(),
  depth = 0
): boolean | undefined {
  if (depth > 8 || seen.has(error)) return undefined;
  const path = new Set(seen).add(error);
  if (error instanceof FlockSyncTimeoutError || error instanceof FlockSyncUnavailableError) {
    return true;
  }
  if (error instanceof RepoTransportError) {
    if (!error.retryable || error.streamsContext?.retryable === false) return false;
    return getSyncRetryability(error.cause, path, depth + 1) !== false;
  }
  if (error instanceof RepoSyncError || error instanceof AggregateError) {
    const errors =
      error instanceof RepoSyncError
        ? error.report.transports.flatMap((transport) =>
            transport.failures.map((failure) => failure.error)
          )
        : error.errors;
    const retryable = errors.map((failure) => getSyncRetryability(failure, path, depth + 1));
    if (retryable.includes(false)) return false;
    return retryable.length > 0 && retryable.every((value) => value === true) ? true : undefined;
  }
  if (error instanceof Error) return getSyncRetryability(error.cause, path, depth + 1);
  return undefined;
}

/** Freshness failed and the local replica cannot establish whether a selection is valid. */
export class MachineFlockReadUnavailableError extends Data.TaggedError(
  'MachineFlockReadUnavailableError'
)<{
  message: string;
  cause: unknown;
  selection?: MachineFlockSelection;
}> {
  toLodyError(): LodyError {
    const retryable = getSyncRetryability(this.cause) === true;
    const selection = this.selection
      ? ` Cannot validate ${this.selection.kind}${this.selection.id ? ` ${JSON.stringify(this.selection.id.slice(0, 120))}` : ''} from the local replica.`
      : ' The local replica cannot validate this request.';
    return {
      code: 'SYNC_UNAVAILABLE',
      message:
        'Machine catalog synchronization was not confirmed.' +
        selection +
        (retryable ? MACHINE_CATALOG_RETRY_GUIDANCE : ''),
      retryable,
    };
  }
}

export function assertMachineFlockCacheSufficient(
  freshness: MachineFlockFreshness,
  message: string,
  selection?: MachineFlockSelection
): void {
  if (!freshness.confirmed) {
    throw new MachineFlockReadUnavailableError({ message, cause: freshness.error, selection });
  }
}

/** Only wrap capability-dependent validation, never authorization or malformed input checks. */
export function validateWithMachineFlockFreshness<T>(
  freshness: MachineFlockFreshness,
  validate: () => T,
  selection?: MachineFlockSelection
): T {
  try {
    return validate();
  } catch (error) {
    assertMachineFlockCacheSufficient(
      freshness,
      error instanceof Error ? error.message : String(error),
      selection
    );
    throw error;
  }
}
