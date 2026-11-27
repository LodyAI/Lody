import { setTimeout as pause } from 'node:timers/promises';
import { Data, Effect, Result } from 'effect';
import { verifySignature } from '@lody/e2ee-core/protocol';
import {
  RemoteMachineOfferSchema,
  RemoteMachineStatusSchema,
  remoteMachineOfferBytes,
  remoteMachineSummary,
} from '@lody/shared/e2ee-remote-pairing';
import { LocalE2eePrepareResponseSchema } from '@lody/shared/e2ee-local-pairing';
import { isTransientHttpStatus, isTransportInterruption } from '../cloud-e2ee-errors';
import {
  prepareCliE2eeMachineLegacy,
  activateCliE2eeWorkspaceLegacy,
  retainCliE2eeMachineBootstrapLegacy,
} from './workspace-legacy';
import type { CloudE2eePort } from '@lody/platform';
import type { MachineKeyring } from './custody';

const raw = (s: string) => new Uint8Array(Buffer.from(s, 'hex'));
const POLL_MS = 1500;
const KEY_RETRY_MAX_MS = 15_000;
// Admission precedes key delivery: the approving desktop's refresh sends the current
// key afterwards and resumes it on its next refresh. Bound this wait for the terminal user.
const KEY_WAIT_MS = 10 * 60_000;
const CLAIM_RETRY_BASE_MS = 1500;
const CLAIM_RETRY_MAX_MS = 15_000;
const CLAIM_RETRY_BUDGET_MS = 60_000;
const CLAIM_RETRY_MAX_ATTEMPTS = 8;

export type FatalPairingCode =
  | 'e2ee_pairing_claimed_by_another_machine'
  | 'e2ee_pairing_expired_create_new_command'
  | 'e2ee_pairing_cancelled_create_new_command'
  | 'e2ee_pairing_conflict_create_new_command'
  | 'e2ee_pairing_conflict'
  | 'e2ee_pairing_superseded_create_new_command'
  | 'e2ee_pairing_invalid_command'
  | 'e2ee_binding_conflict'
  | 'e2ee_member_removed';

export type RetryablePairingCode =
  | 'e2ee_waiting_for_key'
  | 'e2ee_pairing_unavailable_retry_same_command';

export class FatalPairingError extends Data.TaggedError('FatalPairingError')<{
  readonly code: FatalPairingCode;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.code;
  }
}

export class RetryablePairingError extends Data.TaggedError('RetryablePairingError')<{
  readonly code: RetryablePairingCode;
  readonly cause?: unknown;
}> {
  override get message() {
    return this.code;
  }
}

function classifyClaimError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted) return error;
  if (typeof error === 'object' && error !== null && 'status' in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === 'number') {
      return isTransientHttpStatus(status)
        ? new RetryablePairingError({
            code: 'e2ee_pairing_unavailable_retry_same_command',
            cause: error,
          })
        : error;
    }
  }
  if (error instanceof TypeError || (error instanceof Error && isTransportInterruption(error))) {
    return new RetryablePairingError({
      code: 'e2ee_pairing_unavailable_retry_same_command',
      cause: error,
    });
  }
  return error;
}

const retryBounded = <A>(
  work: (remainingMs: number) => Effect.Effect<A, unknown>,
  opts: {
    baseMs: number;
    maxMs: number;
    budgetMs: number;
    maxAttempts?: number;
    timeoutCode: RetryablePairingCode;
    now: () => number;
    signal: AbortSignal;
    wait: (signal: AbortSignal, delayMs: number) => Promise<void>;
    onRetry?: (error: RetryablePairingError) => void;
  }
): Effect.Effect<A, unknown> =>
  Effect.gen(function* () {
    const deadline = opts.now() + opts.budgetMs;
    let delayMs = opts.baseMs;
    let attempts = 0;
    let lastError: unknown;
    for (;;) {
      opts.signal.throwIfAborted();
      const remainingBefore = deadline - opts.now();
      if (remainingBefore <= 0) {
        return yield* Effect.fail(
          lastError ?? new RetryablePairingError({ code: opts.timeoutCode })
        );
      }
      const attempt = yield* Effect.result(work(remainingBefore));
      if (Result.isSuccess(attempt)) return attempt.success;
      const error = attempt.failure;
      opts.signal.throwIfAborted();
      if (!(error instanceof RetryablePairingError)) return yield* Effect.fail(error);
      lastError = error.cause ?? error;
      attempts += 1;
      const remainingAfter = deadline - opts.now();
      if (remainingAfter <= 0 || (opts.maxAttempts !== undefined && attempts >= opts.maxAttempts)) {
        return yield* Effect.fail(lastError);
      }
      opts.onRetry?.(error);
      yield* Effect.tryPromise({
        try: () => opts.wait(opts.signal, Math.min(delayMs, remainingAfter)),
        catch: (cause) => cause,
      });
      delayMs = Math.min(delayMs * 2, opts.maxMs);
    }
  });

/** Verify the executable command before any custody access or network operation. */
export function decodeRemoteMachineOffer(encoded: string) {
  if (encoded.length > 32768 || !/^[A-Za-z0-9_-]+$/.test(encoded))
    throw new FatalPairingError({ code: 'e2ee_pairing_invalid_command' });
  const offer = RemoteMachineOfferSchema.parse(
    JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  );
  if (
    Result.isFailure(
      verifySignature(
        raw(offer.frontendSigningPublicKey),
        remoteMachineOfferBytes(offer),
        raw(offer.signature)
      )
    )
  )
    throw new FatalPairingError({ code: 'e2ee_pairing_invalid_command' });
  return offer;
}

/** Command-owned facade over the existing custody and activation owners. No account login/key is created. */
export async function pairRemoteMachineLegacy(options: {
  encodedOffer: string;
  machineId: string;
  cloud: CloudE2eePort;
  signal: AbortSignal;
  claim: (originalBody: string, signal: AbortSignal) => Promise<unknown>;
  keyring?: MachineKeyring;
  show: (value: {
    summary: string;
    protection: 'os-keystore' | 'file';
    location?: { country: string | null; city: string | null } | null;
    status: string;
  }) => void;
  wait?: (signal: AbortSignal, delayMs: number) => Promise<void>;
  now?: () => number;
}) {
  const wait = options.wait ?? ((signal, delayMs) => pause(delayMs, undefined, { signal }));
  const now = options.now ?? Date.now;
  const offer = decodeRemoteMachineOffer(options.encodedOffer);
  const prepared = await prepareCliE2eeMachineLegacy({
    ...offer,
    machineId: options.machineId,
    keyring: options.keyring,
    cloud: options.cloud,
  });
  if ('superseded' in prepared)
    throw new FatalPairingError({ code: 'e2ee_pairing_superseded_create_new_command' });
  const material = LocalE2eePrepareResponseSchema.parse({
    ...prepared,
    machineId: options.machineId,
    ok: true,
    type: 'prepare',
  });
  const summary = await remoteMachineSummary(offer, material);
  options.show({ summary, protection: material.protection, status: 'connecting' });
  const body = JSON.stringify({
    workspaceId: offer.workspaceId,
    pairingSessionId: offer.pairingSessionId,
    token: offer.token,
    material,
  });

  return Effect.runPromise(
    Effect.gen(function* () {
      for (;;) {
        options.signal.throwIfAborted();
        const rawStatus = yield* retryBounded(
          () =>
            Effect.tryPromise({
              try: () => options.claim(body, options.signal),
              catch: (error) => classifyClaimError(error, options.signal),
            }),
          {
            baseMs: CLAIM_RETRY_BASE_MS,
            maxMs: CLAIM_RETRY_MAX_MS,
            budgetMs: CLAIM_RETRY_BUDGET_MS,
            maxAttempts: CLAIM_RETRY_MAX_ATTEMPTS,
            timeoutCode: 'e2ee_pairing_unavailable_retry_same_command',
            now,
            signal: options.signal,
            wait,
          }
        );
        const status = RemoteMachineStatusSchema.parse(rawStatus);
        if (status.pairingSessionId !== offer.pairingSessionId)
          return yield* Effect.fail(new FatalPairingError({ code: 'e2ee_pairing_conflict' }));
        // Another machine's claim on the same command, before or after ours; never admit it.
        if (
          (status.material && JSON.stringify(status.material) !== JSON.stringify(material)) ||
          (status.status === 'conflict' && status.noAdmissionReserved === true)
        )
          return yield* Effect.fail(
            new FatalPairingError({ code: 'e2ee_pairing_claimed_by_another_machine' })
          );
        options.show({
          summary,
          protection: material.protection,
          location: status.location,
          status: status.status,
        });
        if (
          status.status === 'cancelled' ||
          status.status === 'expired' ||
          status.status === 'conflict'
        )
          return yield* Effect.fail(
            new FatalPairingError({
              code: `e2ee_pairing_${status.status}_create_new_command`,
            })
          );
        if (status.status === 'admitted' || status.status === 'ready') {
          yield* retryBounded(
            (remainingMs) =>
              Effect.tryPromise({
                try: () =>
                  activateCliE2eeWorkspaceLegacy({
                    accountId: offer.accountId,
                    workspaceId: offer.workspaceId,
                    genesisHash: offer.genesisHash,
                    pairingSessionId: offer.pairingSessionId,
                    frontendSigningPublicKey: offer.frontendSigningPublicKey,
                    expectedSigningPublicKey: material.signingPublicKey,
                    cloud: options.cloud,
                    onUnavailable: () => undefined,
                    keyring: options.keyring,
                    signal: options.signal,
                    timeoutMs: remainingMs,
                    now,
                  }),
                catch: (error) =>
                  error instanceof Error && error.message === 'e2ee_waiting_for_key'
                    ? new RetryablePairingError({ code: 'e2ee_waiting_for_key', cause: error })
                    : error,
              }),
            {
              baseMs: POLL_MS,
              maxMs: KEY_RETRY_MAX_MS,
              budgetMs: KEY_WAIT_MS,
              timeoutCode: 'e2ee_waiting_for_key',
              now,
              signal: options.signal,
              wait,
              onRetry: () =>
                options.show({
                  summary,
                  protection: material.protection,
                  location: status.location,
                  status: 'waiting-for-key',
                }),
            }
          );
          options.signal.throwIfAborted();
          yield* Effect.tryPromise({
            try: () =>
              retainCliE2eeMachineBootstrapLegacy(
                {
                  accountId: offer.accountId,
                  workspaceId: offer.workspaceId,
                  genesisHash: offer.genesisHash,
                  signingPublicKey: material.signingPublicKey,
                  machineId: options.machineId,
                  deploymentUrl: offer.deploymentUrl,
                },
                options.keyring
              ),
            catch: (cause) => cause,
          });
          options.signal.throwIfAborted();
          return {
            reference: `${offer.accountId}/${offer.workspaceId}`,
            workspaceId: offer.workspaceId,
            machineId: options.machineId,
            summary,
            ready: true as const,
          };
        }
        yield* Effect.tryPromise({
          try: () => wait(options.signal, POLL_MS),
          catch: (cause) => cause,
        });
      }
    })
  );
}
